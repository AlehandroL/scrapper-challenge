/**
 * smoke-pj.ts — Ejercita el adapter del Poder Judicial contra el sitio vivo.
 *
 * Este script existe por una razón concreta: **el adapter del bloque 7 no se
 * pudo correr contra su fuente.** El portal responde `403` desde Chile y no se
 * contrató proxy (§3.3). Escribir el adapter igual era lo que correspondía;
 * dejarlo sin una forma de ejercitarlo, no.
 *
 * Es el mismo criterio con el que §2.3 entregó `check-access.sh`: cuando algo no
 * se puede cerrar desde acá, se entrega el comando que lo cierra desde donde sí
 * se puede. Quien tenga salida peruana ejercita el adapter entero con esto y
 * sabe, en una corrida, cuál de los supuestos pendientes se sostiene.
 *
 * ## Lo que separa, que es lo que lo hace útil
 *
 * Tres cosas que se confunden y tienen arreglos completamente distintos:
 *
 * | Desenlace | Qué significa | Qué hacer |
 * |---|---|---|
 * | **Bloqueo** | `403` del WAF: no llegamos al portal | `check-access.sh`, o una salida peruana |
 * | **Supuesto refutado** | Llegamos, y el markup no es el que el adapter espera | capturar el request y corregir `pj-rows.ts` |
 * | **Fallo de protocolo** | Llegamos, el markup calza, y algo del ciclo JSF falló | mirar el `ViewState` y la cookie |
 *
 * Sin esa separación, un `403` se reporta como «el scraper no funciona» y manda
 * a arreglar el lugar equivocado. Es el mismo error de diagnóstico que §2.2
 * evitó a nivel de red, aplicado al nivel de arriba.
 *
 * Uso:   npm run smoke:pj
 *        PROXY_URL=http://usuario:clave@host:puerto npm run smoke:pj
 */

import { loadConfig } from '../src/config.ts';
import { AccessDeniedError, TransportError } from '../src/http/errors.ts';
import { CircuitBreaker } from '../src/http/circuit-breaker.ts';
import { RateLimiter } from '../src/http/rate-limiter.ts';
import { createSession } from '../src/http/session.ts';
import { JsfView } from '../src/jsf/view.ts';
import { createLogger } from '../src/obs/logger.ts';
import { Metrics } from '../src/obs/metrics.ts';
import { SourceError, StructuralDriftError } from '../src/sources/errors.ts';
import { createPjSource } from '../src/sources/pj.ts';
import { CAMPOS_BUSQUEDA, FORMS_CONOCIDOS, URL_PJ } from '../src/sources/pj-rows.ts';

const PAGINAS = 2;

const paso = (s: string): void => console.log(`\n\x1b[1m${s}\x1b[0m`);
const ok = (s: string): void => console.log(`  ✓ ${s}`);
const mal = (s: string): void => console.log(`  ✗ ${s}`);
const nota = (s: string): void => console.log(`    ${s}`);

/** `0` el adapter funcionó · `1` supuesto refutado o fallo · `2` bloqueo de acceso. */
const SALIDA = { ok: 0, fallo: 1, bloqueado: 2 } as const;

