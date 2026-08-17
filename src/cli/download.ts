/**
 * `npm run download` — recorre la fuente y baja los documentos de cada fila.
 *
 * **Recorre y baja intercalado, y no puede ser de otra manera.** §5.4 lo verificó
 * con un experimento controlado —misma sesión, misma fila, mismo conjunto de
 * campos, variando solo el origen del token—: con el `ViewState` de la página 2
 * el servidor devuelve `200 text/html` con la página re-renderizada, y con el de
 * la página 1, el PDF. El `dt:0:…` del comando referencia la fila por su índice
 * dentro del árbol de componentes, y ese índice solo significa lo correcto en el
 * estado que corresponde. Eso descarta el pipeline «recolectar todo el metadata
 * primero, descargar después»: para pedir el documento de una fila hay que estar
 * parado en su página.
 *
 * De ahí sale todo lo demás. El engine baja mientras recorre, el checkpoint se
 * escribe por página (que es la unidad en la que el recorrido es reanudable), y
 * `retry-failed` vuelve a navegar hasta la página de cada registro pendiente en
 * vez de reproducir un request guardado.
 *
 * **El producto es el manifiesto, no el JSONL de registros.** `data/oefa.jsonl`
 * lo escribe `scrape`; acá se escribe `data/oefa.descargas.jsonl`, que mapea
 * `id → archivo` y se une al otro por `id`. Un comando, un producto: fusionarlos
 * obligaría a mantener dos historias de idempotencia distintas en el mismo bucle,
 * y la del dataset ya está resuelta.
 *
 * `descargar()` se exporta aparte de `main()` a propósito: recibe todo inyectado
 * —fuente, emisor, cola de fallos, manifiesto— y por eso los tests lo ejercitan
 * entero contra el portal falso, incluido el caso del token desalineado. `main()`
 * es el composition root, igual que en `scrape.ts`.
 *
 * Uso:   npm run download -- --hasta 3
 */

import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Readable } from 'node:stream';

import type { AxiosResponse } from 'axios';

import { loadConfig } from '../config.ts';
import { CircuitBreaker } from '../http/circuit-breaker.ts';
import { AccessDeniedError, CircuitOpenError, TransportError } from '../http/errors.ts';
import { RateLimiter } from '../http/rate-limiter.ts';
import { createSession } from '../http/session.ts';
import type { JsfRequest } from '../jsf/commands.ts';
import { JsfView } from '../jsf/view.ts';
import { cerrarLogs, createLogger, vaciarLogs, type Logger } from '../obs/logger.ts';
import { Metrics, lineasDeSalud } from '../obs/metrics.ts';
import { RangoInvalidoError, SourceError, StructuralDriftError } from '../sources/errors.ts';
import type { RegistroOefa } from '../sources/oefa-rows.ts';
import type { RegistroPj } from '../sources/pj-rows.ts';
import {
  FUENTES,
  checkpointPorDefecto,
  colaPorDefecto,
  descriptorDe,
  documentosPorDefecto,
  manifiestoPorDefecto,
} from '../sources/registry.ts';
import type { Fuente, Pagina, RegistroBase } from '../sources/types.ts';
import {
  borrarCheckpoint,
  escribirCheckpoint,
  leerCheckpoint,
  planificarReanudacion,
  type Checkpoint,
} from '../store/checkpoint.ts';
import { abrirDlq, colaEnMemoria, type ColaFallos } from '../store/dlq.ts';
import {
  ArchivoInvalidoError,
  existeArchivo,
  guardarStream,
  resumenDe,
  sanitizar,
  type ResumenArchivo,
} from '../store/files.ts';
import { JsonlCorruptoError, openJsonlWriter, readJsonl } from '../store/jsonl.ts';

/** Los cinco primeros bytes de todo PDF. La validación que evita acumular
 *  archivos `.pdf` que son páginas web (§5.4, `fixtures/oefa/04-download-a.html`). */
export const PDF_MAGIC = '%PDF-';

/** Un PDF de 200 bytes no existe; una página de error, sí. */
export const TAMANO_MINIMO = 1024;

/**
 * Cuántas respuestas inválidas seguidas se toleran antes de detener la corrida.
 *
 * Una sola es un fallo del documento y va a la cola. Varias seguidas son otra
 * cosa: la vista se cayó —y una sesión caída **no lanza**, devuelve la página de
 * inicio con `200`— o cambió la forma del POST de descarga. Sin este corte, la
 * corrida sigue mil setecientas filas produciendo cero PDFs y una cola gigante,
 * que es exactamente el modo de falla que §6.4 existe para prevenir.
 */
export const MAX_INVALIDAS_SEGUIDAS = 3;

const FUENTE_POR_DEFECTO = 'oefa';
/** Uno por comando: `scrape` y `download` avanzan a ritmos distintos sobre la
 *  misma fuente, y compartirlo haría que el atrasado se saltee páginas. */
const TAREA = 'download';

