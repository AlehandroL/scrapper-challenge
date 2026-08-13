/**
 * Sesión HTTP: cookie jar propio, proxy opcional, y la orquestación de limiter,
 * reintentos y circuit breaker.
 *
 * **Esta capa no sabe qué es un `ViewState`.** No menciona JSF, ni OEFA, ni
 * jurisprudencia. Es la afirmación de §4 —«la capa `jsf/` no sabe nada de
 * jurisprudencia; la capa `sources/` no sabe nada de reintentos ni de cookies»—
 * sostenida desde abajo, y `tests/architecture.test.ts` la verifica en vez de
 * dejarla como promesa del README.
 *
 * Reparto de estado (§5.5): **el jar es por sesión; el limiter y el breaker son
 * globales.** El jar identifica una sesión JSF; la tasa y el breaker protegen al
 * servidor, que es uno solo. Por eso llegan inyectados y no se construyen acá:
 * N sesiones concurrentes se comportan como N navegadores distintos contra un
 * único servidor al que entre todas no deben pasarle por encima.
 */

import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { CookieJar, type Cookie } from 'tough-cookie';
import type { Readable } from 'node:stream';

import { USER_AGENT_POR_DEFECTO } from '../config.ts';
import { redactUrl, type Logger } from '../obs/logger.ts';
import type { Metrics } from '../obs/metrics.ts';
import type { CircuitBreaker } from './circuit-breaker.ts';
import {
  AccessDeniedError,
  NetworkError,
  ServerUnavailableError,
  ThrottledError,
  UnexpectedStatusError,
  type ErrorContext,
} from './errors.ts';
import type { RateLimiter } from './rate-limiter.ts';
import { RETRY_DEFAULTS, parseRetryAfter, withRetry, type RetryHooks, type RetryOptions } from './retry.ts';

export interface SessionDeps {
  readonly limiter: RateLimiter;
  readonly breaker: CircuitBreaker;
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly retry?: RetryOptions;
  readonly retryHooks?: Partial<RetryHooks>;
}

export interface SessionOptions {
  readonly id?: string;
  readonly userAgent?: string;
  readonly timeoutMs?: number;
  readonly proxyUrl?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export type FormFields = URLSearchParams | Readonly<Record<string, string>>;

export interface Session {
  /** Identifica la sesión en los logs cuando hay varias corriendo (§5.5). */
  readonly id: string;
  readonly jar: CookieJar;

  request<T = string>(cfg: AxiosRequestConfig): Promise<AxiosResponse<T>>;
  get(url: string, cfg?: AxiosRequestConfig): Promise<AxiosResponse<string>>;
  postForm(url: string, campos: FormFields, cfg?: AxiosRequestConfig): Promise<AxiosResponse<string>>;
  /** Para las descargas de PDF (§5.4): valida los primeros bytes antes de tocar disco. */
  stream(url: string, cfg?: AxiosRequestConfig): Promise<AxiosResponse<Readable>>;

  cookies(url: string): Promise<Cookie[]>;
  /**
   * Afordancia para el modo de falla silencioso de §2.5: sin `JSESSIONID` la
   * paginación devuelve `200` con la tabla vacía, sin excepción. El adapter
   * asevera esto después del bootstrap en vez de descubrirlo como «el selector
   * dejó de matchear».
   */
  hasCookie(url: string, nombre: string): Promise<boolean>;
}

let contadorSesiones = 0;

export function createSession(deps: SessionDeps, opts: SessionOptions = {}): Session {
  const id = opts.id ?? `s${++contadorSesiones}`;
  const jar = new CookieJar();
  const retry = deps.retry ?? RETRY_DEFAULTS;
  const log = deps.logger.child({ sesion: id });

  const proxyUrl = opts.proxyUrl;
  const agent = proxyUrl === undefined ? undefined : new HttpsProxyAgent(proxyUrl);
  if (proxyUrl !== undefined) {
    log.info({ proxy: new URL(proxyUrl).host }, 'sesión con proxy');
  }

  const instance: AxiosInstance = wrapper(
    axios.create({
      jar,
      withCredentials: true,
      timeout: opts.timeoutMs ?? 30_000,
      maxRedirects: 5,
      // El sitio devuelve HTML/XML; el default de axios (JSON) intentaría parsear
      // y rompería. La transformación la hacen las capas de arriba.
      responseType: 'text',
      transitional: { silentJSONParsing: false, forcedJSONParsing: false, clarifyTimeoutError: true },
      headers: {
        'User-Agent': opts.userAgent ?? USER_AGENT_POR_DEFECTO,
        'Accept-Language': 'es-PE,es;q=0.9,en;q=0.8',
        ...opts.headers,
      },
      ...(agent === undefined
        ? {}
        : // `proxy: false` desactiva el manejo propio de axios: con un agent
          // explícito, dejar los dos activos hace que se pisen.
          { httpAgent: agent, httpsAgent: agent, proxy: false as const }),
    }),
  );

  async function request<T = string>(cfg: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    const ctx: ErrorContext = {
      method: (cfg.method ?? 'get').toUpperCase(),
      url: cfg.url ?? '',
    };

    return withRetry<AxiosResponse<T>>(
      async (attempt) => {
        // Orden deliberado: el breaker primero (barato, corta sin consumir
        // token), después el token. Y ambos **dentro** de la función que se
        // reintenta, para que los reintentos no salten el throttling justo
        // cuando el servidor pidió bajar el ritmo.
        deps.breaker.assertClosed(ctx);
        await deps.limiter.acquire();

        deps.metrics.requests += 1;
        const t0 = performance.now();

        let res: AxiosResponse<T>;
        try {
          // `validateStatus` siempre nuestro: la clasificación por código es de
          // esta capa (§5.6) y no se delega a axios ni se deja sobrescribir.
          res = await instance.request<T>({ ...cfg, validateStatus: () => true });
        } catch (error) {
          deps.metrics.fallidos += 1;
          deps.breaker.recordDegraded();
          const err = aNetworkError(error, ctx);
          log.warn({ url: redactUrl(ctx.url), code: err.code, attempt }, 'fallo de red');
          throw err;
        }

        deps.metrics.observarLatencia(performance.now() - t0);
        return clasificar<T>(res, ctx, deps, log);
      },
      retry,
      {
        ...deps.retryHooks,
        onRetry: (info) => {
          deps.metrics.reintentos += 1;
          log.warn(
            {
              url: redactUrl(info.error.url),
              kind: info.error.kind,
              attempt: info.attempt,
              delayMs: info.delayMs,
            },
            'reintentando',
          );
          deps.retryHooks?.onRetry?.(info);
        },
      },
    );
  }

  return {
    id,
    jar,
    request,
    get: (url, cfg) => request<string>({ ...cfg, method: 'get', url }),

    postForm: (url, campos, cfg) => {
      const body = campos instanceof URLSearchParams ? campos : new URLSearchParams(campos);
      return request<string>({
        ...cfg,
        method: 'post',
        url,
        // `URLSearchParams.toString()` percent-encodea en UTF-8, que es lo que el
        // sitio declara (`<?xml encoding='UTF-8'?>` en el partial-response).
        data: body.toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          ...cfg?.headers,
        },
      });
    },

    stream: (url, cfg) => request<Readable>({ ...cfg, method: cfg?.method ?? 'get', url, responseType: 'stream' }),

    cookies: (url) => jar.getCookies(url),
    hasCookie: async (url, nombre) => (await jar.getCookies(url)).some((c) => c.key === nombre),
  };
}

