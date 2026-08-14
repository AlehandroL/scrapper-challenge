/**
 * Los cuerpos POST contra la verdad de `scripts/capture-oefa.sh`.
 *
 * El script es la evidencia de que esos requests funcionan: se ejecutaron
 * contra el sitio vivo y produjeron los fixtures. Este archivo asevera que el
 * código produce **los mismos pares**, de modo que la implementación queda
 * atada al reversing y no a lo que alguien recuerde de él.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CABECERAS_AJAX, buildAjaxBody, buildCommandBody } from '../src/jsf/commands.ts';
import { pageCommand } from '../src/jsf/datatable.ts';
import { parseForm, type JsfForm } from '../src/jsf/form.ts';

const PAGE_URL = 'https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml';
const FORM_ID = 'listarDetalleInfraccionRAAForm';
const TABLE_ID = `${FORM_ID}:dt`;
const TOKEN = 'TOKEN-DE-PRUEBA';

const bootstrap = readFileSync(
  join(import.meta.dirname, '..', 'fixtures', 'oefa', '01-bootstrap.html'),
  'utf8',
);
const form: JsfForm = parseForm(bootstrap, PAGE_URL)!;

/** Los 7 campos del form que JSF exige reenviar en todo submit. */
const CAMPOS_DEL_FORM: [string, string][] = [
  [FORM_ID, FORM_ID],
  [`${FORM_ID}:txtNroexp`, ''],
  [`${FORM_ID}:j_idt21`, ''],
  [`${FORM_ID}:j_idt25`, ''],
  [`${FORM_ID}:idsector`, ''],
  [`${FORM_ID}:j_idt34`, ''],
  [`${FORM_ID}:dt_scrollState`, '0,0'],
];

const pares = (b: URLSearchParams): [string, string][] => [...b.entries()].sort();
const contiene = (b: URLSearchParams, esperados: [string, string][]): void => {
  for (const [clave, valor] of esperados) expect([clave, b.get(clave)]).toEqual([clave, valor]);
};

describe('POST de paginación', () => {
  const body = buildAjaxBody(form, TOKEN, pageCommand({ tableId: TABLE_ID, first: 10, rows: 10 }));

  it('manda los 18 pares del reversing: 10 del evento, 7 del form y el token', () => {
    expect(pares(body)).toHaveLength(18);
  });

  it('coincide par por par con el request verificado', () => {
    contiene(body, [
      ['javax.faces.partial.ajax', 'true'],
      ['javax.faces.source', TABLE_ID],
      ['javax.faces.partial.execute', TABLE_ID],
      ['javax.faces.partial.render', TABLE_ID],
      ['javax.faces.behavior.event', 'page'],
      [`${TABLE_ID}_pagination`, 'true'],
      [`${TABLE_ID}_first`, '10'],
      [`${TABLE_ID}_rows`, '10'],
      [`${TABLE_ID}_skipChildren`, 'true'],
      [`${TABLE_ID}_encodeFeature`, 'true'],
      ['javax.faces.ViewState', TOKEN],
      ...CAMPOS_DEL_FORM,
    ]);
  });

  it('el offset viaja en dt_first, que es lo que mueve la página', () => {
    const p3 = buildAjaxBody(form, TOKEN, pageCommand({ tableId: TABLE_ID, first: 20, rows: 10 }));
    expect(p3.get(`${TABLE_ID}_first`)).toBe('20');
  });
});

describe('POST de búsqueda', () => {
  const body = buildAjaxBody(form, TOKEN, {
    source: `${FORM_ID}:btnBuscar`,
    execute: '@all',
    render: `${FORM_ID}:pgLista ${FORM_ID}:txtNroexp`,
    params: { [`${FORM_ID}:btnBuscar`]: `${FORM_ID}:btnBuscar` },
  });

  it('manda los 13 pares del reversing', () => {
    expect(pares(body)).toHaveLength(13);
  });

  it('coincide par por par, y sin behavior.event', () => {
    contiene(body, [
      ['javax.faces.partial.ajax', 'true'],
      ['javax.faces.source', `${FORM_ID}:btnBuscar`],
      ['javax.faces.partial.execute', '@all'],
      ['javax.faces.partial.render', `${FORM_ID}:pgLista ${FORM_ID}:txtNroexp`],
      [`${FORM_ID}:btnBuscar`, `${FORM_ID}:btnBuscar`],
      ['javax.faces.ViewState', TOKEN],
      ...CAMPOS_DEL_FORM,
    ]);
    // Un command button no emite behavior.event; la tabla sí. Mandarlo de más
    // hace que el servidor busque un listener que no existe.
    expect(body.has('javax.faces.behavior.event')).toBe(false);
  });
});

describe('POST de descarga (mojarra.jsfcljs)', () => {
  const UUID = '153a6d2a-cbed-40ef-b8ef-cd2272b19867';
  const COMPONENTE = `${FORM_ID}:dt:0:j_idt63`;
  const body = buildCommandBody(form, TOKEN, { [COMPONENTE]: COMPONENTE, param_uuid: UUID });

  it('manda los 10 pares del reversing', () => {
    expect(pares(body)).toHaveLength(10);
  });

  /**
   * La diferencia que define la descarga. `mojarra.jsfcljs` hace un
   * `form.submit()` normal: con cualquier `javax.faces.partial.*` el servidor
   * responde el diff XML en vez del binario.
   */
  it('NO lleva ningún javax.faces.partial.*', () => {
    for (const clave of body.keys()) expect(clave.startsWith('javax.faces.partial.')).toBe(false);
    expect(body.has('javax.faces.behavior.event')).toBe(false);
  });

  it('lleva el componente, el uuid, los campos del form y el token', () => {
    contiene(body, [
      [COMPONENTE, COMPONENTE],
      ['param_uuid', UUID],
      ['javax.faces.ViewState', TOKEN],
      ...CAMPOS_DEL_FORM,
    ]);
  });

  /**
   * §5.4: la descarga exige un token alineado con la página donde vive la fila.
   * Que el token sea un argumento y no `form.viewState` es lo que hace visible
   * en el código de qué página salió.
   */
  it('el token es explícito: dos páginas producen dos cuerpos distintos', () => {
    const pagina1 = buildCommandBody(form, 'TOKEN-PAGINA-1', { param_uuid: UUID });
    const pagina2 = buildCommandBody(form, 'TOKEN-PAGINA-2', { param_uuid: UUID });
    expect(pagina1.get('javax.faces.ViewState')).toBe('TOKEN-PAGINA-1');
    expect(pagina2.get('javax.faces.ViewState')).toBe('TOKEN-PAGINA-2');
  });
});

describe('headers', () => {
  it('el ajax lleva Faces-Request, el header que más se omite', () => {
    expect(CABECERAS_AJAX['Faces-Request']).toBe('partial/ajax');
    expect(CABECERAS_AJAX['X-Requested-With']).toBe('XMLHttpRequest');
  });
});

describe('no muta el form', () => {
  it('dos cuerpos seguidos no se contaminan entre sí', () => {
    const antes = [...form.campos.entries()];
    buildAjaxBody(form, TOKEN, pageCommand({ tableId: TABLE_ID, first: 10, rows: 10 }));
    buildCommandBody(form, TOKEN, { param_uuid: 'x' });
    expect([...form.campos.entries()]).toEqual(antes);
  });
});