/** `0` ok · `1` la corrida falló · `2` uso incorrecto · `3` completó con fallos
 *  en la cola · `130` interrumpida. El `3` existe para que un script distinga
 *  «terminó» de «terminó entero». */
export const SALIDA = { ok: 0, fallo: 1, uso: 2, conFallos: 3, interrumpida: 130 } as const;

// ---------------------------------------------------------------------------
// El engine
// ---------------------------------------------------------------------------

/** Lo mínimo que el engine necesita de un registro. El resto lo aporta `nombre`. */
export interface RegistroDescargable extends RegistroBase {
  readonly documentoUuid?: string;
}

/** Una línea del manifiesto: el mapeo autoritativo `id → archivo` de §5.4. */
export interface EntradaManifiesto {
  readonly id: string;
  readonly fuente: string;
  readonly documentoUuid: string;
  readonly pagina: number;
  readonly indice: number;
  /** Relativo al directorio de destino: mover la carpeta no invalida el manifiesto. */
  readonly archivo: string;
  readonly bytes: number;
  readonly sha256: string;
  /**
   * El `content-disposition` crudo, cuando vino.
   *
   * Se guarda como dato de trazabilidad y **no** se usa para nombrar: OEFA lo
   * manda con el filename en ISO-8859-1 y sin RFC 5987 (`"RTFA N? 264-2012.pdf"`),
   * así que leerlo como UTF-8 produce mojibake, y además no garantiza unicidad
   * entre resoluciones.
   */
  readonly nombreServidor?: string;
  readonly descargadoEn: string;
}

export interface ArchivoBajado extends ResumenArchivo {
  readonly archivo: string;
}

/**
 * Lo que ya está bajado, compartido entre llamadas.
 *
 * Mutable a propósito: `main()` puede llamar al engine dos veces —cuando el
 * checkpoint queda obsoleto y hay que recorrer de nuevo desde la página 1— y la
 * segunda vuelta tiene que saber lo que bajó la primera.
 */
export interface EstadoDescargas {
  /** Identificador del documento → archivo. La clave es el **documento**, no el
   *  registro: dos registros pueden compartirlo (§5.8) y se baja una sola vez. */
  readonly documentos: Map<string, ArchivoBajado>;
  /** `id` de los registros que ya tienen línea en el manifiesto. */
  readonly registros: Set<string>;
}

export const estadoVacio = (): EstadoDescargas => ({ documentos: new Map(), registros: new Set() });

/** El puerto de red del engine: emitir un POST no-ajax y devolver el cuerpo en streaming. */
export interface EmisorDescargas {
  streamCommand(req: JsfRequest): Promise<AxiosResponse<Readable>>;
}

export interface DescargaDeps<R extends RegistroDescargable> {
  readonly fuente: Fuente<R>;
  readonly emisor: EmisorDescargas;
  readonly dlq: ColaFallos;
  readonly logger: Logger;
  readonly metrics: Metrics;
  /** Escribe la línea del manifiesto. Ausente en `--dry-run`. */
  readonly anotar?: (entrada: EntradaManifiesto) => void;
  /** Solo se llama con la página **entera** procesada: es la barrera del checkpoint. */
  readonly alCompletarPagina?: (pagina: Pagina<R>, resumen: ResumenDescarga) => void;
}

export interface OpcionesDescarga<R extends RegistroDescargable> {
  /** Directorio donde viven los archivos. */
  readonly destino: string;
  /** Cómo se llama el archivo de un documento. Lo decide el llamador porque
   *  depende de qué campos tiene el registro. */
  readonly nombreDeArchivo: (registro: R, documentoUuid: string) => string;
  readonly desde?: number;
  readonly hasta?: number;
  /** Válvula de seguridad: los PDFs de OEFA pesan ~9 MB. */
  readonly maxDescargas?: number;
  readonly tamanoMinimo?: number;
  readonly maxInvalidasSeguidas?: number;
  /** Solo estos registros. Es lo que convierte al engine en el motor de `retry-failed`. */
  readonly filtro?: (registro: R) => boolean;
  readonly estado?: EstadoDescargas;
  /** Intentos que estos registros ya acumulaban. Sin esto la cola nunca envejece. */
  readonly intentosPrevios?: ReadonlyMap<string, number>;
  /**
   * El total que el checkpoint decía.
   *
   * Se compara contra el que declara la primera página: si no coincide, el
   * organismo publicó algo nuevo, los índices se corrieron y retomar en la página
   * N leería filas que no son las que faltaban. El engine corta y lo informa;
   * decidir qué hacer es del llamador.
   */
  readonly totalEsperado?: number;
  readonly dryRun?: boolean;
  /** Ctrl-C. Se consulta por fila y no por página: un PDF puede tardar. */
  readonly debeParar?: () => boolean;
}

