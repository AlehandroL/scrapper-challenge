import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cerrarLogs, createLogger, redactUrl, vaciarLogs } from '../src/obs/logger.ts';
import { Metrics, lineasDeSalud } from '../src/obs/metrics.ts';
import { loadConfig } from '../src/config.ts';

describe('redactUrl', () => {
  it('borra el jsessionid que JSF reescribe en el path', () => {
    // Tomado tal cual del <form action> de fixtures/oefa/01-bootstrap.html.
    const url = 'https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml;jsessionid=A1B2C3D4E5';
    expect(redactUrl(url)).toBe(
      'https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml;jsessionid=REDACTED',
    );
  });

  it('conserva el query string', () => {
    expect(redactUrl('http://x/y.xhtml;jsessionid=DEADBEEF?a=1&b=2')).toBe(
      'http://x/y.xhtml;jsessionid=REDACTED?a=1&b=2',
    );
  });

  it('deja intacta una URL sin jsessionid', () => {
    expect(redactUrl('http://x/y.xhtml?a=1')).toBe('http://x/y.xhtml?a=1');
  });
});

describe('Metrics', () => {
  it('calcula percentiles y tasa de throttling', () => {
    const m = new Metrics();
    m.requests = 10;
    m.throttled = 2;
    for (const ms of [10, 20, 30, 40, 500]) m.observarLatencia(ms);

    const s = m.snapshot();
    expect(s.tasaThrottling).toBe(0.2);
    expect(s.latenciaP50Ms).toBe(30);
    expect(s.latenciaP95Ms).toBe(500);
  });

  it('acepta contadores de otras capas sin tener que conocerlas', () => {
    const m = new Metrics();
    m.increment('paginas');
    m.increment('paginas', 4);
    expect(m.snapshot().contadores).toEqual({ paginas: 5 });
  });
});

describe('loadConfig', () => {
  it('aplica defaults conservadores con el entorno vacío', () => {
    const c = loadConfig({});
    expect(c.HTTP_RPS).toBe(1);
    expect(c.HTTP_MAX_RPS).toBe(5);
    expect(c.PROXY_URL).toBeUndefined();
  });

  it('coacciona números desde strings', () => {
    expect(loadConfig({ HTTP_RPS: '2.5' }).HTTP_RPS).toBe(2.5);
  });

  it('falla al arrancar ante un valor inválido, no en la página 900', () => {
    // Sin validación, esto degrada a NaN y el limiter se cuelga en un
    // setTimeout(NaN) sin decir por qué.
    expect(() => loadConfig({ HTTP_RPS: 'cinco' })).toThrow(/HTTP_RPS/);
  });

  it('rechaza un piso de tasa mayor que el techo', () => {
    expect(() => loadConfig({ HTTP_MIN_RPS: '9', HTTP_MAX_RPS: '2' })).toThrow(/HTTP_MIN_RPS/);
  });

  it('rechaza un PROXY_URL que no es una URL', () => {
    expect(() => loadConfig({ PROXY_URL: 'no-es-url' })).toThrow(/PROXY_URL/);
  });

  /**
   * La tasa inicial tiene que caer dentro del rango del ajuste AIMD.
   *
   * Con `HTTP_RPS=10` y el techo por defecto en 5, el limiter arrancaba al doble
   * de lo permitido y solo bajaba después de una racha de éxitos: la ráfaga
   * inicial —lo que un WAF mira— salía por encima del techo que el operador creyó
   * fijar. Por debajo del piso el efecto es el inverso y más raro todavía: el
   * primer 429 *sube* la tasa, porque el AIMD la lleva al mínimo configurado.
   */
  it.each([
    ['por encima del techo', { HTTP_RPS: '10' }],
    ['por debajo del piso', { HTTP_RPS: '0.01' }],
  ])('rechaza una tasa inicial %s del rango AIMD', (_caso, env) => {
    expect(() => loadConfig(env)).toThrow(/HTTP_RPS/);
  });

  it('acepta una tasa inicial que cae dentro del rango', () => {
    expect(loadConfig({ HTTP_RPS: '10', HTTP_MAX_RPS: '20' }).HTTP_RPS).toBe(10);
  });
});

