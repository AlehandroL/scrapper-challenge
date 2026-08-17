import { describe, expect, it, vi } from 'vitest';
import {
  AccessDeniedError,
  CircuitOpenError,
  HostUnreachableError,
  NetworkError,
  ServerUnavailableError,
  ThrottledError,
} from '../src/http/errors.ts';
import { RETRY_DEFAULTS, fullJitter, parseRetryAfter, withRetry } from '../src/http/retry.ts';

const CTX = { method: 'GET', url: 'http://ejemplo/x' };

/** Nunca duerme de verdad: registra cuánto le pidieron dormir. */
function siestaFalsa() {
  const esperas: number[] = [];
  return { esperas, sleep: async (ms: number) => void esperas.push(ms) };
}

describe('fullJitter', () => {
  it('con rng=1 devuelve el tope exponencial', () => {
    const uno = () => 1;
    expect(fullJitter(0, 1000, 60_000, uno)).toBe(1000);
    expect(fullJitter(1, 1000, 60_000, uno)).toBe(2000);
    expect(fullJitter(2, 1000, 60_000, uno)).toBe(4000);
    expect(fullJitter(3, 1000, 60_000, uno)).toBe(8000);
  });

  it('con rng=0 devuelve 0: el rango arranca en cero, no en el tope', () => {
    expect(fullJitter(5, 1000, 60_000, () => 0)).toBe(0);
  });

  it('nunca supera el cap', () => {
    expect(fullJitter(20, 1000, 60_000, () => 1)).toBe(60_000);
  });

  it('reparte en todo el intervalo y no alrededor del tope', () => {
    // La diferencia con «tope + ruido» es justamente ésta: si todas las muestras
    // cayeran cerca del tope, N workers reintentarían en la misma ventana y el
    // pico se reconstruiría solo.
    const muestras = Array.from({ length: 500 }, () => fullJitter(3, 1000, 60_000));
    expect(Math.min(...muestras)).toBeLessThan(1000);
    expect(Math.max(...muestras)).toBeGreaterThan(7000);
  });
});

describe('parseRetryAfter', () => {
  it('acepta delta-seconds', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
  });

  it('acepta HTTP-date', () => {
    const ahora = Date.parse('2026-08-13T12:00:00Z');
    expect(parseRetryAfter('Thu, 13 Aug 2026 12:00:30 GMT', ahora)).toBe(30_000);
  });

  it('una fecha pasada significa «ya», no un negativo', () => {
    const ahora = Date.parse('2026-08-13T12:00:00Z');
    expect(parseRetryAfter('Thu, 13 Aug 2026 11:59:00 GMT', ahora)).toBe(0);
  });

  it('devuelve undefined —no 0— cuando falta o no se entiende', () => {
    // Devolver 0 sería indistinguible de «reintentá ya» y saltaría el backoff.
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('  ')).toBeUndefined();
    expect(parseRetryAfter('pronto')).toBeUndefined();
  });
});