export interface ResumenDescarga {
  paginas: number;
  ultimaPagina: number;
  /** Filas consideradas, ya pasado el filtro. */
  registros: number;
  descargados: number;
  /** Ya estaban: en el manifiesto o en disco. */
  omitidos: number;
  /** Otro registro de esta corrida ya había bajado el mismo documento (§5.8). */
  compartidos: number;
  /** Filas que el sitio publica sin enlace de descarga. Dato, no fallo. */
  sinDocumento: number;
  fallidos: number;
  /** Lo que se habría bajado, en `--dry-run`. */
  pendientes: number;
  bytes: number;
  total: number;
  limiteAlcanzado: boolean;
  interrumpido: boolean;
  totalCambio: boolean;
  /** Registros que terminaron con documento en disco. Lo consume `retry-failed`. */
  readonly resueltos: Set<string>;
}

const resumenVacio = (): ResumenDescarga => ({
  paginas: 0,
  ultimaPagina: 0,
  registros: 0,
  descargados: 0,
  omitidos: 0,
  compartidos: 0,
  sinDocumento: 0,
  fallidos: 0,
  pendientes: 0,
  bytes: 0,
  total: 0,
  limiteAlcanzado: false,
  interrumpido: false,
  totalCambio: false,
  resueltos: new Set<string>(),
});

/**
 * Recorre el rango pedido y baja lo que falte.
 *
 * Qué detiene la corrida y qué solo se anota, que es donde §5.6 se vuelve código:
 *
 * | Condición | Qué pasa |
 * |---|---|
 * | `403` | **Aborta.** Posible ban de IP; insistir es la vía corta al bloqueo. |
 * | Circuito abierto tras agotar reintentos | **Aborta.** Degradación sostenida. |
 * | `429`, `5xx`, red, tras agotar reintentos | Cola de fallos; la corrida sigue |
 * | Cuerpo que no es el documento | Cola de fallos **y** contador de inválidas |
 * | N inválidas seguidas | **Aborta** con drift `descarga-no-pdf` |
 * | Fila sin documento | Se cuenta y se sigue: es un dato del sitio (§5.8) |
 * | Fallo de disco | **Aborta.** No se arregla reintentando ese documento. |
 *
 * Lo que **no** hace: recuperar la vista caída y re-navegar hasta la página de
 * cada fila. Es deliberado y está declarado —para eso está `retry-failed`—;
 * hacerlo a medias sería peor, porque tras un `recover()` el bean de resultados
 * queda vacío y repaginar sin volver a buscar devuelve la tabla vacía con `200`.
 */
