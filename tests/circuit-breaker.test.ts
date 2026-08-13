import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from '../src/http/circuit-breaker.ts';
import { CircuitOpenError } from '../src/http/errors.ts';

const CTX = { method: 'GET', url: 'http://ejemplo/x' };

/** Reloj manual: el cooldown se prueba adelantando el tiempo, no esperándolo. */
function relojManual() {
  let t = 0;
  return {
    now: () => t,
    avanzar: (ms: number) => {
      t += ms;
    },
  };
}

describe('CircuitBreaker', () => {
  it('empieza cerrado y deja pasar', () => {
    const breaker = new CircuitBreaker();
    expect(breaker.state).toBe('closed');
    expect(() => breaker.assertClosed(CTX)).not.toThrow();
  });

  it('no abre con pocas muestras: dos fallos seguidos no son una tendencia', () => {
    const breaker = new CircuitBreaker({ minSamples: 5, threshold: 0.5 });
    breaker.recordDegraded();
    breaker.recordDegraded();
    expect(breaker.state).toBe('closed');
  });

  it('abre cuando la degradación supera el umbral', () => {
    const breaker = new CircuitBreaker({ minSamples: 4, threshold: 0.5 });
    breaker.recordSuccess();
    breaker.recordSuccess();
    breaker.recordDegraded();
    expect(breaker.state).toBe('closed');
    breaker.recordDegraded();
    expect(breaker.state).toBe('open');
    expect(breaker.aperturas).toBe(1);
  });

  it('abierto, rechaza informando cuánto falta del cooldown', () => {
    const reloj = relojManual();
    const breaker = new CircuitBreaker({ minSamples: 1, threshold: 1, cooldownMs: 30_000 }, reloj.now);
    breaker.recordDegraded();

    reloj.avanzar(10_000);
    const error = capturar(() => breaker.assertClosed(CTX));
    expect(error).toBeInstanceOf(CircuitOpenError);
    expect((error as CircuitOpenError).retryAfterMs).toBe(20_000);
  });

  it('cumplido el cooldown deja pasar exactamente una sonda', () => {
    const reloj = relojManual();
    const breaker = new CircuitBreaker({ minSamples: 1, threshold: 1, cooldownMs: 1000 }, reloj.now);
    breaker.recordDegraded();
    reloj.avanzar(1001);

    expect(() => breaker.assertClosed(CTX)).not.toThrow();
    expect(breaker.state).toBe('half-open');

    // Abrir la compuerta de golpe contra un servidor que todavía no se sabe si
    // se recuperó es cómo se vuelve a tumbar.
    expect(capturar(() => breaker.assertClosed(CTX))).toBeInstanceOf(CircuitOpenError);
  });

  it('si la sonda pasa, cierra y olvida los fallos viejos', () => {
    const reloj = relojManual();
    const breaker = new CircuitBreaker(
      { minSamples: 2, threshold: 0.5, cooldownMs: 1000 },
      reloj.now,
    );
    breaker.recordDegraded();
    breaker.recordDegraded();
    reloj.avanzar(1001);
    breaker.assertClosed(CTX);
    breaker.recordSuccess();

    expect(breaker.state).toBe('closed');

    // Con la ventana sin limpiar, el próximo tropiezo reabriría de inmediato.
    breaker.recordDegraded();
    expect(breaker.state).toBe('closed');
  });

  it('si la sonda falla, reabre con el cooldown completo', () => {
    const reloj = relojManual();
    const breaker = new CircuitBreaker({ minSamples: 1, threshold: 1, cooldownMs: 1000 }, reloj.now);
    breaker.recordDegraded();
    reloj.avanzar(1001);
    breaker.assertClosed(CTX);
    breaker.recordDegraded();

    expect(breaker.state).toBe('open');
    expect(breaker.aperturas).toBe(2);
    expect(capturar(() => breaker.assertClosed(CTX))).toBeInstanceOf(CircuitOpenError);
  });

  it('la ventana desliza: los fallos viejos dejan de contar', () => {
    const breaker = new CircuitBreaker({ windowSize: 4, minSamples: 4, threshold: 0.75 });
    breaker.recordDegraded();
    breaker.recordDegraded();
    breaker.recordSuccess();
    breaker.recordSuccess();
    expect(breaker.state).toBe('closed');

    breaker.recordSuccess();
    breaker.recordSuccess();
    breaker.recordSuccess();
    expect(breaker.state).toBe('closed');
  });
});

function capturar(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}