/**
 * Traduce el código HTTP a la taxonomía de `errors.ts` (§5.6).
 *
 * Cada rama que no es 2xx destruye el cuerpo antes de lanzar: con
 * `responseType: 'stream'` un 429 **también** trae stream, y si no se drena el
 * socket queda colgado. Unos pocos reintentos así agotan el pool de conexiones y
 * el síntoma —requests que se cuelgan sin timeout— no se parece en nada a la
 * causa.
 */
function clasificar<T>(
  res: AxiosResponse<T>,
  ctx: ErrorContext,
  deps: SessionDeps,
  log: Logger,
): AxiosResponse<T> {
  const { status } = res;

  if (status >= 200 && status < 300) {
    deps.metrics.ok += 1;
    deps.limiter.onSuccess();
    deps.breaker.recordSuccess();
    log.debug({ url: redactUrl(ctx.url), status, rps: Number(deps.limiter.rps.toFixed(2)) }, 'ok');
    return res;
  }

  descartarCuerpo(res.data);

  if (status === 429) {
    deps.metrics.throttled += 1;
    // El orden importa: bajar la tasa antes de lanzar hace que el reintento —que
    // vuelve a pedir token— ya sienta la tasa nueva.
    deps.limiter.onThrottled();
    deps.breaker.recordDegraded();
    const retryAfterMs = parseRetryAfter(cabecera(res, 'retry-after'));
    log.warn(
      { url: redactUrl(ctx.url), retryAfterMs, rps: Number(deps.limiter.rps.toFixed(2)) },
      '429 — bajando la tasa',
    );
    throw new ThrottledError(ctx, status, retryAfterMs);
  }

  deps.metrics.fallidos += 1;

  if (status === 403) {
    // Se registra como degradación aunque no se reintente: si una sesión recibe
    // 403, las demás deberían frenar también en vez de seguir golpeando.
    deps.breaker.recordDegraded();
    log.error({ url: redactUrl(ctx.url) }, '403 — posible bloqueo; la corrida se detiene');
    throw new AccessDeniedError(ctx);
  }

  if (status >= 500) {
    deps.breaker.recordDegraded();
    throw new ServerUnavailableError(ctx, status);
  }

  throw new UnexpectedStatusError(ctx, status);
}

function cabecera<T>(res: AxiosResponse<T>, nombre: string): string | undefined {
  const valor: unknown = res.headers[nombre];
  return typeof valor === 'string' ? valor : undefined;
}

function descartarCuerpo(data: unknown): void {
  if (data !== null && typeof data === 'object' && 'destroy' in data) {
    const destroy = (data as { destroy: unknown }).destroy;
    if (typeof destroy === 'function') (data as Readable).destroy();
  }
}

function aNetworkError(error: unknown, ctx: ErrorContext): NetworkError {
  if (axios.isAxiosError(error)) {
    return new NetworkError(ctx, error.code, error.message);
  }
  const detalle = error instanceof Error ? error.message : String(error);
  // Sin código conocido `NetworkError` se marca no reintentable: envolver un bug
  // propio y reintentarlo cinco veces lo disfraza de flakiness de red.
  return new NetworkError(ctx, undefined, detalle);
}
