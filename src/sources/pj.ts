/**
 * El adapter del portal de Jurisprudencia Nacional Sistematizada del Poder
 * Judicial del Perú — la **fuente secundaria** del proyecto.
 *
 * ## Lo primero, porque cambia cómo hay que leer todo lo demás
 *
 * **Este archivo nunca corrió contra su fuente.** El portal responde `403` sin
 * salida de red peruana —una regla del WAF por atributo de la IP de origen, con
 * el fingerprinting TLS/JA3 descartado con evidencia (§2.2)— y esta entrega tomó
 * el otro portal del enunciado, OEFA, como sitio principal en vez de contratar
 * una VPN (§3.3). Decir otra cosa sería el número inflado que el documento de
 * estrategia rechaza.
 *
 * Lo que sí hay es markup real del portal, capturado del archivo web y
 * versionado en `fixtures/pj/`. No es el sitio de hoy —el snapshot más nuevo es
 * de septiembre de 2025— pero es markup que el portal produjo, y alcanzó para
 * corregir cuatro supuestos sobre los que este adapter se iba a escribir. El
 * detalle está en `fixtures/pj/README.md` y en §5.11.
 *
 * ## En qué se parece a OEFA y en qué no
 *
 * En el núcleo: Mojarra, `ViewState`, cookie de sesión obligatoria,
 * `mojarra.jsfcljs`. Todo eso es `src/jsf/`, y transfiere entero — que era
 * exactamente la afirmación de §4 y acá deja de ser una promesa.
 *
 * En lo demás, en nada:
 *
 * | | OEFA | Poder Judicial |
 * |---|---|---|
 * | Librería de componentes | PrimeFaces 6.0 | RichFaces 4.2.2 |
 * | State saving | client-side (blob base64) | **server-side** (handle de dos longs) |
 * | Búsqueda | evento AJAX, `partial-response` | POST no-ajax, página completa |
 * | Paginación | `dt_first` de `p:dataTable` | desconocida — se descubre |
 * | Forms en la vista | uno | tres |
 *
 * Por eso `jsf/datatable.ts` no aparece acá salvo por `wrapRows`, y por eso no
 * hay un motor de recorrido común con `oefa.ts`: forzar dos protocolos distintos
 * dentro del molde del que sí está verificado no falla, produce datos.
 *
 * ## El principio que ordena el archivo
 *
 * **Lo que no se puede saber se descubre; lo que no se puede descubrir se
 * denuncia con nombre propio.** No hay un solo id de componente hardcodeado: el
 * botón de búsqueda, el de página siguiente y el enlace de cada documento salen
 * de leer los `onclick` de la página, porque sus ids son autogenerados y un
 * componente agregado más arriba los desplaza a todos.
 *
 * Y cuando el descubrimiento falla, el adapter **se detiene** en vez de seguir.
 * Un portal legacy que devuelve `200` con cero filas es el modo de falla más
 * caro del proyecto (§2.5, §6.4), y acá la probabilidad de encontrarlo es mayor
 * que en ningún otro lado: cada `StructuralDriftError` de este archivo nombra qué
 * request hay que capturar para cerrarlo.
 *
 * ## Cómo ejercitarlo
 *
 *     npm run smoke:pj                    # desde una red con salida peruana
 *     PROXY_URL=… npm run scrape -- --fuente pj --hasta 2
 */

import type { JsfRequest } from '../jsf/commands.ts';
import { ViewExpiredError, isRecoverable } from '../jsf/errors.ts';
import type { JsfView } from '../jsf/view.ts';
import type { Logger } from '../obs/logger.ts';
import type { Metrics } from '../obs/metrics.ts';
import {
  verificarForma,
  verificarIdentidades,
  type Aviso,
  type ContextoPagina,
} from './aserciones.ts';
import {
  PaginaDesalineadaError,
  RangoInvalidoError,
  RecuperacionAgotadaError,
  SinDocumentoError,
  StructuralDriftError,
  type ContextoDrift,
  type TipoDrift,
} from './errors.ts';
import {
  CAMPOS_BUSQUEDA,
  FORMS_CONOCIDOS,
  FUENTE,
  RegistroPjSchema,
  URL_PJ,
  descubrirBusqueda,
  descubrirPaginacion,
  identidadPjDe,
  parseTablaPj,
  rotular,
  type ComandoDescubierto,
  type FilaCrudaPj,
  type RegistroPj,
} from './pj-rows.ts';
import type { Fila, Fuente, OpcionesRecorrido, Pagina } from './types.ts';

