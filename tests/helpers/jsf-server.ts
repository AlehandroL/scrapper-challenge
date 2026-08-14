/**
 * Portal JSF falso para ejercitar la capa de protocolo y el adapter sobre
 * sockets reales.
 *
 * Misma filosofía que `test-server.ts`: `node:http` en puerto 0, nada de mocks
 * de módulo. Tiene dos modos, y los dos importan:
 *
 * - **Modo fixture** (`startJsfServer()`): sirve los archivos de
 *   `fixtures/oefa/` con el token sustituido. El CDATA, los ids autogenerados y
 *   el `;jsessionid=` del `action` son los que el sitio produjo. Es lo que hace
 *   que un test falle cuando el markup real cambia, y no cuando cambia nuestra
 *   idea del markup real.
 * - **Modo sintético** (`startJsfServer({ dataset })`): genera páginas
 *   arbitrarias con la misma forma. Los fixtures son dos páginas de un dataset
 *   de 1.753 registros: no alcanzan para ejercitar la última página incompleta,
 *   un recorrido entero, ni las condiciones de drift de §6.4. El HTML sintético
 *   copia el del fixture clase por clase — si no fuera fiel, los tests validarían
 *   este generador en vez del parser.
 *
 * Reproduce además los modos de falla que el bloque 1 documentó: la sesión
 * caída como `<redirect>`, la página completa cuando falta `Faces-Request`, y el
 * más caro de todos —la paginación que devuelve `200` con la tabla vacía porque
 * los resultados viven en un bean de sesión (§2.5)—.
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

export const RUTA_VISTA = '/repdig/consulta/consultaTfa.xhtml';
const NOMBRE_COOKIE = 'JSESSIONID';

const FORM = 'listarDetalleInfraccionRAAForm';
const TABLA = `${FORM}:dt`;
const LISTA = `${FORM}:pgLista`;

const fixture = (nombre: string): string =>
  readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'oefa', nombre), 'utf8');

const BOOTSTRAP = fixture('01-bootstrap.html');
const BUSQUEDA = fixture('02-search-partial.xml');
const PAGINA2 = fixture('03-page2-partial.xml');
const PAGINA_COMPLETA = fixture('04-download-a.html');
const EXPIRADO = fixture('06-view-expired.xml');

const EXPIRADO_CANONICO =
  `<?xml version='1.0' encoding='UTF-8'?><partial-response id="j_id1"><error>` +
  `<error-name>javax.faces.application.ViewExpiredException</error-name>` +
  `<error-message>View /consulta/consultaTfa.xhtml could not be restored.</error-message>` +
  `</error></partial-response>`;

const CABECERAS_REALES = [
  'Nro.',
  'Número de expediente',
  'Administrado',
  'Unidad fiscalizable',
  'Sector',
  'Nro. Resolución de Apelación',
  'Archivo',
];

/** Envuelve updates en un `<partial-response>` con el token al final, como el sitio. */
const partial = (updates: readonly (readonly [string, string])[], token: string): string =>
  `<?xml version='1.0' encoding='UTF-8'?><partial-response id="j_id1"><changes>` +
  updates.map(([id, html]) => `<update id="${id}"><![CDATA[${html}]]></update>`).join('') +
  `<update id="j_id1:javax.faces.ViewState:0"><![CDATA[${token}]]></update>` +
  `</changes></partial-response>`;

const FILA_VACIA = '<tr class="ui-widget-content ui-datatable-empty-message"><td colspan="7">Sin resultados</td></tr>';