export async function descargar<R extends RegistroDescargable>(
  deps: DescargaDeps<R>,
  opts: OpcionesDescarga<R>,
): Promise<ResumenDescarga> {
  const minimo = opts.tamanoMinimo ?? TAMANO_MINIMO;
  const maxInvalidas = opts.maxInvalidasSeguidas ?? MAX_INVALIDAS_SEGUIDAS;
  const estado = opts.estado ?? estadoVacio();
  const resumen = resumenVacio();
  const bajadosAhora = new Set<string>();

  let invalidasSeguidas = 0;
  let cortar = false;

  const rango = {
    ...(opts.desde === undefined ? {} : { desde: opts.desde }),
    ...(opts.hasta === undefined ? {} : { hasta: opts.hasta }),
  };

  for await (const pagina of deps.fuente.recorrer(rango)) {
    resumen.total = pagina.total;

    // El checkpoint se termina de validar acá y no antes: el total lo declara la
    // búsqueda, y el `desde` hay que decidirlo antes de emitirla.
    if (resumen.paginas === 0 && opts.totalEsperado !== undefined && pagina.total !== opts.totalEsperado) {
      resumen.totalCambio = true;
      deps.logger.warn(
        { antes: opts.totalEsperado, ahora: pagina.total },
        'el total cambió desde el checkpoint: los índices se corrieron y el punto de reanudación no sirve',
      );
      break;
    }

    let completa = true;

    for (const fila of pagina.filas) {
      if (opts.debeParar?.() === true) {
        resumen.interrumpido = true;
        completa = false;
        break;
      }
      if (opts.maxDescargas !== undefined && resumen.descargados >= opts.maxDescargas) {
        resumen.limiteAlcanzado = true;
        completa = false;
        break;
      }

      const registro = fila.registro;
      if (opts.filtro !== undefined && !opts.filtro(registro)) continue;
      resumen.registros += 1;

      // Sin enlace de descarga: registro legítimo, resolución publicada como
      // «Información confidencial» (§5.8). Se cuenta y se sigue; tratarlo como
      // fallo llenaría la cola de 131 entradas que nunca van a poder reintentarse.
      const documentoUuid = registro.documentoUuid;
      if (fila.descarga === undefined || documentoUuid === undefined) {
        resumen.sinDocumento += 1;
        deps.metrics.increment('descargas.sin_documento');
        continue;
      }

      // Que el registro ya esté en el manifiesto **no alcanza** para saltearlo:
      // el archivo puede haberse borrado. §5.7 pide omitir los documentos «ya
      // presentes y validados en disco», y un `stat` por registro es barato al
      // lado de dar por bajado algo que no está — que es como se llega a un
      // manifiesto completo apuntando a una carpeta vacía.
      const yaAnotado = estado.registros.has(registro.id);
      const nombre = opts.nombreDeArchivo(registro, documentoUuid);
      let bajado = estado.documentos.get(documentoUuid);

      // El manifiesto puede mentir: alguien borró el archivo. Se comprueba el
      // disco antes de anotar una línea que apunta a nada.
      if (bajado !== undefined && !existeArchivo(join(opts.destino, bajado.archivo), minimo)) {
        bajado = undefined;
      }
      // Y al revés: el archivo puede estar sin que el manifiesto lo sepa —se
      // borró el manifiesto, o la corrida murió entre el rename y la línea—.
      // Releerlo cuesta caro; bajarlo de nuevo, veinte veces más.
      if (bajado === undefined && existeArchivo(join(opts.destino, nombre), minimo)) {
        const previo = await resumenDe(join(opts.destino, nombre));
        if (previo !== undefined) bajado = { archivo: nombre, ...previo };
      }

      if (bajado !== undefined) {
        if (bajadosAhora.has(documentoUuid)) {
          // Una misma resolución alcanzando a dos unidades fiscalizables: dos
          // registros, un PDF (§5.8). Dos líneas de manifiesto, una descarga.
          resumen.compartidos += 1;
          deps.metrics.increment('descargas.compartidas');
        } else {
          resumen.omitidos += 1;
          deps.metrics.increment('descargas.omitidas');
        }
        estado.documentos.set(documentoUuid, bajado);
        if (yaAnotado) resumen.resueltos.add(registro.id);
        else anotar(deps, estado, resumen, registro, pagina, documentoUuid, bajado, undefined);
        continue;
      }

      if (opts.dryRun === true) {
        resumen.pendientes += 1;
        continue;
      }

      const destino = join(opts.destino, nombre);
      try {
        const res = await deps.emisor.streamCommand(deps.fuente.prepararDescarga(pagina, fila));
        const guardado = await guardarStream(res.data, destino, { magic: PDF_MAGIC, tamanoMinimo: minimo });

        invalidasSeguidas = 0;
        bajado = { archivo: nombre, ...guardado };
        estado.documentos.set(documentoUuid, bajado);
        bajadosAhora.add(documentoUuid);
        resumen.descargados += 1;
        resumen.bytes += guardado.bytes;
        deps.metrics.increment('descargas.ok');
        deps.metrics.increment('descargas.bytes', guardado.bytes);
        anotar(deps, estado, resumen, registro, pagina, documentoUuid, bajado, cabecera(res, 'content-disposition'));
      } catch (error) {
        // Un 403 o un circuito abierto no son un problema de este documento: son
        // el servidor diciendo que paremos.
        if (error instanceof AccessDeniedError || error instanceof CircuitOpenError) throw error;

        const codigo = codigoDe(error);
        if (codigo === undefined) throw error;

        resumen.fallidos += 1;
        deps.metrics.increment('descargas.fallidas');
        deps.metrics.increment(`descargas.error.${codigo}`);
        deps.dlq.registrar({
          id: registro.id,
          tipo: 'pdf',
          error: codigo,
          intentos: (opts.intentosPrevios?.get(registro.id) ?? 0) + intentosDe(error),
          ultimoTs: new Date().toISOString(),
          detalle: error instanceof Error ? error.message : String(error),
          contexto: { pagina: pagina.numero, indice: registro.indice, documentoUuid },
        });
        deps.logger.warn(
          { id: registro.id, pagina: pagina.numero, indice: registro.indice, error: codigo },
          'documento a la cola de fallos',
        );

        // El contador solo se reinicia con un éxito: si el sitio alterna una
        // inválida con un 500, la vista sigue caída igual y el corte tiene que
        // llegar de todos modos.
        if (error instanceof ArchivoInvalidoError) {
          invalidasSeguidas += 1;
          deps.metrics.increment('descargas.invalidas');
          if (invalidasSeguidas >= maxInvalidas) {
            throw new StructuralDriftError(
              deps.fuente.nombre,
              'descarga-no-pdf',
              `${invalidasSeguidas} descargas seguidas devolvieron algo que no es el documento: ` +
                'la vista se cayó o cambió la forma del POST de descarga',
              { pagina: pagina.numero, indice: registro.indice, seguidas: invalidasSeguidas },
            );
          }
        }
      }
    }

    // Solo cuenta como completada si se procesó entera: un checkpoint escrito a
    // mitad de página se saltea las filas que faltaban, y nadie se entera.
    if (completa) {
      resumen.paginas += 1;
      resumen.ultimaPagina = pagina.numero;
      deps.metrics.increment('descargas.paginas');
      deps.alCompletarPagina?.(pagina, resumen);
    } else {
      cortar = true;
    }

    if (cortar) break;
  }

  return resumen;
}

