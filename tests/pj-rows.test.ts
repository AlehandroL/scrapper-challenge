/**
 * Los parsers del portal del Poder Judicial contra el markup archivado.
 *
 * Estos tests son los que le dan al bloque 7 su base de evidencia. El sitio
 * responde `403` desde Chile, pero `fixtures/pj/` tiene markup que el portal
 * produjo de verdad —capturado del archivo web— y contra eso se puede aseverar
 * sin inventar nada.
 *
 * Lo que cubren, que es exactamente lo que los snapshots contienen:
 *
 * - los ids del form y de los campos de búsqueda;
 * - el `ViewState` server-side, en tres muestras de 2016 y 2025;
 * - los tres forms de la vista de resultados;
 * - la forma real del `onclick`, envuelta en `jsf.util.chain`.
 *
 * Lo que **no** cubren, porque ningún snapshot lo trae: las filas de resultado y
 * la paginación. Eso se ejercita contra el portal falso en `pj-source.test.ts`,
 * que es una cosa distinta y más débil, y está dicho ahí.
 *
 * Varios de estos tests aseveran sobre el markup *tal como está guardado*. Si
 * `bash scripts/capture-pj.sh` trae snapshots distintos porque el archivo web
 * indexó capturas nuevas, van a fallar — y eso es lo que tienen que hacer: el
 * cambio hay que mirarlo, no absorberlo.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';

import { parseJsfcljs } from '../src/jsf/commands.ts';
import { parseForm, parseForms } from '../src/jsf/form.ts';
import { extractViewState } from '../src/jsf/view-state.ts';
import {
  CAMPOS_BUSQUEDA,
  FORMS_CONOCIDOS,
  descubrirBusqueda,
  descubrirPaginacion,
  identidadPjDe,
  leerTotal,
  parseTablaPj,
  rotular,
} from '../src/sources/pj-rows.ts';

const fixture = (nombre: string): string =>
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'pj', nombre), 'utf8');

const BOOTSTRAP = fixture('01-bootstrap-resultado.html');
const BUSQUEDA = fixture('02-busqueda-resultado.html');
const GENERAL = fixture('03-busqueda-general.html');

const URL = 'https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml';

describe('el stack del portal, según su propio markup', () => {
  /**
   * La corrección de mayor impacto del bloque: §2.1 y §2.4 daban por hecho que
   * el portal corría PrimeFaces, «mismo stack» que OEFA. No hay una sola
   * coincidencia en cuatro páginas revisadas; hay quince de RichFaces.
   *
   * La consecuencia es concreta: `jsf/datatable.ts` —`rowCount`, `data-ri`, el
   * evento `_pagination`— es de PrimeFaces y no transfiere.
   */
  it.each([
    ['01-bootstrap-resultado.html', BOOTSTRAP],
    ['02-busqueda-resultado.html', BUSQUEDA],
    ['03-busqueda-general.html', GENERAL],
  ])('%s corre RichFaces y no PrimeFaces', (_nombre, html) => {
    expect(html.toLowerCase()).toContain('richfaces');
    expect(html.toLowerCase()).not.toContain('primefaces');
  });

  it('declara RichFaces 4.2.2.Final en sus recursos estáticos', () => {
    expect(BOOTSTRAP).toContain('org.richfaces.staticResource/4.2.2.Final');
  });

  /**
   * §5.1 daba el state saving por client-side, como en OEFA, y mantenía el
   * modelo estricto —token de un solo uso, LRU de vistas, `recover()`
   * obligatorio— «como el caso conservador, que el Poder Judicial puede
   * perfectamente usar». Lo usa: tres muestras, dos de 2016 y una de 2025.
   *
   * El handle de dos longs es la firma inconfundible: con state saving
   * client-side el token es un blob base64 de ~1,5 KB que serializa el árbol de
   * componentes.
   */
  it.each([
    ['01-bootstrap-resultado.html', BOOTSTRAP],
    ['02-busqueda-resultado.html', BUSQUEDA],
    ['03-busqueda-general.html', GENERAL],
  ])('%s guarda el estado en el servidor: el token es un handle, no un blob', (_nombre, html) => {
    const token = extractViewState(html);
    expect(token).toBeDefined();
    expect(token).toMatch(/^-?\d+:-?\d+$/);
    // Un blob client-side mide ~1.500 bytes; un handle, menos de cincuenta.
    expect(token!.length).toBeLessThan(50);
  });
});

