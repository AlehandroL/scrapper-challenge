/**
 * `npm run scrape` — recorre la fuente y escribe los registros en JSONL.
 *
 * Es el composition root: el único lugar donde se arman la sesión, el limiter,
 * el breaker, la vista y el adapter. Por eso `sources/` puede no importar nada
 * de `http/` —recibe la vista ya construida— y esa separación queda sostenida
 * por el código y no por una promesa del README.
 *
 * **Reanudable e idempotente** (§5.7): antes de arrancar lee los identificadores
 * que el archivo ya tiene y no los vuelve a escribir. Correr dos veces el mismo
 * rango escribe cero líneas. Una corrida interrumpida se retoma completando lo
 * que falta, sin duplicar ni tener que borrar nada.
 *
 * Argumentos con `util.parseArgs`, nativo desde Node 18.3: el CLI tiene cinco
 * flags y `commander` sería una dependencia para ahorrar veinte líneas.
 *
 * Uso:   npm run scrape -- --hasta 3
 */

import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { loadConfig } from '../config.ts';
import { CircuitBreaker } from '../http/circuit-breaker.ts';
import { RateLimiter } from '../http/rate-limiter.ts';
import { createSession } from '../http/session.ts';
import { JsfView } from '../jsf/view.ts';
import { createLogger } from '../obs/logger.ts';
import { Metrics } from '../obs/metrics.ts';
import { SourceError, RangoInvalidoError } from '../sources/errors.ts';
import {
  FUENTES,
  checkpointPorDefecto,
  descriptorDe,
  salidaPorDefecto,
} from '../sources/registry.ts';
import {
  borrarCheckpoint,
  escribirCheckpoint,
  leerCheckpoint,
  planificarReanudacion,
  type Checkpoint,
} from '../store/checkpoint.ts';
import { openJsonlWriter, readKeys } from '../store/jsonl.ts';

const FUENTE_POR_DEFECTO = 'oefa';
const TAREA = 'scrape';

/** `0` ok · `1` la corrida falló · `2` uso incorrecto · `130` interrumpida. */
export const SALIDA = { ok: 0, fallo: 1, uso: 2, interrumpida: 130 } as const;

export interface OpcionesCli {
  readonly fuente: string;
  /** Ausente significa «desde donde diga el checkpoint». */
  readonly desde?: number;
  readonly hasta?: number;
  readonly salida: string;
  readonly checkpoint: string;
  readonly maxRecuperaciones: number;
  /** Ignora el checkpoint y recorre desde la primera página. */
  readonly reiniciar: boolean;
  /** Recorre y valida sin tocar el disco: sirve para probar el sitio sin escribir. */
  readonly dryRun: boolean;
  readonly ayuda: boolean;
}

const AYUDA = `
Uso: npm run scrape -- [opciones]

  --fuente <nombre>          ${FUENTES.join(' | ')}. Por defecto ${FUENTE_POR_DEFECTO}.
  --desde <n>                Primera página (1-based). Por defecto, la del checkpoint.
  --hasta <n>                Última página inclusive. Por defecto, la última.
  --salida <ruta>            Archivo JSONL. Por defecto data/<fuente>.jsonl.
  --checkpoint <ruta>        Estado de reanudación. Por defecto data/<fuente>.scrape.checkpoint.json.
  --max-recuperaciones <n>   Reconstrucciones de la vista permitidas. Por defecto 3.
  --reiniciar                Ignora el checkpoint y recorre desde el principio.
  --dry-run                  Recorre y valida sin escribir nada.
  --help                     Esto.

La corrida es reanudable por partida doble: el checkpoint dice en qué página
quedó el recorrido, y los registros ya presentes en la salida no se reescriben.
Repetir el comando completa lo que falte sin duplicar ni volver a pedir páginas
que ya se leyeron.
`.trimStart();