function anotar<R extends RegistroDescargable>(
  deps: DescargaDeps<R>,
  estado: EstadoDescargas,
  resumen: ResumenDescarga,
  registro: R,
  pagina: Pagina<R>,
  documentoUuid: string,
  bajado: ArchivoBajado,
  nombreServidor: string | undefined,
): void {
  deps.anotar?.({
    id: registro.id,
    fuente: registro.fuente,
    documentoUuid,
    pagina: pagina.numero,
    indice: registro.indice,
    archivo: bajado.archivo,
    bytes: bajado.bytes,
    sha256: bajado.sha256,
    ...(nombreServidor === undefined ? {} : { nombreServidor }),
    descargadoEn: new Date().toISOString(),
  });
  estado.registros.add(registro.id);
  resumen.resueltos.add(registro.id);
}

/**
 * El discriminante que va a la cola, no el mensaje.
 *
 * `undefined` significa «esto no es un fallo del documento»: un
 * `PaginaDesalineadaError` o un `SinDocumentoError` son bugs de quien llama, y un
 * `EACCES` es del disco. Los tres salen derecho en vez de acumular mil setecientas
 * entradas idénticas en una cola que nadie va a poder consumir.
 */
function codigoDe(error: unknown): string | undefined {
  if (error instanceof ArchivoInvalidoError) return `documento-${error.motivo}`;
  if (error instanceof TransportError) return error.kind;
  return undefined;
}

const intentosDe = (error: unknown): number => (error instanceof TransportError ? error.attempts : 1);

function cabecera(res: AxiosResponse<unknown>, nombre: string): string | undefined {
  const valor: unknown = res.headers[nombre];
  return typeof valor === 'string' ? valor : undefined;
}

// ---------------------------------------------------------------------------
// El comando
// ---------------------------------------------------------------------------

/**
 * `${documentoUuid}_${slug}.pdf`.
 *
 * El identificador del documento va primero porque es lo que identifica al
 * **archivo**: dos registros pueden compartirlo, y el nombre tiene que ser el
 * mismo para que el segundo no lo baje de nuevo. El slug es para poder mirar la
 * carpeta y entender qué hay; el mapeo autoritativo vive en el manifiesto y no se
 * infiere del nombre.
 */
export const nombreDeArchivoOefa = (registro: RegistroOefa, documentoUuid: string): string => {
  const slug = sanitizar(registro.resolucion === '' ? registro.expediente : registro.resolucion, 80);
  return slug === '' ? `${documentoUuid}.pdf` : `${documentoUuid}_${slug}.pdf`;
};

/**
 * Lo mismo para el portal del Poder Judicial, donde el slug sale del texto de la
 * fila y no de un campo con nombre.
 *
 * No es una versión pobre de la de OEFA: es la que corresponde a un registro cuyo
 * esquema no se pudo reversar (`pj-rows.ts`). Inventar un campo `resolucion` para
 * que el nombre quedara más lindo produciría archivos rotulados con un dato que
 * nadie verificó. El mapeo autoritativo vive en el manifiesto, igual que siempre.
 */
export const nombreDeArchivoPj = (registro: RegistroPj, documentoUuid: string): string => {
  const slug = sanitizar(registro.texto, 80);
  return slug === '' ? `${documentoUuid}.pdf` : `${documentoUuid}_${slug}.pdf`;
};

/**
 * Qué política de nombres le toca a cada fuente.
 *
 * Vive en el CLI y no en el descriptor de la fuente porque el nombre de archivo
 * es una decisión de **persistencia**, no de protocolo: `sources/` no sabe que
 * existe un disco, y meterle esto sería la primera grieta de esa separación. El
 * composition root es el lugar donde las dos capas se encuentran.
 */
const NOMBRE_DE_ARCHIVO: Record<string, (registro: RegistroDescargable, documentoUuid: string) => string> = {
  oefa: (registro, uuid) => nombreDeArchivoOefa(registro as RegistroOefa, uuid),
  pj: (registro, uuid) => nombreDeArchivoPj(registro as RegistroPj, uuid),
};

/**
 * La política de nombres de una fuente, o `undefined` si no tiene.
 *
 * Se exporta para que `retry-failed` use **la misma**: si los dos comandos
 * nombraran distinto, un reintento escribiría un archivo nuevo al lado del que
 * ya estaba y el manifiesto quedaría describiendo el viejo.
 */
export const nombreDeArchivoDe = (
  fuente: string,
): ((registro: RegistroDescargable, documentoUuid: string) => string) | undefined =>
  NOMBRE_DE_ARCHIVO[fuente];

/**
 * Reconstruye qué hay bajado a partir del manifiesto.
 *
 * Tolerante con una línea ilegible: se reporta y se sigue con lo leído. El costo
 * de equivocarse acá es bajar de nuevo algo que ya estaba —no perder datos—, y el
 * writer repara la cola truncada al abrir.
 */
