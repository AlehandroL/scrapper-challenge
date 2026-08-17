/**
 * `JsfView` — la máquina de estados del `ViewState` sobre una `Session`.
 *
 * Es el único módulo de esta capa que tiene estado, que hace I/O y que lanza
 * excepciones. Los cuatro parsers son totales y puros a propósito: un
 * `<partial-response>` sin `<update>` es un dato para el parser y un problema
 * para la vista, y solo la vista tiene el contexto para saber cuál de los dos.
 *
 * El invariante de §5.1: **un solo token vigente por sesión, actualizado en un
 * solo lugar.** Ese lugar es `#absorb`, y ninguna otra línea escribe
 * `#viewState`.
 *
 * Se llama `JsfView` y no `JsfSession` porque `Session` ya está tomado por el
 * transporte, y porque lo que esta clase custodia es una vista (un token), no
 * una sesión (una cookie). La distinción no es cosmética: una sesión puede
 * sobrevivir a la muerte de su vista, y de eso depende `recover()`.
 */

import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import type { Readable } from 'node:stream';

import type { Session } from '../http/session.ts';
import type { Logger } from '../obs/logger.ts';
import type { Metrics } from '../obs/metrics.ts';
import {
  BootstrapError,
  NotPartialResponseError,
  ViewExpiredError,
  ViewNotReadyError,
} from './errors.ts';
import {
  CABECERAS_AJAX,
  buildAjaxBody,
  buildCommandBody,
  type AjaxCommand,
  type JsfRequest,
} from './commands.ts';
import { parseForms, stripJsessionid, type JsfForm } from './form.ts';
import { parsePartialResponse, type PartialResponse } from './partial-response.ts';
import { extractViewState } from './view-state.ts';

export interface JsfViewDeps {
  readonly session: Session;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

export interface JsfViewOptions {
  /** URL de la página que hospeda la vista. Es también el `Referer`. */
  readonly pageUrl: string;
  /** Id del `<form>`; si se omite, el primero del documento. */
  readonly formId?: string;
  /**
   * Nombre de la cookie de sesión. Es un hecho de la Servlet spec, no de JSF, y
   * un contenedor puede renombrarla: hardcodearla sería meter una suposición de
   * infraestructura donde no corresponde.
   */
  readonly sessionCookie?: string;
  /** Falla dura si tras el bootstrap no hay cookie de sesión. */
  readonly requireSessionCookie?: boolean;
}

/** Vista segura para loguear: el token nunca en claro. */
export interface JsfViewSnapshot {
  readonly bootstrapped: boolean;
  readonly formId: string | undefined;
  readonly action: string | undefined;
  readonly viewStateLength: number;
  /** Cuántos bootstraps lleva. Sube con cada `recover()`. */
  readonly generation: number;
}

export class JsfView {
  readonly #deps: JsfViewDeps;
  readonly #pageUrl: string;
  readonly #formId: string | undefined;
  readonly #sessionCookie: string;
  readonly #requireSessionCookie: boolean;
  readonly #log: Logger;

  #form: JsfForm | undefined;
  /**
   * Los demás forms del documento, por id.
   *
   * En OEFA sobra: hay uno solo. La página de resultados del Poder Judicial
   * tiene tres —`formBusqueda`, `frmDetalle` y `frmDetalle2` con
   * `target="_blank"`— y los tres llevan el mismo `ViewState`, así que
   * `parseForm` no puede elegir «el que tiene token» sin que la elección sea
   * incidental. Guardarlos evita el único remedio alternativo, que sería un
   * segundo `bootstrap()` contra la misma URL: un GET de más, y una vista nueva
   * cuyo token no es el que la fila necesita.
   */
  #formsHermanos = new Map<string, JsfForm>();
  #viewState: string | undefined;
  /**
   * El cuerpo de la última página completa que la vista vio.
   *
   * Vive acá y no en el adapter porque es la **fuente** del estado que la vista
   * ya custodia: los forms salen de este HTML, y tenerlos sin él obliga a que
   * cada consumidor guarde su propia copia y las dos se desincronicen. Lo
   * necesita cualquier portal cuyo protocolo haya que descubrir leyendo la
   * página en vez de un script de configuración.
   */
  #html: string | undefined;
  #generation = 0;

  constructor(deps: JsfViewDeps, opts: JsfViewOptions) {
    this.#deps = deps;
    this.#pageUrl = stripJsessionid(opts.pageUrl);
    this.#formId = opts.formId;
    this.#sessionCookie = opts.sessionCookie ?? 'JSESSIONID';
    this.#requireSessionCookie = opts.requireSessionCookie ?? true;
    this.#log = deps.logger.child({ vista: this.#pageUrl });
  }

  get form(): JsfForm | undefined {
    return this.#form;
  }

