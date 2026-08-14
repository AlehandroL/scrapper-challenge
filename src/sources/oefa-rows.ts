/**
 * Lectura de la tabla del Registro de Infractores Ambientales de OEFA.
 *
 * Es la segunda pasada de parsing: `jsf/partial-response.ts` sacó el HTML de su
 * CDATA, y acá se lo convierte en registros. Todo lo específico del portal —los
 * ids de componente, el orden de las columnas, la forma del `onclick`— vive en
 * este archivo y no baja de acá. Es la mitad del criterio de §4 que
 * `tests/architecture.test.ts` verifica desde el otro lado.
 *
 * **Este módulo es total: nunca lanza.** Misma doctrina que
 * `jsf/partial-response.ts` y que `isEmptyTable()`: devuelve lo que pudo leer y
 * lo que no pudo lo deja explícito (`campos: undefined`, `documento` en estado
 * `sin-enlace` o `ilegible`, `total: undefined`). Quién decide que eso es un error es `oefa.ts`, que es el
 * único que sabe cuántas filas esperaba y en qué offset. Si acá se lanzara, un
 * test de búsqueda legítimamente vacía tendría que atrapar y descartar la
 * excepción — y la primera vez que alguien haga eso, la detección real de §6.4
 * se pierde.
 *
 * La consecuencia práctica es que **no hay un solo `?? ''` en el parseo de
 * celdas**. Con `noUncheckedIndexedAccess` es la salida que el compilador
 * empuja, y convierte un cambio en la estructura de la tabla en un registro con
 * campos vacíos: datos que pasan todas las validaciones y no significan nada.
 */

import { createHash } from 'node:crypto';

import * as cheerio from 'cheerio';
import { z } from 'zod';

import { parseJsfcljs } from '../jsf/commands.ts';
import { isEmptyTable, readPageSize, readRowCount, wrapRows } from '../jsf/datatable.ts';
import { RegistroBaseSchema, type RegistroBase } from './types.ts';

export const FUENTE = 'oefa';
export const URL_OEFA = 'https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml';

/**
 * Los ids con nombre explícito del portal. Son los únicos estables: `j_idt21`,
 * `j_idt41`, `j_idt63` y compañía los autogenera JSF según el orden de aparición
 * en el árbol de componentes, y agregar un componente más arriba los desplaza a
 * todos. Esos se descubren en cada corrida (`parseForm`, `parseJsfcljs`) en vez
 * de hardcodearse.
 */
export const ID_FORM = 'listarDetalleInfraccionRAAForm';
export const ID_TABLA = `${ID_FORM}:dt`;
export const ID_BOTON_BUSCAR = `${ID_FORM}:btnBuscar`;
export const ID_LISTA = `${ID_FORM}:pgLista`;
export const ID_CAMPO_EXPEDIENTE = `${ID_FORM}:txtNroexp`;

/**
 * Corroboración, no fuente de verdad: el parámetro se identifica por estructura
 * (ver `leerComando`). En el Poder Judicial la clave es `uuid` y no `param_uuid`,
 * y el mismo parser tiene que servir para los dos.
 */
export const PARAM_DOCUMENTO = 'param_uuid';

export const CABECERAS_ESPERADAS = [
  'Nro.',
  'Número de expediente',
  'Administrado',
  'Unidad fiscalizable',
  'Sector',
  'Nro. Resolución de Apelación',
  'Archivo',
] as const;

export const COLUMNAS_ESPERADAS = CABECERAS_ESPERADAS.length;

/** Índices de columna. Nombrarlos evita el `celdas[3]` sin contexto. */
const COL = { nro: 0, expediente: 1, administrado: 2, unidad: 3, sector: 4, resolucion: 5 } as const;

export interface CamposOefa {
  readonly expediente: string;
  /**
   * Multivalor: el `<td>` trae varios administrados separados por saltos de
   * línea —la primera fila del fixture tiene dos—. Colapsarlos a un string
   * produce un campo que ninguna búsqueda posterior va a matchear.
   */
  readonly administrados: readonly string[];
  readonly unidadFiscalizable: string;
  readonly sector: string;
  readonly resolucion: string;
  /**
   * OEFA **no publica fecha** en esta tabla; el único dato temporal es el año
   * embebido en el número de resolución (`264-2012-OEFA/TFA`). Se deriva acá y
   * se marca opcional en vez de inventar un campo `fecha` que no existe.
   */
  readonly anioResolucion?: number;
}