async function main(): Promise<number> {
  const config = loadConfig();
  const metrics = new Metrics();
  const logger = createLogger({ level: config.LOG_LEVEL, pretty: config.LOG_PRETTY });

  paso(`Smoke del adapter del Poder Judicial — ${URL_PJ}`);
  nota(`proxy: ${config.PROXY_URL === undefined ? 'ninguno' : 'configurado'}`);
  nota('el adapter no se ejercitó nunca contra esta fuente: eso es lo que este script cambia');

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

  const view = new JsfView({ session, logger, metrics }, { pageUrl: URL_PJ });
  const fuente = createPjSource({ view, logger, metrics });

  let paginas = 0;
  let total = 0;
  let conDocumento = 0;

  try {
    paso(`Recorriendo las primeras ${PAGINAS} páginas`);

    for await (const pagina of fuente.recorrer({ hasta: PAGINAS })) {
      paginas += 1;
      total = pagina.total;
      conDocumento += pagina.filas.filter((f) => f.descarga !== undefined).length;

      ok(
        `página ${pagina.numero}: ${pagina.filas.length} fila(s), índices ` +
          `${pagina.filas[0]?.registro.indice ?? '?'}–${pagina.filas.at(-1)?.registro.indice ?? '?'}`,
      );

      const muestra = pagina.filas[0];
      if (pagina.numero === 1 && muestra !== undefined) {
        nota(`campos leídos: ${Object.keys(muestra.registro.campos).join(' · ') || '(ninguno)'}`);
        nota(`texto de la primera fila: ${muestra.registro.texto.slice(0, 90)}`);
        nota(
          muestra.descarga === undefined
            ? 'la primera fila no trae enlace de descarga'
            : `comando de descarga: ${Object.keys(muestra.descarga).join(', ')} ` +
                `→ form «${muestra.formulario ?? '(el de la vista)'}»`,
        );
      }
    }
  } catch (error) {
    return reportarFallo(error);
  }

  paso('Lo que esta corrida confirma');
  if (paginas === 0) {
    mal('el recorrido no emitió ninguna página');
    nota('el portal contestó, pero la búsqueda no devolvió resultados');
    return SALIDA.fallo;
  }

  ok(`${paginas} página(s) recorridas, total declarado por el sitio: ${total}`);
  ok(`${conDocumento} fila(s) con enlace de descarga legible`);
  ok(`state saving: el token mide ${view.snapshot().viewStateLength} bytes`);
  nota(
    view.snapshot().viewStateLength < 100
      ? 'corto: consistente con el server-side que muestran los fixtures del archivo'
      : 'largo: el portal habría pasado a client-side desde los snapshots de fixtures/pj/',
  );

  const s = metrics.snapshot();
  console.log(`\n  requests=${s.requests}  ok=${s.ok}  429=${s.throttled}  reintentos=${s.reintentos}`);
  console.log(`  contadores: ${JSON.stringify(s.contadores)}`);

  paso('OK — el adapter del Poder Judicial funciona contra su fuente');
  nota('actualizar §5.11 y el README: deja de ser código no ejercitado');
  return SALIDA.ok;
}

/**
 * Traduce el fallo al desenlace que corresponde.
 *
 * El orden importa: el bloqueo se comprueba primero porque es el único que no
 * dice nada sobre el adapter. Reportar un `403` como «supuesto refutado» mandaría
 * a corregir un parser que nunca llegó a correr.
 */
function reportarFallo(error: unknown): number {
  if (error instanceof AccessDeniedError) {
    paso('BLOQUEADO — no se llegó al portal');
    mal(`${error.name}: ${error.message}`);
    nota('esto NO dice nada sobre el adapter: el request no llegó a la aplicación');
    nota('diagnóstico por capas:  bash scripts/check-access.sh');
    nota('con salida peruana:     PROXY_URL=http://usuario:clave@host:puerto npm run smoke:pj');
    return SALIDA.bloqueado;
  }

  if (error instanceof StructuralDriftError) {
    paso('SUPUESTO REFUTADO — se llegó al portal y el markup no es el esperado');
    mal(`[${error.tipo}] ${error.message}`);
    console.log(`  contexto: ${JSON.stringify(error.contexto)}`);
    nota('');
    nota('Este es el desenlace más informativo de los tres: significa que el bloqueo');
    nota('se levantó y que ahora hay markup real contra el cual corregir el adapter.');
    nota('');
    nota(`forms conocidos:  ${FORMS_CONOCIDOS.join(', ')}`);
    nota(`campos conocidos: ${CAMPOS_BUSQUEDA.join(', ')}`);
    nota('');
    nota('Para cerrarlo:');
    nota('  1. bash scripts/capture-pj.sh --vivo   — deja el markup al lado de los fixtures');
    nota('  2. comparar contra fixtures/pj/02-busqueda-resultado.html');
    nota('  3. corregir src/sources/pj-rows.ts y agregar el caso a tests/pj-rows.test.ts');
    return SALIDA.fallo;
  }

  if (error instanceof SourceError) {
    paso('FALLO DEL ADAPTER');
    mal(`${error.name} [${error.kind}]: ${error.message}`);
    return SALIDA.fallo;
  }

  if (error instanceof TransportError) {
    paso('FALLO DE TRANSPORTE — se llegó a la red y no a una respuesta útil');
    mal(`${error.name} [${error.kind}]: ${error.message}`);
    nota('si es un timeout o un reset, reintentar; si se repite, revisar el proxy');
    return SALIDA.fallo;
  }

  paso('FALLO NO CONTROLADO');
  mal(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  return SALIDA.fallo;
}

main().then(
  (codigo) => process.exit(codigo),
  (error: unknown) => {
    console.error('\n✗ Fallo no controlado:', error);
    process.exit(SALIDA.fallo);
  },
);
