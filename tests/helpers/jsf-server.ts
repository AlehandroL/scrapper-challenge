/**
 * Portal JSF falso para ejercitar `JsfView` sobre sockets reales.
 *
 * Misma filosofía que `test-server.ts`: `node:http` en puerto 0, nada de mocks
 * de módulo. Lo que lo hace fuerte es que **sirve los fixtures reales** con el
 * token sustituido, en vez de HTML inventado: el CDATA, los ids autogenerados y
 * el `;jsessionid=` del `action` son los que el sitio produjo.
 *
 * Reproduce los tres modos de falla que el bloque 1 documentó:
 * la sesión caída, la tabla vacía sin cookie, y la página completa cuando falta
 * `Faces-Request`.
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

export const RUTA_VISTA = '/repdig/consulta/consultaTfa.xhtml';
const NOMBRE_COOKIE = 'JSESSIONID';

const fixture = (nombre: string): string =>
  readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'oefa', nombre), 'utf8');

const BOOTSTRAP = fixture('01-bootstrap.html');
const BUSQUEDA = fixture('02-search-partial.xml');
const PAGINA2 = fixture('03-page2-partial.xml');
const PAGINA_COMPLETA = fixture('04-download-a.html');
const EXPIRADO = fixture('06-view-expired.xml');

const TABLA_VACIA = (token: string): string =>
  `<?xml version='1.0' encoding='UTF-8'?><partial-response id="j_id1"><changes>` +
  `<update id="listarDetalleInfraccionRAAForm:dt"><![CDATA[` +
  `<tr class="ui-widget-content ui-datatable-empty-message"><td colspan="7"></td></tr>` +
  `]]></update><update id="j_id1:javax.faces.ViewState:0"><![CDATA[${token}]]></update>` +
  `</changes></partial-response>`;

const EXPIRADO_CANONICO =
  `<?xml version='1.0' encoding='UTF-8'?><partial-response id="j_id1"><error>` +
  `<error-name>javax.faces.application.ViewExpiredException</error-name>` +
  `<error-message>View /consulta/consultaTfa.xhtml could not be restored.</error-message>` +
  `</error></partial-response>`;

/** Sustituye el token en el `<input>` del HTML del bootstrap. */
const conTokenHtml = (html: string, token: string): string =>
  html.replace(/(name="javax\.faces\.ViewState"[^>]*value=")[^"]*(")/, `$1${token}$2`);

/** Sustituye el token en el CDATA del `<update>` correspondiente. */
const conTokenPartial = (xml: string, token: string): string =>
  xml.replace(
    /(<update id="[^"]*javax\.faces\.ViewState[^"]*"><!\[CDATA\[)[\s\S]*?(\]\]><\/update>)/,
    `$1${token}$2`,
  );

export interface ReceivedPost {
  readonly path: string;
  readonly fields: URLSearchParams;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export interface JsfTestServer {
  readonly url: string;
  readonly pageUrl: string;
  readonly hits: Readonly<Record<string, number>>;
  /** Cuerpos recibidos, en orden: la aserción sobre la forma real del POST. */
  readonly posts: readonly ReceivedPost[];
  /** El token vigente del lado del servidor. */
  readonly tokenActual: () => string;
  /** Rota el token sin avisar: el siguiente POST llega con uno vencido. */
  expireViewState(): void;
  /** Cómo responder ante un token vencido. OEFA usa `redirect`. */
  expireAs(modo: 'error' | 'redirect'): void;
  /** Deja de emitir `Set-Cookie`: reproduce el modo de falla silencioso de §2.5. */
  dropSessions(): void;
  /** Responde la página completa aunque venga `Faces-Request`. */
  forceFullPage(): void;
  close(): Promise<void>;
}

export async function startJsfServer(): Promise<JsfTestServer> {
  const hits: Record<string, number> = {};
  const posts: ReceivedPost[] = [];

  let token = 'TOKEN-0';
  let generacion = 0;
  let modoExpiracion: 'error' | 'redirect' = 'redirect';
  let emitirCookie = true;
  let paginaCompleta = false;

  const rotar = (): string => {
    generacion += 1;
    token = `TOKEN-${generacion}`;
    return token;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ruta = url.pathname;
    hits[ruta] = (hits[ruta] ?? 0) + 1;

    if (req.method === 'GET') {
      if (emitirCookie) res.setHeader('Set-Cookie', `${NOMBRE_COOKIE}=s-${generacion}; Path=/; HttpOnly`);
      return responder(res, 200, 'text/html;charset=UTF-8', conTokenHtml(BOOTSTRAP, rotar()));
    }

    const trozos: Buffer[] = [];
    req.on('data', (c: Buffer) => trozos.push(c));
    req.on('end', () => {
      const fields = new URLSearchParams(Buffer.concat(trozos).toString('utf8'));
      posts.push({ path: ruta, fields, headers: req.headers as Record<string, string | undefined> });

      const esAjax = req.headers['faces-request'] === 'partial/ajax';
      if (!esAjax || paginaCompleta) {
        // Sin el header, el servidor renderiza la página entera. Es el síntoma
        // que se confunde con un bloqueo del sitio.
        return responder(res, 200, 'text/html;charset=UTF-8', PAGINA_COMPLETA);
      }

      if (fields.get('javax.faces.ViewState') !== token) {
        return responder(
          res,
          200,
          'text/xml;charset=UTF-8',
          modoExpiracion === 'redirect' ? EXPIRADO : EXPIRADO_CANONICO,
        );
      }

      // Los resultados viven en un bean de sesión: sin cookie el bean llega
      // vacío y la respuesta es 200 con la tabla vacía. Sin excepción.
      const tieneCookie = (req.headers.cookie ?? '').includes(NOMBRE_COOKIE);
      if (!tieneCookie) return responder(res, 200, 'text/xml;charset=UTF-8', TABLA_VACIA(rotar()));

      const first = fields.get('listarDetalleInfraccionRAAForm:dt_first');
      const cuerpo = first === null || first === '0' ? BUSQUEDA : PAGINA2;
      return responder(res, 200, 'text/xml;charset=UTF-8', conTokenPartial(cuerpo, rotar()));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    pageUrl: `${url}${RUTA_VISTA}`,
    hits,
    posts,
    tokenActual: () => token,
    expireViewState: () => void rotar(),
    expireAs: (modo) => void (modoExpiracion = modo),
    dropSessions: () => void (emitirCookie = false),
    forceFullPage: () => void (paginaCompleta = true),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function responder(res: http.ServerResponse, status: number, contentType: string, cuerpo: string): void {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(cuerpo);
}
