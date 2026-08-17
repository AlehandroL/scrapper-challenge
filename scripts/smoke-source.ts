/**
 * smoke-source.ts — El adapter contra el sitio vivo, en las dos condiciones que
 * los fixtures no pueden cubrir.
 *
 * Deliberadamente **fuera de `npm test`**, igual que los otros dos smokes: la
 * suite no debe depender de la red ni golpear el sitio en cada corrida.
 *
 * Lo que cierra esto es un riesgo concreto y declarado del plan: la paginación
 * está verificada para el salto `first=0 → first=10`, pero **no** para un salto
 * grande. El adapter hace exactamente eso cada vez que se reanuda con `--desde`,
 * y también cada vez que se recupera de una vista caída en la página 87. Si el
 * servidor no respetara un `dt_first` arbitrario, el síntoma sería un archivo
 * lleno de filas de la página 1 con los `data-ri` correctos.
 *
 * La última página es el otro caso: 1.753 registros dan 175 páginas de 10 y una
 * de 3, y una aserción de «página completa» escrita sin pensar la rechaza.
 *
 * Uso:   npm run smoke:source
 */

import { loadConfig } from '../src/config.ts';
import { CircuitBreaker } from '../src/http/circuit-breaker.ts';
import { RateLimiter } from '../src/http/rate-limiter.ts';
import { createSession } from '../src/http/session.ts';
import { JsfView } from '../src/jsf/view.ts';
import { createLogger } from '../src/obs/logger.ts';
import { Metrics } from '../src/obs/metrics.ts';
import { URL_OEFA, createOefaSource } from '../src/sources/oefa.ts';
import type { Pagina } from '../src/sources/types.ts';
import type { RegistroOefa } from '../src/sources/oefa-rows.ts';

const paso = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const ok = (s: string) => console.log(`  ✓ ${s}`);
const mal = (s: string) => console.log(`  ✗ ${s}`);

async function main(): Promise<number> {
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

  paso('1/2  Primeras dos páginas — el camino que los fixtures cubren');
  const primeras: Pagina<RegistroOefa>[] = [];
  for await (const p of fuente.recorrer({ hasta: 2 })) primeras.push(p);

  const total = primeras[0]?.total ?? 0;
  const ultima = Math.max(1, Math.ceil(total / 10));
  ok(`total declarado por el sitio: ${total} (${ultima} páginas)`);
  for (const p of primeras) {
    ok(
      `página ${p.numero}: ${p.filas.length} filas, data-ri ${p.filas[0]?.registro.indice}–${p.filas.at(-1)?.registro.indice}`,
    );
  }
  const muestra = primeras[0]?.filas[0]?.registro;
  ok(`muestra: ${muestra?.resolucion} · ${muestra?.administrados.join(' / ')}`);

  paso(`2/2  Salto directo a la última página (offset ${(ultima - 1) * 10})`);
  const ultimas: Pagina<RegistroOefa>[] = [];
  for await (const p of fuente.recorrer({ desde: ultima })) ultimas.push(p);

  const final = ultimas[0];
  ok(
    `página ${final?.numero}: ${final?.filas.length} filas, data-ri ${final?.filas[0]?.registro.indice}–${final?.filas.at(-1)?.registro.indice}`,
  );

  const esperadasEnUltima = total - (ultima - 1) * 10;
  const indicesOk =
    final?.filas.every((f, i) => f.registro.indice === (ultima - 1) * 10 + i) ?? false;
  const sinSolape = !primeras
    .flatMap((p) => p.filas.map((f) => f.registro.id))
    .some((u) => final?.filas.some((f) => f.registro.id === u) ?? false);

  paso('Comprobaciones');
  const comprobaciones: [string, boolean][] = [
    ['el sitio reportó un total plausible', total > 100],
    ['la página 1 trae 10 filas', primeras[0]?.filas.length === 10],
    ['la página 2 arranca en el data-ri 10', primeras[1]?.filas[0]?.registro.indice === 10],
    ['el salto grande devolvió el offset pedido', indicesOk],
    [
      `la última página trae ${esperadasEnUltima} fila(s)`,
      final?.filas.length === esperadasEnUltima,
    ],
    ['la última página está marcada como última', final?.esUltima === true],
    ['no hay solapamiento con las primeras páginas', sinSolape],
    [
      'todas las filas traen identidad',
      ultimas.every((p) => p.filas.every((f) => f.registro.id !== '')),
    ],
  ];
  for (const [etiqueta, pasa] of comprobaciones) (pasa ? ok : mal)(etiqueta);

  paso('Métricas de la corrida');
  const s = metrics.snapshot();
  console.log(
    `  requests=${s.requests}  ok=${s.ok}  429=${s.throttled}  reintentos=${s.reintentos}`,
  );
  console.log(`  latencia p50=${s.latenciaP50Ms} ms  p95=${s.latenciaP95Ms} ms`);
  console.log(`  contadores: ${JSON.stringify(s.contadores)}`);

  const fallidas = comprobaciones.filter(([, pasa]) => !pasa);
  if (fallidas.length > 0) {
    paso(`FALLÓ — ${fallidas.length} comprobación(es)`);
    return 1;
  }
  paso('OK — el adapter recorre el sitio real, incluido el salto de offset grande');
  return 0;
}

main().then(
  (codigo) => process.exit(codigo),
  (error: unknown) => {
    console.error(
      '\n✗ El smoke falló:',
      error instanceof Error ? `${error.name}: ${error.message}` : error,
    );
    process.exit(1);
  },
);