export interface RegistroOefa extends RegistroBase, CamposOefa {
  /**
   * El identificador del PDF. **Ni obligatorio ni único**, y el sitio lo
   * demostró dos veces en la misma corrida:
   *
   * - Página 4: dos resoluciones publicadas como «Información confidencial»,
   *   sin número y sin enlace. Registros legítimos, sin documento.
   * - Página 28: las filas 277 y 278 comparten expediente, administrado,
   *   resolución y documento, y se distinguen por la unidad fiscalizable. Una
   *   misma resolución alcanzando a dos unidades es un registro por unidad y un
   *   solo PDF.
   *
   * Por eso `id` se deriva del contenido y esto queda como un atributo más.
   */
  readonly documentoUuid?: string;
}

/**
 * §6.7. Estricto en lo que identifica al registro, permisivo en el contenido.
 *
 * La asimetría es deliberada: si `id` o `indice` vienen mal, el parser se rompió
 * y seguir escribiendo es peor que detenerse. Pero un `sector` vacío es
 * variación del origen, no un bug, y hacer que tumbe una corrida de 1.753
 * registros convierte la validación en algo que la gente desactiva. La calidad
 * del contenido se mide y se reporta (§6.3), no se usa para abortar.
 */
export const RegistroOefaSchema = RegistroBaseSchema.extend({
  fuente: z.literal(FUENTE),
  documentoUuid: z.string().min(1).optional(),
  expediente: z.string(),
  administrados: z.array(z.string().min(1)).readonly(),
  unidadFiscalizable: z.string(),
  sector: z.string(),
  resolucion: z.string(),
  anioResolucion: z.number().int().min(1900).max(2100).optional(),
});

/**
 * Qué se pudo leer del enlace de descarga de una fila.
 *
 * La distinción entre `sin-enlace` e `ilegible` no es cosmética y es la lección
 * de la primera corrida completa: **no tener documento es un dato del sitio; no
 * poder leer el enlace que sí está es un problema nuestro.** Colapsar los dos en
 * «esta fila no tiene identificador» obliga a elegir entre perder registros
 * legítimos y dejar de detectar que el `onclick` cambió de forma.
 */
export type DocumentoFila =
  | { readonly estado: 'ok'; readonly uuid: string; readonly comando: Readonly<Record<string, string>> }
  /** La celda no trae enlace: el sitio publica la resolución como confidencial. */
  | { readonly estado: 'sin-enlace' }
  /** Hay enlace pero sus parámetros no se dejan leer: eso sí es drift. */
  | { readonly estado: 'ilegible'; readonly onclick: string };

/** Lo que se puede leer de una fila **sin** saber en qué offset se la pidió. */
export interface FilaCruda {
  /** `data-ri`: el índice global que emite PrimeFaces. */
  readonly indice: number;
  /**
   * Primera columna, 1-based. `undefined` si no se pudo leer.
   *
   * Sirve como chequeo del **parser**, no del servidor: sale del mismo
   * `rowIndex` del modelo que el `data-ri`, así que si el servidor ignora el
   * offset los dos mienten juntos. Lo que detecta es que las celdas se corrieron.
   */
  readonly nro: number | undefined;
  readonly columnas: number;
  /** `undefined` si la fila no traía las 7 columnas: no se adivina. */
  readonly campos: CamposOefa | undefined;
  readonly documento: DocumentoFila;
}

export interface TablaParseada {
  readonly filas: readonly FilaCruda[];
  /** PrimeFaces marca así la tabla sin resultados. */
  readonly vacia: boolean;
  /** Solo en la respuesta de búsqueda: la de paginación no trae `<thead>`. */
  readonly cabeceras: readonly string[];
  /** `rowCount` del script del widget. Solo en la búsqueda. */
  readonly total: number | undefined;
  /** `rows` del mismo script. Solo en la búsqueda. */
  readonly pageSize: number | undefined;
  /** Texto del paginador, para cruzar contra `total` con otra fuente. */
  readonly paginadorTexto: string | undefined;
}

/**
 * Colapsa el espacio en blanco de una celda.
 *
 * En HTML el whitespace no es significativo y el markup del portal viene con
 * saltos e indentación adentro de los `<td>`. `\s` en JavaScript incluye
 * ` `, así que esto también normaliza los `&nbsp;`.
 */
const normalizar = (texto: string): string => texto.replace(/\s+/g, ' ').trim();