export async function leerManifiesto(
  ruta: string,
  onLineaInvalida?: (detalle: string) => void,
): Promise<EstadoDescargas> {
  const estado = estadoVacio();

  try {
    for await (const { valor } of readJsonl<Partial<EntradaManifiesto>>(ruta)) {
      const { id, documentoUuid, archivo, bytes, sha256 } = valor;
      if (typeof id !== 'string' || typeof archivo !== 'string' || typeof documentoUuid !== 'string') continue;
      estado.registros.add(id);
      estado.documentos.set(documentoUuid, {
        archivo,
        bytes: typeof bytes === 'number' ? bytes : 0,
        sha256: typeof sha256 === 'string' ? sha256 : '',
      });
    }
  } catch (error) {
    if (!(error instanceof JsonlCorruptoError)) throw error;
    onLineaInvalida?.(error.message);
  }

  return estado;
}

export interface OpcionesCli {
  readonly fuente: string;
  readonly desde?: number;
  readonly hasta?: number;
  readonly destino: string;
  readonly manifiesto: string;
  readonly dlq: string;
  readonly checkpoint: string;
  readonly maxDescargas?: number;
  readonly reiniciar: boolean;
  readonly dryRun: boolean;
  readonly ayuda: boolean;
}

const AYUDA = `
Uso: npm run download -- [opciones]

  --fuente <nombre>    ${FUENTES.join(' | ')}. Por defecto ${FUENTE_POR_DEFECTO}.
  --desde <n>          Primera página (1-based). Por defecto, la del checkpoint.
  --hasta <n>          Última página inclusive. Por defecto, la última.
  --destino <dir>      Directorio de los archivos. Por defecto data/<fuente>/.
  --manifiesto <ruta>  JSONL con el mapeo id → archivo. Por defecto data/<fuente>.descargas.jsonl.
  --dlq <ruta>         Cola de fallos. Por defecto data/<fuente>.failed.jsonl.
  --checkpoint <ruta>  Estado de reanudación. Por defecto data/<fuente>.download.checkpoint.json.
  --max-descargas <n>  Corta después de n descargas. Los PDFs pesan ~9 MB.
  --reiniciar          Ignora el checkpoint y recorre desde el principio.
  --dry-run            Recorre y reporta qué bajaría, sin bajar ni escribir.
  --help               Esto.

La corrida es reanudable e idempotente: los documentos ya presentes no se vuelven
a pedir, y repetir el comando completa lo que falte. Lo que falle queda en la cola
y se reintenta con «npm run retry-failed».
`.trimStart();

export function parsearArgs(argv: readonly string[]): OpcionesCli {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        fuente: { type: 'string' },
        desde: { type: 'string' },
        hasta: { type: 'string' },
        destino: { type: 'string' },
        manifiesto: { type: 'string' },
        dlq: { type: 'string' },
        checkpoint: { type: 'string' },
        'max-descargas': { type: 'string' },
        reiniciar: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    throw new Error(`Argumentos inválidos: ${error instanceof Error ? error.message : String(error)}`);
  }

  const { values } = parsed;
  const desde = enteroPositivo(values.desde, 'desde');
  const hasta = enteroPositivo(values.hasta, 'hasta');
  const maxDescargas = enteroPositivo(values['max-descargas'], 'max-descargas');

  if (desde !== undefined && hasta !== undefined && hasta < desde) {
    throw new Error(`Argumentos inválidos: --hasta (${hasta}) es menor que --desde (${desde})`);
  }

  const fuente = values.fuente ?? FUENTE_POR_DEFECTO;

  return {
    fuente,
    ...(desde === undefined ? {} : { desde }),
    ...(hasta === undefined ? {} : { hasta }),
    ...(maxDescargas === undefined ? {} : { maxDescargas }),
    destino: values.destino ?? documentosPorDefecto(fuente),
    manifiesto: values.manifiesto ?? manifiestoPorDefecto(fuente),
    dlq: values.dlq ?? colaPorDefecto(fuente),
    checkpoint: values.checkpoint ?? checkpointPorDefecto(fuente, TAREA),
    reiniciar: values.reiniciar === true,
    dryRun: values['dry-run'] === true,
    ayuda: values.help === true,
  };
}

