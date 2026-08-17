/**
 * El adapter del Registro de Infractores Ambientales de OEFA — la **fuente
 * principal** del proyecto y el default de los cuatro CLIs. Es la única que se
 * ejercitó entera contra su sitio: 176 páginas, 1.753 filas y 30 documentos.
 *
 * Es la máquina que convierte «una vista JSF viva» en «páginas de registros»:
 * bootstrap, búsqueda, y un evento de paginación por página. Todo lo que sabe de
 * protocolo se lo pide a `jsf/`; todo lo que sabe del portal se lo pide a
 * `oefa-rows.ts`. Lo que aporta este archivo es lo único que ninguno de los dos
 * puede tener: **el contexto**.
 *
 * Ese contexto es lo que hace decidibles las aserciones de §6.4.
 * `jsf/datatable.ts` puede ver que la tabla vino vacía, pero no puede saber si
 * eso es una búsqueda sin resultados o la sesión perdida; para distinguirlas hay
 * que saber que la búsqueda declaró 1.753 registros y que estamos pidiendo el
 * offset 1.730. Por eso las aserciones viven acá y todas en el mismo lugar: el
 * día que se repartan entre tres funciones, la primera que estorbe se va a
 * relajar sin que nadie note que las otras dos dejaron de cubrir nada.
 *
 * **La `JsfView` llega inyectada.** Así este archivo no importa nada de
 * `src/http/` —ni siquiera como tipo— y la afirmación de §4 queda verificable
 * desde los dos lados. Quien arma la sesión es el CLI.
 *
 * Sobre filtros: §2.5 dejó el request de búsqueda con valores sin reversar, así
 * que `recorrer()` no los acepta. Una firma que promete lo que no hace es peor
 * que una que no lo ofrece.
 */

import type { JsfRequest } from '../jsf/commands.ts';
import { pageCommand } from '../jsf/datatable.ts';
import { isRecoverable } from '../jsf/errors.ts';
import { findUpdate } from '../jsf/partial-response.ts';
import type { JsfView } from '../jsf/view.ts';
import type { Logger } from '../obs/logger.ts';
import type { Metrics } from '../obs/metrics.ts';
import {
  verificarForma,
  verificarIdentidades,
  verificarPageSize,
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
  CABECERAS_ESPERADAS,
  COLUMNAS_ESPERADAS,
  FUENTE,
  ID_BOTON_BUSCAR,
  ID_CAMPO_EXPEDIENTE,
  ID_LISTA,
  ID_TABLA,
  RegistroOefaSchema,
  URL_OEFA,
  identidadDe,
  parsePaginador,
  parseTabla,
  type FilaCruda,
  type RegistroOefa,
  type TablaParseada,
} from './oefa-rows.ts';
import type { Fila, Fuente, OpcionesRecorrido, Pagina } from './types.ts';

export { URL_OEFA } from './oefa-rows.ts';

export interface OefaDeps {
  /** Ya construida y apuntando a la URL del portal. */
  readonly view: JsfView;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

export interface OefaOptions {
  /** Se asevera contra el que declare el widget: no se confía en el default. */
  readonly pageSize?: number;
  readonly maxRecuperaciones?: number;
}

const PAGE_SIZE_POR_DEFECTO = 10;
const MAX_RECUPERACIONES_POR_DEFECTO = 3;

export function createOefaSource(deps: OefaDeps, opts: OefaOptions = {}): Fuente<RegistroOefa> {
  return new OefaSource(deps, opts);
}

class OefaSource implements Fuente<RegistroOefa> {
  readonly nombre = FUENTE;
  readonly urlBase = URL_OEFA;

  readonly #view: JsfView;
  readonly #metrics: Metrics;
  readonly #log: Logger;
  readonly #pageSize: number;
  readonly #maxRecuperaciones: number;

