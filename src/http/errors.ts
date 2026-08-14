/**
 * Taxonomía de errores de transporte.
 *
 * §5.6 del documento de estrategia: «Diferenciar códigos: 429 → backoff +
 * reducción de tasa; 403 → posible ban, detener y alertar; 503 → backoff largo;
 * ECONNRESET/timeout → reintento inmediato acotado. Tratarlos todos igual es el
 * error frecuente.»
 *
 * La política vive en el tipo y no en un `switch` disperso por el código: quien
 * reintenta hace un `instanceof` y ya sabe qué corresponde. Agregar un caso
 * nuevo es agregar una clase, no editar cinco condicionales que pueden quedar
 * desincronizadas entre sí.
 */

export interface ErrorContext {
  readonly method: string;
  readonly url: string;
}

export abstract class TransportError extends Error {
  /**
   * Discriminante estable para logs y métricas. No se usa el nombre de la clase
   * porque un minificador lo puede reescribir y las métricas históricas dejarían
   * de cuadrar.
   */
  abstract readonly kind: string;

  /**
   * Si reintentar tiene alguna chance de cambiar el resultado. Un 403 es una
   * decisión de política del servidor, no una condición transitoria.
   */
  abstract readonly retryable: boolean;

  /**
   * Si este error es evidencia de que **el servidor** está degradado. Es lo que
   * alimenta al circuit breaker.
   *
   * Es `abstract` y no un valor por defecto, a propósito: obliga a que toda
   * clase nueva declare su postura. La alternativa —que cada rama de
   * `session.ts` se acordara de avisarle al breaker— ya falló una vez: el camino
   * del `UnexpectedStatusError` no avisaba, y una sonda de `half-open` que
   * terminaba en 404 dejaba el circuito trabado **para siempre**, para todas las
   * sesiones. Con el miembro abstracto ese olvido no compila.
   *
   * `false` no significa «salió bien»: significa «esto no dice nada malo sobre
   * la salud del servidor».
   */
  abstract readonly degradaServidor: boolean;

  readonly method: string;
  readonly url: string;

  /** Intentos consumidos. Lo completa `withRetry()` antes de propagar. */
  attempts = 1;

  constructor(message: string, ctx: ErrorContext) {
    super(message);
    this.name = new.target.name;
    this.method = ctx.method;
    this.url = ctx.url;
  }
}

/**
 * 429. El servidor pide explícitamente bajar el ritmo.
 *
 * Se reintenta, pero lo importante pasa antes: el limiter reduce su tasa a la
 * mitad (AIMD). Los reintentos *curan* el 429; el throttling lo *previene*.
 */
export class ThrottledError extends TransportError {
  readonly kind = 'throttled';
  readonly retryable = true;
  readonly degradaServidor = true;
  readonly status: number;

  /** Milisegundos pedidos por `Retry-After`, si vino y era parseable. */
  readonly retryAfterMs: number | undefined;

  constructor(ctx: ErrorContext, status: number, retryAfterMs: number | undefined) {
    super(`HTTP ${status} — el servidor está throttleando`, ctx);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * 403. **No se reintenta.**
 *
 * Es la lección directa de §2.2: el 403 de jurisprudencia.pj.gob.pe resultó ser
 * una regla de política del WAF —diez pruebas por capas lo confirmaron, incluida
 * una huella TLS de Chrome real vía curl-impersonate— y no una condición
 * transitoria. Reintentarlo no lo cura, y sí es la vía más corta para que un
 * throttling temporal escale al ban de IP que §5.6 identifica como riesgo.
 *
 * La corrida se detiene y alerta. Es deliberado que duela.
 */
export class AccessDeniedError extends TransportError {
  readonly kind = 'access-denied';
  readonly retryable = false;
  /** Se reporta como degradación aunque no se reintente: si una sesión recibe
   *  403, las demás deberían frenar también en vez de seguir golpeando. */
  readonly degradaServidor = true;
  readonly status = 403;

  constructor(ctx: ErrorContext) {
    super(
      'HTTP 403 — acceso denegado. Posible bloqueo por WAF o ban de IP: ' +
        'la corrida se detiene en vez de insistir (ver §5.6).',
      ctx,
    );
  }
}

/** 5xx. El servidor está caído o degradado: backoff largo, no insistencia rápida. */
export class ServerUnavailableError extends TransportError {
  readonly kind = 'server-unavailable';
  readonly retryable = true;
  readonly degradaServidor = true;
  readonly status: number;

  constructor(ctx: ErrorContext, status: number) {
    super(`HTTP ${status} — servidor no disponible`, ctx);
    this.status = status;
  }
}

/** Cualquier otro código fuera de 2xx. No se reintenta: no es transitorio. */
export class UnexpectedStatusError extends TransportError {
  readonly kind = 'unexpected-status';
  readonly retryable = false;
  /** Un 404 o un 400 son respuestas HTTP legítimas: prueba de que el servidor
   *  está vivo, no de que esté degradado. Abrir el circuito por esto sería
   *  castigar al servidor por un error nuestro. */
  readonly degradaServidor = false;
  readonly status: number;

  constructor(ctx: ErrorContext, status: number) {
    super(`HTTP ${status} — código inesperado`, ctx);
    this.status = status;
  }
}

/**
 * Códigos de error de red que sí vale la pena reintentar: son fallos de
 * transporte, no respuestas del servidor. Un `ECONNREFUSED` contra un puerto
 * equivocado también entra acá, y por eso el presupuesto de reintentos para esta
 * clase es corto.
 */
const CODIGOS_TRANSITORIOS: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNABORTED', // axios marca así los timeouts
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EPIPE',
  'EAI_AGAIN', // fallo temporal de DNS
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_NETWORK',
]);

/**
 * Fallo por debajo de HTTP: socket cortado, DNS, timeout.
 *
 * `retryable` se decide por el código en vez de ser fijo: envolver un error
 * desconocido y reintentarlo cinco veces esconde bugs propios detrás de lo que
 * parece flakiness de red.
 */
export class NetworkError extends TransportError {
  readonly kind = 'network';
  readonly retryable: boolean;
  /** Vale incluso con un código desconocido: si el socket falló, algo entre
   *  nosotros y el servidor no está sano. */
  readonly degradaServidor = true;
  readonly code: string | undefined;

  constructor(ctx: ErrorContext, code: string | undefined, detalle: string) {
    super(`Fallo de red (${code ?? 'sin código'}): ${detalle}`, ctx);
    this.code = code;
    this.retryable = code !== undefined && CODIGOS_TRANSITORIOS.has(code);
  }
}

/**
 * El circuit breaker está abierto: hay degradación sostenida y toca esperar.
 *
 * Es reintentable a propósito. Así el breaker y la política de reintentos
 * componen sin conocerse: el breaker dice cuánto falta, `retry.ts` espera ese
 * tiempo exacto en vez de calcular un backoff propio que lo ignoraría.
 */
export class CircuitOpenError extends TransportError {
  readonly kind = 'circuit-open';
  readonly retryable = true;
  /** Lo lanza el propio breaker **antes** de que salga el request, así que
   *  nunca se le reporta de vuelta. Declararlo igual es lo que pide el tipo. */
  readonly degradaServidor = false;
  readonly retryAfterMs: number;

  constructor(ctx: ErrorContext, retryAfterMs: number) {
    super(`Circuito abierto — reintentar en ${Math.round(retryAfterMs)} ms`, ctx);
    this.retryAfterMs = retryAfterMs;
  }
}
