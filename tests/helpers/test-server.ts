/**
 * Servidor HTTP efímero para los tests de transporte.
 *
 * Se usa un `node:http` real en vez de `nock` o `msw` por dos razones concretas:
 * los interceptores trabajan a nivel de módulo y **no pueden reproducir un
 * socket cortado a la mitad** (`ECONNRESET`), que es justo uno de los casos que
 * §5.6 obliga a manejar; y el cookie jar hay que ejercitarlo a través del camino
 * real de axios, incluidas las cadenas de redirección, no de un mock que las
 * saltea.
 *
 * Escucha en el puerto 0: el SO asigna uno libre y los tests pueden correr en
 * paralelo sin coordinarse.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestServer {
  readonly url: string;
  /** Requests recibidos por ruta. Sirve para asertar que un 403 **no** se reintentó. */
  readonly hits: Readonly<Record<string, number>>;
  /** Último cuerpo y content-type recibidos en `/echo`. */
  readonly ultimo: { body: string; contentType: string | undefined };
  close(): Promise<void>;
}

const NOMBRE_COOKIE = 'JSESSIONID';

export async function startTestServer(): Promise<TestServer> {
  const hits: Record<string, number> = {};
  const ultimo = { body: '', contentType: undefined as string | undefined };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ruta = url.pathname;
    const n = (hits[ruta] = (hits[ruta] ?? 0) + 1);
    const num = (clave: string, porDefecto: number) =>
      Number(url.searchParams.get(clave) ?? porDefecto);

    switch (ruta) {
      case '/ok':
        return responder(res, 200, 'ok');

      case '/set-cookie':
        res.setHeader('Set-Cookie', `${NOMBRE_COOKIE}=abc123; Path=/; HttpOnly`);
        return responder(res, 200, 'cookie seteada');

      /**
       * Réplica del modo de falla de §2.5: sin la cookie el servidor responde
       * **200 igual**, solo que vacío. No hay excepción que atrapar; parece que
       * el selector dejó de matchear.
       */
      case '/needs-cookie': {
        const tiene = (req.headers.cookie ?? '').includes(NOMBRE_COOKIE);
        return responder(res, 200, tiene ? 'con-cookie' : 'sin-cookie');
      }

      /**
       * `Set-Cookie` emitido **dentro** de un 302. Es el caso que justifica
       * `axios-cookiejar-support`: axios sigue los redirects internamente, así
       * que un interceptor de respuesta casero nunca ve esta cabecera y la
       * cookie se pierde en silencio.
       */
      case '/redirect-with-cookie':
        res.setHeader('Set-Cookie', `${NOMBRE_COOKIE}=viaredirect; Path=/; HttpOnly`);
        res.setHeader('Location', '/needs-cookie');
        return responder(res, 302, '');

      /** 429 con `Retry-After` en delta-seconds las primeras `times` veces. */
      case '/throttle':
        if (n <= num('times', 1)) {
          res.setHeader('Retry-After', String(num('after', 1)));
          return responder(res, 429, 'calmate');
        }
        return responder(res, 200, 'ok');

      /** 429 con `Retry-After` en formato HTTP-date (la otra forma del RFC 9110). */
      case '/retry-after-date':
        if (n <= num('times', 1)) {
          res.setHeader(
            'Retry-After',
            new Date(Date.now() + num('seconds', 2) * 1000).toUTCString(),
          );
          return responder(res, 429, 'calmate');
        }
        return responder(res, 200, 'ok');

      /** Corta el socket sin responder: produce ECONNRESET del lado del cliente. */
      case '/flaky':
        if (n <= num('destroy', 1)) return void req.socket.destroy();
        return responder(res, 200, 'ok');

      case '/forbidden':
        return responder(res, 403, 'prohibido');

      case '/unavailable':
        return responder(res, 503, 'no disponible');

      case '/echo': {
        const trozos: Buffer[] = [];
        req.on('data', (c: Buffer) => trozos.push(c));
        req.on('end', () => {
          ultimo.body = Buffer.concat(trozos).toString('utf8');
          ultimo.contentType = req.headers['content-type'];
          responder(res, 200, ultimo.body);
        });
        return;
      }

      /** Cuerpo grande, para que un 429 con `responseType: 'stream'` tenga algo que drenar. */
      case '/throttle-stream':
        if (n <= num('times', 1)) {
          res.setHeader('Retry-After', '0');
          return responder(res, 429, 'x'.repeat(64 * 1024));
        }
        return responder(res, 200, 'contenido');

      default:
        return responder(res, 404, 'no encontrado');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    ultimo,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Sin esto, las conexiones keep-alive que axios deja abiertas mantienen
        // el proceso vivo y la suite no termina.
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function responder(res: http.ServerResponse, status: number, cuerpo: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(cuerpo);
}
