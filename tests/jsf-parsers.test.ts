/**
 * Los parsers contra los fixtures reales. Sin red, sin servidor.
 *
 * Cada aserción acá codifica un modo de falla que costó descubrir. Cuando el
 * sitio cambie, el ciclo de corrección baja de minutos a segundos porque el
 * parser se ejercita contra estos archivos (§6.5).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  isEmptyTable,
  pageCommand,
  readRowCount,
  readRowIndices,
  wrapRows,
} from '../src/jsf/datatable.ts';
import { parseJsfcljs } from '../src/jsf/commands.ts';
import { parseForm, stripJsessionid, toSearchParams } from '../src/jsf/form.ts';
import { findUpdate, parsePartialResponse } from '../src/jsf/partial-response.ts';
import { esIdViewState, extractViewState } from '../src/jsf/view-state.ts';

const fixture = (nombre: string): string =>
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'oefa', nombre), 'utf8');

const BOOTSTRAP = fixture('01-bootstrap.html');
const BUSQUEDA = fixture('02-search-partial.xml');
const PAGINA2 = fixture('03-page2-partial.xml');
const DESCARGA_A = fixture('04-download-a.html');
const EXPIRADO = fixture('06-view-expired.xml');

const PAGE_URL = 'https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml';
const FORM_ID = 'listarDetalleInfraccionRAAForm';

describe('partial-response', () => {
  it('parsea los tres updates de la búsqueda', () => {
    const res = parsePartialResponse(BUSQUEDA);
    expect(res.esPartial).toBe(true);
    expect([...res.updates.keys()]).toEqual([
      `${FORM_ID}:txtNroexp`,
      `${FORM_ID}:pgLista`,
      'j_id1:javax.faces.ViewState:0',
    ]);
  });

  it('resuelve el CDATA: el HTML de las filas viaja adentro', () => {
    const res = parsePartialResponse(BUSQUEDA);
    const lista = res.updates.get(`${FORM_ID}:pgLista`);

    // Aplicar un parser de HTML sobre el cuerpo crudo devuelve cero filas: el
    // HTML está encapsulado en CDATA dentro de un documento XML.
    expect(lista).toBeDefined();
    expect(lista!.length).toBeGreaterThan(1000);
    expect(lista).toContain('<tr data-ri="0"');
  });

  /**
   * Las dos mitades del bug de §5.2. Juntas dicen algo; separadas, nada.
   */
  it('el ViewState NO se encuentra por id exacto, pero sí por subcadena', () => {
    const res = parsePartialResponse(BUSQUEDA);
    expect(res.updates.get('javax.faces.ViewState')).toBeUndefined();
    expect(res.viewState).toBeDefined();
    expect(res.viewState!.length).toBeGreaterThan(1000);
  });

  it('el token rota entre la búsqueda y la paginación', () => {
    const busqueda = parsePartialResponse(BUSQUEDA);
    const pagina2 = parsePartialResponse(PAGINA2);
    expect(pagina2.viewState).toBeDefined();
    expect(pagina2.viewState).not.toBe(busqueda.viewState);
  });

  it('la respuesta de paginación solo actualiza la tabla', () => {
    const res = parsePartialResponse(PAGINA2);
    expect([...res.updates.keys()]).toEqual([`${FORM_ID}:dt`, 'j_id1:javax.faces.ViewState:0']);
  });

  /**
   * El mejor test del archivo. `04-download-a.html` **empieza** con
   * `<?xml version='1.0' encoding='UTF-8' ?>` y sigue con `<!DOCTYPE html>`:
   * cualquier detección del tipo «arranca con <?xml» lo clasifica como
   * partial-response y el error aparece mucho después, disfrazado de otra cosa.
   */
  it('una página HTML que empieza con <?xml NO es un partial-response', () => {
    expect(DESCARGA_A.startsWith("<?xml")).toBe(true);
    expect(parsePartialResponse(DESCARGA_A).esPartial).toBe(false);
    expect(parsePartialResponse(BOOTSTRAP).esPartial).toBe(false);
  });

  /**
   * Capturado contra OEFA con un ViewState corrupto. La forma canónica de JSF
   * es <error><error-name>ViewExpiredException; este sitio contesta 200 con un
   * <redirect> y sin mencionarla. Un parser que solo mirara <error-name> vería
   * un partial-response válido, con cero updates y ningún error.
   */
  it('la sesión caída llega como <redirect>, sin <error> ni ViewExpiredException', () => {
    const res = parsePartialResponse(EXPIRADO);
    expect(res.esPartial).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.updates.size).toBe(0);
    expect(res.viewState).toBeUndefined();
    expect(res.redirect).toBe('/repdig/consulta/consultaInicio.xhtml');
    expect(EXPIRADO).not.toMatch(/ViewExpiredException/i);
  });

  it('reconoce también la forma canónica con <error>', () => {
    const res = parsePartialResponse(
      `<?xml version='1.0' encoding='UTF-8'?><partial-response id="j_id1"><error>` +
        `<error-name>javax.faces.application.ViewExpiredException</error-name>` +
        `<error-message>View could not be restored.</error-message></error></partial-response>`,
    );
    expect(res.error).toEqual({
      name: 'javax.faces.application.ViewExpiredException',
      message: 'View could not be restored.',
    });
  });

  it('findUpdate cae al sufijo cuando el naming container no coincide', () => {
    const res = parsePartialResponse(BUSQUEDA);
    expect(findUpdate(res, `${FORM_ID}:pgLista`)).toBeDefined();
    expect(findUpdate(res, 'pgLista')).toBeDefined();
    expect(findUpdate(res, 'noExiste')).toBeUndefined();
  });

  it('es total: un cuerpo cualquiera no lanza', () => {
    expect(parsePartialResponse('').esPartial).toBe(false);
    expect(parsePartialResponse('{"json":true}').esPartial).toBe(false);
  });
});

