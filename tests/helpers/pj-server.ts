/**
 * Portal falso con la forma del sitio del Poder Judicial.
 *
 * Misma filosofía que `jsf-server.ts` —`node:http` en puerto 0, sockets reales,
 * cero mocks de módulo— y un propósito distinto: donde aquel reproduce OEFA,
 * este reproduce lo que el markup archivado dice que hace el portal objetivo.
 *
 * Las cuatro diferencias que lo justifican, todas verificadas en `fixtures/pj/`:
 *
 * 1. **La búsqueda es un POST no-ajax** y devuelve la página entera. No hay
 *    `<partial-response>` en ninguna parte de este servidor.
 * 2. **Tres forms con el mismo token**, uno de ellos con `target="_blank"`. Es lo
 *    que obliga a `parseJsfcljs` a devolver el form que el `onclick` nombra.
 * 3. **Los `onclick` van envueltos en `jsf.util.chain` con comillas escapadas.**
 *    El generador los emite escapados a propósito: si los escribiera pelados,
 *    los tests validarían una comodidad nuestra en vez del markup real.
 * 4. **State saving server-side con LRU de vistas.** Es la diferencia que más
 *    cambia el comportamiento y la que OEFA no puede ejercitar: allá el token es
 *    un blob autocontenido y no se desaloja nunca, así que `recover()` solo se
 *    podía probar corrompiendo el token a mano. Acá el desalojo pasa solo,
 *    recorriendo suficientes páginas, que es como pasa en producción.
 *
 * Lo que este servidor **no** es: evidencia de que el portal se comporte así.
 * Ningún snapshot del archivo trae filas de resultado ni paginación (ver
 * `fixtures/pj/README.md`). Modela la forma que §2.1 documenta a partir de un
 * scraper público, y su valor es probar que el adapter hace lo correcto **si**
 * esa forma es la buena, más los modos de falla, que sí son universales.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const RUTA_VISTA = '/jurisprudenciaweb/faces/page/resultado.xhtml';
const NOMBRE_COOKIE = 'JSESSIONID';

export const FORM = 'formBuscador';
export const FORM_DETALLE = 'frmDetalle2';
/** El iterador del ejemplo de §2.1: `formBusqueda:repeat:0:j_idt158`. */
export const ITERADOR = 'repeat';

export const CABECERAS = [
  'Nro.',
  'Órgano jurisdiccional',
  'Materia',
  'Sumilla',
  'Resolución',
] as const;

export interface OpcionesPortalPj {
  readonly total: number;
  readonly pageSize?: number;
  /**
   * Cuántas vistas conserva el servidor antes de desalojar la más vieja.
   *
   * Es el LRU del state saving server-side, con quince de default en Mojarra.
   *
   * Conviene saber qué **no** prueba: un recorrido secuencial siempre emite su
   * POST con el token más nuevo, así que el LRU no lo alcanza por muchas páginas
   * que recorra. La vista se pierde por otras vías —la sesión expira, el
   * contenedor recicla, otro trabajo de la misma sesión llena el LRU— y para eso
   * está `expirarEnPagina`. Este parámetro existe para poder aseverar que el
   * desalojo ocurre y que el adapter no lo nota mientras no le toque.
   */
  readonly vistasRetenidas?: number;
  /**
   * Desaloja **todas** las vistas justo antes de servir esta página.
   *
   * Es la condición que un recorrido sí encuentra en producción: la sesión que
   * caduca a mitad de corrida. Con state saving server-side eso deja al cliente
   * con un token que el servidor no puede restaurar, y este portal —que no habla
   * ajax— contesta la página de inicio con `200`.
   */
  readonly expirarEnPagina?: number;
  /** Cuántas veces se dispara esa trampa. Por defecto, una. */
  readonly expirarVeces?: number;
  /** La vista no trae botón «Buscar»: el caso del snapshot de 2025. */
  readonly sinBotonBuscar?: boolean;
  /** Índices (globales) que se sirven sin enlace de descarga. */
  readonly filasSinDocumento?: readonly number[];
  /** Índices cuyo `onclick` está pero no se deja leer: eso sí es drift. */
  readonly onclickRoto?: readonly number[];
  /** El texto de la fila se repite: dos filas idénticas dentro de la página. */
  readonly filasIdenticas?: readonly number[];
  /** No emite el texto con el total: `leerTotal` devuelve `undefined`. */
  readonly sinTotal?: boolean;
  /** La página de resultados no trae control de «Siguiente». */
  readonly sinPaginacion?: boolean;
  /** Los ids de fila no siguen la convención `form:iterador:N:componente`. */
  readonly sinIterador?: boolean;
  /** Devuelve siempre la página 1, ignorando el avance. */
  readonly noAvanza?: boolean;
  /** Los índices de fila no arrancan en 0 dentro de la página. */
  readonly indicesCorridos?: number;
}