export { URL_PJ } from './pj-rows.ts';

export interface PjDeps {
  /** Ya construida y apuntando a la URL del portal. La arma el CLI. */
  readonly view: JsfView;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

export interface PjOptions {
  /**
   * Filas por página.
   *
   * Se **deriva de la primera página** si no se pasa, y esa es la opción por
   * defecto a propósito: en OEFA el widget de PrimeFaces declara su `rows` en el
   * script de configuración, acá no hay nada equivalente que leer. Hardcodear un
   * 10 y que el portal sirva 20 produce el peor desenlace de todos — offsets
   * corridos, filas perfectamente válidas de otro lugar del dataset, y un
   * archivo con huecos que parece completo.
   */
  readonly pageSize?: number;
  readonly maxRecuperaciones?: number;
}

const MAX_RECUPERACIONES_POR_DEFECTO = 3;

export function createPjSource(deps: PjDeps, opts: PjOptions = {}): Fuente<RegistroPj> {
  return new PjSource(deps, opts);
}

class PjSource implements Fuente<RegistroPj> {
  readonly nombre = FUENTE;
  readonly urlBase = URL_PJ;

  readonly #view: JsfView;
  readonly #metrics: Metrics;
  readonly #log: Logger;
  readonly #pageSizeConfigurado: number | undefined;
  readonly #maxRecuperaciones: number;

  #total = 0;
  #pageSize = 0;
  /** El comando de búsqueda, descubierto una vez por corrida. */
  #comandoBusqueda: ComandoDescubierto | undefined;
  #vistosEnCorrida = new Set<string>();
  #recuperaciones = 0;

  constructor(deps: PjDeps, opts: PjOptions) {
    this.#view = deps.view;
    this.#metrics = deps.metrics;
    this.#log = deps.logger.child({ fuente: FUENTE });
    this.#pageSizeConfigurado = opts.pageSize;
    this.#maxRecuperaciones = opts.maxRecuperaciones ?? MAX_RECUPERACIONES_POR_DEFECTO;
  }

