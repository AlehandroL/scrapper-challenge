/**
 * El parser de la tabla de OEFA contra los fixtures reales. Sin red.
 *
 * Cada aserción de acá codifica una decisión de parsing que costó descubrir: el
 * CDATA que llega sin `<table>`, el anchor de más en el paginador, el
 * administrado multivalor separado por saltos de línea, y el `rowCount` que solo
 * viaja en la respuesta de búsqueda. Cuando el sitio cambie, el ciclo de
 * corrección baja de minutos a segundos porque el parser se ejercita contra
 * estos archivos y no contra el sitio (§6.5).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { findUpdate, parsePartialResponse } from '../src/jsf/partial-response.ts';
import { readPageSize } from '../src/jsf/datatable.ts';
import {
  CABECERAS_ESPERADAS,
  ID_LISTA,
  ID_TABLA,
  PARAM_DOCUMENTO,
  RegistroOefaSchema,
  anioDeResolucion,
  identidadDe,
  parsePaginador,
  parseTabla,
  type FilaCruda,
} from '../src/sources/oefa-rows.ts';

const fixture = (nombre: string): string =>
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'oefa', nombre), 'utf8');

/** El CDATA de cada respuesta, ya desencapsulado: es lo que recibe el parser. */
const fragmento = (archivo: string, id: string): string => {
  const contenido = findUpdate(parsePartialResponse(fixture(archivo)), id);
  if (contenido === undefined) throw new Error(`el fixture ${archivo} no trae un <update> ${id}`);
  return contenido;
};

const BUSQUEDA = fragmento('02-search-partial.xml', ID_LISTA);
const PAGINA2 = fragmento('03-page2-partial.xml', ID_TABLA);
const PAGINA4 = fragmento('07-page4-confidencial.xml', ID_TABLA);
const PAGINA28 = fragmento('08-page28-uuid-repetida.xml', ID_TABLA);

/** El uuid del documento, cuando la fila tiene uno. */
const uuidDe = (f: FilaCruda | undefined): string | undefined =>
  f?.documento.estado === 'ok' ? f.documento.uuid : undefined;

const TABLA_VACIA = '<tr class="ui-widget-content ui-datatable-empty-message"><td colspan="7"></td></tr>';

