/**
 * Métricas de la corrida (§6.6): «Un scraper que reporta su propia salud es un
 * scraper que se puede operar.»
 *
 * Este bloque cubre lo que nace en el transporte. Los bloques siguientes agregan
 * páginas por minuto y tasa de éxito de descargas vía `increment()`, sin tener
 * que editar esta clase — por eso existe el contador genérico.
 */

export interface MetricsSnapshot {
  readonly duracionMs: number;
  readonly requests: number;
  readonly ok: number;
  readonly throttled: number;
  readonly fallidos: number;
  readonly reintentos: number;
  readonly tasaThrottling: number;
  readonly latenciaP50Ms: number;
  readonly latenciaP95Ms: number;
  readonly contadores: Readonly<Record<string, number>>;
}

export class Metrics {
  readonly iniciadaEn = Date.now();

  requests = 0;
  ok = 0;
  throttled = 0;
  fallidos = 0;
  reintentos = 0;

  readonly #latencias: number[] = [];
  readonly #contadores = new Map<string, number>();

  observarLatencia(ms: number): void {
    this.#latencias.push(ms);
  }

  /** Punto de extensión para los bloques 4–6 (páginas, PDFs, expiraciones de ViewState). */
  increment(nombre: string, delta = 1): void {
    this.#contadores.set(nombre, (this.#contadores.get(nombre) ?? 0) + delta);
  }

  snapshot(): MetricsSnapshot {
    const ordenadas = [...this.#latencias].sort((a, b) => a - b);
    return {
      duracionMs: Date.now() - this.iniciadaEn,
      requests: this.requests,
      ok: this.ok,
      throttled: this.throttled,
      fallidos: this.fallidos,
      reintentos: this.reintentos,
      tasaThrottling: this.requests === 0 ? 0 : this.throttled / this.requests,
      latenciaP50Ms: percentil(ordenadas, 0.5),
      latenciaP95Ms: percentil(ordenadas, 0.95),
      contadores: Object.fromEntries(this.#contadores),
    };
  }
}

/**
 * Las líneas de salud de la corrida, iguales en el camino feliz y en el de
 * fallo.
 *
 * Existen como función y no copiadas en cada CLI porque los caminos de fallo
 * eran los que se quedaban cortos: `download` imprimía **solo** `contadores` —el
 * mapa de extensión, vacío si la corrida murió antes de bajar nada— y `scrape`
 * no imprimía nada. Un `contadores: {}` como todo diagnóstico esconde el
 * `requests=3 fallidos=3 reintentos=2` que sí estaba medido y sí explica lo que
 * pasó.
 */
export function lineasDeSalud(s: MetricsSnapshot): string[] {
  const contadores = Object.keys(s.contadores).length === 0 ? '(ninguno)' : JSON.stringify(s.contadores);
  return [
    `  requests=${s.requests}  ok=${s.ok}  429=${s.throttled}  fallidos=${s.fallidos}  reintentos=${s.reintentos}`,
    `  latencia p50=${s.latenciaP50Ms} ms  p95=${s.latenciaP95Ms} ms`,
    `  contadores: ${contadores}`,
  ];
}

function percentil(ordenadas: readonly number[], p: number): number {
  if (ordenadas.length === 0) return 0;
  const indice = Math.min(ordenadas.length - 1, Math.floor(p * ordenadas.length));
  return Math.round(ordenadas[indice] ?? 0);
}
