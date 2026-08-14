/**
 * El `p:dataTable` de PrimeFaces: emisión del evento de página y lectura de lo
 * que vuelve.
 *
 * Separado de `commands.ts` porque JSF **no es** PrimeFaces. El próximo portal
 * legacy puede correr Mojarra con RichFaces o con componentes propios: ahí
 * `commands.ts` se reusa entero y este archivo se tira.
 *
 * Lo que hay acá es protocolo, no dominio: `rowCount` y `data-ri` son de la
 * librería de componentes. Si vivieran en `sources/oefa.ts` serían exactamente
 * la filtración que la arquitectura promete evitar.
 */

import type { AjaxCommand } from './commands.ts';

export interface PageEvent {
  /** Id completo del componente tabla, p.ej. `listarDetalleInfraccionRAAForm:dt`. */
  readonly tableId: string;
  /** Offset 0-based de la primera fila. */
  readonly first: number;
  readonly rows: number;
}

/** Los pares verificados de §5.3, listos para `buildAjaxBody`. */
export function pageCommand(e: PageEvent): AjaxCommand {
  return {
    source: e.tableId,
    execute: e.tableId,
    render: e.tableId,
    event: 'page',
    params: {
      [`${e.tableId}_pagination`]: 'true',
      [`${e.tableId}_first`]: String(e.first),
      [`${e.tableId}_rows`]: String(e.rows),
      [`${e.tableId}_skipChildren`]: 'true',
      [`${e.tableId}_encodeFeature`]: 'true',
    },
  };
}

/**
 * `rowCount` del script de init del widget:
 *
 *     PrimeFaces.cw("DataTable",…,{…paginator:{…rows:10,rowCount:1753,page:0…}…})
 *
 * Tricotomía deliberada, verificada sobre los tres fixtures: bootstrap → `0`
 * (el sitio lo reporta así, sin búsqueda hecha), búsqueda → `1753`, paginación
 * → `undefined` porque esa respuesta solo actualiza el componente `dt` y no
 * trae el script del widget.
 *
 * Distinguir «reportó cero» de «no lo reportó» es lo que impide que el sanity
 * check de §6.3 compare el total contra un cero inventado.
 */
export function readRowCount(html: string): number | undefined {
  const m = html.match(/rowCount:\s*(\d+)/);
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

/**
 * Los `data-ri` en orden de aparición.
 *
 * Regex y no cheerio, por la misma razón que existe `wrapRows`: la respuesta de
 * paginación es una tira de `<tr>` pelados y un parser de HTML los descarta.
 */
export function readRowIndices(html: string): number[] {
  return [...html.matchAll(/data-ri="(\d+)"/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));
}

/**
 * PrimeFaces marca así la tabla vacía.
 *
 * Se devuelve un booleano y **no** se lanza, aunque sea el modo de falla más
 * caro del proyecto (§2.5). Esta capa no puede distinguir «se perdió la sesión»
 * de «la búsqueda no tuvo resultados»: para eso hay que saber que la búsqueda
 * anterior reportó 1.753 registros y que estamos pidiendo la página 2. Ese
 * contexto vive en `sources/`, y ahí van las aserciones duras de §6.4.
 *
 * Si esta capa lanzara, un adapter con una búsqueda legítimamente vacía tendría
 * que atrapar la excepción y descartarla — y la primera vez que alguien haga
 * eso, la detección real se pierde.
 */
export function isEmptyTable(html: string): boolean {
  return html.includes('ui-datatable-empty-message');
}

/**
 * Envuelve un fragmento de filas para que un parser de HTML no lo descarte.
 *
 * **Verificado, no supuesto:** el CDATA de `fixtures/oefa/03-page2-partial.xml`
 * empieza literalmente en `<tr data-ri="10"`, sin `<table>` que lo contenga.
 * Cargado tal cual, cheerio devuelve **0 filas**; envuelto, devuelve las 10. El
 * algoritmo de parsing de HTML descarta un `<tr>` fuera de contexto de tabla, y
 * lo hace en silencio.
 *
 * Es el mismo síntoma que la sesión perdida —cero filas, ninguna excepción—
 * pero causado por nosotros. El bloque 4 parsea estas filas con cheerio: sin
 * esto, le devuelven vacío.
 */
export function wrapRows(fragment: string): string {
  return `<table><tbody>${fragment}</tbody></table>`;
}

/**
 * `rows` del mismo script de init que reporta `rowCount`.
 *
 * Se lee en vez de hardcodearse porque el tamaño de página es lo que traduce un
 * número de página a un offset: con un `10` supuesto contra un servidor que
 * pasó a `20`, el evento pide `_first=1730` y el servidor contesta filas
 * perfectamente válidas de otro lugar del dataset. No hay excepción, no hay
 * filas faltantes, y el resultado es un archivo con huecos que parece completo.
 *
 * Anclado dentro del objeto `paginator:{…}` y no a un `rows:` suelto: la
 * configuración del widget crece entre versiones y matchear la primera
 * coincidencia sería apostar a que ninguna clave nueva empiece igual.
 */
export function readPageSize(html: string): number | undefined {
  const m = html.match(/paginator:\s*\{[^}]*\brows:\s*(\d+)/);
  return m?.[1] === undefined ? undefined : Number(m[1]);
}