describe('los forms de la vista', () => {
  it('el bootstrap de 2025 usa formBuscador, no formBusqueda', () => {
    const form = parseForm(BOOTSTRAP, URL);
    expect(form?.id).toBe('formBuscador');
    // Los dos nombres están en la lista de conocidos porque el portal ya cambió
    // de uno al otro entre 2016 y 2025: hardcodear cualquiera de los dos habría
    // acertado en un snapshot y fallado en el otro.
    expect(FORMS_CONOCIDOS).toContain(form?.id);
  });

  /**
   * La página de resultados tiene tres forms y **los tres llevan el mismo
   * token**, así que «el primero con ViewState» es una elección incidental. Es
   * la razón por la que `JsfView` conserva todos y `parseJsfcljs` devuelve el
   * form que el `onclick` nombra.
   */
  it('la página de resultados de 2016 tiene tres forms con el mismo token', () => {
    const forms = parseForms(BUSQUEDA, URL);

    expect(forms.map((f) => f.id)).toEqual(['formBusqueda', 'frmDetalle', 'frmDetalle2']);
    const tokens = new Set(forms.map((f) => f.viewState));
    expect(tokens.size).toBe(1);
    expect([...tokens][0]).toMatch(/^-?\d+:-?\d+$/);
  });

  it('el form del documento abre en otra pestaña, que es lo que lo delata', () => {
    const $ = cheerio.load(BUSQUEDA);
    expect($('form#frmDetalle2').attr('target')).toBe('_blank');
  });

  it('el action trae el jsessionid reescrito y parseForm lo saca', () => {
    // Redactado en el fixture, pero la forma es la del sitio: la cookie es la
    // fuente de verdad y el id en la URL solo sirve para filtrarse.
    expect(BUSQUEDA).toContain(';jsessionid=');
    expect(parseForm(BUSQUEDA, URL)?.action).not.toContain('jsessionid');
  });
});

describe('los campos de búsqueda', () => {
  /**
   * Al revés que OEFA, donde tres de los cuatro filtros son `j_idt21`, `j_idt25`
   * y `j_idt34`, este portal los nombra. Es lo que permite reconocer que el form
   * del bootstrap es efectivamente el de búsqueda y no otro de la página.
   */
  it('el form de resultados trae los filtros con nombre estable', () => {
    const campos = [...(parseForm(BUSQUEDA, URL)?.campos.keys() ?? [])];

    for (const esperado of [
      'buCorte',
      'buEspecialidad',
      'buSala',
      'buTipoRecurso',
      'buTipoResolucion',
      'buAnio',
    ]) {
      expect(campos.some((c) => c.endsWith(`:${esperado}`))).toBe(true);
    }
  });

  it('el bootstrap de 2025 trae al menos uno de los campos conocidos', () => {
    const campos = [...(parseForm(BOOTSTRAP, URL)?.campos.keys() ?? [])];
    const reconocidos = CAMPOS_BUSQUEDA.filter((c) =>
      campos.some((n) => n === c || n.endsWith(`:${c}`)),
    );
    expect(reconocidos).toContain('txtBusqueda');
  });

  /**
   * Aunque los nombres se conozcan, **el adapter no expone filtros**: el request
   * de búsqueda con valores no está reversado (§2.5). Este test fija esa
   * decisión para que agregarlos exija tocarlo y leer el porqué.
   */
  it('los filtros se conocen pero se reenvían vacíos: la búsqueda con valores no está reversada', () => {
    const campos = parseForm(BUSQUEDA, URL)?.campos;

    // Presentes y vacíos: JSF exige el submit completo del form, así que viajan
    // en cada POST con el valor que tenían. Lo que no está reversado es emitirlos
    // **con valores**, que es otra cosa.
    for (const campo of [
      'formBusqueda:txtBusqueda',
      'formBusqueda:buPalabraClaveValue',
      'formBusqueda:buPretensionValue',
    ]) {
      expect(campos?.get(campo)).toEqual(['']);
    }
  });
});

