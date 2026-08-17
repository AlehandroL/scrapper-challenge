/**
 * Tests de la sesión contra un servidor HTTP real y efímero.
 *
 * Sin red externa: el servidor vive en `tests/helpers/test-server.ts` y escucha
 * en un puerto que asigna el SO. Ejercita el camino completo —axios, cookie jar,
 * sockets— y no un interceptor que lo simula.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CircuitBreaker } from '../src/http/circuit-breaker.ts';
import {
  AccessDeniedError,
  CircuitOpenError,
  HostUnreachableError,
  NetworkError,
  ServerUnavailableError,
  UnexpectedStatusError,
} from '../src/http/errors.ts';
import { RateLimiter } from '../src/http/rate-limiter.ts';
import { createSession, type SessionDeps } from '../src/http/session.ts';
import { silentLogger } from '../src/obs/logger.ts';
import { Metrics } from '../src/obs/metrics.ts';
import { startTestServer, type TestServer } from './helpers/test-server.ts';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

/** Limiter holgado y sleeps instantáneos: acá se prueba el transporte, no las esperas. */
function deps(overrides: Partial<SessionDeps> = {}): SessionDeps {
  return {
    limiter: new RateLimiter({ rps: 1000, burst: 100 }),
    breaker: new CircuitBreaker(),
    metrics: new Metrics(),
    logger: silentLogger,
    retryHooks: { sleep: async () => {}, rng: () => 0 },
    ...overrides,
  };
}

async function leerStream(stream: NodeJS.ReadableStream): Promise<string> {
  const trozos: Buffer[] = [];
  for await (const trozo of stream) trozos.push(Buffer.from(trozo as Buffer));
  return Buffer.concat(trozos).toString('utf8');
}