/** Sustituye el token en el `<input>` del HTML del bootstrap. */
const conTokenHtml = (html: string, token: string): string =>
  html.replace(/(name="javax\.faces\.ViewState"[^>]*value=")[^"]*(")/, `$1${token}$2`);

/** Sustituye el token en el CDATA del `<update>` correspondiente. */
const conTokenPartial = (xml: string, token: string): string =>
  xml.replace(
    /(<update id="[^"]*javax\.faces\.ViewState[^"]*"><!\[CDATA\[)[\s\S]*?(\]\]><\/update>)/,
    `$1${token}$2`,
  );

/**
 * Un uuid determinístico por índice de fila.
 *
 * Determinístico y no aleatorio para que un test pueda aseverar *qué* filas
 * llegaron, no solo cuántas — que es la diferencia entre detectar un
 * desalineamiento y contar bien filas equivocadas.
 */
export const uuidSintetico = (ri: number): string =>
  `00000000-0000-4000-8000-${String(ri).padStart(12, '0')}`;

export interface OpcionesDataset {
  readonly total: number;
  readonly pageSize?: number;
  /** Distinto de 7 para simular un cambio en la estructura de la tabla. */
  readonly columnas?: number;
  readonly cabeceras?: readonly string[];
  /**
   * `data-ri` que comparten el **documento** de la fila anterior conservando su
   * propio contenido: es el caso real de la página 28, donde una resolución
   * alcanza a dos unidades fiscalizables.
   */
  readonly documentoCompartido?: readonly number[];
  /** `data-ri` que son un clon exacto de la fila anterior, documento incluido. */
  readonly filasIdenticas?: readonly number[];
  /** Ignora el `dt_first` recibido: los `data-ri` no coinciden con lo pedido. */
  readonly offsetFijo?: number;
  /** `data-ri` correctos pero contenido de otro offset: el solapamiento de §6.3. */
  readonly uuidsDesde?: number;
  /** Menos filas de las que corresponden, sin ser la última página. */
  readonly filasPorRespuesta?: number;
  /** La búsqueda no emite el script del widget: se pierde `rowCount` y `rows`. */
  readonly sinTotal?: boolean;
  /** La primera columna deja de seguir al `data-ri`. */
  readonly nroCorrido?: boolean;
  /**
   * `data-ri` que se sirven sin enlace de descarga, como las resoluciones que
   * OEFA publica marcadas «Información confidencial». **No es drift**: son
   * registros legítimos sin documento.
   */
  readonly filasSinDocumento?: readonly number[];
  /** `data-ri` cuyo `onclick` está pero no se deja leer. Eso **sí** es drift. */
  readonly onclickRoto?: readonly number[];
}

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
  /**
   * Expira solo cuando llegue un evento de página con este offset.
   *
   * `expireViewState()` no alcanza para probar la recuperación del adapter:
   * expira «el próximo POST», sin poder decir en qué página. Con `veces:
   * Infinity` la trampa no se desarma, que es como se prueba el tope de una
   * recuperación por offset.
   */
  expirarEnOffset(first: number, veces?: number): void;
  /** Cómo responder ante un token vencido. OEFA usa `redirect`. */
  expireAs(modo: 'error' | 'redirect'): void;
  /** Deja de emitir `Set-Cookie`: reproduce el modo de falla silencioso de §2.5. */
  dropSessions(): void;
  /** Responde la página completa aunque venga `Faces-Request`. */
  forceFullPage(): void;
  /** Cambia el dataset a mitad de corrida (solo en modo sintético). */
  ajustarDataset(parche: Partial<OpcionesDataset>): void;
  close(): Promise<void>;
}

export async function startJsfServer(opts: { dataset?: OpcionesDataset } = {}): Promise<JsfTestServer> {
  const hits: Record<string, number> = {};
  const posts: ReceivedPost[] = [];

  let dataset = opts.dataset;
  let token = 'TOKEN-0';
  let generacion = 0;
  let modoExpiracion: 'error' | 'redirect' = 'redirect';
  let emitirCookie = true;
  let paginaCompleta = false;
  let trampa: { first: number; veces: number } | undefined;

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

      // El ruteo va por `javax.faces.source` y no por la presencia de
      // `dt_first`: un evento de página con offset 0 es perfectamente legítimo y
      // tiene que devolver una tira de `<tr>`, no la tabla entera.
      const source = fields.get('javax.faces.source') ?? '';
      const esBusqueda = source.endsWith(':btnBuscar');
      const first = Number(fields.get(`${TABLA}_first`) ?? 0);

      if (!esBusqueda && trampa !== undefined && trampa.first === first) {
        trampa = trampa.veces <= 1 ? undefined : { first, veces: trampa.veces - 1 };
        return responder(res, 200, 'text/xml;charset=UTF-8', EXPIRADO);
      }

      if (fields.get('javax.faces.ViewState') !== token) {
        return responder(
          res,
          200,
          'text/xml;charset=UTF-8',
          modoExpiracion === 'redirect' ? EXPIRADO : EXPIRADO_CANONICO,
        );
      }

      // §2.5: la búsqueda es autocontenida y funciona sin cookie, pero los
      // resultados quedan en un bean de sesión. Sin cookie, la **paginación**
      // devuelve 200 con la tabla vacía. Sin excepción, sin error: el peor modo
      // de falla del proyecto, y por eso el falso lo reproduce tal cual.
      const tieneCookie = (req.headers.cookie ?? '').includes(NOMBRE_COOKIE);
      if (!esBusqueda && !tieneCookie) {
        return responder(res, 200, 'text/xml;charset=UTF-8', partial([[TABLA, FILA_VACIA]], rotar()));
      }

      if (dataset === undefined) {
        const cuerpo = esBusqueda ? BUSQUEDA : PAGINA2;
        return responder(res, 200, 'text/xml;charset=UTF-8', conTokenPartial(cuerpo, rotar()));
      }

      const html = esBusqueda ? tablaCompleta(dataset) : filasDe(dataset, first);
      return responder(
        res,
        200,
        'text/xml;charset=UTF-8',
        partial([[esBusqueda ? LISTA : TABLA, html]], rotar()),
      );
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
    expirarEnOffset: (first, veces = 1) => void (trampa = { first, veces }),
    expireAs: (modo) => void (modoExpiracion = modo),
    dropSessions: () => void (emitirCookie = false),
    forceFullPage: () => void (paginaCompleta = true),
    ajustarDataset: (parche) => {
      if (dataset === undefined) throw new Error('ajustarDataset requiere modo sintético');
      dataset = { ...dataset, ...parche };
    },
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

// ---------------------------------------------------------------------------
// Síntesis del markup
// ---------------------------------------------------------------------------

/**
 * Una fila con la misma forma que la del fixture: mismos `class`, mismos
 * `style`, y el `<script>` de `jsf.js` solo en la primera de cada respuesta —el
 * sitio lo emite así, y es la clase de detalle que distingue un fixture fiel de
 * uno inventado.
 */
function filaSintetica(
  ri: number,
  contenidoRi: number,
  documentoRi: number,
  nro: number,
  columnas: number,
  conScript: boolean,
): string {
  const celda = (estilo: string, contenido: string): string =>
    `<td role="gridcell" style="${estilo}">${contenido}</td>`;

  const izq = 'text-align: justify;vertical-align:top;';
  const script = conScript
    ? '\n<script type="text/javascript" src="/repdig/javax.faces.resource/jsf.js.xhtml?ln=javax.faces"></script>\n'
    : '';
  const boton = `${FORM}:dt:${ri}:j_idt63`;
  const archivo =
    `${script}<a href="#" title="" onclick="mojarra.jsfcljs(document.getElementById('${FORM}'),` +
    `{'${boton}':'${boton}','param_uuid':'${uuidSintetico(documentoRi)}'},'');return false">` +
    '<img src="../images/pdf_descarga.png" alt="" style="border:0;width:25px" /></a>';

  // La fila 0 lleva dos administrados separados por un salto de línea, como la
  // del fixture: sin eso, el caso multivalor solo estaría cubierto por los dos
  // registros que los fixtures alcanzan a mostrar.
  const administrado =
    contenidoRi % 10 === 0
      ? `Corporación del Mar  S.A.\nAustral Group S.A.A. `
      : `Administrado ${contenidoRi} S.A.C.`;

  const estandar = [
    celda('text-align:center;vertical-align:top;', ` ${nro}`),
    celda(izq, `${100 + contenidoRi}-2011-PRODUCE/DIGSECOVI-Dsvs`),
    celda(izq, administrado),
    celda(izq, `Planta de procesamiento ${contenidoRi}`),
    celda(izq, 'Pesquería'),
    celda('text-align:left;', `${String(contenidoRi).padStart(3, '0')}-2013-OEFA/TFA`),
  ];

  // La columna de archivo siempre va última: así, aunque la tabla cambie de
  // ancho, el comando de descarga sigue siendo legible y el drift que se prueba
  // es el de columnas y no el de uuid ausente.
  const cuerpo = estandar.slice(0, Math.max(0, columnas - 1));
  cuerpo.push(celda('text-align: center;vertical-align:top;', archivo));

  const paridad = ri % 2 === 0 ? 'even' : 'odd';
  return `<tr data-ri="${ri}" class="ui-widget-content ui-datatable-${paridad}" role="row">${cuerpo.join('')}</tr>`;
}

/** Las filas que corresponden a un offset, con las distorsiones que pida el dataset. */
function filasDe(d: OpcionesDataset, firstPedido: number): string {
  const pageSize = d.pageSize ?? 10;
  const first = d.offsetFijo ?? firstPedido;
  const disponibles = Math.max(0, Math.min(pageSize, d.total - first));
  const cantidad = Math.min(d.filasPorRespuesta ?? disponibles, disponibles);
  if (cantidad === 0) return FILA_VACIA;

  const compartido = new Set(d.documentoCompartido ?? []);
  const identicas = new Set(d.filasIdenticas ?? []);
  const filas: string[] = [];

  for (let i = 0; i < cantidad; i += 1) {
    const ri = first + i;
    // `uuidsDesde` deja los `data-ri` correctos y cambia el contenido: es el
    // caso que `indices[0] === first` no puede ver y que solo el solapamiento de
    // identidades detecta.
    const base = d.uuidsDesde === undefined ? ri : d.uuidsDesde + i;
    // La cadena de clones retrocede hasta la primera fila que no lo sea: con
    // `filasIdenticas: [5, 6]` las tres filas tienen que salir idénticas, no
    // dos pares distintos.
    let salto = 1;
    while (identicas.has(ri) && identicas.has(ri - salto) && base - salto > 0) salto += 1;
    const origen = Math.max(0, base - salto);
    const contenidoRi = identicas.has(ri) ? origen : base;
    const documentoRi = identicas.has(ri) ? origen : compartido.has(ri) ? Math.max(0, base - 1) : base;
    const nro = ri + (d.nroCorrido === true ? 2 : 1);
    let fila = filaSintetica(ri, contenidoRi, documentoRi, nro, d.columnas ?? 7, i === 0);
    if (d.filasSinDocumento?.includes(ri) === true) {
      fila = fila.replace(/<a href="#"[\s\S]*?<\/a>/, 'Información confidencial');
    } else if (d.onclickRoto?.includes(ri) === true) {
      fila = fila.replace(/onclick="[^"]*"/, 'onclick="algoQueNoEsJsfcljs()"');
    }
    filas.push(fila);
  }
  return filas.join('');
}

/**
 * La respuesta de la búsqueda: la tabla entera, con `<thead>`, paginador y el
 * script del widget. Es lo único que reporta `rowCount` y `rows`, y por eso las
 * cabeceras y el tamaño de página solo se pueden chequear acá.
 */
function tablaCompleta(d: OpcionesDataset): string {
  const pageSize = d.pageSize ?? 10;
  const paginas = Math.max(1, Math.ceil(d.total / pageSize));
  const cabeceras = d.cabeceras ?? CABECERAS_REALES;

  const th = cabeceras
    .map(
      (t, i) =>
        `<th id="${TABLA}:j_idt${41 + i * 3}" class="ui-state-default" role="columnheader" aria-label="${t}">` +
        `<span class="ui-column-title"><span class="cabeceraGrilla">${t}</span></span></th>`,
    )
    .join('');

  const widget =
    d.sinTotal === true
      ? ''
      : `<script id="${TABLA}_s" type="text/javascript">$(function(){PrimeFaces.cw("DataTable",` +
        `"widget_${FORM}_dt",{id:"${TABLA}",paginator:{id:['${TABLA}_paginator_bottom'],rows:${pageSize},` +
        `rowCount:${d.total},page:0,currentPageTemplate:'Página {currentPage} de {totalPages} ({totalRecords} registros)'},` +
        `scrollable:true,liveScroll:false,scrollStep:0,scrollLimit:${d.total},liveScrollBuffer:0});});</script>`;

  return (
    `<span id="${LISTA}"><div id="${TABLA}" class="ui-datatable ui-widget ui-datatable-scrollable">` +
    `<div class="ui-widget-header ui-datatable-scrollable-header"><div class="ui-datatable-scrollable-header-box">` +
    `<table role="grid" class="grillaFlat"><thead id="${TABLA}_head"><tr role="row">${th}</tr></thead></table>` +
    `</div></div><div class="ui-datatable-scrollable-body" tabindex="-1"><table role="grid" class="grillaFlat">` +
    `<tbody id="${TABLA}_data" class="ui-datatable-data ui-widget-content">${filasDe(d, 0)}</tbody></table></div>` +
    `<div id="${TABLA}_paginator_bottom" class="ui-paginator ui-paginator-bottom" role="navigation">` +
    `<span class="ui-paginator-current">Página 1 de ${paginas} (${d.total} registros)</span></div>` +
    `${widget}</span>`
  );
}