describe('view-state', () => {
  it('reconoce el id con naming container e índice', () => {
    expect(esIdViewState('j_id1:javax.faces.ViewState:0')).toBe(true);
    expect(esIdViewState('javax.faces.ViewState')).toBe(true);
    // Jakarta EE 9+ renombró el paquete; el sitio todavía no, pero cuesta nada.
    expect(esIdViewState('j_id1:jakarta.faces.ViewState:0')).toBe(true);
    expect(esIdViewState(`${FORM_ID}:pgLista`)).toBe(false);
    expect(esIdViewState('miViewState')).toBe(false);
  });

  it('extrae el token del HTML del bootstrap', () => {
    const token = extractViewState(BOOTSTRAP);
    expect(token).toBeDefined();
    expect(token!.length).toBeGreaterThan(1000);
    expect(token).not.toMatch(/\s/);
  });

  it('no encuentra token en un partial-response: ese camino es del otro parser', () => {
    expect(extractViewState(BUSQUEDA)).toBeUndefined();
  });
});

describe('form', () => {
  const form = parseForm(BOOTSTRAP, PAGE_URL);

  it('encuentra el form y sus siete campos', () => {
    expect(form).toBeDefined();
    expect(form!.id).toBe(FORM_ID);
    expect([...form!.campos.keys()]).toEqual([
      FORM_ID,
      `${FORM_ID}:txtNroexp`,
      `${FORM_ID}:j_idt21`,
      `${FORM_ID}:j_idt25`,
      `${FORM_ID}:idsector`,
      `${FORM_ID}:j_idt34`,
      `${FORM_ID}:dt_scrollState`,
    ]);
  });

  it('conserva el valor de los hidden y vacía los de texto', () => {
    expect(form!.campos.get(FORM_ID)).toEqual([FORM_ID]);
    expect(form!.campos.get(`${FORM_ID}:dt_scrollState`)).toEqual(['0,0']);
    expect(form!.campos.get(`${FORM_ID}:txtNroexp`)).toEqual(['']);
  });

  it('toma la primera option del select cuando ninguna está selected', () => {
    expect(form!.campos.get(`${FORM_ID}:idsector`)).toEqual(['']);
  });

  /**
   * El form de OEFA es todo monovaluado, así que este caso no aparece en los
   * fixtures — pero un `selectManyCheckbox` es un componente estándar de JSF y
   * los filtros del bloque 4 pueden traerlo. Con un `Map<string, string>`
   * sobrevivía **solo el último valor**, en silencio: el peor modo de falla del
   * proyecto, aplicado al request de salida en vez de a la respuesta.
   */
  it('un grupo de checkboxes conserva todos los valores marcados', () => {
    const doc =
      `<form id="f" action="/v.xhtml">` +
      `<input type="checkbox" name="f:sectores" value="A" checked/>` +
      `<input type="checkbox" name="f:sectores" value="B" checked/>` +
      `<input type="checkbox" name="f:sectores" value="C" checked/>` +
      `<input type="checkbox" name="f:sectores" value="D"/>` +
      `<input type="hidden" name="javax.faces.ViewState" value="T"/></form>`;

    // La no marcada no viaja, igual que en un navegador.
    expect(parseForm(doc, PAGE_URL)!.campos.get('f:sectores')).toEqual(['A', 'B', 'C']);
  });

  it('un <select multiple> manda una entrada por opción seleccionada', () => {
    const doc =
      `<form id="f" action="/v.xhtml"><select name="f:sectores" multiple>` +
      `<option value="1" selected>uno</option><option value="2">dos</option>` +
      `<option value="3" selected>tres</option></select>` +
      `<input type="hidden" name="javax.faces.ViewState" value="T"/></form>`;

    expect(parseForm(doc, PAGE_URL)!.campos.get('f:sectores')).toEqual(['1', '3']);
  });

  /**
   * Sin `multiple` el navegador manda la primera opción cuando ninguna está
   * marcada; **con** `multiple` no manda nada. Colapsar los dos casos haría que
   * un filtro vacío viajara con un valor que el usuario nunca eligió.
   */
  it('un <select multiple> sin nada seleccionado no manda el campo', () => {
    const doc =
      `<form id="f" action="/v.xhtml"><select name="f:sectores" multiple>` +
      `<option value="1">uno</option><option value="2">dos</option></select>` +
      `<input type="hidden" name="javax.faces.ViewState" value="T"/></form>`;

    expect(parseForm(doc, PAGE_URL)!.campos.has('f:sectores')).toBe(false);
  });

  it('toSearchParams emite un par por valor, no uno por campo', () => {
    const doc =
      `<form id="f" action="/v.xhtml">` +
      `<input type="checkbox" name="f:s" value="A" checked/>` +
      `<input type="checkbox" name="f:s" value="B" checked/>` +
      `<input type="hidden" name="f:uno" value="x"/>` +
      `<input type="hidden" name="javax.faces.ViewState" value="T"/></form>`;

    const params = toSearchParams(parseForm(doc, PAGE_URL)!.campos);
    expect(params.getAll('f:s')).toEqual(['A', 'B']);
    expect(params.toString()).toBe('f%3As=A&f%3As=B&f%3Auno=x');
  });

  /** Los extra son parámetros de protocolo: pisan el campo entero, no se suman. */
  it('un extra pisa todos los valores del campo que lleva su nombre', () => {
    const doc =
      `<form id="f" action="/v.xhtml">` +
      `<input type="checkbox" name="f:s" value="A" checked/>` +
      `<input type="checkbox" name="f:s" value="B" checked/>` +
      `<input type="hidden" name="javax.faces.ViewState" value="T"/></form>`;

    const params = toSearchParams(parseForm(doc, PAGE_URL)!.campos, { 'f:s': 'Z' });
    expect(params.getAll('f:s')).toEqual(['Z']);
  });

  it('deja el ViewState fuera de los campos y aparte', () => {
    expect(form!.campos.has('javax.faces.ViewState')).toBe(false);
    expect(form!.viewState).toBeDefined();
    expect(form!.viewState).toBe(extractViewState(BOOTSTRAP));
  });

  it('excluye el botón de submit: el pulsado entra como parámetro del evento', () => {
    expect(form!.campos.has(`${FORM_ID}:btnBuscar`)).toBe(false);
  });

  it('resuelve el action a absoluto y le saca el jsessionid', () => {
    expect(form!.action).toBe(PAGE_URL);
    expect(BOOTSTRAP).toContain(';jsessionid=');
  });

  it('stripJsessionid respeta el resto de la URL', () => {
    expect(stripJsessionid('https://h/a/b.xhtml;jsessionid=ABC123?x=1')).toBe('https://h/a/b.xhtml?x=1');
    expect(stripJsessionid('https://h/a/b.xhtml')).toBe('https://h/a/b.xhtml');
  });

  /**
   * Un portal con un buscador en la cabecera tiene varios forms y solo uno es la
   * vista JSF. Quedarse con el primero produce un submit sin token contra un
   * endpoint que no es.
   */
  it('elige el form que trae el ViewState, no el primero del documento', () => {
    const doc =
      `<html><body><form id="buscadorCabecera" action="/buscar"><input name="q" value="x"/></form>` +
      `<form id="vistaJsf" action="/vista.xhtml"><input name="dato" value="y"/>` +
      `<input type="hidden" name="javax.faces.ViewState" value="TOKEN"/></form></body></html>`;

    const elegido = parseForm(doc, PAGE_URL);
    expect(elegido!.id).toBe('vistaJsf');
    expect(elegido!.viewState).toBe('TOKEN');
    expect(elegido!.campos.has('q')).toBe(false);
  });

  it('es total: un HTML sin form devuelve undefined', () => {
    expect(parseForm('<html><body>nada</body></html>', PAGE_URL)).toBeUndefined();
    expect(parseForm(BOOTSTRAP, PAGE_URL, 'formQueNoExiste')).toBeUndefined();
  });
});

