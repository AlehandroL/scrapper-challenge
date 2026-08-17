/**
 * `npm run validate` — los sanity checks del §6.3 como comando, no como párrafo
 * del README.
 *
 * Revisa lo que quedó escrito: el dataset, el manifiesto de descargas y, si se
 * pide, los archivos en disco. Es la contraparte post-hoc de la detección de
 * drift del bloque 4: aquélla detiene una corrida que empezó a leer mal, ésta
 * mira el archivo terminado y contesta si el resultado se sostiene.
 *
 * **Todo el I/O vive acá.** `src/validate/` no abre archivos ni emite requests:
 * recibe datos y devuelve hallazgos, igual que `src/sources/` recibe la vista ya
 * construida. Así los chequeos se prueban con arreglos en memoria y el día que
 * el dataset venga de otro lado —una base, un S3— se cambia este archivo y no la
 * capa que decide qué está bien.
 *
 * Por defecto no toca la red. `--contra-el-sitio` es opt-in y cuesta dos
 * requests: es el único modo de contestar «total reportado por el sitio vs.
 * registros capturados» sin depender de un checkpoint que `.gitignore` no
 * versiona.
 *
 * Uso:   npm run validate
 *        npm run validate -- --descargas descargas --hash
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { loadConfig } from '../config.ts';
import { CircuitBreaker } from '../http/circuit-breaker.ts';
import { RateLimiter } from '../http/rate-limiter.ts';
import { createSession } from '../http/session.ts';
import { JsfView } from '../jsf/view.ts';
import { cerrarLogs, createLogger } from '../obs/logger.ts';
import { Metrics } from '../obs/metrics.ts';
import { SourceError } from '../sources/errors.ts';
import {
  FUENTES,
  checkpointPorDefecto,
  colaPorDefecto,
  descriptorDe,
  documentosPorDefecto,
  manifiestoPorDefecto,
  salidaPorDefecto,
} from '../sources/registry.ts';
import type { RegistroBase } from '../sources/types.ts';
import { CheckpointInvalidoError, leerCheckpoint } from '../store/checkpoint.ts';
import { leerDlq } from '../store/dlq.ts';
import { resumenDe, tamanoDe } from '../store/files.ts';
import { JsonlCorruptoError, readJsonl } from '../store/jsonl.ts';
import { revisarDocumentos, type EntradaDocumento, type Sonda } from '../validate/documentos.ts';
import {
  error,
  hayErrores,
  lineasDe,
  numero,
  ok,
  resumen,
  type Hallazgo,
  type Seccion,
} from '../validate/informe.ts';
import { RevisionOefa } from '../validate/oefa.ts';
import { RevisionDataset, type TotalDeclarado } from '../validate/sanity.ts';

const FUENTE_POR_DEFECTO = 'oefa';
const PAGE_SIZE = 10;

/** `0` sin errores · `1` no pudo correr · `2` uso incorrecto · `3` corrió y
 *  encontró errores. El `3` copia el `conFallos` de `download.ts`: un script
 *  necesita distinguir «no pude mirar» de «miré y está mal». */
export const SALIDA = { ok: 0, fallo: 1, uso: 2, conHallazgos: 3 } as const;

export interface OpcionesCli {
  readonly fuente: string;
  readonly dataset: string;
  readonly manifiesto: string;
  readonly dlq: string;
  readonly descargas: string;
  readonly checkpoint: string;
  readonly pageSize: number;
  readonly total?: number;
  /** Re-lee cada archivo y recalcula su sha256. Lento a propósito. */
  readonly hash: boolean;
  /** Dos requests al portal para preguntarle el total y la primera página. */
  readonly contraElSitio: boolean;
  readonly ayuda: boolean;
}