export function parseTabla(fragmento: string): TablaParseada {
  // El fragmento de la paginación es una tira de `<tr>` pelados: cargado tal
  // cual, el algoritmo de parsing de HTML los descarta en silencio y cheerio
  // devuelve 0 filas. Se envuelve solo si hace falta — envolver el de la
  // búsqueda, que ya trae `<table>`, funciona por el *foster parenting* de
  // parse5, pero depender de esa regla para leer bien es deuda de legibilidad.
  const html = /<t(?:able|body)\b/i.test(fragmento) ? fragmento : wrapRows(fragmento);
  const $ = cheerio.load(html);

  const cabeceras = $('thead th')
    .map((_, th) => normalizar($(th).text()))
    .get();

  const filas: FilaCruda[] = [];
  $('tr[data-ri]').each((_, tr) => {
    const fila = leerFila($(tr));
    if (fila !== undefined) filas.push(fila);
  });

  const paginadorTexto = $('.ui-paginator-current').first().text().trim();

  return {
    filas,
    vacia: isEmptyTable(fragmento),
    cabeceras,
    total: readRowCount(fragmento),
    pageSize: readPageSize(fragmento),
    paginadorTexto: paginadorTexto === '' ? undefined : paginadorTexto,
  };
}

/**
 * Se tipa con `ReturnType<cheerio.CheerioAPI>` —el mismo recurso que usa
 * `jsf/form.ts`— porque cheerio 1.x no reexporta el tipo de nodo de
 * `domhandler`. Trabajar con la selección (`.eq(i)`) en vez de con los nodos
 * crudos evita la dependencia de tipos y de paso deja el código sin un solo
 * indexado de array sobre el DOM.
 */
type Seleccion = ReturnType<cheerio.CheerioAPI>;

function leerFila($tr: Seleccion): FilaCruda | undefined {
  const indice = Number($tr.attr('data-ri'));
  if (!Number.isInteger(indice)) return undefined;

  const celdas = $tr.find('> td');

  return {
    indice,
    nro: leerNro(celdas.eq(COL.nro)),
    columnas: celdas.length,
    campos: celdas.length === COLUMNAS_ESPERADAS ? leerCampos(celdas) : undefined,
    documento: leerComando($tr),
  };
}

function leerNro(celda: Seleccion): number | undefined {
  if (celda.length === 0) return undefined;
  const valor = Number(normalizar(celda.text()));
  return Number.isInteger(valor) ? valor : undefined;
}

/**
 * Solo se llama con las 7 columnas presentes, que es lo que hace legítimo el
 * indexado directo: el caso de la tabla que cambió se resuelve **antes**,
 * devolviendo `campos: undefined`, y no acá rellenando con vacíos.
 */
function leerCampos(celdas: Seleccion): CamposOefa | undefined {
  const texto = (i: number): string | undefined => {
    const celda = celdas.eq(i);
    return celda.length === 0 ? undefined : celda.text();
  };

  const crudoAdministrado = texto(COL.administrado);
  const expediente = texto(COL.expediente);
  const unidad = texto(COL.unidad);
  const sector = texto(COL.sector);
  const resolucion = texto(COL.resolucion);
  if (
    crudoAdministrado === undefined ||
    expediente === undefined ||
    unidad === undefined ||
    sector === undefined ||
    resolucion === undefined
  ) {
    return undefined;
  }

  const normalizada = normalizar(resolucion);
  const anio = anioDeResolucion(normalizada);

  return {
    expediente: normalizar(expediente),
    // El split va **antes** de normalizar: `\s` incluye `\n`, así que colapsar
    // primero fusionaría los dos administrados en uno.
    administrados: crudoAdministrado
      .split('\n')
      .map(normalizar)
      .filter((v) => v !== ''),
    unidadFiscalizable: normalizar(unidad),
    sector: normalizar(sector),
    resolucion: normalizada,
    ...(anio === undefined ? {} : { anioResolucion: anio }),
  };
}

/**
 * El año de `264-2012-OEFA/TFA` o de `007-2016-OEFA/TFA-SEPIM`.
 *
 * Acotado a un rango plausible: sin eso, un correlativo de cuatro dígitos entre
 * guiones se convertiría en un año y el dato quedaría peor que ausente.
 */