describe('Session', () => {
  it('hace un GET y contabiliza el éxito', async () => {
    const d = deps();
    const s = createSession(d);

    const res = await s.get(`${server.url}/ok`);

    expect(res.status).toBe(200);
    expect(res.data).toBe('ok');
    expect(d.metrics.ok).toBe(1);
    expect(d.metrics.requests).toBe(1);
  });

  describe('cookie jar', () => {
    it('persiste la cookie entre requests de la misma sesión', async () => {
      const s = createSession(deps());

      await s.get(`${server.url}/set-cookie`);
      const res = await s.get(`${server.url}/needs-cookie`);

      // §2.5: sin cookie el servidor responde 200 igual, solo que vacío. Es el
      // modo de falla que se confunde con «el selector dejó de matchear».
      expect(res.data).toBe('con-cookie');
      expect(await s.hasCookie(server.url, 'JSESSIONID')).toBe(true);
    });

    it('captura un Set-Cookie emitido dentro de una redirección', async () => {
      const s = createSession(deps());

      const res = await s.get(`${server.url}/redirect-with-cookie`);

      // Éste es el caso que justifica axios-cookiejar-support: axios sigue los
      // redirects internamente, así que un interceptor de respuesta casero nunca
      // vería este Set-Cookie y la cookie se perdería en silencio.
      expect(res.data).toBe('con-cookie');
    });

    it('sesiones distintas no comparten cookies (§5.5)', async () => {
      const compartidas = deps();
      const a = createSession(compartidas);
      const b = createSession(compartidas);

      await a.get(`${server.url}/set-cookie`);

      // N sesiones se comportan como N navegadores distintos, aunque compartan
      // limiter y breaker.
      expect(await b.hasCookie(server.url, 'JSESSIONID')).toBe(false);
      expect((await b.get(`${server.url}/needs-cookie`)).data).toBe('sin-cookie');
    });
  });

  describe('429', () => {
    it('reintenta, baja la tasa a la mitad y termina bien', async () => {
      const d = deps();
      const s = createSession(d);
      const rpsInicial = d.limiter.rps;

      const res = await s.get(`${server.url}/throttle?times=1&after=0`);

      expect(res.data).toBe('ok');
      expect(server.hits['/throttle']).toBe(2);
      expect(d.metrics.throttled).toBe(1);
      expect(d.metrics.reintentos).toBe(1);
      // El reintento cura el 429; bajar la tasa es lo que evita el siguiente.
      expect(d.limiter.rps).toBe(rpsInicial / 2);
    });

    it('entiende un Retry-After en formato HTTP-date', async () => {
      const d = deps();
      const s = createSession(d);

      const res = await s.get(`${server.url}/retry-after-date?times=1&seconds=1`);

      expect(res.data).toBe('ok');
      expect(d.metrics.throttled).toBe(1);
    });

    it('drena el cuerpo del 429 también en modo stream', async () => {
      const s = createSession(deps());

      // Con responseType: 'stream' un 429 trae stream igual. Si no se destruye,
      // el socket queda colgado y unos pocos reintentos agotan el pool: los
      // requests se cuelgan sin timeout y el síntoma no se parece a la causa.
      const res = await s.stream(`${server.url}/throttle-stream?times=1`);

      expect(await leerStream(res.data)).toBe('contenido');
      expect(server.hits['/throttle-stream']).toBe(2);
    });
  });

  describe('clasificación por código', () => {
    it('un 403 aborta sin reintentar', async () => {
      const d = deps();
      const s = createSession(d);

      await expect(s.get(`${server.url}/forbidden`)).rejects.toBeInstanceOf(AccessDeniedError);

      // Insistir sobre un 403 es cómo un throttling temporal escala a ban de IP.
      expect(server.hits['/forbidden']).toBe(1);
      expect(d.metrics.reintentos).toBe(0);
    });

    it('un 5xx se reintenta según su presupuesto y después propaga', async () => {
      const d = deps();
      const s = createSession(d);

      const error = await s.get(`${server.url}/unavailable`).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ServerUnavailableError);
      expect((error as ServerUnavailableError).attempts).toBe(4);
      expect(server.hits['/unavailable']).toBe(4);
    });

    it('un 404 no se reintenta: no es transitorio', async () => {
      const s = createSession(deps());

      await expect(s.get(`${server.url}/no-existe`)).rejects.toBeInstanceOf(UnexpectedStatusError);
      expect(server.hits['/no-existe']).toBe(1);
    });
  });

  it('reintenta un socket cortado y se recupera', async () => {
    const d = deps();
    const s = createSession(d);

    const res = await s.get(`${server.url}/flaky?destroy=2`);

    expect(res.data).toBe('ok');
    expect(d.metrics.reintentos).toBe(2);
  });

  it('agota el presupuesto ante un socket que nunca deja de cortarse', async () => {
    const s = createSession(deps());

    const error = await s.get(`${server.url}/flaky?destroy=99`).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).retryable).toBe(true);
    expect((error as NetworkError).attempts).toBe(3);
  });

  it('un host que rechaza la conexión falla al primer intento y dice qué comprobar', async () => {
    // Un servidor que existió y ya no: es la forma exacta del portal caído
    // —DNS resuelve, el puerto rechaza— sin depender de red externa.
    const muerto = await startTestServer();
    const url = `${muerto.url}/ok;jsessionid=DEADBEEF`;
    await muerto.close();

    const d = deps();
    const error = await createSession(d)
      .get(url)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HostUnreachableError);
    expect((error as HostUnreachableError).code).toBe('ECONNREFUSED');
    expect((error as HostUnreachableError).attempts).toBe(1);
    expect(d.metrics.reintentos).toBe(0);
    // El mensaje es lo único que ve quien corre el comando: sale sin líneas de
    // «reintentando» que lo contextualicen, así que carga el diagnóstico.
    expect((error as HostUnreachableError).message).toContain('El servidor rechaza la conexión');
    expect((error as HostUnreachableError).message).toContain('curl');
    // Y no filtra el id de sesión, que el sitio reescribe dentro del path.
    expect((error as HostUnreachableError).message).not.toContain('DEADBEEF');
  });

  it('el breaker corta ante degradación sostenida', async () => {
    const d = deps({
      breaker: new CircuitBreaker({ minSamples: 2, threshold: 1, cooldownMs: 60_000 }),
    });
    const s = createSession(d);

    const error = await s.get(`${server.url}/unavailable`).catch((e: unknown) => e);

    // Los 503 abren el circuito y el propio reintento se topa con él: breaker y
    // retry componen sin conocerse.
    expect(d.breaker.state).toBe('open');
    expect(error).toBeInstanceOf(CircuitOpenError);
    // Con el circuito abierto ya no se golpea al servidor.
    expect(server.hits['/unavailable']).toBe(2);
  });

  /**
   * La regresión del latch.
   *
   * El camino del `UnexpectedStatusError` era el único de `clasificar()` que no
   * le avisaba al breaker. Cuando ese 404 caía justo sobre la sonda de un
   * `half-open`, la sonda quedaba «en vuelo» para siempre: `assertClosed()`
   * rechazaba todo request posterior —de **todas** las sesiones, porque el
   * breaker es global— y ningún cooldown lo salvaba. Verificado en su momento
   * con un millón de ms de reloj virtual: seguía trabado.
   */
  it('un 404 durante la sonda del half-open no traba el circuito', async () => {
    let ahora = 0;
    const breaker = new CircuitBreaker(
      { minSamples: 2, threshold: 1, cooldownMs: 60_000 },
      () => ahora,
    );
    const d = deps({ breaker });
    const s = createSession(d);

    await s.get(`${server.url}/unavailable`).catch(() => {});
    expect(breaker.state).toBe('open');

    // Cumplido el cooldown pasa exactamente una sonda, y le toca un 404.
    ahora = 60_001;
    await expect(s.get(`${server.url}/no-existe`)).rejects.toBeInstanceOf(UnexpectedStatusError);

    // El servidor contestó: está vivo. La sonda se libera y el circuito cierra.
    expect(breaker.state).toBe('closed');
    expect((await s.get(`${server.url}/ok`)).data).toBe('ok');
  });

  it('una racha de 404 no abre el circuito: el servidor está contestando', async () => {
    const d = deps({ breaker: new CircuitBreaker({ minSamples: 2, threshold: 0.5 }) });
    const s = createSession(d);

    for (let i = 0; i < 5; i++) {
      await expect(s.get(`${server.url}/no-existe`)).rejects.toBeInstanceOf(UnexpectedStatusError);
    }

    // Un 404 es una respuesta HTTP legítima, no una señal de degradación. Cortar
    // la corrida por esto sería castigar al servidor por un error nuestro.
    expect(d.breaker.state).toBe('closed');
    expect(d.metrics.fallidos).toBe(5);
  });

  it('postForm envía urlencoded en UTF-8', async () => {
    const s = createSession(deps());

    await s.postForm(`${server.url}/echo`, {
      'javax.faces.partial.ajax': 'true',
      titulo: 'Resolución N° 264',
    });

    expect(server.ultimo.contentType).toBe('application/x-www-form-urlencoded; charset=UTF-8');
    expect(server.ultimo.body).toContain('javax.faces.partial.ajax=true');

    // El `°` viaja como %C2%B0 (UTF-8) y no como %B0 (ISO-8859-1). §5.4 encontró
    // el problema inverso en la bajada —el filename del content-disposition sí
    // viene en ISO-8859-1— y confundir las dos direcciones produce mojibake.
    expect(server.ultimo.body).toContain('%C2%B0');

    // Se decodifica con un parser de form-urlencoded, no con decodeURIComponent:
    // en este formato el espacio es `+`, que es lo que Tomcat espera recibir.
    expect(new URLSearchParams(server.ultimo.body).get('titulo')).toBe('Resolución N° 264');
  });

  it('comparte limiter y breaker entre sesiones, y las métricas los agregan', async () => {
    const d = deps();
    const a = createSession(d);
    const b = createSession(d);

    await Promise.all([a.get(`${server.url}/ok`), b.get(`${server.url}/ok`)]);

    expect(d.metrics.requests).toBe(2);
    expect(d.metrics.snapshot().tasaThrottling).toBe(0);
    expect(a.id).not.toBe(b.id);
  });
});
