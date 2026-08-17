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
