import { describe, expect, it } from 'vitest';
import { RateLimiter, type RateLimiterClock } from '../src/http/rate-limiter.ts';

/**
 * Reloj virtual: `sleep()` adelanta el tiempo en vez de esperarlo.
 *
 * Probar un token bucket con temporizadores reales convertiría esta suite en
 * minutos de espera. Como el limiter recibe su reloj por inyección, no hace
 * falta ni siquiera `vi.useFakeTimers()`: el control es total y determinista.
 */
function relojVirtual(): RateLimiterClock & { readonly transcurridoMs: number; readonly siestas: number[] } {
  let t = 0;
  const siestas: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      siestas.push(ms);
      t += ms;
    },
    get transcurridoMs() {
      return t;
    },
    get siestas() {
      return siestas;
    },
  };
}

describe('RateLimiter', () => {
  it('deja salir la ráfaga inicial sin esperar', async () => {
    const reloj = relojVirtual();
    const limiter = new RateLimiter({ rps: 1, burst: 3 }, reloj);

    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();

    expect(reloj.siestas).toEqual([]);
    expect(reloj.transcurridoMs).toBe(0);
  });

  it('agotada la ráfaga, espacia los requests según la tasa', async () => {
    const reloj = relojVirtual();
    const limiter = new RateLimiter({ rps: 2, burst: 1 }, reloj);

    for (let i = 0; i < 5; i++) await limiter.acquire();

    // El primero sale con el token de ráfaga; los otros cuatro esperan 500 ms.
    expect(reloj.siestas).toEqual([500, 500, 500, 500]);
    expect(reloj.transcurridoMs).toBe(2000);
  });

  it('respeta el orden de llegada con waiters concurrentes', async () => {
    const reloj = relojVirtual();
    const limiter = new RateLimiter({ rps: 1, burst: 1 }, reloj);
    const orden: number[] = [];

    await Promise.all(
      [0, 1, 2, 3].map(async (i) => {
        await limiter.acquire();
        orden.push(i);
      }),
    );

    // Sin la cola FIFO los cuatro leerían el mismo estado del bucket y saldrían
    // juntos, que es exactamente lo que el limiter debe impedir.
    expect(orden).toEqual([0, 1, 2, 3]);
  });

  describe('AIMD', () => {
    it('parte la tasa a la mitad ante un 429', () => {
      const limiter = new RateLimiter({ rps: 4, minRps: 0.2 }, relojVirtual());
      limiter.onThrottled();
      expect(limiter.rps).toBe(2);
      limiter.onThrottled();
      expect(limiter.rps).toBe(1);
    });

    it('no baja del piso por más 429 que reciba', () => {
      const limiter = new RateLimiter({ rps: 1, minRps: 0.5 }, relojVirtual());
      for (let i = 0; i < 10; i++) limiter.onThrottled();
      expect(limiter.rps).toBe(0.5);
    });

    it('vacía el bucket al throttlear', async () => {
      const reloj = relojVirtual();
      const limiter = new RateLimiter({ rps: 1, burst: 5 }, reloj);

      // Con 5 tokens acumulados, bajar la tasa no basta: si no se drena el
      // bucket, salen 5 requests de inmediato justo después de que el servidor
      // pidió lo contrario.
      limiter.onThrottled();
      await limiter.acquire();

      expect(reloj.siestas).toEqual([2000]); // 1 token a 0,5 rps
    });

    it('sube solo tras completar la racha de éxitos, y no pasa del techo', () => {
      const limiter = new RateLimiter(
        { rps: 1, maxRps: 1.2, successStreak: 3, increment: 0.1 },
        relojVirtual(),
      );

      limiter.onSuccess();
      limiter.onSuccess();
      expect(limiter.rps).toBe(1); // todavía no

      limiter.onSuccess();
      expect(limiter.rps).toBeCloseTo(1.1, 5);

      for (let i = 0; i < 30; i++) limiter.onSuccess();
      expect(limiter.rps).toBe(1.2);
    });

    it('un 429 resetea la racha en curso', () => {
      const limiter = new RateLimiter({ rps: 2, successStreak: 3, increment: 0.1 }, relojVirtual());

      limiter.onSuccess();
      limiter.onSuccess();
      limiter.onThrottled(); // rps 2 → 1 y racha a cero
      limiter.onSuccess();
      limiter.onSuccess();

      // Si la racha no se hubiera reseteado, acá ya habría subido.
      expect(limiter.rps).toBe(1);
    });
  });
});