function enteroPositivo(valor: string | undefined, nombre: string): number | undefined {
  if (valor === undefined) return undefined;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Argumentos inválidos: --${nombre} debe ser un entero ≥ 1, llegó «${valor}»`);
  }
  return n;
}

const paso = (s: string): void => console.log(`\n\x1b[1m${s}\x1b[0m`);
const ok = (s: string): void => console.log(`  ✓ ${s}`);

export async function main(argv: readonly string[]): Promise<number> {
  let opciones: OpcionesCli;
  let config: ReturnType<typeof loadConfig>;
  let descriptor: ReturnType<typeof descriptorDe>;
  try {
    opciones = parsearArgs(argv);
    if (opciones.ayuda) {
      console.log(AYUDA);
      return SALIDA.ok;
    }
    descriptor = descriptorDe(opciones.fuente);
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return SALIDA.uso;
  }

  const metrics = new Metrics();
  const logger = createLogger({ level: config.LOG_LEVEL, pretty: config.LOG_PRETTY });

  const session = createSession(
    {
      limiter: new RateLimiter({
        rps: config.HTTP_RPS,
        minRps: config.HTTP_MIN_RPS,
        maxRps: config.HTTP_MAX_RPS,
        burst: config.HTTP_BURST,
      }),
      breaker: new CircuitBreaker(),
      metrics,
      logger,
    },
    {
      timeoutMs: config.HTTP_TIMEOUT_MS,
      userAgent: config.HTTP_USER_AGENT,
      ...(config.PROXY_URL === undefined ? {} : { proxyUrl: config.PROXY_URL }),
    },
  );

  const view = new JsfView({ session, logger, metrics }, { pageUrl: descriptor.urlBase });
  const fuente = descriptor.crear(
    { view, logger, metrics },
    descriptor.pageSize === undefined ? {} : { pageSize: descriptor.pageSize },
  );

  paso(`Fuente: ${descriptor.nombre} — ${descriptor.urlBase}`);
  console.log(`  evidencia: ${descriptor.evidencia}`);

  if (opciones.reiniciar && !opciones.dryRun) borrarCheckpoint(opciones.checkpoint);
  let checkpoint: Checkpoint | undefined;
  try {
    checkpoint = opciones.reiniciar ? undefined : leerCheckpoint(opciones.checkpoint);
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'checkpoint ilegible: se ignora');
  }

  const plan = planificarReanudacion(checkpoint, {
    fuente: fuente.nombre,
    tarea: TAREA,
    pageSize: descriptor.pageSize ?? 0,
    ...(opciones.desde === undefined ? {} : { desde: opciones.desde }),
    ...(opciones.hasta === undefined ? {} : { hasta: opciones.hasta }),
  });
  if (plan.nadaPendiente !== undefined) {
    paso('Nada pendiente');
    ok(plan.nadaPendiente);
    console.log('  usar --reiniciar para recorrer de nuevo, o --desde <n> para una página puntual');
    return SALIDA.ok;
  }

  const estado = await leerManifiesto(opciones.manifiesto, (detalle) =>
    logger.warn({ detalle }, 'línea ilegible en el manifiesto: se sigue con lo leído'),
  );
  const writer = opciones.dryRun ? undefined : openJsonlWriter(opciones.manifiesto);
  const dlq = opciones.dryRun ? colaEnMemoria() : abrirDlq(opciones.dlq);

  paso(`Descargando de ${fuente.nombre}${opciones.dryRun ? ' (dry-run: no se baja ni se escribe nada)' : ''}`);
  if (estado.registros.size > 0) ok(`${estado.registros.size} registro(s) ya en el manifiesto: se omiten`);
  if (plan.mensaje !== undefined) ok(plan.mensaje);

  let interrumpido = false;
  const alInterrumpir = (): void => {
    if (interrumpido) process.exit(SALIDA.interrumpida);
    interrumpido = true;
    console.error('\n  interrupción recibida: cerrando al terminar el documento (Ctrl-C otra vez para cortar ya)');
  };
  process.on('SIGINT', alInterrumpir);

  const nombreDeArchivo = NOMBRE_DE_ARCHIVO[descriptor.nombre];
  if (nombreDeArchivo === undefined) {
    // Una fuente en el registro sin política de nombres es un bug nuestro, no un
    // error del usuario. Se dice así en vez de caer a la de OEFA: archivos
    // rotulados con el criterio de otro portal son indistinguibles de los buenos.
    console.error(`\n✗ la fuente «${descriptor.nombre}» no tiene política de nombres de archivo`);
    return SALIDA.fallo;
  }

  const opcionesEngine = {
    destino: opciones.destino,
    nombreDeArchivo,
    estado,
    ...(opciones.hasta === undefined ? {} : { hasta: opciones.hasta }),
    ...(opciones.maxDescargas === undefined ? {} : { maxDescargas: opciones.maxDescargas }),
    dryRun: opciones.dryRun,
    debeParar: () => interrumpido,
  };

  const deps: DescargaDeps<RegistroDescargable> = {
    fuente,
    emisor: view,
    dlq,
    logger,
    metrics,
    ...(writer === undefined ? {} : { anotar: (entrada: EntradaManifiesto) => writer.append(entrada) }),
    alCompletarPagina: (pagina, resumen) => {
      writer?.flush();
      if (opciones.dryRun) return;
      escribirCheckpoint(opciones.checkpoint, {
        fuente: fuente.nombre,
        tarea: TAREA,
        pageSize: descriptor.pageSize ?? 0,
        total: pagina.total,
        ultimaPagina: pagina.numero,
        registros: resumen.registros,
        actualizadoEn: new Date().toISOString(),
      });
    },
  };

  let resumen: ResumenDescarga;
  try {
    resumen = await descargar(deps, {
      ...opcionesEngine,
      ...(plan.desde === undefined ? {} : { desde: plan.desde }),
      ...(plan.totalEsperado === undefined ? {} : { totalEsperado: plan.totalEsperado }),
    });

    // El checkpoint quedó obsoleto: el sitio publicó algo y los índices se
    // corrieron. Recorrer de nuevo desde la página 1 es barato —lo ya bajado se
    // omite por manifiesto— y es lo único correcto.
    if (resumen.totalCambio) {
      console.error('\n  el total del sitio cambió: se descarta el checkpoint y se recorre desde la página 1');
      if (!opciones.dryRun) borrarCheckpoint(opciones.checkpoint);
      resumen = await descargar(deps, opcionesEngine);
    }
  } catch (error) {
    writer?.close();
    if ('close' in dlq) dlq.close();
    process.off('SIGINT', alInterrumpir);
    // El bloque humano va por `console.error` —sincrónico— y los logs por un
    // worker: sin vaciar primero, el `✗` se adelanta a los WARN que lo explican.
    await vaciarLogs(logger);
    return reportarFallo(error, metrics);
  }

  writer?.close();
  if ('close' in dlq) dlq.close();
  process.off('SIGINT', alInterrumpir);
  await vaciarLogs(logger);

  reportar(resumen, metrics, opciones);

  if (resumen.interrumpido) {
    paso('INTERRUMPIDA — lo bajado está completo y validado; repetir el comando la retoma');
    return SALIDA.interrumpida;
  }
  if (resumen.fallidos > 0) {
    paso(`COMPLETÓ CON ${resumen.fallidos} FALLO(S) — «npm run retry-failed» los reintenta`);
    return SALIDA.conFallos;
  }
  paso('OK');
  return SALIDA.ok;
}

function reportar(resumen: ResumenDescarga, metrics: Metrics, opciones: OpcionesCli): void {
  const s = metrics.snapshot();
  const intentadas = resumen.descargados + resumen.fallidos;

  paso('Resumen');
  if (opciones.dryRun) ok(`${resumen.pendientes} documento(s) por bajar`);
  ok(`${resumen.descargados} documento(s) nuevo(s) · ${(resumen.bytes / 1e6).toFixed(1)} MB`);
  ok(`${resumen.omitidos} ya presente(s) · ${resumen.compartidos} compartido(s) con otro registro`);
  ok(`${resumen.sinDocumento} fila(s) sin documento publicado`);
  ok(`${resumen.fallidos} fallo(s) en la cola`);
  ok(`última página completada: ${resumen.ultimaPagina}`);
  if (resumen.limiteAlcanzado) ok('se alcanzó el límite de --max-descargas');
  if (!opciones.dryRun) ok(`archivos en ${opciones.destino}/ · manifiesto: ${opciones.manifiesto}`);

  const minutos = s.duracionMs / 60_000;
  for (const linea of lineasDeSalud(s)) console.log(linea);
  console.log(
    `  páginas/min=${minutos === 0 ? 0 : (resumen.paginas / minutos).toFixed(1)}  ` +
      `éxito de descarga=${intentadas === 0 ? '—' : `${((resumen.descargados / intentadas) * 100).toFixed(1)}%`}`,
  );
}

function reportarFallo(error: unknown, metrics: Metrics): number {
  if (error instanceof RangoInvalidoError) {
    console.error(`\n✗ ${error.message}`);
    return SALIDA.uso;
  }
  if (error instanceof SourceError) {
    console.error(`\n✗ ${error.name} [${error.kind}]: ${error.message}`);
  } else if (error instanceof AccessDeniedError) {
    console.error(`\n✗ ${error.message}`);
    console.error('  la corrida se detiene: insistir es la vía corta al bloqueo de IP (§5.6)');
  } else {
    console.error(`\n✗ ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  }
  console.error('  lo descargado hasta acá está completo y validado; el manifiesto quedó consistente.');
  // Antes iba solo `contadores`, que ante un fallo temprano es `{}` y no dice
  // nada. Lo que explica la corrida es el resto del snapshot.
  for (const linea of lineasDeSalud(metrics.snapshot())) console.error(linea);
  return SALIDA.fallo;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  // El transport de pino-pretty vive en un worker y `process.exit()` no lo
  // espera: sin `cerrarLogs()` se pierden las últimas líneas, las del fallo.
  const salir = async (codigo: number): Promise<never> => {
    await cerrarLogs();
    process.exit(codigo);
  };
  main(process.argv.slice(2)).then(salir, (error: unknown) => {
    console.error('\n✗ Fallo no controlado:', error);
    return salir(SALIDA.fallo);
  });
}