  /**
   * Un form del mismo documento por id, o `undefined` si no estaba.
   *
   * Devuelve también el form de la vista cuando el id coincide, para que quien
   * resuelve un `onclick` no tenga que preguntar dos veces.
   */
  formPorId(id: string): JsfForm | undefined {
    if (this.#form?.id === id) return this.#form;
    return this.#formsHermanos.get(id);
  }

  /** Para el bloque 5 y para los tests. No loguearlo: usar `snapshot()`. */
  get viewState(): string | undefined {
    return this.#viewState;
  }

  /**
   * El token vigente, o `ViewNotReadyError` si no hay.
   *
   * Existe para que quien necesita un `string` no tenga que inventarse un valor
   * de relleno. El getter de arriba devuelve `string | undefined` —correcto: la
   * vista puede no estar lista— y quien construye una página necesita un
   * `string`. Sin esto la conversión era un `?? ''`, y el string vacío **no es
   * nullish**: se colaba entero por la guarda de `prepareCommand` y salía un POST
   * con `javax.faces.ViewState=` vacío. El portal contesta eso con un `200` y la
   * página re-renderizada, que es el modo de falla que el repo persigue en todas
   * partes. Un token faltante tiene que romper acá, con el nombre de la
   * operación, y no tres capas más abajo disfrazado de respuesta buena.
   */
  viewStateRequerido(operacion: string): string {
    return this.#requireViewState(operacion);
  }

  /** El cuerpo de la última página completa: bootstrap, `recover()` o `adoptarPagina()`. */
  get html(): string | undefined {
    return this.#html;
  }

  snapshot(): JsfViewSnapshot {
    return {
      bootstrapped: this.#form !== undefined,
      formId: this.#form?.id,
      action: this.#form?.action,
      viewStateLength: this.#viewState?.length ?? 0,
      generation: this.#generation,
    };
  }

  /** GET inicial: cookie, form y token. */
  async bootstrap(): Promise<JsfForm> {
    const res = await this.#deps.session.get(this.#pageUrl);

    // Se parsean todos de una pasada y después se elige: `parseForm` volvería a
    // cargar el documento en cheerio para leer lo mismo.
    const todos = parseForms(res.data, this.#pageUrl);
    const form =
      this.#formId === undefined
        ? (todos.find((f) => f.viewState !== undefined) ?? todos[0])
        : todos.find((f) => f.id === this.#formId);

    if (form === undefined) {
      throw new BootstrapError(
        this.#pageUrl,
        'form-not-found',
        this.#formId === undefined ? 'el documento no tiene ningún <form>' : `no existe el form «${this.#formId}»`,
      );
    }
    if (form.viewState === undefined) {
      throw new BootstrapError(this.#pageUrl, 'no-view-state', `el form «${form.id}» no trae javax.faces.ViewState`);
    }

    // La aserción que hace seguro sacar el `;jsessionid=` de las URLs: si la
    // sesión viajara solo por reescritura, esto falla acá y no dentro de
    // trescientas páginas con la tabla vacía (§2.5). Se comprueba contra el
    // action —la URL a la que efectivamente va el POST— y no contra pageUrl,
    // que es la que tiene que resolver el matcheo de dominio y path del jar.
    if (this.#requireSessionCookie && !(await this.#deps.session.hasCookie(form.action, this.#sessionCookie))) {
      throw new BootstrapError(
        this.#pageUrl,
        'no-session',
        `el servidor no propagó ${this.#sessionCookie}: la paginación devolvería 200 con la tabla vacía`,
      );
    }

    this.#form = form;
    this.#formsHermanos = new Map(todos.filter((f) => f.id !== form.id).map((f) => [f.id, f]));
    this.#html = typeof res.data === 'string' ? res.data : undefined;
    this.#generation += 1;
    this.#deps.metrics.increment('jsf.bootstraps');
    this.#absorb(form.viewState);

    this.#log.debug({ form: form.id, campos: form.campos.size, generacion: this.#generation }, 'vista lista');
    return form;
  }

  /**
   * Descarta el estado local y rehace el bootstrap.
   *
   * **No toca las cookies**, y es deliberado. §5.1 lo describe como «nueva
   * cookie, nuevo bootstrap», pero eso solo vale si la sesión murió. Botarla
   * garantiza el peor modo de falla del proyecto: los resultados viven en un
   * bean de sesión, así que sin cookie la paginación devuelve `200` con la
   * tabla vacía y sin excepción — se cambia un error ruidoso por uno mudo. Y es
   * innecesario: si la sesión efectivamente murió, el GET trae un `Set-Cookie`
   * nuevo y el jar la reemplaza solo.
   *
   * Restablece estado de **protocolo**, no de aplicación: deja la vista lista
   * para emitir eventos y el bean de resultados vacío. Rehacer la búsqueda y
   * repaginar es de `sources/`, que es quien sabe qué se estaba buscando.
   */
  async recover(): Promise<JsfForm> {
    this.#log.warn({ generacion: this.#generation }, 'reconstruyendo la vista');
    this.#form = undefined;
    this.#formsHermanos = new Map();
    this.#html = undefined;
    this.#viewState = undefined;
    this.#deps.metrics.increment('jsf.recuperaciones');
    return this.bootstrap();
  }

  /**
   * Adopta los forms de una página completa que el servidor acaba de devolver.
   *
   * Un POST no-ajax devuelve la vista **re-renderizada**: campos nuevos, forms
   * que antes no estaban, valores que cambiaron. Los del bootstrap quedan
   * viejos, y reenviarlos manda al servidor el estado de la página anterior —que
   * en un portal donde la búsqueda es no-ajax significa repetir la búsqueda
   * anterior en cada paginación—.
   *
   * Es explícito y no automático dentro de `submitCommand` por una razón
   * concreta: la respuesta de una **descarga** también es un POST no-ajax que a
   * veces devuelve HTML, y ese HTML es la página de error. Adoptar sus forms sin
   * que nadie lo pida reemplazaría la vista buena por la de un fallo.
   *
   * **No incrementa la generación.** La generación marca «se reconstruyó la
   * vista y los tokens viejos no restauran nada»; un re-render es la misma vista
   * avanzando, y subirla invalidaría páginas cuyo token sigue sirviendo.
   */
  adoptarPagina(html: string): JsfForm {
    const todos = parseForms(html, this.#pageUrl);
    const form =
      this.#formId === undefined
        ? (todos.find((f) => f.viewState !== undefined) ?? todos[0])
        : todos.find((f) => f.id === this.#formId);

    if (form === undefined) {
      throw new BootstrapError(
        this.#pageUrl,
        'form-not-found',
        this.#formId === undefined
          ? 'la página re-renderizada no trae ningún <form>'
          : `la página re-renderizada no trae el form «${this.#formId}»`,
      );
    }

    this.#form = form;
    this.#formsHermanos = new Map(todos.filter((f) => f.id !== form.id).map((f) => [f.id, f]));
    this.#html = html;
    this.#absorb(form.viewState);
    this.#log.debug({ form: form.id, campos: form.campos.size, hermanos: this.#formsHermanos.size }, 'página adoptada');
    return form;
  }

  /** Arma el POST ajax sin emitirlo. */
  prepareAjax(cmd: AjaxCommand): JsfRequest {
    const form = this.#requireForm('prepareAjax');
    return {
      url: form.action,
      body: buildAjaxBody(form, this.#requireViewState('prepareAjax'), cmd),
      headers: { ...CABECERAS_AJAX, Referer: this.#pageUrl },
    };
  }

  /**
   * Arma el POST no-ajax (`mojarra.jsfcljs`) sin emitirlo: el bloque 5 lo streamea.
   *
   * `formId` selecciona contra qué form del documento se arma. Es lo que exige un
   * portal que reparte el trabajo entre varios —el del Poder Judicial manda el
   * documento por `frmDetalle2` y no por el form de búsqueda—, y por eso el
   * `onclick` nombra su form: `parseJsfcljs` devuelve ese id justamente para que
   * llegue hasta acá en vez de perderse.
   *
   * Lanza si el id no existe en el documento. Caer al form de la vista sería el
   * atajo cómodo y produce el peor desenlace posible: un POST bien formado, `200`,
   * y la página re-renderizada en vez del documento — el mismo síntoma que §5.4
   * documenta para el token desalineado, con una causa que no se le parece.
   */
  prepareCommand(
    params: Readonly<Record<string, string>>,
    opts: { readonly viewState?: string; readonly formId?: string } = {},
  ): JsfRequest {
    const form = opts.formId === undefined ? this.#requireForm('prepareCommand') : this.#requireFormId(opts.formId);
    return {
      url: form.action,
      body: buildCommandBody(form, opts.viewState ?? this.#requireViewState('prepareCommand'), params),
      headers: { Referer: this.#pageUrl },
    };
  }

  /**
   * POST ajax. Absorbe el token e interpreta las señales de sesión caída antes
   * de devolver.
   */
  async submitAjax(cmd: AjaxCommand): Promise<PartialResponse> {
    const req = this.prepareAjax(cmd);
    const res = await this.#deps.session.postForm(req.url, req.body, { headers: req.headers });

    const partial = parsePartialResponse(res.data);
    if (!partial.esPartial) {
      throw new NotPartialResponseError(req.url, contentType(res), res.data);
    }

    // Absorber **antes** de interpretar: una respuesta de error también puede
    // rotar el token, y descartarlo dejaría la vista con uno viejo.
    this.#absorb(partial.viewState);

    if (partial.error !== undefined) {
      this.#deps.metrics.increment('jsf.view_expired');
      throw new ViewExpiredError(req.url, 'error', `${partial.error.name}: ${partial.error.message}`);
    }

    // El `<redirect>` es la otra cara de la misma condición, y en OEFA es la
    // única que aparece: ante un token que no se puede restaurar contesta 200
    // con un redirect de 113 bytes, sin `<error>` ni mención a
    // ViewExpiredException (`fixtures/oefa/06-view-expired.xml`). Tratarlo como
    // «respuesta válida sin updates» es leer cero filas sin ningún error.
    if (partial.redirect !== undefined) {
      this.#deps.metrics.increment('jsf.view_expired');
      throw new ViewExpiredError(req.url, 'redirect', partial.redirect);
    }

    this.#deps.metrics.increment('jsf.eventos');
    return partial;
  }

  /**
   * POST no-ajax con cuerpo de texto. Absorbe el token de la página
   * re-renderizada si vino uno.
   */
  async submitCommand(
    params: Readonly<Record<string, string>>,
    opts: { readonly formId?: string; readonly cfg?: AxiosRequestConfig } = {},
  ): Promise<AxiosResponse<string>> {
    const { cfg } = opts;
    const req = this.prepareCommand(params, opts.formId === undefined ? {} : { formId: opts.formId });
    const res = await this.#deps.session.postForm(req.url, req.body, {
      ...cfg,
      headers: { ...req.headers, ...cfg?.headers },
    });
    if (typeof res.data === 'string') this.#absorb(extractViewState(res.data));
    return res;
  }

  /**
   * POST no-ajax en **streaming**: el camino de la descarga (§5.4).
   *
   * Existe acá, y no como una llamada suelta a `session.stream` desde el
   * consumidor, porque concentra las dos trampas que tienen el mismo síntoma
   * —`200` con la página re-renderizada en vez del documento— y ninguna causa
   * parecida:
   *
   * 1. **`session.stream` no pone el `Content-Type`.** `postForm` sí lo pone, y
   *    `prepareCommand` solo agrega el `Referer`; por el hueco entre los dos, un
   *    POST en streaming sale sin declarar el encoding del cuerpo y el servidor
   *    procesa un form vacío.
   * 2. **No absorbe el token.** Es la diferencia con `submitCommand`, y es
   *    deliberada: si el servidor contesta la página re-renderizada, esa página
   *    trae su propio `ViewState`, y absorberlo reemplazaría en silencio el token
   *    del recorrido por el de una vista que no corresponde. La respuesta acá es
   *    un binario; no hay nada que absorber.
   *
   * Toma el `JsfRequest` ya armado —`prepareCommand(params, viewStateDeLaPagina)`—
   * en vez de armarlo, justamente porque el token tiene que ser el de la página
   * donde vive la fila y no el vigente.
   */
  streamCommand(req: JsfRequest): Promise<AxiosResponse<Readable>> {
    return this.#deps.session.stream(req.url, {
      method: 'post',
      data: req.body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', ...req.headers },
    });
  }

  /**
   * El único lugar donde `#viewState` se escribe (§5.1).
   *
   * Un `undefined` **no** borra el vigente: hay respuestas que legítimamente no
   * traen token —el `<redirect>` de sesión caída es una— y tratarlas como
   * «perdimos el token» convertiría una condición recuperable en una vista
   * inutilizable.
   */
  #absorb(token: string | undefined): void {
    if (token === undefined || token === this.#viewState) return;
    const rotacion = this.#viewState !== undefined;
    this.#viewState = token;
    if (rotacion) {
      this.#deps.metrics.increment('jsf.view_state_rotado');
      // La longitud, nunca el valor: el token serializa el árbol de componentes.
      this.#log.debug({ bytes: token.length }, 'ViewState rotado');
    }
  }

  #requireForm(operacion: string): JsfForm {
    if (this.#form === undefined) throw new ViewNotReadyError(this.#pageUrl, operacion);
    return this.#form;
  }

  #requireFormId(id: string): JsfForm {
    this.#requireForm('prepareCommand');
    const form = this.formPorId(id);
    if (form === undefined) {
      throw new BootstrapError(
        this.#pageUrl,
        'form-not-found',
        `el documento no tiene un form «${id}»; hay: ${[this.#form?.id, ...this.#formsHermanos.keys()].join(', ')}`,
      );
    }
    return form;
  }

  #requireViewState(operacion: string): string {
    if (this.#viewState === undefined) throw new ViewNotReadyError(this.#pageUrl, operacion);
    return this.#viewState;
  }
}

function contentType(res: AxiosResponse<unknown>): string | undefined {
  const valor: unknown = res.headers['content-type'];
  return typeof valor === 'string' ? valor : undefined;
}