export interface PortalPj {
  readonly url: string;
  readonly pageUrl: string;
  readonly posts: readonly URLSearchParams[];
  readonly hits: Readonly<Record<string, number>>;
  /** Cuántas vistas se desalojaron: la evidencia de que el LRU se ejercitó. */
  readonly desalojos: () => number;
  /** Deja de emitir `Set-Cookie`: el modo de falla silencioso de §2.5. */
  dropSessions(): void;
  /** Fuerza el desalojo de todas las vistas vivas. */
  expirarVistas(): void;
  close(): Promise<void>;
}

/**
 * El `onclick` tal como lo emite el portal: `mojarra.jsfcljs` **adentro** de un
 * `jsf.util.chain`, o sea como string dentro de otro string, con las comillas
 * escapadas.
 *
 * Que el generador lo escriba así y no pelado es lo que hace que estos tests
 * sirvan: la versión anterior de `parseJsfcljs` devolvía `undefined` contra esta
 * forma exacta.
 */
function onclickJsfcljs(formId: string, pares: Readonly<Record<string, string>>): string {
  const objeto = Object.entries(pares)
    .map(([k, v]) => `\\'${k}\\':\\'${v}\\'`)
    .join(',');
  return (
    `jsf.util.chain(this,event,'RichFaces.$(\\'panelStatus\\').show();',` +
    `'mojarra.jsfcljs(document.getElementById(\\'${formId}\\'),{${objeto}},\\'\\')');return false`
  );
}

const escapar = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