export function anioDeResolucion(resolucion: string): number | undefined {
  for (const m of resolucion.matchAll(/-(\d{4})(?:-|$)/g)) {
    const anio = Number(m[1]);
    if (anio >= 1900 && anio <= 2100) return anio;
  }
  return undefined;
}

/**
 * Los pares del `onclick` de la fila, y cuál de ellos es el documento.
 *
 * **El identificador se deduce por estructura, no por su nombre.**
 * `mojarra.jsfcljs` recibe dos pares: el del componente pulsado, que JSF emite
 * con clave y valor idénticos, y el parámetro de negocio, que no. Buscar
 * `param_uuid` por su nombre ataría este parser a OEFA — en el Poder Judicial la
 * clave es `uuid`— y la regla estructural cubre los dos sin tocar nada.
 *
 * Se exige **exactamente un** candidato. Si el sitio agregara un tercer par,
 * quedarse con «el primero que aparezca» elegiría en silencio; devolver
 * `undefined` hace que `oefa.ts` lo reporte como drift.
 *
 * El scope `tr[data-ri]` no es decorativo: el fragmento de la búsqueda trae
 * **once** anchors con `mojarra.jsfcljs` y solo diez filas. El sobrante es
 * «Exportar a excel», que vive en el paginador.
 */
function leerComando($tr: Seleccion): DocumentoFila {
  const onclick = $tr.find('a[onclick]').first().attr('onclick');
  // Sin enlace no hay nada roto: la celda dice «Información confidencial» y el
  // registro simplemente no tiene documento.
  if (onclick === undefined) return { estado: 'sin-enlace' };

  const pares = parseJsfcljs(onclick);
  if (pares === undefined) return { estado: 'ilegible', onclick };

  const candidatos = Object.entries(pares).filter(([clave, valor]) => clave !== valor);
  const elegido = candidatos.length === 1 ? candidatos[0] : undefined;
  if (elegido === undefined) return { estado: 'ilegible', onclick };

  return { estado: 'ok', uuid: elegido[1], comando: pares };
}

/**
 * «Página 1 de 176 (1753 registros)» → sus tres números.
 *
 * Vive acá y no en `jsf/datatable.ts` porque el template lo configura la
 * aplicación (`currentPageTemplate` en el script del widget), no PrimeFaces: el
 * próximo portal puede rotularlo en otro idioma o no rotularlo.
 *
 * Su valor es ser una **segunda fuente** del total, independiente del `rowCount`
 * del script. Que dos caminos distintos coincidan es lo que convierte el total
 * en un dato verificado en vez de en uno leído.
 */
export function parsePaginador(texto: string): { pagina: number; paginas: number; total: number } | undefined {
  const m = texto.match(/(\d+)\s+de\s+([\d.,]+)\s*\(\s*([\d.,]+)\s+registros?\s*\)/i);
  if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined) return undefined;

  const numero = (s: string): number => Number(s.replace(/[.,]/g, ''));
  return { pagina: Number(m[1]), paginas: numero(m[2]), total: numero(m[3]) };
}

/**
 * La identidad del registro: un hash de su contenido.
 *
 * La opción obvia —el uuid del documento— no sirve, y no por un caso teórico: en
 * el mismo dataset hay filas sin documento y hay dos filas que comparten uno. Un
 * identificador que a veces falta y a veces se repite no es una clave.
 *
 * La otra opción obvia, el `indice`, tampoco: es la posición dentro del
 * resultado de la búsqueda y **se corre entera** en cuanto el organismo publica
 * una resolución nueva, así que la corrida siguiente reescribiría todo lo que
 * quedó desplazado.
 *
 * Queda el contenido, que es lo que efectivamente identifica al registro. El
 * `documentoUuid` entra al hash cuando existe: distingue de forma legítima,
 * aunque no alcance por sí solo.
 *
 * La contrapartida, escrita para que nadie la descubra por su cuenta: si el
 * sitio corrige una tilde en el nombre de un administrado, el hash cambia y una
 * reanudación agrega ese registro de nuevo. Aparece como un registro de más —no
 * como uno perdido— y el sanity check del bloque 6 lo ve.
 */
export function identidadDe(campos: CamposOefa, documentoUuid: string | undefined): string {
  const contenido = [
    campos.expediente,
    campos.administrados.join('|'),
    campos.unidadFiscalizable,
    campos.sector,
    campos.resolucion,
    documentoUuid ?? '',
  ].join('\u0000');

  return createHash('sha1').update(contenido, 'utf8').digest('hex').slice(0, 24);
}
