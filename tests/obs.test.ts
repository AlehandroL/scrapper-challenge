import { describe, expect, it } from 'vitest';
import { redactUrl } from '../src/obs/logger.ts';
import { Metrics } from '../src/obs/metrics.ts';
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