describe('lineasDeSalud', () => {
  it('reporta los fallidos y no solo los contadores de extensión', () => {
    const m = new Metrics();
    m.requests = 3;
    m.fallidos = 3;
    m.reintentos = 2;

    const [salud, , contadores] = lineasDeSalud(m.snapshot());

    // Lo que el camino de fallo escondía: la corrida que muere en el primer
    // request igual tiene números, y son los que explican qué pasó.
    expect(salud).toContain('requests=3');
    expect(salud).toContain('fallidos=3');
    expect(salud).toContain('reintentos=2');
    // `contadores: {}` se leía como «no hay métricas», que no era el caso.
    expect(contadores).toContain('(ninguno)');
  });

  it('serializa los contadores de las capas de arriba cuando hay alguno', () => {
    const m = new Metrics();
    m.increment('paginas', 4);

    expect(lineasDeSalud(m.snapshot())[2]).toContain('{"paginas":4}');
  });
});

describe('cierre del logging', () => {
  it('vaciar y cerrar resuelven sin transport', async () => {
    const logger = createLogger({ level: 'silent', pretty: false });

    await expect(vaciarLogs(logger)).resolves.toBeUndefined();
    await expect(cerrarLogs()).resolves.toBeUndefined();
  });

  it('cierra el worker de pino-pretty en vez de dejarlo en vuelo', async () => {
    // `silent` para no ensuciar la salida de la suite: lo que se prueba es que el
    // cierre termine —si colgara, colgaría también la salida de cada CLI—, no lo
    // que imprime.
    const logger = createLogger({ level: 'silent', pretty: true });
    logger.warn('línea de prueba');

    await expect(vaciarLogs(logger)).resolves.toBeUndefined();
    await expect(cerrarLogs()).resolves.toBeUndefined();
  });
});

/**
 * Toda variable validada tiene que **llegar a algún lado**.
 *
 * `HTTP_MAX_RETRY_AFTER_MS` se validaba con zod y estaba documentada en el
 * README, pero ningún CLI se la pasaba a `createSession`: la sesión caía a
 * `RETRY_DEFAULTS` y el tope quedaba clavado en los 120 s del default. Ponerla
 * en el entorno no hacía nada, en silencio y sin error.
 *
 * Ese es el modo de falla peor de una configuración: no el valor inválido —de
 * eso ya se ocupan los tests de arriba— sino el valor válido que se ignora.
 * Quien lo setea cree haber acotado la espera y no la acotó, y el síntoma
 * aparece recién cuando un portal manda un `Retry-After` grande.
 *
 * El test lee los fuentes en vez de ejercitar los cuatro `main()` porque lo que
 * hay que impedir es exactamente eso: que alguien agregue una variable al schema
 * y se olvide de cablearla. Es el mismo criterio de `architecture.test.ts`.
 */
describe('el cableado de la configuración', () => {
  const DIR_SRC = join(import.meta.dirname, '..', 'src');
  const CLIS = ['scrape.ts', 'download.ts', 'validate.ts', 'retry-failed.ts'];

  const declaradas = (): string[] => {
    const fuente = readFileSync(join(DIR_SRC, 'config.ts'), 'utf8');
    const cuerpo = /const EnvSchema = z\.object\(\{([\s\S]*?)\n\}\);/.exec(fuente)?.[1] ?? '';
    return [...cuerpo.matchAll(/^  ([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1] ?? '');
  };

  it('encuentra las variables del schema', () => {
    expect(declaradas()).toContain('HTTP_MAX_RETRY_AFTER_MS');
  });

  it.each(CLIS)('%s consume todas las variables validadas', (cli) => {
    const fuente = readFileSync(join(DIR_SRC, 'cli', cli), 'utf8');
    const huerfanas = declaradas().filter((v) => !fuente.includes(`config.${v}`));

    expect(huerfanas).toEqual([]);
  });
});