describe('withRetry', () => {
  it('reintenta hasta el presupuesto de la clase y después propaga', async () => {
    const { esperas, sleep } = siestaFalsa();
    const fn = vi.fn(async () => {
      throw new ThrottledError(CTX, 429, undefined);
    });

    await expect(withRetry(fn, RETRY_DEFAULTS, { sleep, rng: () => 1 })).rejects.toBeInstanceOf(
      ThrottledError,
    );

    expect(fn).toHaveBeenCalledTimes(RETRY_DEFAULTS.throttled.maxAttempts);
    expect(esperas).toEqual([1000, 2000, 4000, 8000]);
  });

  it('deja el conteo de intentos en el error para la DLQ del bloque 5', async () => {
    const { sleep } = siestaFalsa();
    const error = await withRetry(
      async () => {
        throw new ThrottledError(CTX, 429, undefined);
      },
      RETRY_DEFAULTS,
      { sleep, rng: () => 0 },
    ).catch((e: unknown) => e as ThrottledError);

    expect(error.attempts).toBe(5);
  });

  it('el Retry-After del servidor tiene prioridad sobre el jitter propio', async () => {
    const { esperas, sleep } = siestaFalsa();
    let intentos = 0;
    const resultado = await withRetry(
      async () => {
        if (++intentos === 1) throw new ThrottledError(CTX, 429, 7_000);
        return 'listo';
      },
      RETRY_DEFAULTS,
      { sleep, rng: () => 1 },
    );

    expect(resultado).toBe('listo');
    // Con rng=1 el jitter habría dado 1000 ms; se respeta el header.
    expect(esperas).toEqual([7_000]);
  });

  it('acota un Retry-After desmedido', async () => {
    const { esperas, sleep } = siestaFalsa();
    let intentos = 0;
    await withRetry(
      async () => {
        if (++intentos === 1) throw new ThrottledError(CTX, 429, 3_600_000);
        return 'listo';
      },
      RETRY_DEFAULTS,
      { sleep, rng: () => 0 },
    );

    // Una hora de espera colgaría la corrida sin que nadie sepa por qué.
    expect(esperas).toEqual([RETRY_DEFAULTS.maxRetryAfterMs]);
  });

  it('usa el cooldown que reporta el breaker en vez de calcular uno propio', async () => {
    const { esperas, sleep } = siestaFalsa();
    let intentos = 0;
    await withRetry(
      async () => {
        if (++intentos === 1) throw new CircuitOpenError(CTX, 4_321);
        return 'listo';
      },
      RETRY_DEFAULTS,
      { sleep, rng: () => 1 },
    );

    expect(esperas).toEqual([4_321]);
  });

  it('NO reintenta un 403: es política, no una condición transitoria', async () => {
    const { esperas, sleep } = siestaFalsa();
    const fn = vi.fn(async () => {
      throw new AccessDeniedError(CTX);
    });

    await expect(withRetry(fn, RETRY_DEFAULTS, { sleep })).rejects.toBeInstanceOf(AccessDeniedError);

    // Insistir sobre un 403 es cómo un throttling temporal escala a ban de IP.
    expect(fn).toHaveBeenCalledTimes(1);
    expect(esperas).toEqual([]);
  });

  it('reintenta un fallo de red transitorio con presupuesto corto', async () => {
    const { esperas, sleep } = siestaFalsa();
    const fn = vi.fn(async () => {
      throw new NetworkError(CTX, 'ECONNRESET', 'socket hang up');
    });

    await expect(withRetry(fn, RETRY_DEFAULTS, { sleep, rng: () => 1 })).rejects.toBeInstanceOf(
      NetworkError,
    );

    expect(fn).toHaveBeenCalledTimes(3);
    expect(esperas).toEqual([250, 500]);
  });

  it('no reintenta un host que no acepta conexiones', async () => {
    const { esperas, sleep } = siestaFalsa();
    const fn = vi.fn(async () => {
      throw new HostUnreachableError(CTX, 'ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.1:443');
    });

    // Un servicio caído no vuelve en 400 ms: tres viajes ahí no son recuperación,
    // son ruido con forma de reintento.
    await expect(withRetry(fn, RETRY_DEFAULTS, { sleep })).rejects.toBeInstanceOf(
      HostUnreachableError,
    );

    expect(fn).toHaveBeenCalledTimes(1);
    expect(esperas).toEqual([]);
  });

  it('lo decide el presupuesto y no la clase: subirlo alcanza para reintentar', async () => {
    const { esperas, sleep } = siestaFalsa();
    const fn = vi.fn(async () => {
      throw new HostUnreachableError(CTX, 'ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.1:443');
    });

    // La política vive en `RETRY_DEFAULTS.unreachable`, así que absorber el
    // rebote de un balanceador es cambiar un número y no editar la taxonomía.
    const opts = { ...RETRY_DEFAULTS, unreachable: { maxAttempts: 3, baseMs: 2_000 } };
    await expect(withRetry(fn, opts, { sleep, rng: () => 1 })).rejects.toBeInstanceOf(
      HostUnreachableError,
    );

    expect(fn).toHaveBeenCalledTimes(3);
    expect(esperas).toEqual([2_000, 4_000]);
  });

  it('no reintenta un error de red con código desconocido', async () => {
    const { sleep } = siestaFalsa();
    const fn = vi.fn(async () => {
      throw new NetworkError(CTX, undefined, 'algo raro');
    });

    // Envolver un bug propio y reintentarlo lo disfraza de flakiness de red.
    await expect(withRetry(fn, RETRY_DEFAULTS, { sleep })).rejects.toBeInstanceOf(NetworkError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('da más espacio a un 5xx que a un fallo de socket', async () => {
    const { esperas, sleep } = siestaFalsa();
    await expect(
      withRetry(
        async () => {
          throw new ServerUnavailableError(CTX, 503);
        },
        RETRY_DEFAULTS,
        { sleep, rng: () => 1 },
      ),
    ).rejects.toBeInstanceOf(ServerUnavailableError);

    expect(esperas).toEqual([2000, 4000, 8000]);
  });

  it('propaga intacto lo que no es un TransportError', async () => {
    const { sleep } = siestaFalsa();
    const bug = new TypeError('undefined no es una función');
    const fn = vi.fn(async () => {
      throw bug;
    });

    await expect(withRetry(fn, RETRY_DEFAULTS, { sleep })).rejects.toBe(bug);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reporta cada reintento por el hook, para métricas y logs', async () => {
    const { sleep } = siestaFalsa();
    const onRetry = vi.fn();
    let intentos = 0;

    await withRetry(
      async () => {
        if (++intentos < 3) throw new ThrottledError(CTX, 429, 1000);
        return 'listo';
      },
      RETRY_DEFAULTS,
      { sleep, onRetry },
    );

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ attempt: 1, delayMs: 1000 });
    expect(onRetry.mock.calls[1]?.[0]).toMatchObject({ attempt: 2, delayMs: 1000 });
  });
});
