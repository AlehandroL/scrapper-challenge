/**
 * `npm run retry-failed` — reintenta lo que quedó en la cola de fallos.
 *
 * El enunciado lo pide literalmente: «registrar qué documentos fallaron para
 * poder reintentarlos después». Lo interesante es el «después», porque §5.4 lo
 * vuelve caro: no se puede guardar el request y reproducirlo más tarde —el
 * `ViewState` de la descarga tiene que estar alineado con la página donde vive la
 * fila, y una sesión nueva ni siquiera tiene esa página renderizada—. Reintentar
 * significa **volver a navegar**, y por eso este comando es el mismo engine de
 * `download` con un filtro por identidad y un rango derivado de la cola.
 *
 * Ese rango es lo que lo hace barato: si los tres pendientes están en las páginas
 * 12, 13 y 47, se recorre de la 12 a la 47 y se baja solo esos tres. Sin la
 * página anotada en cada entrada habría que recorrer el dataset entero.
 *
 * Al terminar, la cola se reescribe con lo que **siguió** fallando, con los
 * intentos acumulados. Nada se borra por conveniencia: un documento que agota el
 * presupuesto de intentos se deja de reintentar pero se queda en el archivo, que
 * es donde tiene que estar la evidencia de que el sitio no lo entrega.
 *
 * Uso:   npm run retry-failed
 */

import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { loadConfig } from '../config.ts';
import { CircuitBreaker } from '../http/circuit-breaker.ts';
import { AccessDeniedError } from '../http/errors.ts';
import { RateLimiter } from '../http/rate-limiter.ts';
import { RETRY_DEFAULTS } from '../http/retry.ts';
import { createSession } from '../http/session.ts';
import { JsfView } from '../jsf/view.ts';
import { cerrarLogs, createLogger, vaciarLogs } from '../obs/logger.ts';
import { Metrics, lineasDeSalud } from '../obs/metrics.ts';
import { SourceError } from '../sources/errors.ts';
import {
  FUENTES,
  colaPorDefecto,
  descriptorDe,
  documentosPorDefecto,
  manifiestoPorDefecto,
} from '../sources/registry.ts';
import type { RegistroBase } from '../sources/types.ts';
import { colaEnMemoria, leerDlq, reescribirDlq, type EntradaDlq } from '../store/dlq.ts';
import { openJsonlWriter, repararCola } from '../store/jsonl.ts';
import {
  descargar,
  leerManifiesto,
  nombreDeArchivoDe,
  type DescargaDeps,
  type EntradaManifiesto,
  type ResumenDescarga,
} from './download.ts';

const FUENTE_POR_DEFECTO = 'oefa';
const MAX_INTENTOS_POR_DEFECTO = 5;

export const SALIDA = { ok: 0, fallo: 1, uso: 2, conFallos: 3, interrumpida: 130 } as const;

export interface OpcionesCli {
  readonly fuente: string;
  readonly dlq: string;
  readonly destino: string;
  readonly manifiesto: string;
  readonly maxIntentos: number;
  readonly dryRun: boolean;
  readonly ayuda: boolean;
}

const AYUDA = `
Uso: npm run retry-failed -- [opciones]

  --fuente <nombre>     ${FUENTES.join(' | ')}. Por defecto ${FUENTE_POR_DEFECTO}.
  --dlq <ruta>          Cola de fallos. Por defecto data/<fuente>.failed.jsonl.
  --destino <dir>       Directorio de los archivos. Por defecto data/<fuente>/.
  --manifiesto <ruta>   JSONL con el mapeo id → archivo. Por defecto data/<fuente>.descargas.jsonl.
  --max-intentos <n>    Se deja de reintentar a partir de acá. Por defecto ${MAX_INTENTOS_POR_DEFECTO}.
  --dry-run             Reporta qué reintentaría, sin tocar la red ni el disco.
  --help                Esto.

Reintentar exige volver a navegar hasta la página de cada registro: el ViewState
de la descarga tiene que estar alineado con ella (§5.4). El rango recorrido sale
de las páginas anotadas en la cola.
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
        dlq: { type: 'string' },
        destino: { type: 'string' },
        manifiesto: { type: 'string' },
        'max-intentos': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    throw new Error(
      `Argumentos inválidos: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const { values } = parsed;
  const crudo = values['max-intentos'];
  const maxIntentos = crudo === undefined ? MAX_INTENTOS_POR_DEFECTO : Number(crudo);
  if (!Number.isInteger(maxIntentos) || maxIntentos < 1) {
    throw new Error(
      `Argumentos inválidos: --max-intentos debe ser un entero ≥ 1, llegó «${crudo}»`,
    );
  }

  const fuente = values.fuente ?? FUENTE_POR_DEFECTO;

  return {
    fuente,
    dlq: values.dlq ?? colaPorDefecto(fuente),
    destino: values.destino ?? documentosPorDefecto(fuente),
    manifiesto: values.manifiesto ?? manifiestoPorDefecto(fuente),
    maxIntentos,
    dryRun: values['dry-run'] === true,
    ayuda: values.help === true,
  };
}