export function parsearArgs(argv: readonly string[]): OpcionesCli {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      // `strict` para que una flag mal escrita falle en vez de ignorarse: un
      // `--hastaa 3` silencioso descarga el dataset entero sin que nadie lo pida.
      strict: true,
      allowPositionals: false,
      options: {
        fuente: { type: 'string' },
        desde: { type: 'string' },
        hasta: { type: 'string' },
        salida: { type: 'string' },
        checkpoint: { type: 'string' },
        'max-recuperaciones': { type: 'string' },
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
  const maxRecuperaciones = enteroPositivo(values['max-recuperaciones'], 'max-recuperaciones') ?? 3;

  if (hasta !== undefined && desde !== undefined && hasta < desde) {
    throw new Error(`Argumentos inválidos: --hasta (${hasta}) es menor que --desde (${desde})`);
  }

  const fuente = values.fuente ?? FUENTE_POR_DEFECTO;

  return {
    fuente,
    // `exactOptionalPropertyTypes`: un `desde: undefined` explícito no compila
    // contra `desde?: number`.
    ...(desde === undefined ? {} : { desde }),
    ...(hasta === undefined ? {} : { hasta }),
    salida: values.salida ?? salidaPorDefecto(fuente),
    checkpoint: values.checkpoint ?? checkpointPorDefecto(fuente, TAREA),
    maxRecuperaciones,
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

/**
 * La clave con la que se deduplica. `store/` no sabe que existe.
 *
 * Es `id` —la identidad derivada del contenido— y no el uuid del documento: en
 * OEFA hay registros sin documento y hay pares de registros que comparten uno,
 * así que deduplicar por documento perdería filas legítimas.
 */
const idDe = (valor: unknown): string | undefined =>
  typeof valor === 'object' && valor !== null && 'id' in valor && typeof valor.id === 'string'
    ? valor.id
    : undefined;

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
    // Antes de `loadConfig()` a propósito: una fuente mal escrita tiene que
    // fallar por lo que el usuario escribió, no por una variable de entorno.
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
    {
      ...(descriptor.pageSize === undefined ? {} : { pageSize: descriptor.pageSize }),
      maxRecuperaciones: opciones.maxRecuperaciones,
    },
  );

  // El estado de la evidencia se imprime **antes** de tocar la red. Un adapter no
  // ejercitado contra su fuente que corre sin decirlo es la cobertura simulada
  // que §3.3 rechaza; dicho en pantalla, quien lo corre sabe qué está midiendo.
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
    // `0` = «lo deriva la corrida». Es el caso del portal del Poder Judicial,
    // que no publica su configuración de paginación en ninguna parte legible.
    // Guardarlo así mantiene la comprobación de compatibilidad del checkpoint
    // —una corrida derivada no puede retomar una configurada— sin inventar el
    // número que traduce página a offset.
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

  // Los ya escritos se leen **antes** de abrir el writer: abrirlo repara la cola
  // truncada, y quien quiera contar lo que había debe verlo tal cual quedó.
  // Copia mutable: durante la corrida también sirve para no reescribir una
  // identidad que ya se persistió en esta misma pasada — el portal repite alguna
  // fila byte por byte dentro de la misma página.
  const yaEnDisco = new Set(
    opciones.dryRun
      ? []
      : await readKeys(opciones.salida, idDe, {
          onColaInvalida: (linea) =>
            logger.warn({ linea }, 'la última línea quedó truncada; se repara al abrir'),
        }),
  );
  const writer = opciones.dryRun ? undefined : openJsonlWriter(opciones.salida);

  paso(`Recorriendo ${fuente.nombre}${opciones.dryRun ? ' (dry-run: no se escribe nada)' : ''}`);
  if (writer !== undefined && writer.bytesReparados > 0) {
    ok(`se descartaron ${writer.bytesReparados} byte(s) de una línea a medio escribir`);
  }
  if (yaEnDisco.size > 0) ok(`${yaEnDisco.size} registro(s) ya en ${opciones.salida}: se omiten`);
  if (plan.mensaje !== undefined) ok(plan.mensaje);

  // Ctrl-C corta **en el borde de una página**, no en medio de una escritura: el
  // archivo queda consistente y la corrida se retoma con el mismo comando. Un
  // segundo Ctrl-C sale de inmediato, para no dejar la terminal secuestrada.
  let interrumpido = false;
  const alInterrumpir = (): void => {
    if (interrumpido) process.exit(SALIDA.interrumpida);
    interrumpido = true;
    console.error('\n  interrupción recibida: cerrando al terminar la página (Ctrl-C otra vez para cortar ya)');
  };
  process.on('SIGINT', alInterrumpir);

  let nuevos = 0;
  let omitidos = 0;
  let ultimaPagina = 0;
  let desde = plan.desde;
  let totalEsperado = plan.totalEsperado;
  let recorrerDeNuevo = false;

  try {
    do {
      recorrerDeNuevo = false;
      let primera = true;

      for await (const pagina of fuente.recorrer({
        ...(desde === undefined ? {} : { desde }),
        ...(opciones.hasta === undefined ? {} : { hasta: opciones.hasta }),
      })) {
        // El checkpoint se termina de validar acá y no antes: el total lo declara
        // la búsqueda, y el `desde` hay que decidirlo antes de emitirla. Si no
        // coincide, el organismo publicó algo nuevo, todos los índices se
        // corrieron y retomar en esta página leería filas que no son las que
        // faltaban.
        if (primera) {
          primera = false;
          if (totalEsperado !== undefined && pagina.total !== totalEsperado) {
            logger.warn(
              { antes: totalEsperado, ahora: pagina.total },
              'el total cambió desde el checkpoint: se descarta y se recorre desde la página 1',
            );
            if (!opciones.dryRun) borrarCheckpoint(opciones.checkpoint);
            desde = undefined;
            totalEsperado = undefined;
            recorrerDeNuevo = true;
            break;
          }
        }

        for (const { registro } of pagina.filas) {
          if (yaEnDisco.has(registro.id)) {
            omitidos += 1;
            continue;
          }
          writer?.append(registro);
          yaEnDisco.add(registro.id);
          nuevos += 1;
        }
        // Una barrera por página, no por registro: acota la pérdida ante un corte
        // de energía a la granularidad del checkpoint, y 176 fsync no se notan al
        // lado de 176 requests. El checkpoint va después del fsync, nunca antes:
        // al revés apuntaría a registros que todavía no están en disco.
        writer?.flush();
        ultimaPagina = pagina.numero;
        if (!opciones.dryRun) {
          escribirCheckpoint(opciones.checkpoint, {
            fuente: fuente.nombre,
            tarea: TAREA,
            pageSize: descriptor.pageSize ?? 0,
            total: pagina.total,
            ultimaPagina: pagina.numero,
            registros: nuevos + omitidos,
            actualizadoEn: new Date().toISOString(),
          });
        }

        logger.info(
          { pagina: pagina.numero, filas: pagina.filas.length, esUltima: pagina.esUltima, nuevos },
          'página persistida',
        );
        if (interrumpido) break;
      }
    } while (recorrerDeNuevo && !interrumpido);
  } catch (error) {
    writer?.close();
    process.off('SIGINT', alInterrumpir);
    return reportarFallo(error, ultimaPagina);
  }

  writer?.close();
  process.off('SIGINT', alInterrumpir);

  paso('Resumen');
  ok(`${nuevos} registro(s) nuevo(s), ${omitidos} omitido(s) por ya estar presentes`);
  ok(`última página completada: ${ultimaPagina}`);
  if (!opciones.dryRun) ok(`salida: ${opciones.salida} · checkpoint: ${opciones.checkpoint}`);

  const s = metrics.snapshot();
  console.log(`  requests=${s.requests}  ok=${s.ok}  429=${s.throttled}  reintentos=${s.reintentos}`);
  console.log(`  latencia p50=${s.latenciaP50Ms} ms  p95=${s.latenciaP95Ms} ms`);
  console.log(`  contadores: ${JSON.stringify(s.contadores)}`);

  if (interrumpido) {
    paso('INTERRUMPIDA — el archivo quedó consistente; repetir el comando la retoma');
    return SALIDA.interrumpida;
  }
  paso('OK');
  return SALIDA.ok;
}

/**
 * Un drift no se arregla reintentando: se arregla mirando el sitio. Por eso el
 * mensaje dice **qué** cambió y no solo que algo falló.
 */
function reportarFallo(error: unknown, ultimaPagina: number): number {
  if (error instanceof RangoInvalidoError) {
    console.error(`\n✗ ${error.message}`);
    return SALIDA.uso;
  }
  if (error instanceof SourceError) {
    console.error(`\n✗ ${error.name} [${error.kind}]: ${error.message}`);
    console.error(`  última página completada: ${ultimaPagina}. Lo escrito hasta acá es válido.`);
    return SALIDA.fallo;
  }
  console.error(`\n✗ ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  return SALIDA.fallo;
}

// Solo cuando se ejecuta como programa: así los tests importan `parsearArgs` sin
// arrancar una corrida. `import.meta.filename` sería más corto pero es de Node
// 20.11 y el `engines` del proyecto declara >=20.0.0.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (codigo) => process.exit(codigo),
    (error: unknown) => {
      console.error('\n✗ Fallo no controlado:', error);
      process.exit(SALIDA.fallo);
    },
  );
}