export async function startPortalPj(opts: { dataset: OpcionesPortalPj }): Promise<PortalPj> {
  const posts: URLSearchParams[] = [];
  const hits: Record<string, number> = {};

  const total = opts.dataset.total;
  const pageSize = opts.dataset.pageSize ?? 10;
  const retenidas = opts.dataset.vistasRetenidas ?? Number.POSITIVE_INFINITY;

  let contador = 0;
  let emitirCookie = true;
  let desalojos = 0;
  let paginacionesServidas = 0;
  let trampasRestantes =
    opts.dataset.expirarEnPagina === undefined ? 0 : (opts.dataset.expirarVeces ?? 1);

  /**
   * Las vistas vivas: token → offset que ese token restaura.
   *
   * Un `Map` conserva el orden de inserción, así que la más vieja es la primera
   * clave. Es el LRU de Mojarra con state saving server-side, en cuatro líneas.
   */
  const vistas = new Map<string, number>();

  const nuevaVista = (offset: number): string => {
    contador += 1;
    // La forma real del handle: dos longs separados por dos puntos
    // (`8130872589646157352:-5634686416281607506` en el fixture 01).
    const token = `${1000000 + contador}:${-2000000 - contador}`;
    vistas.set(token, offset);

    while (vistas.size > retenidas) {
      const masVieja = vistas.keys().next().value;
      if (masVieja === undefined) break;
      vistas.delete(masVieja);
      desalojos += 1;
    }
    return token;
  };

  /** Las filas de una página, con la convención de nombres de §2.1. */
  const filasDe = (offset: number, token: string): string => {
    const hasta = Math.min(offset + pageSize, total);
    const filas: string[] = [];

    for (let global = offset; global < hasta; global += 1) {
      const local = global - offset + (opts.dataset.indicesCorridos ?? 0);
      // Una fila idéntica repite el contenido de la anterior, documento incluido:
      // es lo que el portal de OEFA hizo cuatro veces y no hay razón para suponer
      // que este no lo haga.
      const fuente = opts.dataset.filasIdenticas?.includes(global) === true ? global - 1 : global;
      const uuid = `uuid-${fuente}`;
      const prefijo =
        opts.dataset.sinIterador === true
          ? `${FORM}:celda${local}`
          : `${FORM}:${ITERADOR}:${local}:j_idt158`;

      const sinDoc = opts.dataset.filasSinDocumento?.includes(global) === true;
      const roto = opts.dataset.onclickRoto?.includes(global) === true;

      const enlace = sinDoc
        ? '<span>Reservado</span>'
        : `<a id="${prefijo}" href="#" onclick="${escapar(
            roto
              ? "jsf.util.chain(this,event,'mojarra.jsfcljs(???)')"
              : onclickJsfcljs(FORM_DETALLE, { [prefijo]: prefijo, uuid }),
          )}">Ver Resolución</a>`;

      // Cuando la fila no tiene enlace hace falta igual un componente con el id
      // de la convención, o la fila entera se vuelve invisible para el parser —
      // que es justo lo que NO tiene que pasar con un registro legítimo sin
      // documento.
      const ancla = sinDoc ? `<span id="${prefijo}"></span>` : '';

      filas.push(
        `<tr>` +
          `<td>${fuente + 1}</td>` +
          `<td>Sala Penal Permanente</td>` +
          `<td>Penal</td>` +
          `<td>Sumilla de la resolución ${fuente}</td>` +
          `<td>${ancla}${enlace}</td>` +
          `</tr>`,
      );
    }

    const siguiente =
      opts.dataset.sinPaginacion === true || hasta >= total
        ? ''
        : `<a href="#" onclick="${escapar(
            onclickJsfcljs(FORM, { [`${FORM}:j_idt77`]: `${FORM}:j_idt77`, forward: 'buscar' }),
          )}">Siguiente</a>`;

    return (
      `<table><thead><tr>${CABECERAS.map((c) => `<th>${c}</th>`).join('')}</tr></thead>` +
      `<tbody>${filas.join('')}</tbody></table>` +
      (opts.dataset.sinTotal === true
        ? ''
        : `<div class="tot">Se encontraron ${total} resultados</div>`) +
      `<div class="pag">${siguiente}</div>` +
      `<input type="hidden" name="javax.faces.ViewState" id="javax.faces.ViewState" value="${token}" autocomplete="off" />`
    );
  };

  /** Los tres forms de la vista, con el mismo token en los tres (fixture `02`). */
  const pagina = (token: string, cuerpo: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Jurisprudencia Nacional Sistematizada</title>
<script src="/org.richfaces.resources/javax.faces.resource/org.richfaces.staticResource/4.2.2.Final/PackedCompressed/packed/packed.js"></script>
</head><body>
<form id="${FORM}" name="${FORM}" method="post" action="${RUTA_VISTA};jsessionid=SESSION" enctype="application/x-www-form-urlencoded">
<input type="hidden" name="${FORM}" value="${FORM}" />
<input type="hidden" name="javax.faces.ViewState" id="javax.faces.ViewState" value="${token}" autocomplete="off" />
<input id="${FORM}:txtBusqueda" type="text" name="${FORM}:txtBusqueda" value="" />
<input id="${FORM}:buCorteselValue" name="${FORM}:buCorte" type="hidden" value="0" />
<input id="${FORM}:buAnioselValue" name="${FORM}:buAnio" type="hidden" />
${
  opts.dataset.sinBotonBuscar === true
    ? '<!-- la celda del botón viene vacía, como en el snapshot de 2025 -->'
    : `<input type="submit" name="${FORM}:j_idt65" value="Buscar" onclick="${escapar(
        onclickJsfcljs(FORM, { [`${FORM}:j_idt65`]: `${FORM}:j_idt65`, [`${FORM}:j_idt66`]: '' }),
      )}" />`
}
${cuerpo}
</form>
<form id="frmDetalle" name="frmDetalle" method="post" action="${RUTA_VISTA}">
<input type="hidden" name="javax.faces.ViewState" value="${token}" autocomplete="off" />
</form>
<form id="${FORM_DETALLE}" name="${FORM_DETALLE}" method="post" action="${RUTA_VISTA}" target="_blank">
<input type="hidden" name="${FORM_DETALLE}" value="${FORM_DETALLE}" />
<input type="hidden" name="javax.faces.ViewState" value="${token}" autocomplete="off" />
</form>
</body></html>`;

  const responder = (res: http.ServerResponse, cuerpo: string): void => {
    res.writeHead(200, { 'Content-Type': 'text/html;charset=UTF-8' });
    res.end(cuerpo);
  };

  const server = http.createServer((req, res) => {
    const ruta = new URL(req.url ?? '/', 'http://localhost').pathname;
    hits[ruta] = (hits[ruta] ?? 0) + 1;

    if (req.method === 'GET') {
      if (emitirCookie) res.setHeader('Set-Cookie', `${NOMBRE_COOKIE}=s1; Path=/; HttpOnly`);
      // El bootstrap no renderizó resultados: su vista no restaura ningún offset.
      hits['bootstrap'] = (hits['bootstrap'] ?? 0) + 1;
      return responder(res, pagina(nuevaVista(-1), ''));
    }

    let crudo = '';
    req.on('data', (c) => (crudo += String(c)));
    req.on('end', () => {
      const campos = new URLSearchParams(crudo);
      posts.push(campos);

      const token = campos.get('javax.faces.ViewState') ?? '';
      const offsetVigente = vistas.get(token);

      // La vista desalojada. Con state saving server-side el servidor no tiene
      // cómo restaurarla, y este portal —que no habla ajax— contesta la página de
      // inicio: `200`, cuerpo válido, sin resultados. Ninguna excepción, ninguna
      // mención a ViewExpiredException.
      if (offsetVigente === undefined) {
        hits['expirada'] = (hits['expirada'] ?? 0) + 1;
        return responder(res, pagina(nuevaVista(-1), ''));
      }

      const esBusqueda = campos.has(`${FORM}:j_idt65`);
      const offset = opts.dataset.noAvanza === true ? 0 : esBusqueda ? 0 : offsetVigente + pageSize;

      hits[esBusqueda ? 'busqueda' : 'paginacion'] =
        (hits[esBusqueda ? 'busqueda' : 'paginacion'] ?? 0) + 1;

      // La sesión que caduca a mitad de corrida. Se cuenta por paginaciones
      // servidas y no por offset porque tras recuperarse el adapter vuelve a
      // pasar por los mismos offsets: contar offsets haría que la trampa se
      // dispare de nuevo en el mismo lugar y el test mediría un ciclo infinito
      // en vez de una recuperación.
      if (!esBusqueda) {
        paginacionesServidas += 1;
        // Módulo y no igualdad: con `expirarVeces > 1` la trampa tiene que poder
        // volver a saltar después de que el adapter se recupere, que es como se
        // ejercita el tope del presupuesto.
        const cada = opts.dataset.expirarEnPagina ?? 0;
        if (trampasRestantes > 0 && cada > 0 && paginacionesServidas % cada === 0) {
          trampasRestantes -= 1;
          desalojos += vistas.size;
          vistas.clear();
          hits['expirada'] = (hits['expirada'] ?? 0) + 1;
          return responder(res, pagina(nuevaVista(-1), ''));
        }
      }

      const nuevo = nuevaVista(offset);
      return responder(res, pagina(nuevo, filasDe(offset, nuevo)));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    pageUrl: `${url}${RUTA_VISTA}`,
    posts,
    hits,
    desalojos: () => desalojos,
    dropSessions: () => {
      emitirCookie = false;
    },
    expirarVistas: () => {
      desalojos += vistas.size;
      vistas.clear();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