export interface PlanReintento {
  readonly pendientes: readonly EntradaDlq[];
  /** Las que ya agotaron el presupuesto: se conservan sin reintentar. */
  readonly agotadas: readonly EntradaDlq[];
  readonly desde?: number;
  readonly hasta?: number;
}

/**
 * Qué se reintenta y en qué rango.
 *
 * Una entrada sin página anotada obliga a recorrer todo: no se sabe dónde vive.
 * Es preferible a saltearla en silencio, y en la práctica no pasa —el engine
 * siempre anota la página—; existe por las entradas escritas a mano y por las que
 * pueda dejar una versión futura.
 */
export function planificar(entradas: readonly EntradaDlq[], maxIntentos: number): PlanReintento {
  const dePdf = entradas.filter((e) => e.tipo === 'pdf');
  const pendientes = dePdf.filter((e) => e.intentos < maxIntentos);
  const agotadas = dePdf.filter((e) => e.intentos >= maxIntentos);

  const paginas = pendientes.map((e) => Number(e.contexto?.pagina));
  if (pendientes.length === 0 || paginas.some((p) => !Number.isInteger(p) || p < 1)) {
    return { pendientes, agotadas };
  }

  return {
    pendientes,
    agotadas,
    desde: Math.min(...paginas),
    hasta: Math.max(...paginas),
  };
}

/**
 * Cómo queda la cola después de reintentar.
 *
 * Tres destinos posibles y ninguno es «borrar y ver qué pasa»:
 *
 * - volvió a fallar → la entrada nueva, con los intentos acumulados;
 * - se resolvió → sale de la cola;
 * - se recorrió su página y la fila no apareció → se conserva con
 *   `no-encontrado`, porque el registro se movió o el sitio lo despublicó, y las
 *   dos cosas son información.
 *
 * Cuando la corrida se cortó antes de tiempo (403, drift, Ctrl-C) el tercer caso
 * no aplica: no se llegó a mirar, así que la entrada se conserva tal cual.
 */
