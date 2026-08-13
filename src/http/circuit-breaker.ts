/**
 * Circuit breaker: válvula de seguridad ante degradación sostenida.
 *
 * §5.6 lo lista como mecanismo propio: «Pausa global si la tasa de 429 supera un
 * umbral». El AIMD del limiter ya baja la tasa ante cada 429, pero baja *desde
 * donde está*: si el servidor entra en crisis, seguir goteando requests alarga la
 * crisis. El breaker corta del todo y espera.
 *
 * Importa especialmente acá por el riesgo declarado en §7: «Rate limiting del WAF
 * escala a ban de IP». Perder la tasa un minuto es barato; perder la fuente, no.
 *
 * Como el limiter, es **global** y compartido por todas las sesiones (§5.5).
 */

import { CircuitOpenError, type ErrorContext } from './errors.ts';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Cuántos resultados recientes se consideran. */
  readonly windowSize: number;
  /** Proporción de degradados (0..1) que abre el circuito. */
  readonly threshold: number;
  /** Muestras mínimas antes de poder abrir: dos fallos seguidos no son una tendencia. */
  readonly minSamples: number;
  /** Cuánto permanece abierto antes de dejar pasar una sonda. */
  readonly cooldownMs: number;
  /** Qué se le dice a quien llega mientras otra sonda está en vuelo. */
  readonly probeWaitMs: number;
}

export const CIRCUIT_BREAKER_DEFAULTS: CircuitBreakerOptions = {
  windowSize: 20,
  threshold: 0.5,
  minSamples: 5,
  cooldownMs: 30_000,
  probeWaitMs: 1_000,
};

export class CircuitBreaker {
  readonly #opts: CircuitBreakerOptions;
  readonly #now: () => number;

  /** Ventana deslizante; `true` = resultado degradado. */
  #ventana: boolean[] = [];
  #estado: CircuitState = 'closed';
  #abiertoEn = 0;
  #sondaEnVuelo = false;
  #aperturas = 0;

  constructor(opts: Partial<CircuitBreakerOptions> = {}, now: () => number = () => Date.now()) {
    this.#opts = { ...CIRCUIT_BREAKER_DEFAULTS, ...opts };
    this.#now = now;
  }

  get state(): CircuitState {
    return this.#estado;
  }

  /** Cuántas veces se abrió en la corrida. §6.6: un scraper que reporta su salud se puede operar. */
  get aperturas(): number {
    return this.#aperturas;
  }

  /**
   * Puerta de entrada. Lanza `CircuitOpenError` si no corresponde salir todavía.
   *
   * Lanzar en vez de esperar internamente es deliberado: `CircuitOpenError` es
   * reintentable y lleva el remanente exacto de cooldown, así que `retry.ts`
   * espera ese tiempo y vuelve. Los dos componen sin conocerse, y el presupuesto
   * de intentos sigue acotando el total — un breaker que esperara por su cuenta
   * podría colgar la corrida sin límite.
   */
  assertClosed(ctx: ErrorContext): void {
    if (this.#estado === 'closed') return;

    if (this.#estado === 'open') {
      const restante = this.#opts.cooldownMs - (this.#now() - this.#abiertoEn);
      if (restante > 0) throw new CircuitOpenError(ctx, restante);
      // Cumplido el cooldown se deja pasar exactamente una sonda.
      this.#estado = 'half-open';
      this.#sondaEnVuelo = true;
      return;
    }

    // half-open: una sonda a la vez. Dejar pasar a todos acá sería reabrir la
    // compuerta de golpe contra un servidor que todavía no se sabe si se
    // recuperó.
    if (this.#sondaEnVuelo) throw new CircuitOpenError(ctx, this.#opts.probeWaitMs);
    this.#sondaEnVuelo = true;
  }

  recordSuccess(): void {
    if (this.#estado === 'half-open') {
      // La sonda pasó: se cierra y se limpia la ventana. Conservar los fallos
      // viejos haría que el circuito reabriera al primer tropiezo posterior.
      this.#estado = 'closed';
      this.#ventana = [];
      this.#sondaEnVuelo = false;
      return;
    }
    this.#registrar(false);
  }

  recordDegraded(): void {
    if (this.#estado === 'half-open') {
      this.#abrir();
      return;
    }
    this.#registrar(true);
    this.#evaluar();
  }

  #registrar(degradado: boolean): void {
    this.#sondaEnVuelo = false;
    this.#ventana.push(degradado);
    if (this.#ventana.length > this.#opts.windowSize) this.#ventana.shift();
  }

  #evaluar(): void {
    if (this.#estado !== 'closed') return;
    if (this.#ventana.length < this.#opts.minSamples) return;
    const degradados = this.#ventana.reduce((n, d) => (d ? n + 1 : n), 0);
    if (degradados / this.#ventana.length >= this.#opts.threshold) this.#abrir();
  }

  #abrir(): void {
    this.#estado = 'open';
    this.#abiertoEn = this.#now();
    this.#sondaEnVuelo = false;
    this.#ventana = [];
    this.#aperturas += 1;
  }
}