  #total = 0;
  /**
   * El fragmento que devolvió la última búsqueda, todavía sin consumir.
   *
   * La respuesta de la búsqueda **ya trae la primera página**: pedirla otra vez
   * con un `pageCommand({first: 0})` gastaría un POST por corrida y, peor,
   * apostaría a que el servidor trata el offset 0 igual que los demás — que es
   * lo único de la paginación que los fixtures no verificaron.
   */
  #busquedaFresca: string | undefined;
  #vistosEnCorrida = new Set<string>();
  #buscada = false;
  #recuperaciones = 0;

  constructor(deps: OefaDeps, opts: OefaOptions) {
    this.#view = deps.view;
    this.#metrics = deps.metrics;
    this.#log = deps.logger.child({ fuente: FUENTE });
    this.#pageSize = opts.pageSize ?? PAGE_SIZE_POR_DEFECTO;
    this.#maxRecuperaciones = opts.maxRecuperaciones ?? MAX_RECUPERACIONES_POR_DEFECTO;
  }

  async *recorrer(opts: OpcionesRecorrido = {}): AsyncGenerator<Pagina<RegistroOefa>, void, void> {
    // Todo el estado es de **una** corrida, así que se reinicia acá y no en el
    // constructor. Sin esto, un segundo recorrido sobre la misma instancia
    // arranca con las identidades de la primera ya vistas y la página 1 se denuncia
    // como solapamiento — un falso positivo que además apunta al lugar
    // equivocado.
    this.#total = 0;
    this.#buscada = false;
    this.#busquedaFresca = undefined;
    this.#vistosEnCorrida = new Set();
    this.#recuperaciones = 0;

    await this.#view.bootstrap();
    await this.#buscar();

    if (this.#total === 0) {
      // Dato, no error: la búsqueda declaró cero y la tabla vino vacía. Las dos
      // señales coinciden, así que no hay nada que denunciar.
      this.#log.info('la búsqueda no devolvió resultados');
      return;
    }

    const ultima = Math.max(1, Math.ceil(this.#total / this.#pageSize));
    const { desde, hasta } = this.#rango(opts, ultima);

    this.#log.info({ total: this.#total, pageSize: this.#pageSize, desde, hasta, ultima }, 'recorrido');

    for (let numero = desde; numero <= hasta; numero += 1) {
      yield await this.#leerPaginaConRecuperacion(numero, (numero - 1) * this.#pageSize, ultima);
    }
  }

  /**
   * El seam del bloque 5 (§5.4).
   *
   * Devuelve el POST armado y **sin emitir**. Tres cosas sobre cómo ejecutarlo,
   * porque las tres tienen el mismo síntoma —`200` con la página re-renderizada
   * en vez del PDF— y ninguna se parece a su causa:
   *
   * 1. **Con `session.stream`, nunca con `view.submitCommand`.** `submitCommand`
   *    usa el token *vigente*, que después de avanzar de página ya no está
   *    alineado con esta fila; y encima absorbe el `ViewState` de la página que
   *    devuelve el fallo, reemplazando en silencio el token del recorrido.
   * 2. **Hay que agregar el `Content-Type`.** `prepareCommand` solo pone
   *    `Referer`; `session.postForm` completa el resto, pero `session.stream` no.
   * 3. **El token de la página sigue sirviendo después de avanzar** — verificado
   *    en §2.5, donde el PDF de la fila 0 se bajó estando la sesión en la página
   *    2. Lo que lo mata es un `recover()`, y de eso se ocupa la primera guarda.
   */
  prepararDescarga(pagina: Pagina<RegistroOefa>, fila: Fila<RegistroOefa>): JsfRequest {
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

    return this.#view.prepareCommand(fila.descarga, { viewState: pagina.viewState });
  }

  // -------------------------------------------------------------------------

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
    // Pedir de más se acota; pedir de menos no. `--hasta 9999` es la forma
    // natural de decir «todas» desde una línea de comandos.
    const hasta = Math.min(pedido, ultima);
    if (pedido > ultima) this.#log.info({ pedido, ultima }, 'el rango se acota a la última página');

    return { desde, hasta };
  }

  /**
   * Emite el evento de búsqueda y fija el estado de la corrida.
   *
   * También la usa la recuperación: tras un `recover()` la vista queda lista
   * pero el bean de resultados vacío, y repaginar sin volver a buscar devuelve la
   * tabla vacía con `200` (§5.1).
   */
  async #buscar(): Promise<void> {
    const respuesta = await this.#view.submitAjax({
      source: ID_BOTON_BUSCAR,
      // `@all` y el render de estos dos componentes es lo verificado contra el
      // sitio en el bloque 3; cambiarlo devuelve un partial-response que no trae
      // la lista.
      execute: '@all',
      render: `${ID_LISTA} ${ID_CAMPO_EXPEDIENTE}`,
      params: { [ID_BOTON_BUSCAR]: ID_BOTON_BUSCAR },
    });