export function reconciliar(
  plan: PlanReintento,
  resumen: ResumenDescarga,
  nuevos: readonly EntradaDlq[],
  completa: boolean,
  ahora: string,
): EntradaDlq[] {
  const porId = new Map(nuevos.map((e) => [e.id, e]));
  const sobrevivientes: EntradaDlq[] = [];

  for (const entrada of plan.pendientes) {
    const nuevo = porId.get(entrada.id);
    if (nuevo !== undefined) {
      sobrevivientes.push(nuevo);
      continue;
    }
    if (resumen.resueltos.has(entrada.id)) continue;
    if (!completa) {
      sobrevivientes.push(entrada);
      continue;
    }
    sobrevivientes.push({
      ...entrada,
      error: 'no-encontrado',
      intentos: entrada.intentos + 1,
      ultimoTs: ahora,
      detalle:
        'se recorrió su página y la fila no apareció: el registro se movió o dejó de publicarse',
    });
  }

  return [...sobrevivientes, ...plan.agotadas];
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

  // Reparar **antes** de leer: quien escribió esta cola es una corrida que ya
  // venía fallando, o sea la que más chances tiene de haber muerto a mitad de
  // línea. Y reparar es decisión de quien va a mutar el archivo, que es este
  // comando.
  if (!opciones.dryRun) repararCola(opciones.dlq);

  let entradas: EntradaDlq[];
  try {
    entradas = await leerDlq(opciones.dlq);
  } catch (error) {
    console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
    return SALIDA.fallo;
  }

  const plan = planificar(entradas, opciones.maxIntentos);

  paso(`Cola: ${entradas.length} entrada(s)`);
  ok(
    `${plan.pendientes.length} por reintentar · ${plan.agotadas.length} con el presupuesto agotado`,
  );
  if (plan.pendientes.length === 0) {
    paso('Nada que reintentar');
    return SALIDA.ok;
  }
  ok(
    plan.desde === undefined
      ? 'alguna entrada no tiene página anotada: se recorre el dataset completo'
      : `páginas ${plan.desde}–${plan.hasta}`,
  );

  if (opciones.dryRun) {
    for (const e of plan.pendientes) {
      console.log(
        `    ${e.id}  pág. ${String(e.contexto?.pagina ?? '?')}  ${e.error}  ${e.intentos} intento(s)`,
      );
    }
    paso('OK (dry-run: no se tocó la red)');
    return SALIDA.ok;
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
      // Sin esta línea `HTTP_MAX_RETRY_AFTER_MS` es una perilla documentada que no
      // hace nada: `createSession` cae a `RETRY_DEFAULTS` y el tope queda clavado
      // en 120 s. Configurar algo y que el proceso lo ignore en silencio es peor
      // que no poder configurarlo, porque además da confianza.
      retry: { ...RETRY_DEFAULTS, maxRetryAfterMs: config.HTTP_MAX_RETRY_AFTER_MS },
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

  // La cola se recolecta en memoria y el archivo se reescribe entero al final:
  // appendear acá dejaría las entradas viejas y las nuevas conviviendo, y la
  // reconciliación tendría que deshacerlo.
  const cola = colaEnMemoria();
  const estado = await leerManifiesto(opciones.manifiesto);
  const writer = openJsonlWriter(opciones.manifiesto);

  const aReintentar = new Set(plan.pendientes.map((e) => e.id));
  const intentosPrevios = new Map(plan.pendientes.map((e) => [e.id, e.intentos]));

  let interrumpido = false;
  const alInterrumpir = (): void => {
    if (interrumpido) process.exit(SALIDA.interrumpida);
    interrumpido = true;
    console.error('\n  interrupción recibida: cerrando al terminar el documento');
  };
  process.on('SIGINT', alInterrumpir);

  const nombreDeArchivo = nombreDeArchivoDe(descriptor.nombre);
  if (nombreDeArchivo === undefined) {
    console.error(`\n✗ la fuente «${descriptor.nombre}» no tiene política de nombres de archivo`);
    return SALIDA.fallo;
  }

  const deps: DescargaDeps<RegistroBase> = {
    fuente,
    emisor: view,
    dlq: cola,
    logger,
    metrics,
    anotar: (entrada: EntradaManifiesto) => writer.append(entrada),
    alCompletarPagina: () => writer.flush(),
  };

  paso(`Reintentando ${plan.pendientes.length} documento(s)`);

  let resumen: ResumenDescarga | undefined;
  let completa = false;
  let fallo: unknown;
  try {
    resumen = await descargar(deps, {
      destino: opciones.destino,
      nombreDeArchivo,
      estado,
      intentosPrevios,
      // El filtro corre sobre lo que el sitio sirve hoy: si el registro se movió
      // de página, no matchea, y la reconciliación lo marca `no-encontrado` en
      // vez de dejarlo dando vueltas para siempre.
      filtro: (registro: RegistroBase) => aReintentar.has(registro.id),
      ...(plan.desde === undefined ? {} : { desde: plan.desde }),
      ...(plan.hasta === undefined ? {} : { hasta: plan.hasta }),
      debeParar: () => interrumpido,
    });
    completa = !resumen.interrumpido;
  } catch (error) {
    fallo = error;
  } finally {
    writer.close();
    process.off('SIGINT', alInterrumpir);
  }

  const resultado = resumen ?? { ...vacio(), resueltos: new Set<string>() };
  const quedan = reconciliar(plan, resultado, cola.entradas, completa, new Date().toISOString());
  reescribirDlq(opciones.dlq, quedan);

  // Vaciar antes de escribir: los logs salen por un worker y el resumen por
  // stdout sincrónico, así que sin esto el bloque humano se les adelanta.
  await vaciarLogs(logger);

  paso('Resumen');
  ok(`${resultado.descargados} recuperado(s) · ${resultado.omitidos} ya estaba(n)`);
  ok(`la cola queda con ${quedan.length} entrada(s)`);
  for (const linea of lineasDeSalud(metrics.snapshot())) console.log(linea);

  if (fallo !== undefined) {
    if (fallo instanceof SourceError)
      console.error(`\n✗ ${fallo.name} [${fallo.kind}]: ${fallo.message}`);
    else if (fallo instanceof AccessDeniedError) console.error(`\n✗ ${fallo.message}`);
    else
      console.error(
        `\n✗ ${fallo instanceof Error ? `${fallo.name}: ${fallo.message}` : String(fallo)}`,
      );
    console.error('  la cola quedó actualizada con lo que se alcanzó a reintentar.');
    return SALIDA.fallo;
  }
  if (resultado.interrumpido) {
    paso('INTERRUMPIDA');
    return SALIDA.interrumpida;
  }
  if (quedan.length > 0) {
    paso(`QUEDAN ${quedan.length} EN LA COLA`);
    return SALIDA.conFallos;
  }
  paso('OK — la cola quedó vacía');
  return SALIDA.ok;
}

/** Un resumen neutro para cuando la corrida murió antes de producir uno. */
const vacio = (): Omit<ResumenDescarga, 'resueltos'> => ({
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
});

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const salir = async (codigo: number): Promise<never> => {
    await cerrarLogs();
    process.exit(codigo);
  };
  main(process.argv.slice(2)).then(salir, (error: unknown) => {
    console.error('\n✗ Fallo no controlado:', error);
    return salir(SALIDA.fallo);
  });
}