describe('el onclick real, que es el que rompía el parser', () => {
  /**
   * El defecto que encontró el markup: el patrón viene envuelto en
   * `jsf.util.chain` y con las comillas escapadas como `\\'`. La versión anterior
   * de `parseJsfcljs` devolvía `undefined` contra esta cadena exacta, con lo que
   * el adapter habría marcado **toda** fila del portal como enlace ilegible en la
   * primera página.
   */
  it('lee el botón Buscar de la página de resultados', () => {
    const $ = cheerio.load(BUSQUEDA);
    const onclick = $('input[value="Buscar"]').first().attr('onclick') ?? '';

    expect(onclick).toContain('jsf.util.chain');
    expect(onclick).toContain("\\'");

    expect(parseJsfcljs(onclick)).toEqual({
      formId: 'formBusqueda',
      params: { 'formBusqueda:j_idt65': 'formBusqueda:j_idt65', 'formBusqueda:j_idt66': '' },
    });
  });

  it('descubrirBusqueda encuentra ese mismo control sin saber su id', () => {
    // El id es autogenerado (`j_idt65`) y un componente agregado más arriba lo
    // desplaza entero. Lo estable es la etiqueta.
    expect(descubrirBusqueda(BUSQUEDA)).toEqual({
      formulario: 'formBusqueda',
      params: { 'formBusqueda:j_idt65': 'formBusqueda:j_idt65', 'formBusqueda:j_idt66': '' },
    });
  });

  /**
   * El snapshot de 2025 no trae el botón: el portal lo renderiza
   * condicionalmente y las celdas que lo alojarían vienen vacías. Es un
   * desenlace legítimo del parser, no un fallo, y `pj.ts` lo convierte en un
   * drift con nombre propio.
   */
  it('en el bootstrap de 2025 no hay botón Buscar, y eso es un dato', () => {
    expect(descubrirBusqueda(BOOTSTRAP)).toBeUndefined();
  });

  /**
   * Ningún snapshot trae paginación. El primer borrador de `fixtures/pj/README.md`
   * leyó el comando de `03` como paginación por el `-pag` de su URL; mirado el
   * elemento, es un buscador general que abre resultados en otra pestaña. Este
   * test fija la corrección para que no vuelva a colarse.
   */
  it('ningún snapshot trae control de paginación', () => {
    for (const html of [BOOTSTRAP, BUSQUEDA, GENERAL]) {
      expect(descubrirPaginacion(html)).toBeUndefined();
    }
  });

  it('el comando de 03 es una búsqueda con parámetros, no un offset de página', () => {
    const $ = cheerio.load(GENERAL);
    const onclick = $('[onclick]')
      .toArray()
      .map((el) => $(el).attr('onclick') ?? '')
      .find((v) => v.includes('jsfcljs'));

    expect(parseJsfcljs(onclick ?? '')).toEqual({
      formId: 'formBusqueda',
      params: {
        'formBusqueda:j_idt16': 'formBusqueda:j_idt16',
        forward: 'buscar',
        'formBusqueda:j_idt18': '21',
        'formBusqueda:j_idt19': 'DESC',
      },
    });
    // Y abre en otra pestaña, igual que frmDetalle2: el portal usa el target del
    // form para decidir dónde pinta la respuesta.
    expect(onclick).toContain('_blank');
  });
});