describe('la respuesta de búsqueda', () => {
  const tabla = parseTabla(BUSQUEDA);

  it('trae las diez filas de la primera página', () => {
    expect(tabla.filas).toHaveLength(10);
    expect(tabla.filas.map((f) => f.indice)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(tabla.vacia).toBe(false);
  });

  it('reporta el total y el tamaño de página desde el script del widget', () => {
    expect(tabla.total).toBe(1753);
    expect(tabla.pageSize).toBe(10);
  });

  /**
   * El paginador es una **segunda fuente** del total, independiente del
   * `rowCount`. Que dos caminos distintos coincidan es lo que lo convierte en un
   * dato verificado en vez de en uno leído.
   */
  it('el paginador confirma el total por otro camino', () => {
    expect(tabla.paginadorTexto).toBe('Página 1 de 176 (1753 registros)');
    expect(parsePaginador(tabla.paginadorTexto ?? '')).toEqual({ pagina: 1, paginas: 176, total: 1753 });
  });

  it('descubre las siete cabeceras', () => {
    expect(tabla.cabeceras).toEqual([...CABECERAS_ESPERADAS]);
  });

  it('parsea la primera fila entera', () => {
    const fila = tabla.filas[0];
    expect(fila?.nro).toBe(1);
    expect(fila?.columnas).toBe(7);
    expect(uuidDe(fila)).toBe('153a6d2a-cbed-40ef-b8ef-cd2272b19867');
    expect(fila?.campos).toEqual({
      expediente: '891-08-PRODUCE/DIGSECOVI-Dsvs',
      administrados: ['Corporación del Mar S.A.', 'Austral Group S.A.A.'],
      unidadFiscalizable: 'Planta Playa Lado Norte Puerto Malabrigo',
      sector: 'Pesquería',
      resolucion: '264-2012-OEFA/TFA',
      anioResolucion: 2012,
    });
  });

  /**
   * El `<td>` de la primera fila trae dos administrados separados por un salto
   * de línea. Colapsarlos a un string produce un campo que ninguna búsqueda
   * posterior matchea, y el bug es invisible: el registro se ve bien.
   */
  it('separa los administrados multivalor', () => {
    expect(tabla.filas[0]?.campos?.administrados).toHaveLength(2);
    expect(tabla.filas[1]?.campos?.administrados).toEqual(['Consorcio Pacífico Sur S.R.L.']);
  });

  it('cada fila trae un uuid distinto', () => {
    const uuids = tabla.filas.map(uuidDe);
    expect(uuids.every((u) => typeof u === 'string')).toBe(true);
    expect(new Set(uuids).size).toBe(10);
  });

  /**
   * El fragmento trae **once** anchors con `mojarra.jsfcljs` y solo diez filas:
   * el sobrante es «Exportar a excel», que vive en el paginador y no lleva
   * parámetro de documento. Sin el scope a `tr[data-ri]`, se cuela como una fila
   * fantasma sin uuid.
   */
  it('no confunde el botón de exportar a excel con una fila', () => {
    const anchors = BUSQUEDA.match(/mojarra\.jsfcljs/g) ?? [];
    expect(anchors.length).toBe(11);
    expect(tabla.filas).toHaveLength(10);
  });

  it('el comando de descarga conserva los dos pares del onclick', () => {
    const documento = tabla.filas[0]?.documento;
    if (documento?.estado !== 'ok') throw new Error('la primera fila debería traer documento');

    expect(Object.keys(documento.comando)).toHaveLength(2);
    expect(documento.comando[PARAM_DOCUMENTO]).toBe('153a6d2a-cbed-40ef-b8ef-cd2272b19867');
  });

  it('produce registros que pasan el esquema de §6.7', () => {
    for (const fila of tabla.filas) {
      const registro = {
        fuente: 'oefa',
        id: identidadDe(fila.campos!, uuidDe(fila)),
        indice: fila.indice,
        pagina: 1,
        capturadoEn: new Date().toISOString(),
        documentoUuid: uuidDe(fila),
        ...fila.campos,
      };
      expect(RegistroOefaSchema.safeParse(registro).success).toBe(true);
    }
  });
});

describe('la respuesta de paginación', () => {
  const tabla = parseTabla(PAGINA2);

  /**
   * El CDATA empieza literalmente en `<tr data-ri="10"`, sin `<table>` que lo
   * contenga. Cargado tal cual, el algoritmo de parsing de HTML descarta los
   * `<tr>` fuera de contexto de tabla y devuelve **cero filas, sin excepción**:
   * el mismo síntoma que la sesión perdida, pero causado por nosotros.
   */
  it('lee la tira de <tr> pelados sin <table>', () => {
    expect(PAGINA2.trimStart().startsWith('<tr data-ri="10"')).toBe(true);
    expect(tabla.filas).toHaveLength(10);
    expect(tabla.filas.map((f) => f.indice)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  /**
   * Distinguir «no lo reportó» de «reportó cero» es lo que impide que el sanity
   * check de §6.3 compare el total contra un cero inventado. Y es la razón por
   * la que las cabeceras y el tamaño de página solo se pueden chequear sobre la
   * respuesta de búsqueda.
   */
  it('no trae total, ni tamaño de página, ni cabeceras', () => {
    expect(tabla.total).toBeUndefined();
    expect(tabla.pageSize).toBeUndefined();
    expect(tabla.cabeceras).toEqual([]);
    expect(tabla.paginadorTexto).toBeUndefined();
  });

  it('la numeración sigue al índice global', () => {
    expect(tabla.filas.map((f) => f.nro)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  });

  it('no se solapa con la página anterior', () => {
    const pagina1 = parseTabla(BUSQUEDA).filas.map(uuidDe);
    const solapadas = tabla.filas.filter((f) => pagina1.includes(uuidDe(f)));
    expect(solapadas).toEqual([]);
  });
});

describe('robustez del parser', () => {
  it('envolver o no el fragmento da el mismo resultado', () => {
    const envuelto = parseTabla(`<table><tbody>${PAGINA2}</tbody></table>`);
    expect(envuelto.filas).toEqual(parseTabla(PAGINA2).filas);
  });

  it('reconoce la tabla vacía sin inventar filas', () => {
    const tabla = parseTabla(TABLA_VACIA);
    expect(tabla.vacia).toBe(true);
    expect(tabla.filas).toEqual([]);
  });

  /**
   * Total por contrato: una tabla que cambió de forma es un dato para el parser
   * y un problema para `oefa.ts`, que es el único que sabe qué esperaba.
   */
  it('no lanza ante una fila con menos columnas: deja `campos` en undefined', () => {
    const tabla = parseTabla('<tr data-ri="0"><td> 1</td><td>solo dos</td></tr>');
    expect(tabla.filas[0]?.columnas).toBe(2);
    expect(tabla.filas[0]?.campos).toBeUndefined();
  });

  it('una fila sin onclick se reporta como «sin enlace», no como rota', () => {
    const sinBoton = PAGINA2.replace(/onclick="[^"]*"/g, '');
    expect(parseTabla(sinBoton).filas.every((f) => f.documento.estado === 'sin-enlace')).toBe(true);
  });

  /**
   * El identificador se deduce por estructura —JSF emite el par del componente
   * con clave y valor idénticos— y no por el nombre `param_uuid`, que en el
   * Poder Judicial es `uuid`. Con un tercer par la deducción es ambigua y se
   * devuelve `undefined`: elegir «el primero» decidiría en silencio.
   */
  it('con un tercer parámetro en el onclick no adivina cuál es el documento', () => {
    const conExtra = PAGINA2.replace(/'param_uuid':'([^']*)'/, "'param_uuid':'$1','otro':'x'");
    expect(parseTabla(conExtra).filas[0]?.documento.estado).toBe('ilegible');
  });

  it('el `nro` ilegible se reporta como undefined y no como cero', () => {
    const tabla = parseTabla('<tr data-ri="0"><td>—</td></tr>');
    expect(tabla.filas[0]?.nro).toBeUndefined();
  });
});

describe('derivaciones', () => {
  it.each([
    ['264-2012-OEFA/TFA', 2012],
    ['007-2016-OEFA/TFA-SEPIM', 2016],
    ['019-2015-OEFA/TFA-SEPIM', 2015],
  ])('extrae el año de «%s»', (resolucion, esperado) => {
    expect(anioDeResolucion(resolucion)).toBe(esperado);
  });

  /**
   * Los dos formatos que la primera versión del parser no cubría, y que ningún
   * fixture tenía: los encontró `npm run validate` sobre el dataset completo, 29
   * resoluciones con documento publicado y sin año. El regex exigía `-` o fin de
   * cadena después del año, y el portal escribe `/TFA-SEP1` sin el segmento
   * `-OEFA`, o mete un espacio antes del guion.
   */
  it.each([
    ['019-2014/TFA-SEP1', 2014],
    ['027-2014/TFA-SE1', 2014],
    ['075-2013 -OEFA/TFA', 2013],
  ])('extrae el año de «%s», que el regex viejo perdía', (resolucion, esperado) => {
    expect(anioDeResolucion(resolucion)).toBe(esperado);
  });

  /**
   * OEFA no publica fecha; un correlativo de cuatro dígitos no es un año. El
   * `-20145` es la contracara del arreglo de arriba: aflojar el delimitador de
   * la derecha no puede convertir un número de cinco cifras en 2014.
   */
  it.each([['sin año'], ['12-0345-X'], [''], ['001-20145-OEFA/TFA'], ['Información confidencial']])(
    'no inventa un año para «%s»',
    (resolucion) => {
      expect(anioDeResolucion(resolucion)).toBeUndefined();
    },
  );

  it('el paginador tolera separadores de miles', () => {
    expect(parsePaginador('Página 3 de 1.760 (17.593 registros)')).toEqual({
      pagina: 3,
      paginas: 1760,
      total: 17593,
    });
  });

  it('el paginador devuelve undefined si el rótulo cambió', () => {
    expect(parsePaginador('Mostrando 1-10')).toBeUndefined();
  });

  /** El `rowCount` no debe confundirse con el `rows` del paginador. */
  it('readPageSize lee `rows` y no `rowCount`', () => {
    expect(readPageSize('paginator:{id:[\'x\'],rows:20,rowCount:1753,page:0}')).toBe(20);
    expect(readPageSize('scrollLimit:1753,rows:99')).toBeUndefined();
  });
});

/**
 * El hallazgo de la primera corrida completa, con el fixture que lo prueba.
 *
 * OEFA publica algunas resoluciones como «Información confidencial»: sin número
 * y **sin enlace de descarga**. Son registros legítimos —expediente,
 * administrado, unidad y sector están— que simplemente no tienen documento.
 * Tratar la ausencia de enlace como drift costaba perderlos; tratarla como «uuid
 * vacío» costaba perder la detección de que el `onclick` cambió de forma. Por eso
 * el parser distingue «no hay enlace» de «hay enlace y no se deja leer».
 */
describe('filas sin documento (fixture 07, página 4)', () => {
  const tabla = parseTabla(PAGINA4);

  it('la página trae sus diez filas igual', () => {
    expect(tabla.filas).toHaveLength(10);
    expect(tabla.filas.map((f) => f.indice)).toEqual([30, 31, 32, 33, 34, 35, 36, 37, 38, 39]);
  });

  it('exactamente dos filas no tienen enlace de descarga', () => {
    const sinEnlace = tabla.filas.filter((f) => f.documento.estado === 'sin-enlace');
    expect(sinEnlace.map((f) => f.indice)).toEqual([37, 38]);
  });

  it('ninguna fila queda marcada como ilegible', () => {
    expect(tabla.filas.filter((f) => f.documento.estado === 'ilegible')).toEqual([]);
  });

  it('las filas sin documento conservan todos sus campos', () => {
    const fila = tabla.filas.find((f) => f.indice === 37);
    expect(fila?.columnas).toBe(7);
    expect(fila?.campos).toMatchObject({
      expediente: '3739-2009-PRODUCE/DIGSECOVI-Dsvs',
      administrados: ['Tecnologías en Favor del Medio Ambiente S.A.C.'],
      unidadFiscalizable: 'Planta Harina Residual',
      sector: 'Pesquería',
      resolucion: 'Información confidencial',
    });
  });

  it('sin número de resolución no se inventa un año', () => {
    expect(tabla.filas.find((f) => f.indice === 37)?.campos?.anioResolucion).toBeUndefined();
  });
});

/**
 * El segundo hallazgo de la primera corrida completa, también con su fixture.
 *
 * Las filas 277 y 278 comparten expediente, administrado, resolución y
 * **documento**; se distinguen por la unidad fiscalizable. Una misma resolución
 * alcanzando a dos unidades da un registro por unidad y un solo PDF. La versión
 * anterior del adapter trataba el documento repetido como drift y se detenía en
 * el registro 277 de 1.753.
 */
describe('documento compartido entre filas (fixture 08, página 28)', () => {
  const tabla = parseTabla(PAGINA28);

  it('dos filas distintas comparten el identificador del documento', () => {
    const conDocumento = tabla.filas.filter((f) => f.documento.estado === 'ok');
    const uuids = conDocumento.map(uuidDe);

    expect(conDocumento).toHaveLength(10);
    expect(new Set(uuids).size).toBe(9);
    expect(uuidDe(tabla.filas.find((f) => f.indice === 277))).toBe(
      uuidDe(tabla.filas.find((f) => f.indice === 278)),
    );
  });

  it('y sin embargo son registros distintos: cambia la unidad fiscalizable', () => {
    const a = tabla.filas.find((f) => f.indice === 277)?.campos;
    const b = tabla.filas.find((f) => f.indice === 278)?.campos;

    expect(a?.expediente).toBe(b?.expediente);
    expect(a?.resolucion).toBe(b?.resolucion);
    expect(a?.unidadFiscalizable).not.toBe(b?.unidadFiscalizable);
  });

  it('sus identidades no colisionan', () => {
    const identidad = (indice: number): string => {
      const fila = tabla.filas.find((f) => f.indice === indice);
      if (fila?.campos === undefined) throw new Error(`sin campos en ${indice}`);
      return identidadDe(fila.campos, uuidDe(fila));
    };

    expect(identidad(277)).not.toBe(identidad(278));
  });
});

describe('identidad del registro', () => {
  const campos = {
    expediente: '3739-2009-PRODUCE/DIGSECOVI-Dsvs',
    administrados: ['Tecnologías en Favor del Medio Ambiente S.A.C.'],
    unidadFiscalizable: 'Planta Harina Residual',
    sector: 'Pesquería',
    resolucion: 'Información confidencial',
  };

  it('es un hash del contenido, estable entre llamadas', () => {
    const id = identidadDe(campos, '153a6d2a-cbed-40ef-b8ef-cd2272b19867');
    expect(id).toMatch(/^[0-9a-f]{24}$/);
    expect(identidadDe(campos, '153a6d2a-cbed-40ef-b8ef-cd2272b19867')).toBe(id);
  });

  /**
   * El caso de la página 28: una misma resolución alcanza a dos unidades
   * fiscalizables, así que dos registros comparten documento. Si la identidad
   * fuera el uuid del PDF, uno de los dos se perdería.
   */
  it('dos filas con el mismo documento pero distinta unidad no colisionan', () => {
    const doc = '85116078-9d2d-4d81-b91b-ce17d234b555';
    expect(identidadDe({ ...campos, unidadFiscalizable: 'Chicrin N° 2' }, doc)).not.toBe(
      identidadDe({ ...campos, unidadFiscalizable: 'Chicrin N° 12' }, doc),
    );
  });

  /** Y no depende de tener documento: la regla es una sola para todas las filas. */
  it('funciona igual sin documento', () => {
    expect(identidadDe(campos, undefined)).toMatch(/^[0-9a-f]{24}$/);
    expect(identidadDe(campos, undefined)).not.toBe(identidadDe(campos, 'algun-uuid'));
  });

  /**
   * No se usa el `indice`, que es la opción obvia: es la posición dentro del
   * resultado y **se corre entera** en cuanto el organismo publica una
   * resolución nueva, así que la corrida siguiente duplicaría todo lo desplazado.
   */
  it('dos filas distintas sin documento no comparten identidad', () => {
    expect(identidadDe(campos, undefined)).not.toBe(
      identidadDe({ ...campos, expediente: 'otro' }, undefined),
    );
  });
});