  /**
   * Recorre las páginas en orden.
   *
   * **Siempre arranca en la página 1, aunque `desde` diga otra cosa**, y las
   * anteriores al rango se descartan sin emitirse. No es una simplificación: la
   * paginación de este portal es un comando de «página siguiente», o sea
   * relativa al estado del servidor, y no hay forma de saltar a la página 87 sin
   * pasar por las 86 anteriores. Fingir lo contrario —emitir el comando con un
   * número inventado— devolvería filas perfectamente válidas de un lugar
   * equivocado del dataset.
   *
   * Cuesta requests y se dice en el log. Cuando haya un POST de paginación
   * capturado y resulte que acepta un offset absoluto, este método se acorta y el
   * resto del archivo no se toca.
   */
  async *recorrer(opts: OpcionesRecorrido = {}): AsyncGenerator<Pagina<RegistroPj>, void, void> {
    // Todo el estado es de **una** corrida. Sin este reinicio, un segundo
    // recorrido sobre la misma instancia arranca con las identidades de la
    // primera ya vistas y la página 1 se denuncia como solapamiento.
    this.#total = 0;
    this.#pageSize = 0;
    this.#comandoBusqueda = undefined;
    this.#vistosEnCorrida = new Set();
    this.#recuperaciones = 0;

    await this.#view.bootstrap();
    this.#verificarVista();
    await this.#buscar();

    if (this.#total === 0) {
      this.#log.info('la búsqueda no devolvió resultados');
      return;
    }

    const ultima = Math.max(1, Math.ceil(this.#total / this.#pageSize));
    const { desde, hasta } = this.#rango(opts, ultima);

    this.#log.info(
      { total: this.#total, pageSize: this.#pageSize, desde, hasta, ultima, derivado: this.#pageSizeConfigurado === undefined },
      'recorrido',
    );
    if (desde > 1) {
      this.#log.info(
        { desde },
        'la paginación de esta fuente es relativa: se recorren y descartan las páginas anteriores al rango',
      );
    }

    for (let numero = 1; numero <= hasta; numero += 1) {
      // La página 1 ya llegó con la búsqueda; las demás se piden.
      if (numero > 1) await this.#avanzarConRecuperacion(numero);

      const pagina = this.#construirPagina(numero, ultima);
      if (numero >= desde) yield pagina;
      else this.#metrics.increment('sources.paginas_descartadas');
    }
  }

  /**
   * El seam del bloque 5 (§5.4), con una guarda más que en OEFA.
   *
   * Las dos primeras son las mismas —la vista no puede haberse reconstruido, y
   * la fila tiene que ser de esta página—. La tercera es propia de este portal:
   * el POST del documento va **al form que el `onclick` nombra**, que puede no
   * ser el de la vista. Mandarlo al de búsqueda produciría un `200` con la página
   * re-renderizada, o sea el mismo síntoma que el token desalineado y una causa
   * que no se le parece en nada.
   */
  prepararDescarga(pagina: Pagina<RegistroPj>, fila: Fila<RegistroPj>): JsfRequest {
    const generacionActual = this.#view.snapshot().generation;
    if (pagina.generacion !== generacionActual) {
      throw new PaginaDesalineadaError(
        FUENTE,
        'generacion',
        `la página ${pagina.numero} se leyó en la generación ${pagina.generacion} y la vista va por la ` +
          `${generacionActual}: su ViewState ya no restaura esas filas`,
      );
    }
    if (!pagina.filas.includes(fila)) {
      throw new PaginaDesalineadaError(
        FUENTE,
        'fila-ajena',
        `la fila ${fila.registro.indice} no pertenece a la página ${pagina.numero}`,
      );
    }
    if (fila.descarga === undefined) throw new SinDocumentoError(FUENTE, fila.registro.id);

    return this.#view.prepareCommand(fila.descarga, {
      viewState: pagina.viewState,
      ...(fila.formulario === undefined ? {} : { formId: fila.formulario }),
    });
  }

  // -------------------------------------------------------------------------

  /**
   * Que el form del bootstrap sea efectivamente el de búsqueda.
   *
   * Dos chequeos con severidades distintas, y la diferencia importa. Que el form
   * se llame distinto es un **aviso**: ya cambió de nombre una vez entre 2016
   * (`formBusqueda`) y 2025 (`formBuscador`), así que volver a cambiar es
   * plausible y no rompe nada por sí solo. Que no traiga ninguno de los campos de
   * búsqueda conocidos es un **error**: significa que se está mirando otro form
   * de la página, y todo lo que venga después sería basura bien formada.
   */
  #verificarVista(): void {
    const form = this.#view.form;
    if (form === undefined) return;

