/**
 * El banco de pruebas del bloque 5: portal falso + engine de descarga cableado
 * contra él, sobre sockets reales.
 *
 * Vive acá y no dentro de un test porque `download` y `retry-failed` son el mismo
 * engine con distinta entrada, y montarlo dos veces garantizaría que las dos
 * copias se desincronicen.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  descargar,
  estadoVacio,
  nombreDeArchivoOefa,
  type EntradaManifiesto,
  type EstadoDescargas,
  type OpcionesDescarga,
  type ResumenDescarga,
} from '../../src/cli/download.ts';
import { CircuitBreaker } from '../../src/http/circuit-breaker.ts';
import { RateLimiter } from '../../src/http/rate-limiter.ts';
import { createSession } from '../../src/http/session.ts';
import { JsfView } from '../../src/jsf/view.ts';
import { silentLogger } from '../../src/obs/logger.ts';
import { Metrics } from '../../src/obs/metrics.ts';
import type { RegistroOefa } from '../../src/sources/oefa-rows.ts';
import { createOefaSource } from '../../src/sources/oefa.ts';
import type { Fuente, Pagina } from '../../src/sources/types.ts';
import { colaEnMemoria, type EntradaDlq } from '../../src/store/dlq.ts';
import { startJsfServer, type JsfTestServer, type OpcionesDataset } from './jsf-server.ts';

export interface Banco {
  readonly server: JsfTestServer;
  readonly fuente: Fuente<RegistroOefa>;
  readonly view: JsfView;
  readonly metrics: Metrics;
  readonly destino: string;
  readonly manifiesto: EntradaManifiesto[];
  readonly fallos: readonly EntradaDlq[];
  readonly completadas: number[];
  readonly estado: EstadoDescargas;
  correr(opts?: Partial<OpcionesDescarga<RegistroOefa>>): Promise<ResumenDescarga>;
}

/**
 * Levanta el portal y cablea el engine contra él.
 *
 * El limiter y el breaker van desactivados de fábrica —tasa altísima, umbral
 * inalcanzable— porque los dos tienen sus propios tests y acá solo agregarían
 * acoplamiento: sin eso, un test de «429 va a la cola» terminaría midiendo el
 * AIMD. Los tests que sí quieren ver al breaker lo piden explícito.
 */
export async function montarDescargas(
  dir: string,
  dataset?: OpcionesDataset,
  opts: { breaker?: CircuitBreaker; estado?: EstadoDescargas } = {},
): Promise<Banco> {
  const server = await startJsfServer(dataset === undefined ? {} : { dataset });
  const metrics = new Metrics();

  const session = createSession({
    limiter: new RateLimiter({ rps: 1000, minRps: 1000, maxRps: 1000, burst: 1000 }),
    breaker: opts.breaker ?? new CircuitBreaker({ minSamples: 10_000 }),
    metrics,
    logger: silentLogger,
    retryHooks: { sleep: async () => {}, rng: () => 0 },
  });

  const view = new JsfView({ session, logger: silentLogger, metrics }, { pageUrl: server.pageUrl });
  const fuente = createOefaSource({ view, logger: silentLogger, metrics });

  const manifiesto: EntradaManifiesto[] = [];
  const cola = colaEnMemoria();
  const completadas: number[] = [];
  const estado = opts.estado ?? estadoVacio();

  return {
    server,
    fuente,
    view,
    metrics,
    destino: dir,
    manifiesto,
    get fallos() {
      return cola.entradas;
    },
    completadas,
    estado,
    correr: (extra = {}) =>
      descargar(
        {
          fuente,
          emisor: view,
          dlq: cola,
          logger: silentLogger,
          metrics,
          anotar: (entrada) => void manifiesto.push(entrada),
          alCompletarPagina: (pagina) => void completadas.push(pagina.numero),
        },
        { destino: dir, nombreDeArchivo: nombreDeArchivoOefa, estado, ...extra },
      ),
  };
}


export const archivosDe = (dir: string): string[] => readdirSync(dir).sort();

export const contenidoDe = (dir: string, nombre: string): string =>
  readFileSync(join(dir, nombre), 'latin1');

export const datasetBase = (extra: Partial<OpcionesDataset> = {}): OpcionesDataset => ({ total: 25, ...extra });

export const recolectarPaginas = async (
  fuente: Fuente<RegistroOefa>,
  opts = {},
): Promise<Pagina<RegistroOefa>[]> => {
  const paginas: Pagina<RegistroOefa>[] = [];
  for await (const p of fuente.recorrer(opts)) paginas.push(p);
  return paginas;
};
