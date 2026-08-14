/**
 * smoke-jsf.ts — Verifica el protocolo completo contra el sitio vivo.
 *
 * Deliberadamente **fuera de `npm test`**, igual que `smoke:oefa`: la suite no
 * debe depender de la red ni golpear el sitio en cada corrida. Esto se ejecuta a
 * mano cuando se quiere evidencia de que la capa `jsf/` habla con el servidor
 * real y no solo con el portal falso de los tests.
 *
 * Donde `smoke:oefa` comprueba transporte —200, cookie, la subcadena del
 * token—, esto comprueba **protocolo**: bootstrap, búsqueda y paginación, con
 * el ViewState rotando y las páginas sin solaparse.
 *
 * Cierra además la única brecha que los fixtures no pueden cubrir:
 * `capture-oefa.sh` manda `:` y espacios crudos con `--data`, mientras
 * `URLSearchParams.toString()` percent-encodea `:` como `%3A` y el espacio de
 * `render` como `+`. Ambos decodifican igual del lado de Java, pero eso es una
 * suposición hasta que un request real la confirma.
 *
 * Uso:   npm run smoke:jsf
 */

import { loadConfig } from '../src/config.ts';
import { CircuitBreaker } from '../src/http/circuit-breaker.ts';
import { RateLimiter } from '../src/http/rate-limiter.ts';
import { createSession } from '../src/http/session.ts';
import { createLogger } from '../src/obs/logger.ts';
import { Metrics } from '../src/obs/metrics.ts';
import { pageCommand, readRowCount, readRowIndices } from '../src/jsf/datatable.ts';
import { JsfView } from '../src/jsf/view.ts';

const URL_OEFA = 'https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml';

/**
 * Los únicos ids con nombre explícito y estable del portal. Los demás
 * (`j_idt21`, `j_idt25`…) son autogenerados y se descubren en el bootstrap:
 * hardcodearlos garantiza morir en silencio en el próximo deploy.
 */
const FORM = 'listarDetalleInfraccionRAAForm';
const TABLA = `${FORM}:dt`;
const BOTON = `${FORM}:btnBuscar`;
const TAMANO_PAGINA = 10;

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

  paso('1/3  Bootstrap — GET de la vista');
  const form = await view.bootstrap();
  const tokenInicial = view.viewState;
  ok(`form ${form.id} · ${form.campos.size} campos descubiertos`);
  ok(`ViewState: ${tokenInicial?.length ?? 0} bytes`);
  ok(`action sin jsessionid: ${!form.action.includes('jsessionid')}`);

  paso('2/3  Búsqueda — evento AJAX sobre el form vacío');
  const busqueda = await view.submitAjax({
    source: BOTON,
    execute: '@all',
    render: `${FORM}:pgLista ${FORM}:txtNroexp`,
    params: { [BOTON]: BOTON },
  });
  const lista = busqueda.updates.get(`${FORM}:pgLista`) ?? '';
  const total = readRowCount(lista);
  const pagina1 = readRowIndices(lista);
  const tokenBusqueda = view.viewState;
  ok(`total reportado por el sitio: ${total ?? '?'}`);
  ok(`filas en la página 1: ${pagina1.length} (data-ri ${pagina1[0]}–${pagina1.at(-1)})`);

  paso('3/3  Paginación — página 2');
  const pagina = await view.submitAjax(pageCommand({ tableId: TABLA, first: TAMANO_PAGINA, rows: TAMANO_PAGINA }));
  const filas2 = pagina.updates.get(TABLA) ?? '';
  const pagina2 = readRowIndices(filas2);
  ok(`filas en la página 2: ${pagina2.length} (data-ri ${pagina2[0]}–${pagina2.at(-1)})`);

  const solapadas = pagina1.filter((i) => pagina2.includes(i));

  paso('Comprobaciones');
  const comprobaciones: [string, boolean][] = [
    ['cookie JSESSIONID propagada', await session.hasCookie(URL_OEFA, 'JSESSIONID')],
    ['el bootstrap trajo un ViewState', (tokenInicial?.length ?? 0) > 100],
    ['el ViewState rotó tras la búsqueda', tokenBusqueda !== tokenInicial],
    ['el ViewState rotó tras la paginación', view.viewState !== tokenBusqueda],
    [`la página 1 trae ${TAMANO_PAGINA} filas`, pagina1.length === TAMANO_PAGINA],
    ['las páginas no se solapan', solapadas.length === 0 && pagina2.length > 0],
  ];
  for (const [etiqueta, pasa] of comprobaciones) (pasa ? ok : mal)(etiqueta);

  paso('Métricas de la corrida');
  const s = metrics.snapshot();
  console.log(`  requests=${s.requests}  ok=${s.ok}  429=${s.throttled}  reintentos=${s.reintentos}`);
  console.log(`  latencia p50=${s.latenciaP50Ms} ms  p95=${s.latenciaP95Ms} ms`);
  console.log(`  contadores: ${JSON.stringify(s.contadores)}`);

  const fallidas = comprobaciones.filter(([, pasa]) => !pasa);
  if (fallidas.length > 0) {
    paso(`FALLÓ — ${fallidas.length} comprobación(es)`);
    return 1;
  }
  paso('OK — el protocolo JSF funciona contra el sitio real');
  return 0;
}

main().then(
  (codigo) => process.exit(codigo),
  (error: unknown) => {
    console.error('\n✗ El smoke falló:', error instanceof Error ? `${error.name}: ${error.message}` : error);
    process.exit(1);
  },
);
