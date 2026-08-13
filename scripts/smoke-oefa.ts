/**
 * smoke-oefa.ts — Verifica la capa de transporte contra el sitio vivo.
 *
 * Deliberadamente **fuera de `npm test`**: la suite no debe depender de la red
 * ni golpear el sitio en cada corrida. Esto se ejecuta a mano cuando se quiere
 * evidencia de que el código habla con el servidor real y no solo con el
 * servidor de pruebas.
 *
 * Alcance: es un smoke de **transporte**, no del protocolo. Comprueba tres cosas
 * y ninguna más:
 *
 *   1. el GET responde 200,
 *   2. el cookie jar capturó `JSESSIONID` — sin esa cookie la paginación
 *      devuelve 200 con la tabla vacía y sin excepción (§2.5),
 *   3. el cuerpo contiene la subcadena `javax.faces.ViewState`.
 *
 * El punto 3 es un `includes`, no un parseo: extraer y rotar el token es del
 * bloque 3. Acá solo se constata que el transporte entrega lo que ese bloque va
 * a necesitar.
 *
 * Uso:   npm run smoke:oefa
 */

import { loadConfig } from '../src/config.ts';
import { CircuitBreaker } from '../src/http/circuit-breaker.ts';
import { RateLimiter } from '../src/http/rate-limiter.ts';
import { createSession } from '../src/http/session.ts';
import { createLogger } from '../src/obs/logger.ts';
import { Metrics } from '../src/obs/metrics.ts';

const URL_OEFA = 'https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml';

const paso = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const ok = (s: string) => console.log(`  ✓ ${s}`);
const mal = (s: string) => console.log(`  ✗ ${s}`);

async function main(): Promise<number> {
  const config = loadConfig();
  const metrics = new Metrics();

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
      logger: createLogger({ level: config.LOG_LEVEL, pretty: config.LOG_PRETTY }),
    },
    {
      timeoutMs: config.HTTP_TIMEOUT_MS,
      userAgent: config.HTTP_USER_AGENT,
      ...(config.PROXY_URL === undefined ? {} : { proxyUrl: config.PROXY_URL }),
    },
  );

  paso('GET publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml');

  const res = await session.get(URL_OEFA);
  const cuerpo = res.data;

  const comprobaciones: [string, boolean][] = [
    [`HTTP ${res.status}`, res.status === 200],
    ['cookie JSESSIONID en el jar', await session.hasCookie(URL_OEFA, 'JSESSIONID')],
    ['el cuerpo trae javax.faces.ViewState', cuerpo.includes('javax.faces.ViewState')],
  ];

  for (const [etiqueta, pasa] of comprobaciones) (pasa ? ok : mal)(etiqueta);
  ok(`${cuerpo.length.toLocaleString('es-CL')} bytes recibidos`);

  paso('Métricas de la corrida');
  const s = metrics.snapshot();
  console.log(`  requests=${s.requests}  ok=${s.ok}  429=${s.throttled}  reintentos=${s.reintentos}`);
  console.log(`  latencia p50=${s.latenciaP50Ms} ms  p95=${s.latenciaP95Ms} ms`);

  const fallidas = comprobaciones.filter(([, pasa]) => !pasa);
  if (fallidas.length > 0) {
    paso(`FALLÓ — ${fallidas.length} comprobación(es)`);
    return 1;
  }
  paso('OK — la capa de transporte entrega lo que el bloque 3 necesita');
  return 0;
}

main().then(
  (codigo) => process.exit(codigo),
  (error: unknown) => {
    // Se imprime el error tipado: la clase ya dice qué política corresponde.
    console.error('\n✗ El smoke falló:', error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
