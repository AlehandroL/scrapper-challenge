/**
 * Política de reintentos: full jitter, `Retry-After` con prioridad, y
 * presupuesto por clase de error.
 *
 * §5.6: «Full jitter: `random(0, min(cap, base × 2^n))`. Sin jitter, N workers
 * reintentan sincronizados y se auto-perpetúan.»
 *
 * Se implementa a mano en vez de usar `axios-retry` o `p-retry` porque ninguna
 * puede expresar las tres cosas que acá importan a la vez: el acople con el
 * limiter (cada intento vuelve a pedir token), la prioridad del header
 * `Retry-After` sobre el cálculo propio, y que un 403 **aborte** en lugar de
 * reintentar.
 */

import { CircuitOpenError, ThrottledError, TransportError } from './errors.ts';

/** Presupuesto de una clase de error: cuántos intentos y con qué base de backoff. */
export interface RetryBudget {
  /** Intentos totales, incluido el primero. `1` significa «sin reintentos». */
  readonly maxAttempts: number;
  /** Base del backoff exponencial en milisegundos. */
  readonly baseMs: number;
}

export interface RetryOptions {
  /** 429 — el servidor pide bajar el ritmo. */
  readonly throttled: RetryBudget;
  /** 5xx — el servidor está degradado; conviene ceder más espacio. */
  readonly unavailable: RetryBudget;
  /** Fallos de socket/DNS/timeout: transitorios y baratos de reintentar. */
  readonly network: RetryBudget;
  /** Circuito abierto: el delay lo dicta el breaker, la base casi no se usa. */
  readonly circuitOpen: RetryBudget;
  /** Techo del backoff exponencial. */
  readonly capMs: number;
  /** Techo del `Retry-After` recibido. */
  readonly maxRetryAfterMs: number;
}

export const RETRY_DEFAULTS: RetryOptions = {
  throttled: { maxAttempts: 5, baseMs: 1_000 },
  unavailable: { maxAttempts: 4, baseMs: 2_000 },
  network: { maxAttempts: 3, baseMs: 250 },
  circuitOpen: { maxAttempts: 4, baseMs: 1_000 },
  capMs: 60_000,
  // Un `Retry-After: 3600` —por error de configuración o por hostilidad— colgaría
  // la corrida una hora sin que nadie sepa por qué. Se respeta el header, pero
  // acotado: si el servidor realmente necesita más, el siguiente 429 lo repite.
  maxRetryAfterMs: 120_000,
};

/** Ganchos inyectables: sin ellos los tests de backoff tardarían minutos reales. */
export interface RetryHooks {
  readonly rng: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly onRetry?: (info: RetryInfo) => void;
}

export interface RetryInfo {
  readonly error: TransportError;
  /** Número del intento que acaba de fallar, empezando en 1. */
  readonly attempt: number;
  readonly delayMs: number;
}

const HOOKS_POR_DEFECTO: RetryHooks = {
  rng: Math.random,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Full jitter, tal cual §5.6: el delay es aleatorio **entre 0 y** el tope
 * exponencial, no el tope más un ruido.
 *
 * La diferencia importa: «tope + ruido» deja a todos los workers reintentando en
 * la misma ventana estrecha y el pico se reconstruye solo. Repartir uniforme en
 * todo el intervalo es lo que efectivamente los desincroniza.
 *
 * `rng` se recibe por parámetro en vez de mockear `Math.random` global: hace el
 * test determinista sin efectos colaterales sobre el resto de la suite.
 */
export function fullJitter(
  attempt: number,
  baseMs: number,
  capMs: number,
  rng: () => number = Math.random,
): number {
  const tope = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(rng() * tope);
}

/**
 * Parsea `Retry-After` en sus dos formas (RFC 9110 §10.2.3): delta-seconds o
 * HTTP-date. Devuelve `undefined` si el header falta o no es interpretable —
 * nunca `0`, que se confundiría con «reintentá ya».
 */
export function parseRetryAfter(
  raw: string | undefined | null,
  nowMs: number = Date.now(),
): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const valor = raw.trim();
  if (valor === '') return undefined;

  if (/^\d+$/.test(valor)) return Number(valor) * 1000;

  const instante = Date.parse(valor);
  if (Number.isNaN(instante)) return undefined;
  // Una fecha en el pasado significa «ya podés»: 0, no negativo.
  return Math.max(0, instante - nowMs);
}

function presupuesto(error: TransportError, opts: RetryOptions): RetryBudget {
  switch (error.kind) {
    case 'throttled':
      return opts.throttled;
    case 'server-unavailable':
      return opts.unavailable;
    case 'network':
      return opts.network;
    case 'circuit-open':
      return opts.circuitOpen;
    default:
      // Los no reintentables nunca llegan acá, pero un `default` explícito evita
      // que agregar una clase nueva la deje sin presupuesto por descuido.
      return { maxAttempts: 1, baseMs: 0 };
  }
}

function demora(
  error: TransportError,
  attempt: number,
  budget: RetryBudget,
  opts: RetryOptions,
  rng: () => number,
): number {
  // El breaker sabe exactamente cuánto falta de su cooldown: calcular un backoff
  // propio acá sería adivinar teniendo el dato.
  if (error instanceof CircuitOpenError) {
    return Math.min(opts.maxRetryAfterMs, Math.ceil(error.retryAfterMs));
  }

  // §5.6: «`Retry-After` tiene prioridad sobre el cálculo propio. El servidor
  // está diciendo explícitamente cuánto esperar.»
  if (error instanceof ThrottledError && error.retryAfterMs !== undefined) {
    return Math.min(opts.maxRetryAfterMs, error.retryAfterMs);
  }

  return fullJitter(attempt, budget.baseMs, opts.capMs, rng);
}

/**
 * Ejecuta `fn` reintentando según la clase del error.
 *
 * `fn` recibe el número de intento y se re-ejecuta **completa**: quien la
 * construya debe meter dentro el `limiter.acquire()`, de modo que los reintentos
 * también pasen por el throttling. Si el token se pidiera afuera, los reintentos
 * saltarían la tasa justo cuando el servidor pidió bajarla, y el 429 se
 * auto-perpetuaría.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = RETRY_DEFAULTS,
  hooks: Partial<RetryHooks> = {},
): Promise<T> {
  const { rng, sleep, onRetry } = { ...HOOKS_POR_DEFECTO, ...hooks };
  let attempt = 0;

  for (;;) {
    try {
      return await fn(attempt);
    } catch (error) {
      // Lo que no es un TransportError es un bug propio, no una falla de red:
      // propagar intacto y rápido, sin disfrazarlo de flakiness.
      if (!(error instanceof TransportError)) throw error;

      error.attempts = attempt + 1;
      if (!error.retryable) throw error;

      const budget = presupuesto(error, opts);
      if (error.attempts >= budget.maxAttempts) throw error;

      const delayMs = demora(error, attempt, budget, opts, rng);
      onRetry?.({ error, attempt: error.attempts, delayMs });
      await sleep(delayMs);
      attempt += 1;
    }
  }
}