describe('parseTablaPj', () => {
  /**
   * Ninguno de los snapshots trae resultados —el archivo web captura GETs y acá
   * los resultados nacen de un POST—, así que el parser tiene que devolver «no
   * encontré iterador» y no un error ni una tabla inventada. Es lo que hace que
   * `pj.ts` pueda distinguir «esta página no tiene resultados» de «el parser se
   * rompió».
   */
  it.each([
    ['01-bootstrap-resultado.html', BOOTSTRAP],
    ['02-busqueda-resultado.html', BUSQUEDA],
    ['03-busqueda-general.html', GENERAL],
  ])('%s no trae filas de resultado y lo dice sin lanzar', (_nombre, html) => {
    const tabla = parseTablaPj(html);
    expect(tabla.iterador).toBeUndefined();
    expect(tabla.filas).toEqual([]);
  });

  it('reconoce las filas por la convención de nombres de JSF, no por CSS', () => {
    const html =
      '<table><tbody>' +
      '<tr><td>1</td><td>Penal</td><td><a id="formBusqueda:repeat:0:j_idt158" ' +
      'onclick="mojarra.jsfcljs(document.getElementById(\'frmDetalle2\')," +' +
      "\"{'formBusqueda:repeat:0:j_idt158':'formBusqueda:repeat:0:j_idt158','uuid':'abc'},'')\">Ver</a></td></tr>" +
      '<tr><td>2</td><td>Civil</td><td><a id="formBusqueda:repeat:1:j_idt158" ' +
      'onclick="mojarra.jsfcljs(document.getElementById(\'frmDetalle2\')," +' +
      "\"{'formBusqueda:repeat:1:j_idt158':'formBusqueda:repeat:1:j_idt158','uuid':'def'},'')\">Ver</a></td></tr>" +
      '</tbody></table>';

    const tabla = parseTablaPj(html);
    expect(tabla.iterador).toBe('repeat');
    expect(tabla.filas.map((f) => f.indice)).toEqual([0, 1]);
    expect(tabla.filas.map((f) => f.celdas.length)).toEqual([3, 3]);
  });
});

describe('leerTotal', () => {
  it.each([
    ['Se encontraron 1.753 resultados', 1753],
    ['se encontraron 42 registros', 42],
    ['Mostrando 10 de 300 resultados', 300],
    ['Página 1 de 5 (1,234 registros)', 1234],
  ])('lee «%s» como %i', (texto, esperado) => {
    expect(leerTotal(texto)).toBe(esperado);
  });

  /**
   * `undefined` es un desenlace de primera clase, no un fallo: `pj.ts` lo
   * convierte en drift `sin-total`, porque sin total no hay última página y
   * adivinarla produce un archivo con huecos que parece completo.
   */
  it('devuelve undefined cuando no reconoce la frase, en vez de inventar un total', () => {
    expect(leerTotal('Resultados de la búsqueda')).toBeUndefined();
    expect(leerTotal('')).toBeUndefined();
  });
});

describe('identidad y rótulos', () => {
  it('la identidad sale del contenido y es estable entre corridas', () => {
    expect(identidadPjDe('una fila', 'uuid-1')).toBe(identidadPjDe('una fila', 'uuid-1'));
    expect(identidadPjDe('una fila', 'uuid-1')).not.toBe(identidadPjDe('otra fila', 'uuid-1'));
    expect(identidadPjDe('una fila', 'uuid-1')).toHaveLength(24);
  });

  /** Dos filas que comparten documento son registros distintos (§5.8). */
  it('dos filas con el mismo documento y distinto texto no colisionan', () => {
    expect(identidadPjDe('fila A', 'mismo-uuid')).not.toBe(identidadPjDe('fila B', 'mismo-uuid'));
  });

  it('una fila sin documento tiene identidad igual', () => {
    expect(identidadPjDe('fila sin doc', undefined)).toHaveLength(24);
  });

  it('rotula con los encabezados y cae a columnaN cuando faltan', () => {
    expect(rotular(['a', 'b'], ['Materia', 'Sumilla'])).toEqual({ Materia: 'a', Sumilla: 'b' });
    expect(rotular(['a', 'b'], ['Materia'])).toEqual({ Materia: 'a', columna2: 'b' });
    expect(rotular(['a'], [])).toEqual({ columna1: 'a' });
  });
});