const AYUDA = `
Uso: npm run validate -- [opciones]

  --fuente <nombre>     ${FUENTES.join(' | ')}. Por defecto ${FUENTE_POR_DEFECTO}.
  --dataset <ruta>      JSONL de registros. Por defecto data/<fuente>.jsonl.
  --manifiesto <ruta>   JSONL de descargas. Por defecto data/<fuente>.descargas.jsonl.
  --dlq <ruta>          Cola de fallos. Por defecto data/<fuente>.failed.jsonl.
  --descargas <dir>     Carpeta de los archivos. Por defecto data/<fuente>/.
  --checkpoint <ruta>   De donde sacar el total. Por defecto data/<fuente>.scrape.checkpoint.json.
  --page-size <n>       Tamaño de página del recorrido. Por defecto ${PAGE_SIZE}.
  --total <n>           Total de filas que declara el sitio.
  --hash                Re-lee cada archivo y recalcula su sha256 (lento).
  --contra-el-sitio     Le pregunta el total al portal: 2 requests.
  --help                Esto.

Sin --total ni checkpoint ni --contra-el-sitio, la cobertura queda «no evaluable»:
el archivo por si solo prueba una cota inferior, no el total.
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
        dataset: { type: 'string' },
        manifiesto: { type: 'string' },
        dlq: { type: 'string' },
        descargas: { type: 'string' },
        checkpoint: { type: 'string' },
        'page-size': { type: 'string' },
        total: { type: 'string' },
        hash: { type: 'boolean', default: false },
        'contra-el-sitio': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (e) {
    throw new Error(`Argumentos inválidos: ${e instanceof Error ? e.message : String(e)}`);
  }

  const { values } = parsed;
  const total = enteroPositivo(values.total, 'total');
  const fuente = values.fuente ?? FUENTE_POR_DEFECTO;

  return {
    fuente,
    dataset: values.dataset ?? salidaPorDefecto(fuente),
    manifiesto: values.manifiesto ?? manifiestoPorDefecto(fuente),
    dlq: values.dlq ?? colaPorDefecto(fuente),
    descargas: values.descargas ?? documentosPorDefecto(fuente),
    checkpoint: values.checkpoint ?? checkpointPorDefecto(fuente, 'scrape'),
    pageSize: enteroPositivo(values['page-size'], 'page-size') ?? PAGE_SIZE,
    ...(total === undefined ? {} : { total }),
    hash: values.hash === true,
    contraElSitio: values['contra-el-sitio'] === true,
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

/**
 * El puente entre el esquema de la fuente y el validador inyectado del bloque 6.
 *
 * El esquema vive en `sources/` porque se usa **antes** de escribir el registro;
 * acá se lo reusa para leerlo. Duplicarlo en `validate/` habría dado dos
 * verdades sobre la misma forma, y la que se desactualiza es siempre la que no
 * corre en cada scrape.
 *
 * Con dos fuentes, cuál esquema aplicar lo decide el registro de fuentes y no un
 * import fijo: validar el dataset del Poder Judicial contra el esquema de OEFA
 * reportaría 1.749 registros inválidos y ningún hallazgo real.
 */

/**
 * La parte de la revisión de dominio que **toda** fuente necesita.
 *
 * `revisarDocumentos` pide dos cosas —el índice por identidad y cuántos
 * registros declaran documento— y ninguna es de OEFA. Los chequeos que sí lo son
 * (el año de resolución, las resoluciones confidenciales) viven en
 * `validate/oefa.ts` y no tienen equivalente en el otro portal, porque de su
 * esquema no se reversó ningún campo con semántica.
 *
 * Vive en el CLI y no en `validate/` a propósito: es cableado entre una fuente y
 * un chequeo, que es lo que el composition root hace. Poner un
 * `RevisionGenerica` en `validate/` invitaría a que `RevisionOefa` heredara de
 * ella, y la herencia es la forma más rápida de que un chequeo de un portal se
 * cuele en el informe de otro.
 */
interface RevisionDominio {
  readonly porId: ReadonlyMap<string, { readonly documentoUuid?: string }>;
  readonly conDocumento: number;
  agregar(registro: RegistroBase): void;
  hallazgos(): Hallazgo[];
}

class RevisionBasica implements RevisionDominio {
  readonly #porId = new Map<string, { readonly documentoUuid?: string }>();
  #conDocumento = 0;

  get porId(): ReadonlyMap<string, { readonly documentoUuid?: string }> {
    return this.#porId;
  }

  get conDocumento(): number {
    return this.#conDocumento;
  }

  agregar(registro: RegistroBase): void {
    const con = registro as { readonly documentoUuid?: string };
    this.#porId.set(registro.id, con);
    if (typeof con.documentoUuid === 'string' && con.documentoUuid !== '') this.#conDocumento += 1;
  }

  /**
   * Ninguno, y es deliberado.
   *
   * Un informe que no puede decir nada del contenido tiene que decir eso, no
   * inventar un `✓` sobre campos que nadie reversó. Es la lección de §5.10
   * llevada a su conclusión: «no pudo correr» es un nivel del informe.
   */
  hallazgos(): Hallazgo[] {
    return [];
  }
}

/** Las líneas del manifiesto que tienen la forma que los chequeos necesitan. */
async function leerEntradas(ruta: string): Promise<{ entradas: EntradaDocumento[]; invalidas: number }> {
  const entradas: EntradaDocumento[] = [];
  let invalidas = 0;

  try {
    for await (const { valor } of readJsonl<Record<string, unknown>>(ruta)) {
      const { id, documentoUuid, archivo, bytes, sha256 } = valor;
      if (
        typeof id !== 'string' ||
        typeof documentoUuid !== 'string' ||
        typeof archivo !== 'string' ||
        typeof bytes !== 'number' ||
        typeof sha256 !== 'string'
      ) {
        invalidas += 1;
        continue;
      }
      entradas.push({ id, documentoUuid, archivo, bytes, sha256 });
    }
  } catch (e) {
    if (!(e instanceof JsonlCorruptoError)) throw e;
    invalidas += 1;
  }

  return { entradas, invalidas };
}

/**
 * De donde sale el total, en orden de autoridad: el sitio ahora, lo que el
 * operador afirma, y el checkpoint de la corrida que escribió el archivo.
 */
function totalDeclarado(
  opciones: OpcionesCli,
  vivo: number | undefined,
): { total?: TotalDeclarado; nota?: string } {
  if (vivo !== undefined) return { total: { valor: vivo, origen: 'que el portal declara ahora' } };
  if (opciones.total !== undefined) return { total: { valor: opciones.total, origen: 'pasado con --total' } };

  try {
    const cp = leerCheckpoint(opciones.checkpoint);
    if (cp !== undefined) return { total: { valor: cp.total, origen: `del checkpoint de «${cp.tarea}»` } };
  } catch (e) {
    if (!(e instanceof CheckpointInvalidoError)) throw e;
    return { nota: `checkpoint ilegible: ${e.message}` };
  }

  return {};
}

const paso = (s: string): void => console.log(`\n\x1b[1m${s}\x1b[0m`);

/**
 * La consulta al portal, inyectada.
 *
 * `revisar()` no sabe emitir requests: recibe una función o no recibe nada. Así
 * el mismo recorrido de chequeos corre en la suite sin red —`tests/dataset.test.ts`
 * lo usa sobre los archivos commiteados— y el modo `--contra-el-sitio` no obliga
 * a montar un doble de la sesión HTTP para probar lo que ya está probado aparte.
 */
export type ConsultaSitio = (
  identidades: ReadonlySet<string>,
) => Promise<{ total: number; hallazgos: Hallazgo[] }>;

export interface Revision {
  readonly secciones: Seccion[];
  /** Algo que no es un hallazgo pero conviene decir: un checkpoint ilegible, p.ej. */
  readonly nota?: string;
}

/**
 * Todo el recorrido de chequeos, sin imprimir nada.
 *
 * Se exporta aparte de `main()` por la misma razón que `descargar()` en
 * `download.ts`: es lo que tiene sentido llamar desde un test.
 */
export async function revisar(opciones: OpcionesCli, consultar?: ConsultaSitio): Promise<Revision> {
  // 1. El dataset, en streaming: lo que queda en memoria son identidades y
  //    contadores, no las 1.749 líneas.
  const descriptor = descriptorDe(opciones.fuente);
  const revision = new RevisionDataset(descriptor.validarRegistro, { pageSize: opciones.pageSize });
  const dominio: RevisionDominio =
    descriptor.nombre === 'oefa' ? (new RevisionOefa() as unknown as RevisionDominio) : new RevisionBasica();
  try {
    for await (const { numero: linea, valor } of readJsonl<unknown>(opciones.dataset)) {
      const registro = revision.agregar(linea, valor);
      if (registro !== undefined) dominio.agregar(registro);
    }
  } catch (e) {
    if (!(e instanceof JsonlCorruptoError)) throw e;
    revision.marcarIlegible(e.message);
  }

  // 2. El sitio, solo si se pidió. Después de leer el archivo: si no existiera,
  //    no habría motivo para gastar los requests.
  let sitio: Seccion | undefined;
  let totalVivo: number | undefined;
  if (consultar !== undefined) {
    try {
      const consulta = await consultar(revision.identidades);
      totalVivo = consulta.total;
      sitio = { titulo: `Contra el sitio — ${descriptor.urlBase}`, hallazgos: consulta.hallazgos };
    } catch (e) {
      const detalle = e instanceof SourceError ? `${e.name} [${e.kind}]: ${e.message}` : String(e);
      sitio = {
        titulo: 'Contra el sitio',
        hallazgos: [error('sitio-alcanzable', `no se pudo consultar el portal: ${detalle}`)],
      };
    }
  }

  const { total, nota } = totalDeclarado(opciones, totalVivo);

  // 3. El manifiesto y, si la carpeta está, el disco.
  const { entradas, invalidas } = await leerEntradas(opciones.manifiesto);
  const sonda = crearSonda(opciones);
  let pendientes: number | undefined;
  try {
    pendientes = (await leerDlq(opciones.dlq)).length;
  } catch {
    pendientes = undefined;
  }

  const documentos = await revisarDocumentos(entradas, {
    registros: dominio.porId,
    conDocumento: dominio.conDocumento,
    ...(sonda === undefined ? {} : { sonda }),
    ...(pendientes === undefined ? {} : { pendientes }),
    invalidas,
  });

  return {
    secciones: [
      {
        titulo: `Dataset — ${opciones.dataset}`,
        hallazgos: [...revision.hallazgos(total), ...dominio.hallazgos()],
      },
      { titulo: `Documentos — ${opciones.manifiesto}`, hallazgos: documentos },
      ...(sitio === undefined ? [] : [sitio]),
    ],
    ...(nota === undefined ? {} : { nota }),
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  let opciones: OpcionesCli;
  try {
    opciones = parsearArgs(argv);
    if (opciones.ayuda) {
      console.log(AYUDA);
      return SALIDA.ok;
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return SALIDA.uso;
  }

  if (!existsSync(opciones.dataset)) {
    // El comando que se sugiere lleva la fuente: con dos portales, un
    // «npm run scrape» pelado recorrería OEFA y dejaría el archivo del otro
    // igual de ausente.
    const sufijo = opciones.fuente === 'oefa' ? '' : ` -- --fuente ${opciones.fuente}`;
    console.error(`\n✗ No existe ${opciones.dataset}. Correr «npm run scrape${sufijo}» primero.`);
    return SALIDA.fallo;
  }

  const { secciones, nota } = await revisar(
    opciones,
    opciones.contraElSitio
      ? (identidades) => preguntarleAlSitio(descriptorDe(opciones.fuente), identidades)
      : undefined,
  );

  for (const seccion of secciones) {
    paso(seccion.titulo);
    for (const linea of lineasDe(seccion.hallazgos)) console.log(linea);
  }
  if (nota !== undefined) console.log(`\n  nota: ${nota}`);

  paso('Resumen');
  console.log(`  ${resumen(secciones)}`);

  if (hayErrores(secciones)) {
    paso('CON HALLAZGOS');
    return SALIDA.conHallazgos;
  }
  paso('OK');
  return SALIDA.ok;
}

/**
 * La sonda de disco: `stat` por defecto, re-lectura completa con `--hash`.
 *
 * Devuelve `undefined` cuando la carpeta no existe, y eso importa: los chequeos
 * de integridad se reportan entonces como no evaluables. Un informe que dice
 * «los 30 archivos están bien» sin haber mirado uno solo es peor que no tener
 * informe (§5.9).
 */
function crearSonda(opciones: OpcionesCli): Sonda | undefined {
  if (!existsSync(opciones.descargas)) return undefined;

  return async (archivo: string) => {
    const ruta = join(opciones.descargas, archivo);
    if (opciones.hash) return resumenDe(ruta);
    const bytes = tamanoDe(ruta);
    return bytes === undefined ? undefined : { bytes };
  };
}

/**
 * Dos requests: bootstrap y búsqueda. Trae el total vigente y la primera página.
 *
 * Que las diez filas que el portal muestra hoy estén todas en el archivo es una
 * afirmación más fuerte que el total: cubre el caso en que el organismo publicó
 * algo nuevo y todos los índices se corrieron.
 */
async function preguntarleAlSitio(
  descriptor: ReturnType<typeof descriptorDe>,
  identidades: ReadonlySet<string>,
): Promise<{ total: number; hallazgos: Hallazgo[] }> {
  const config = loadConfig();
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
  const fuente = descriptor.crear({ view, logger, metrics });

  for await (const pagina of fuente.recorrer({ hasta: 1 })) {
    const faltan = pagina.filas.map((f) => f.registro.id).filter((id) => !identidades.has(id));

    return {
      total: pagina.total,
      hallazgos: [
        ok(
          'sitio-total',
          `el portal declara ${numero(pagina.total)} fila(s), en ${metrics.snapshot().requests} request(s)`,
        ),
        faltan.length === 0
          ? ok('sitio-primera-pagina', `las ${pagina.filas.length} filas de la página 1 están en el dataset`)
          : error(
              'sitio-primera-pagina',
              faltan.length === pagina.filas.length
                ? 'ninguna fila de la página 1 del portal está en el dataset: cambió el sitio o el parser'
                : `${faltan.length} de ${pagina.filas.length} filas de la página 1 no están en el dataset: ` +
                  'el organismo publicó algo desde la corrida',
              { muestras: faltan.slice(0, 5) },
            ),
      ],
    };
  }

  throw new Error('el recorrido no devolvió ninguna página');
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const salir = async (codigo: number): Promise<never> => {
    await cerrarLogs();
    process.exit(codigo);
  };
  main(process.argv.slice(2)).then(
    salir,
    (e: unknown) => {
      console.error('\n✗ Fallo no controlado:', e);
      return salir(SALIDA.fallo);
    },
  );
}