    const fragmento = findUpdate(respuesta, ID_LISTA);
    if (fragmento === undefined) {
      throw this.#drift('sin-filas', `la búsqueda no devolvió el componente ${ID_LISTA}`, {
        updates: [...respuesta.updates.keys()].join(', '),
      });
    }

    const tabla = parseTabla(fragmento);
    this.#verificarEncabezado(tabla);

    if (tabla.total === undefined) {
      throw this.#drift('sin-total', 'la búsqueda no reportó `rowCount`: sin total no hay última página');
    }

    // Un total que cambia a mitad de corrida invalida todos los offsets
    // posteriores: seguir produce un archivo con huecos que parece completo.
    if (this.#buscada && tabla.total !== this.#total) {
      throw this.#drift('total-inestable', `el total pasó de ${this.#total} a ${tabla.total} entre búsquedas`, {
        antes: this.#total,
        ahora: tabla.total,
      });
    }

    this.#total = tabla.total;
    this.#buscada = true;
    this.#busquedaFresca = fragmento;
    this.#metrics.increment('sources.busquedas');
  }

  /**
   * Cabeceras y tamaño de página **solo se pueden chequear sobre la búsqueda**:
   * la respuesta de paginación es una tira de `<tr>` pelados, sin `<thead>` y sin
   * el script del widget. Que falte el chequeo ahí no es un olvido.
   */
  #verificarEncabezado(tabla: TablaParseada): void {
    this.#conMetrica(() => verificarPageSize(FUENTE, tabla.pageSize, this.#pageSize));

    // El conteo de columnas sí es error (se chequea por fila); los textos, no.
    // Una tilde agregada o un renombre editorial no rompen nada, y hacer que
    // tumben la corrida es cómo se llega a que alguien desactive el chequeo.
    const esperadas: readonly string[] = CABECERAS_ESPERADAS;
    if (tabla.cabeceras.length > 0 && tabla.cabeceras.join('|') !== esperadas.join('|')) {
      this.#advertir('cambiaron los rótulos de las columnas', {
        esperadas: esperadas.join(' · '),
        observadas: tabla.cabeceras.join(' · '),
      });
    }

    // El paginador es una segunda fuente del total, por un camino distinto al
    // `rowCount` del script. Que coincidan lo convierte en un dato verificado.
    const paginador = tabla.paginadorTexto === undefined ? undefined : parsePaginador(tabla.paginadorTexto);
    if (paginador !== undefined && tabla.total !== undefined && paginador.total !== tabla.total) {
      this.#advertir('el paginador y el widget no reportan el mismo total', {
        widget: tabla.total,
        paginador: paginador.total,
      });
    }
  }

  async #leerPaginaConRecuperacion(
    numero: number,
    first: number,
    ultima: number,
  ): Promise<Pagina<RegistroOefa>> {
    try {
      return await this.#leerPagina(numero, first, ultima);
    } catch (error) {
      // El drift y el `NotPartialResponseError` salen derecho: ninguno de los
      // dos se arregla con una sesión nueva, y reintentarlos solo retrasa el
      // diagnóstico.
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
      this.#log.warn({ pagina: numero, first }, 'vista caída: reconstruyendo y rehaciendo la búsqueda');

      // `recover()` restablece protocolo; el estado de aplicación —qué se estaba
      // buscando— es de esta capa, que es exactamente lo que §5.1 pide y la razón
      // por la que `jsf/` no expone un `withRecovery()` que reintente solo.
      await this.#view.recover();
      await this.#buscar();

      // Y el repaginado **no es ciego**: si el bean quedó en la página 1, las
      // aserciones de índices lo denuncian en vez de escribir filas del offset
      // equivocado.
      try {
        return await this.#leerPagina(numero, first, ultima);
      } catch (segundo) {
        if (!isRecoverable(segundo)) throw segundo;
        // Un solo intento por offset. Sin este tope, una vista que expira
        // determinísticamente en la misma página se recupera una y otra vez,
        // gastando un bootstrap y una búsqueda por vuelta para volver a fallar
        // igual — y el presupuesto global tarda en notarlo.
        throw new RecuperacionAgotadaError(
          FUENTE,
          'mismo-offset',
          numero,
          `el offset ${first} volvió a fallar con la vista recién reconstruida`,
        );
      }
    }
  }

  async #leerPagina(numero: number, first: number, ultima: number): Promise<Pagina<RegistroOefa>> {
    const cacheada = first === 0 ? this.#busquedaFresca : undefined;
    this.#busquedaFresca = undefined;

    let fragmento = cacheada;
    if (fragmento === undefined) {
      const respuesta = await this.#view.submitAjax(
        pageCommand({ tableId: ID_TABLA, first, rows: this.#pageSize }),
      );
      fragmento = findUpdate(respuesta, ID_TABLA);
      if (fragmento === undefined) {
        throw this.#drift('sin-filas', `la paginación no devolvió el componente ${ID_TABLA}`, {
          pagina: numero,
          first,
          updates: [...respuesta.updates.keys()].join(', '),
        });
      }
    }

    return this.#construirPagina(fragmento, numero, first, ultima);
  }

  /**
   * Parseo y aserciones, con el contexto completo del recorrido.
   *
   * Las aserciones viven en `aserciones.ts` porque no son de OEFA —dependen del
   * offset, del tamaño de página y del total, y de nada más—, pero el contexto
   * que las hace decidibles se arma acá: `jsf/datatable.ts` puede ver que la
   * tabla vino vacía y no puede saber si eso es una búsqueda sin resultados o la
   * sesión perdida.
   *
   * Entre las dos fases corren las aserciones **por fila**, que sí son de este
   * portal: siete columnas, la numeración, el enlace legible y el esquema.
   */
  #construirPagina(
    fragmento: string,
    numero: number,
    first: number,
    ultima: number,
  ): Pagina<RegistroOefa> {
    const tabla = parseTabla(fragmento);
    const ctx: ContextoPagina = {
      fuente: FUENTE,
      numero,
      first,
      pageSize: this.#pageSize,
      total: this.#total,
    };
    const ctxDrift: ContextoDrift = { pagina: numero, first, esperadas: Math.min(this.#pageSize, this.#total - first) };

    this.#conMetrica(() =>
      verificarForma(
        tabla.filas.map((f) => f.indice),
        ctx,
        tabla.vacia,
      ),
    );

    const capturadoEn = new Date().toISOString();
    const filas = tabla.filas.map((cruda) => this.#construirFila(cruda, numero, capturadoEn, ctxDrift));

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
      // El token que corresponde a **esta** página. Se captura acá y no se vuelve
      // a leer: para cuando el consumidor pida un PDF, `view.viewState` ya rotó.
      viewState: this.#view.viewState ?? '',
      generacion: this.#view.snapshot().generation,
    };
  }

  #construirFila(
    cruda: FilaCruda,
    pagina: number,
    capturadoEn: string,
    ctx: ContextoDrift,
  ): Fila<RegistroOefa> {
    if (cruda.columnas !== COLUMNAS_ESPERADAS || cruda.campos === undefined) {
      throw this.#drift(
        'columnas',
        `la fila ${cruda.indice} trae ${cruda.columnas} columnas y se esperaban ${COLUMNAS_ESPERADAS}`,
        { ...ctx, indice: cruda.indice, columnas: cruda.columnas },
      );
    }

    // Sale del mismo `rowIndex` que el `data-ri`, así que no denuncia al
    // servidor: denuncia que las celdas se corrieron de lugar. Cuesta nada y
    // cubre el único caso que las otras aserciones no ven.
    if (cruda.nro !== cruda.indice + 1) {
      throw this.#drift(
        'numeracion',
        `la fila con data-ri ${cruda.indice} está numerada ${cruda.nro ?? 'sin número'}`,
        { ...ctx, indice: cruda.indice },
      );
    }

    // Un enlace que está pero no se deja leer **sí** es drift: cambió la forma
    // del `onclick`. Que la celda no traiga enlace, en cambio, es un dato del
    // sitio —resoluciones publicadas como «Información confidencial»— y tratarlo
    // como error costaría los registros legítimos que vienen así.
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
    const registro: RegistroOefa = {
      fuente: FUENTE,
      id: identidadDe(cruda.campos, documentoUuid),
      indice: cruda.indice,
      pagina,
      capturadoEn,
      ...(documentoUuid === undefined ? {} : { documentoUuid }),
      ...cruda.campos,
    };

    // §6.7. Llegado acá el esquema no debería fallar nunca —las aserciones de
    // arriba cubren todo lo que él exige—, y es justamente por eso que vale
    // tenerlo: si falla, lo que se rompió es un supuesto, no un dato.
    const validado = RegistroOefaSchema.safeParse(registro);
    if (!validado.success) {
      throw this.#drift('registro-invalido', `la fila ${cruda.indice} no pasa el esquema del registro`, {
        ...ctx,
        indice: cruda.indice,
        problemas: validado.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' | '),
      });
    }

    // Campos vacíos: se cuentan, no detienen. Una resolución sin unidad
    // fiscalizable es variación del origen; el porcentaje lo reporta §6.3.
    if (cruda.campos.administrados.length === 0) this.#metrics.increment('sources.sin_administrado');
    if (cruda.campos.expediente === '') this.#metrics.increment('sources.sin_expediente');

    return { registro, descarga: conDocumento ? cruda.documento.comando : undefined };
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

  /**
   * Le pone métrica y log a un drift que nació en `aserciones.ts`.
   *
   * El módulo de aserciones es puro —no cuenta ni loguea— y eso es lo que
   * permite testear los cinco desenlaces sin montar un `Metrics`. La
   * contrapartida es este envoltorio: **el único lugar** por el que un drift del
   * módulo llega al CLI, y por lo tanto el único que puede olvidarse de contarlo.
   */
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
    this.#metrics.increment(aviso.metrica, contarDe(aviso));
    this.#advertir(aviso.detalle, aviso.contexto);
  }
}

/**
 * Cuántas filas cubre un aviso.
 *
 * Los contadores de `filas_identicas` y `duplicados` se incrementan por fila y no
 * por aviso: «3 duplicados en una página» y «3 páginas con un duplicado» son
 * cosas distintas y el número tiene que reflejar la primera. El mensaje ya trae
 * la cantidad al principio, así que se lee de ahí en vez de duplicar el dato en
 * el tipo.
 */
function contarDe(aviso: Aviso): number {
  const n = Number(/^(\d+)/.exec(aviso.detalle)?.[1]);
  return Number.isInteger(n) && n > 0 ? n : 1;
}
