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
import { createLogger } from '../obs/logger.ts';
import { Metrics } from '../obs/metrics.ts';
import { SourceError } from '../sources/errors.ts';
import { URL_OEFA, createOefaSource } from '../sources/oefa.ts';
import { RegistroOefaSchema, type RegistroOefa } from '../sources/oefa-rows.ts';
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

const DATASET_POR_DEFECTO = 'data/oefa.jsonl';
const MANIFIESTO_POR_DEFECTO = 'data/oefa.descargas.jsonl';
const DLQ_POR_DEFECTO = 'data/oefa.failed.jsonl';
const DESCARGAS_POR_DEFECTO = 'descargas';
const CHECKPOINT_POR_DEFECTO = 'data/oefa.scrape.checkpoint.json';
const PAGE_SIZE = 10;

/** `0` sin errores · `1` no pudo correr · `2` uso incorrecto · `3` corrió y
 *  encontró errores. El `3` copia el `conFallos` de `download.ts`: un script
 *  necesita distinguir «no pude mirar» de «miré y está mal». */
export const SALIDA = { ok: 0, fallo: 1, uso: 2, conHallazgos: 3 } as const;

export interface OpcionesCli {
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

  --dataset <ruta>      JSONL de registros. Por defecto ${DATASET_POR_DEFECTO}.
  --manifiesto <ruta>   JSONL de descargas. Por defecto ${MANIFIESTO_POR_DEFECTO}.
  --dlq <ruta>          Cola de fallos. Por defecto ${DLQ_POR_DEFECTO}.
  --descargas <dir>     Carpeta de los archivos. Por defecto ${DESCARGAS_POR_DEFECTO}/.
  --checkpoint <ruta>   De donde sacar el total. Por defecto ${CHECKPOINT_POR_DEFECTO}.
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

  return {
    dataset: values.dataset ?? DATASET_POR_DEFECTO,
    manifiesto: values.manifiesto ?? MANIFIESTO_POR_DEFECTO,
    dlq: values.dlq ?? DLQ_POR_DEFECTO,
    descargas: values.descargas ?? DESCARGAS_POR_DEFECTO,
    checkpoint: values.checkpoint ?? CHECKPOINT_POR_DEFECTO,
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
 * El puente entre el esquema del bloque 4 y el validador inyectado del bloque 6.
 *
 * El esquema vive en `sources/` porque se usa **antes** de escribir el registro;
 * acá se lo reusa para leerlo. Duplicarlo en `validate/` habría dado dos
 * verdades sobre la misma forma, y la que se desactualiza es siempre la que no
 * corre en cada scrape.
 */
const validarRegistro = (valor: unknown): RegistroOefa | string => {
  const resultado = RegistroOefaSchema.safeParse(valor);
  // El cast es por `exactOptionalPropertyTypes`: zod infiere los opcionales como
  // `documentoUuid?: string | undefined` y la interfaz los declara `?: string`.
  // Es sano porque JSON no puede expresar `undefined`: tras el parseo la clave
  // está ausente o es un string. Reconstruir el objeto campo por campo sería más
  // literal y peor — un campo nuevo en el esquema se perdería en silencio.
  if (resultado.success) return resultado.data as RegistroOefa;
  return resultado.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`)
    .join('; ');
};

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
  const revision = new RevisionDataset(validarRegistro, { pageSize: opciones.pageSize });
  const dominio = new RevisionOefa();
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
      sitio = { titulo: `Contra el sitio — ${URL_OEFA}`, hallazgos: consulta.hallazgos };
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
    console.error(`\n✗ No existe ${opciones.dataset}. Correr «npm run scrape» primero.`);
    return SALIDA.fallo;
  }

  const { secciones, nota } = await revisar(
    opciones,
    opciones.contraElSitio ? preguntarleAlSitio : undefined,
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

  const view = new JsfView({ session, logger, metrics }, { pageUrl: URL_OEFA });
  const fuente = createOefaSource({ view, logger, metrics });

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
  main(process.argv.slice(2)).then(
    (codigo) => process.exit(codigo),
    (e: unknown) => {
      console.error('\n✗ Fallo no controlado:', e);
      process.exit(SALIDA.fallo);
    },
  );
}