describe('datatable', () => {
  const filas = parsePartialResponse(PAGINA2).updates.get(`${FORM_ID}:dt`) ?? '';

  it('readRowCount distingue «cero» de «no lo reportó»', () => {
    expect(readRowCount(BOOTSTRAP)).toBe(0);
    expect(readRowCount(BUSQUEDA)).toBe(1753);
    // La respuesta de paginación no trae el script del widget.
    expect(readRowCount(PAGINA2)).toBeUndefined();
  });

  it('las páginas no se solapan: 0–9 y 10–19', () => {
    const p1 = readRowIndices(BUSQUEDA);
    const p2 = readRowIndices(PAGINA2);
    expect(p1).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(p2).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(p1.filter((i) => p2.includes(i))).toEqual([]);
  });

  /**
   * El fragmento de la paginación es una tira de <tr> pelados. Un parser de
   * HTML los descarta en silencio, y el síntoma —cero filas, ninguna excepción—
   * es idéntico al de la sesión perdida, solo que causado por nosotros.
   */
  it('wrapRows: sin envolver, un parser de HTML devuelve cero filas', async () => {
    const cheerio = await import('cheerio');
    expect(filas.startsWith('<tr data-ri="10"')).toBe(true);
    expect(cheerio.load(filas)('tr[data-ri]').length).toBe(0);
    expect(cheerio.load(wrapRows(filas))('tr[data-ri]').length).toBe(10);
  });

  it('isEmptyTable reconoce la marca de PrimeFaces', () => {
    expect(isEmptyTable('<tr class="ui-widget-content ui-datatable-empty-message"><td></td></tr>')).toBe(true);
    expect(isEmptyTable(filas)).toBe(false);
  });

  it('pageCommand arma los pares verificados de §5.3', () => {
    const cmd = pageCommand({ tableId: `${FORM_ID}:dt`, first: 10, rows: 10 });
    expect(cmd.source).toBe(`${FORM_ID}:dt`);
    expect(cmd.event).toBe('page');
    expect(cmd.params).toEqual({
      [`${FORM_ID}:dt_pagination`]: 'true',
      [`${FORM_ID}:dt_first`]: '10',
      [`${FORM_ID}:dt_rows`]: '10',
      [`${FORM_ID}:dt_skipChildren`]: 'true',
      [`${FORM_ID}:dt_encodeFeature`]: 'true',
    });
  });
});

describe('mojarra.jsfcljs', () => {
  it('extrae el componente y el uuid del onclick real de la fila 0', () => {
    const onclick = BUSQUEDA.match(/onclick="(mojarra\.jsfcljs[^"]*)"/)?.[1] ?? '';
    expect(parseJsfcljs(onclick)).toEqual({
      [`${FORM_ID}:dt:0:j_idt63`]: `${FORM_ID}:dt:0:j_idt63`,
      param_uuid: '153a6d2a-cbed-40ef-b8ef-cd2272b19867',
    });
  });

  it('devuelve undefined si el patrón no está, en vez de un objeto vacío', () => {
    expect(parseJsfcljs('return false')).toBeUndefined();
    expect(parseJsfcljs('PrimeFaces.ab({s:"form:btnBuscar"})')).toBeUndefined();
  });
});