    const conocidos: readonly string[] = FORMS_CONOCIDOS;
    if (!conocidos.includes(form.id)) {
      this.#advertir(`el form de la vista se llama «${form.id}» y no es ninguno de los conocidos`, {
        conocidos: conocidos.join(', '),
      });
    }

    const nombres = [...form.campos.keys()];
    const reconocidos = CAMPOS_BUSQUEDA.filter((campo) =>
      nombres.some((nombre) => nombre === campo || nombre.endsWith(`:${campo}`)),
    );
    if (reconocidos.length === 0) {
      throw this.#drift(
        'sin-filas',
        `el form «${form.id}» no trae ninguno de los campos de búsqueda conocidos: ` +
          'o no es el form de búsqueda, o el portal se rediseñó por completo',
        { campos: nombres.slice(0, 8).join(', '), conocidos: CAMPOS_BUSQUEDA.join(', ') },
      );
    }
    this.#log.debug({ form: form.id, reconocidos: reconocidos.join(', ') }, 'vista de búsqueda reconocida');
  }

  /**
   * Emite la búsqueda y fija el estado de la corrida.
   *
   * Tres cosas que no pasan en OEFA:
   *
   * 1. **El comando se descubre.** El id del botón es autogenerado
   *    (`formBusqueda:j_idt65` en el fixture de 2016); lo estable es que diga
   *    «Buscar».
   * 2. **El POST es no-ajax** y devuelve la página entera, no un diff XML.
   * 3. **Hay que adoptar la página que vuelve.** Es una vista re-renderizada:
   *    campos nuevos, forms que antes no estaban y un `ViewState` nuevo.
   *    Reenviar los campos del bootstrap en la paginación mandaría al servidor el
   *    estado anterior a la búsqueda.
   */
  async #buscar(): Promise<void> {
    const comando = this.#comandoBusqueda ?? descubrirBusqueda(this.#htmlDeLaVista('la búsqueda'));
    if (comando === undefined) {
      throw this.#drift(
        'busqueda-no-descubierta',
        'la página no trae ningún control rotulado «Buscar» con un mojarra.jsfcljs: ' +
          'capturar el POST de búsqueda con DevTools y comparar contra fixtures/pj/02-busqueda-resultado.html',
      );
    }
    this.#comandoBusqueda = comando;

    const html = await this.#emitir(comando);
    const tabla = parseTablaPj(html);

    if (tabla.iterador === undefined) {
      throw this.#drift(
        'sin-iterador',
        'la página de resultados no trae ningún componente con la forma «form:iterador:N:componente», ' +
          'que es como se reconocen las filas (§2.1): capturar el POST de búsqueda y revisar el markup real',
      );
    }

    if (tabla.total === undefined) {
      throw this.#drift(
        'sin-total',
        'no se pudo leer el total de resultados de la página: sin total no hay última página, ' +
          'y adivinarla produce un archivo con huecos que parece completo',
        { filas: tabla.filas.length, iterador: tabla.iterador },
      );
    }

    this.#total = tabla.total;
    // Derivado y no supuesto: es la única fuente disponible, porque este portal
    // no publica su configuración de paginación en ninguna parte legible.
    this.#pageSize = this.#pageSizeConfigurado ?? Math.max(1, tabla.filas.length);
    this.#metrics.increment('sources.busquedas');

    this.#log.info(
      { total: this.#total, pageSize: this.#pageSize, iterador: tabla.iterador, cabeceras: tabla.cabeceras.length },
      'búsqueda emitida',
    );
  }

  /**
   * Avanza una página, con la recuperación de §5.1.
   *
   * `recover()` importa más acá que en OEFA y no por precaución: el state saving
   * de este portal es **server-side**, o sea que el servidor guarda un número
   * acotado de vistas por sesión en un LRU —típicamente quince— y una corrida
   * larga puede perder la suya aunque el token sea el más reciente. En OEFA eso
   * no puede pasar: el token es un blob autocontenido.
   *
   * Después de recuperar hay que **rehacer la búsqueda**, porque `recover()`
   * restablece protocolo y no aplicación: deja la vista lista y el bean de
   * resultados vacío. Y como la paginación es relativa, hay que volver a avanzar
   * hasta donde estábamos: repaginar a ciegas sobre un bean recién buscado
   * devolvería la página 2 creyendo que es la 87.
   */
  async #avanzarConRecuperacion(numero: number): Promise<void> {
    try {
      await this.#avanzar();
      return;
    } catch (error) {
      if (!isRecoverable(error)) throw error;

      if (this.#recuperaciones >= this.#maxRecuperaciones) {
        throw new RecuperacionAgotadaError(
          FUENTE,
          'presupuesto',
          numero,
          `ya se hicieron ${this.#recuperaciones} recuperaciones en esta corrida`,
        );
      }
      this.#recuperaciones += 1;
      this.#metrics.increment('sources.recuperaciones');
      this.#log.warn(
        { pagina: numero, aRepaginar: numero - 1 },
        'vista caída: reconstruyendo, rehaciendo la búsqueda y volviendo a avanzar',
      );

      await this.#view.recover();
      this.#verificarVista();
      await this.#buscar();

      // Volver al punto donde se cayó. Las aserciones de identidad cubren el caso
      // de que el servidor no haya avanzado lo mismo: si el bean quedó en la
      // página 1, el solapamiento lo denuncia en vez de escribir filas del offset
      // equivocado.
      try {
        for (let i = 2; i <= numero; i += 1) await this.#avanzar();
      } catch (segundo) {
        if (!isRecoverable(segundo)) throw segundo;
        // Un solo intento por página. Sin este tope, una vista que expira
        // determinísticamente en la misma página se recupera una y otra vez,
        // gastando un bootstrap, una búsqueda y N avances por vuelta para volver
        // a fallar igual.
        throw new RecuperacionAgotadaError(
          FUENTE,
          'mismo-offset',
          numero,
          'la página volvió a fallar con la vista recién reconstruida',
        );
      }
    }
  }

  /** Un paso de «página siguiente», descubierto en la página que tenemos. */
  async #avanzar(): Promise<void> {
    const comando = descubrirPaginacion(this.#htmlDeLaVista('la paginación'));
    if (comando === undefined) {
      throw this.#drift(
        'paginacion-no-descubierta',
        'la página de resultados no trae un control de «página siguiente» con un mojarra.jsfcljs. ' +
          'Ningún snapshot del archivo web trae paginación, así que este es el punto del adapter con ' +
          'menos evidencia: capturar un POST de paginación cierra el hueco (§5.11)',
      );
    }

    const html = await this.#emitir(comando);

    // La vista caída, en un protocolo sin XML donde anunciarla.
    //
    // OEFA la contesta con un `<redirect>` dentro de un `<partial-response>`, y
    // `JsfView.submitAjax` la reconoce y lanza. Acá no hay partial-response: el
    // POST es no-ajax y lo que vuelve es HTML. Un servidor que perdió la vista
    // —con state saving server-side y un LRU acotado, cosa que en OEFA no puede
    // pasar— devuelve `200` con la página de inicio, que es un cuerpo válido
    // salvo por no traer resultados.
    //
    // La inferencia es legítima **por el contexto**, que es el mismo argumento de
    // §6.4: acabamos de leer una página con filas de un resultado que declaró un
    // total mayor que cero, así que «ahora no hay ni iterador» no es un dataset
    // vacío, es la sesión que se fue. Si en realidad cambió la estructura del
    // portal, la recuperación falla igual en el segundo intento y sale un
    // `RecuperacionAgotadaError`: el costo de equivocarse está acotado a un
    // bootstrap, y el de no intentarlo era detener una corrida recuperable.
    if (parseTablaPj(html).iterador === undefined) {
      this.#metrics.increment('jsf.view_expired');
      throw new ViewExpiredError(
        this.urlBase,
        'pagina-inicial',
        'la paginación devolvió una página sin iterador de resultados en medio de un recorrido ' +
          `con ${this.#total} fila(s) declaradas: la vista se perdió`,
      );
    }
  }

  /**
   * Emite un comando no-ajax y adopta la página que vuelve.
   *
   * Los dos pasos van juntos y en un solo lugar porque separarlos es la forma de
   * olvidarse del segundo: sin adoptar, la vista sigue con los campos de la
   * página anterior y el POST siguiente le manda al servidor un estado que ya no
   * existe. En un portal donde la búsqueda es no-ajax, eso significa repetir la
   * búsqueda anterior en cada paginación — con `200`, sin excepción, y filas
   * perfectamente válidas de la página equivocada.
   */
  async #emitir(comando: ComandoDescubierto): Promise<string> {
    const res = await this.#view.submitCommand(comando.params, {
      ...(comando.formulario === undefined ? {} : { formId: comando.formulario }),
    });
    const html = typeof res.data === 'string' ? res.data : '';
    this.#view.adoptarPagina(html);
    return html;
  }

  /**
   * Parseo y aserciones sobre la página que está cargada.
   *
   * El `indiceBase: 0` es la única línea de este archivo que merece leerse dos
   * veces. Un `p:dataTable` numera sus filas de forma global —la página 2
   * arranca en `data-ri="10"`— y un `ui:repeat` numera **dentro de la
   * iteración**, así que cada página vuelve a arrancar en 0. §2.1 documenta este
   * portal con `formBusqueda:repeat:0:…`, y `repeat` es el nombre canónico de un
   * `ui:repeat`. Exigirle el offset global denunciaría como desalineada toda
   * página después de la primera.
   *
   * Es un supuesto, no un hecho, y por eso el `indice` que va al registro sí es
   * global: si el supuesto está mal, lo que se rompe es una aserción ruidosa y no
   * el dataset.
   */
  #construirPagina(numero: number, ultima: number): Pagina<RegistroPj> {
    const tabla = parseTablaPj(this.#view.html ?? '');
    const first = (numero - 1) * this.#pageSize;

    const ctx: ContextoPagina = {
      fuente: FUENTE,
      numero,
      first,
      pageSize: this.#pageSize,
      total: this.#total,
      indiceBase: 0,
    };
    const ctxDrift: ContextoDrift = { pagina: numero, first };

    this.#conMetrica(() =>
      verificarForma(
        tabla.filas.map((f) => f.indice),
        ctx,
        tabla.filas.length === 0,
      ),
    );

    const capturadoEn = new Date().toISOString();
    const filas = tabla.filas.map((cruda) =>
      this.#construirFila(cruda, numero, first, tabla.cabeceras, capturadoEn, ctxDrift),
    );

    const avisos = this.#conMetrica(() =>
      verificarIdentidades(
        filas.map((f) => f.registro),
        ctx,
        this.#vistosEnCorrida,
      ),
    );
    for (const aviso of avisos) this.#avisar(aviso);

    this.#metrics.increment('sources.paginas');
    this.#metrics.increment('sources.registros', filas.length);

    return {
      numero,
      first,
      filas,
      total: this.#total,
      esUltima: numero === ultima,
      viewState: this.#view.viewState ?? '',
      generacion: this.#view.snapshot().generation,
    };
  }

  #construirFila(
    cruda: FilaCrudaPj,
    pagina: number,
    first: number,
    cabeceras: readonly string[],
    capturadoEn: string,
    ctx: ContextoDrift,
  ): Fila<RegistroPj> {
    // Un enlace que está pero no se deja leer **sí** es drift: cambió la forma
    // del `onclick`. Que la fila no traiga enlace, en cambio, puede ser un dato
    // del portal —OEFA publica resoluciones sin documento— y tratarlo como error
    // costaría los registros legítimos que vengan así.
    if (cruda.documento.estado === 'ilegible') {
      throw this.#drift(
        'sin-uuid',
        `la fila ${cruda.indice} trae un enlace de descarga cuyos parámetros no se dejan leer: ` +
          'cambió la forma del onclick',
        { ...ctx, indice: cruda.indice, onclick: cruda.documento.onclick.slice(0, 120) },
      );
    }

    const conDocumento = cruda.documento.estado === 'ok';
    if (!conDocumento) this.#metrics.increment('sources.sin_documento');

    const documentoUuid = conDocumento ? cruda.documento.uuid : undefined;
    const registro: RegistroPj = {
      fuente: FUENTE,
      id: identidadPjDe(cruda.texto, documentoUuid),
      // Global, aunque el portal numere por página: el `indice` es la coordenada
      // dentro del resultado y tiene que servir para localizar la fila desde la
      // cola de fallos del bloque 5.
      indice: first + cruda.indice,
      pagina,
      capturadoEn,
      ...(documentoUuid === undefined ? {} : { documentoUuid }),
      campos: rotular(cruda.celdas, cabeceras),
      texto: cruda.texto,
    };

    const validado = RegistroPjSchema.safeParse(registro);
    if (!validado.success) {
      throw this.#drift('registro-invalido', `la fila ${cruda.indice} no pasa el esquema del registro`, {
        ...ctx,
        indice: cruda.indice,
        problemas: validado.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' | '),
      });
    }

    if (cruda.celdas.length === 0) this.#metrics.increment('sources.sin_celdas');

    return {
      registro,
      descarga: conDocumento ? cruda.documento.comando : undefined,
      ...(conDocumento && cruda.documento.formulario !== undefined
        ? { formulario: cruda.documento.formulario }
        : {}),
    };
  }

  #rango(opts: OpcionesRecorrido, ultima: number): { desde: number; hasta: number } {
    const desde = opts.desde ?? 1;
    if (!Number.isInteger(desde) || desde < 1) {
      throw new RangoInvalidoError(FUENTE, `«desde» debe ser una página ≥ 1, llegó ${desde}`);
    }
    if (desde > ultima) {
      throw new RangoInvalidoError(FUENTE, `«desde» es ${desde} y el resultado tiene ${ultima} página(s)`);
    }

    const pedido = opts.hasta ?? ultima;
    if (!Number.isInteger(pedido) || pedido < desde) {
      throw new RangoInvalidoError(FUENTE, `«hasta» (${pedido}) no puede ser menor que «desde» (${desde})`);
    }
    const hasta = Math.min(pedido, ultima);
    if (pedido > ultima) this.#log.info({ pedido, ultima }, 'el rango se acota a la última página');

    return { desde, hasta };
  }

  /**
   * La página que la vista tiene cargada, que es sobre la que se descubre.
   *
   * `JsfView` la conserva desde el bootstrap y la reemplaza en cada
   * `adoptarPagina()`, así que acá no hay una segunda copia que se pueda
   * desincronizar. Que falte es un error de secuencia —descubrir antes de tener
   * página— y se reporta como tal en vez de devolver un string vacío sobre el
   * que todo descubrimiento fallaría con el mensaje equivocado.
   */
  #htmlDeLaVista(para: string): string {
    const html = this.#view.html;
    if (html !== undefined && html !== '') return html;
    throw this.#drift(
      'busqueda-no-descubierta',
      `no hay página cargada sobre la cual descubrir ${para}: la vista no completó el bootstrap`,
    );
  }

  #drift(tipo: TipoDrift, detalle: string, contexto: ContextoDrift = {}): StructuralDriftError {
    this.#metrics.increment(`sources.drift.${tipo}`);
    this.#log.error({ tipo, ...contexto }, detalle);
    return new StructuralDriftError(FUENTE, tipo, detalle, contexto);
  }

  #advertir(detalle: string, contexto: ContextoDrift): void {
    this.#metrics.increment('sources.drift_warn');
    this.#log.warn(contexto, detalle);
  }

  /** Le pone métrica y log a un drift nacido en `aserciones.ts`. Ver `oefa.ts`. */
  #conMetrica<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof StructuralDriftError) {
        this.#metrics.increment(`sources.drift.${error.tipo}`);
        this.#log.error({ tipo: error.tipo, ...error.contexto }, error.message);
      }
      throw error;
    }
  }

  #avisar(aviso: Aviso): void {
    const n = Number(/^(\d+)/.exec(aviso.detalle)?.[1]);
    this.#metrics.increment(aviso.metrica, Number.isInteger(n) && n > 0 ? n : 1);
    this.#advertir(aviso.detalle, aviso.contexto);
  }
}
