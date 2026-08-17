/**
 * Lectura del portal de Jurisprudencia Nacional Sistematizada del Poder Judicial.
 *
 * Es el gemelo de `oefa-rows.ts` y se parece poco, porque los portales se
 * parecen poco. Comparten el núcleo —Mojarra, `ViewState`, `mojarra.jsfcljs`— y
 * divergen en todo lo demás: acá corre **RichFaces 4.2.2**, el state saving es
 * **server-side**, la vista tiene **tres forms** y la búsqueda es un POST
 * no-ajax. Nada de `p:dataTable`, así que `jsf/datatable.ts` casi no se usa.
 *
 * ## Qué está verificado y qué no
 *
 * El sitio responde `403` desde Chile (§2.2) y no se contrató proxy (§3.3), así
 * que **nada de este archivo se ejercitó contra el portal vivo**. Lo que sí hay
 * es markup real, capturado del archivo web y versionado en `fixtures/pj/`:
 *
 * | Cosa | Estado |
 * |---|---|
 * | Ids del form y de los filtros | verificado — fixtures `01` y `02` |
 * | State saving server-side | verificado — tres muestras, 2016 y 2025 |
 * | Forma del `onclick` (`jsf.util.chain`) | verificado — fixture `02` |
 * | Los tres forms de la vista | verificado — fixture `02` |
 * | **Forma de las filas de resultado** | pendiente — ningún snapshot las trae |
 * | **Comando de paginación** | pendiente — ningún snapshot lo trae |
 *
 * Las dos últimas son la superficie no verificada, y la razón es estructural: el
 * archivo web captura GETs, y en este portal los resultados nacen de un POST.
 *
 * ## Cómo se compensa
 *
 * No hardcodeando lo que no se sabe. El parser de filas **no busca clases CSS ni
 * un orden de columnas**: se apoya en lo único que sí es un hecho del framework
 * —la convención de nombres de los naming containers de JSF—, que §2.1 documenta
 * para este portal a partir de un scraper público:
 *
 *     formBusqueda : repeat : 0 : j_idt158
 *        form        iterador  |    componente
 *                              indice de la fila
 *
 * El segmento numérico es el análogo del `data-ri` de PrimeFaces: la posición de
 * la fila dentro de la iteración. Eso alcanza para encontrar las filas,
 * numerarlas y aseverar su alineación sin saber qué columnas tienen.
 *
 * Y no inventando un esquema. `RegistroPj` no declara `expediente`, `sumilla` ni
 * `materia`: guarda las celdas tal como vengan, rotuladas con los encabezados si
 * los hay. Un esquema con campos que nadie vio es la clase de deuda que después
 * se descubre con el archivo lleno.
 */

import { createHash } from 'node:crypto';

import * as cheerio from 'cheerio';
import { z } from 'zod';

import { parseJsfcljs } from '../jsf/commands.ts';
import { wrapRows } from '../jsf/datatable.ts';
import { RegistroBaseSchema, type RegistroBase } from './types.ts';

export const FUENTE = 'pj';
export const URL_PJ = 'https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml';

/**
 * Los dos nombres de form observados, con nueve años de distancia.
 *
 * No se usan para elegir: la vista toma el primer form con token, que en los
 * tres fixtures es el correcto. Se usan para **avisar** si el form encontrado no
 * es ninguno de los dos, que es la señal barata de que el portal se rediseñó.
 */
export const FORMS_CONOCIDOS = ['formBuscador', 'formBusqueda'] as const;

/**
 * Campos de búsqueda con nombre estable, del fixture `02`.
 *
 * Al revés que OEFA —donde tres de los cuatro filtros son `j_idt21`, `j_idt25`,
 * `j_idt34`—, acá el portal los nombra. Se listan **sin prefijo de form** porque
 * ese prefijo cambió entre 2016 y 2025 (`formBusqueda:` / `formBuscador:`).
 *
 * Sirven hoy para una sola cosa: reconocer que el form que trajo el bootstrap es
 * efectivamente el de búsqueda y no otro de la página. **El adapter no expone
 * filtros**, por la misma razón que en OEFA (§2.5): el request con valores no
 * está reversado, y una firma que promete lo que no hace es peor que una que no
 * lo ofrece. La diferencia es que acá el siguiente paso está a la vista — los
 * nombres se conocen, falta emitir el POST y comparar.
 */
export const CAMPOS_BUSQUEDA = [
  'txtBusqueda',
  'buCorte',
  'buEspecialidad',
  'buSala',
  'buTipoRecurso',
  'buTipoResolucion',
  'buAnio',
  'buPalabraClaveValue',
  'buPretensionValue',
] as const;

/** Lo que un control tiene que decir para que lo tomemos por el botón de búsqueda. */
const ETIQUETA_BUSCAR = /^\s*buscar\s*$/i;

/**
 * Lo que un control tiene que decir para que lo tomemos por «página siguiente».
 *
 * Es lo que menos evidencia tiene de todo el adapter: ningún snapshot del
 * archivo trae paginación. Se listan las formas habituales de rotularla en un
 * portal en español; que ninguna matchee es un desenlace previsto y `pj.ts` lo
 * reporta con nombre propio.
 */
const ETIQUETA_SIGUIENTE = /^\s*(?:siguiente|next|ir a la p[áa]gina siguiente)\s*$/i;

/**
 * El identificador del documento en el `onclick` de una fila.
 *
 * En OEFA la clave es `param_uuid`; acá, según §2.1, es `uuid`. Ninguno de los
 * dos se busca por su nombre: el par de negocio se distingue del par del
 * componente porque JSF emite este último con clave y valor idénticos. La
 * constante queda como corroboración, no como fuente de verdad.
 */
export const PARAM_DOCUMENTO = 'uuid';

export interface RegistroPj extends RegistroBase {
  /**
   * El identificador del documento, cuando la fila trae enlace.
   *
   * Opcional por la misma lección de §5.8: en OEFA hay filas sin documento y
   * pares de filas que lo comparten. No hay razón para suponer que este portal
   * se porte mejor, y suponerlo cuesta un rediseño a mitad de corrida.
   */
  readonly documentoUuid?: string;
  /**
   * Las celdas de la fila, rotuladas con los encabezados de la tabla cuando los
   * hay y con `columna1`, `columna2` cuando no.
   *
   * **No es un esquema provisorio: es el esquema que la evidencia permite.**
   * Nombrar campos que nadie vio produce un archivo lleno de nulos con nombres
   * convincentes. Cuando haya un POST de búsqueda capturado, mapear esto a
   * campos con nombre es media hora de trabajo.
   */
  readonly campos: Readonly<Record<string, string>>;
  /**
   * El texto completo de la fila, normalizado.
   *
   * Es lo que sobrevive a cualquier cambio de columnas, y por eso es la base de
   * la identidad: un registro sigue siendo el mismo aunque el portal agregue una
   * columna en el medio.
   */
  readonly texto: string;
}

export const RegistroPjSchema = RegistroBaseSchema.extend({
  fuente: z.literal(FUENTE),
  documentoUuid: z.string().min(1).optional(),
  campos: z.record(z.string(), z.string()).readonly(),
  // Estricto acá y permisivo en `campos`, misma asimetría que en OEFA: si el
  // texto viene vacío, lo que se rompió es el parser y seguir escribiendo es
  // peor que detenerse.
  texto: z.string().min(1),
});

/** Qué se pudo leer del enlace de descarga. Misma tricotomía que en OEFA. */
export type DocumentoFilaPj =
  | {
      readonly estado: 'ok';
      readonly uuid: string;
      readonly comando: Readonly<Record<string, string>>;
      /** El form que el `onclick` nombra; `undefined` = el de la vista. */
      readonly formulario: string | undefined;
    }
  | { readonly estado: 'sin-enlace' }
  | { readonly estado: 'ilegible'; readonly onclick: string };

export interface FilaCrudaPj {
  /** Posición dentro de la iteración: el análogo del `data-ri` de PrimeFaces. */
  readonly indice: number;
  readonly celdas: readonly string[];
  readonly texto: string;
  readonly documento: DocumentoFilaPj;
}

export interface TablaPjParseada {
  readonly filas: readonly FilaCrudaPj[];
  readonly cabeceras: readonly string[];
  /** El iterador que se encontró (`repeat`, en el ejemplo de §2.1). */
  readonly iterador: string | undefined;
  /** Total declarado por el sitio, si lo dice en alguna parte reconocible. */
  readonly total: number | undefined;
}

const normalizar = (texto: string): string => texto.replace(/\s+/g, ' ').trim();

/**
 * El id de un componente dentro de una fila iterada, p.ej.
 * `formBusqueda:repeat:0:j_idt158`. Se capturan el nombre del iterador y el
 * índice.
 *
 * El primer segmento no se ancla al nombre del form justamente porque ese nombre
 * cambió entre 2016 y 2025.
 */
const ID_FILA = /^([^:]+):([^:]+):(\d+):/;

type Seleccion = ReturnType<cheerio.CheerioAPI>;

/**
 * Lee la tabla de resultados de una página completa del portal.
 *
 * **Total: nunca lanza.** Misma doctrina que `oefa-rows.ts`: devuelve lo que
 * pudo leer y deja explícito lo que no. Quién decide que eso es un error es
 * `pj.ts`, que es el único que sabe cuántas filas esperaba y en qué offset.
 */
export function parseTablaPj(html: string): TablaPjParseada {
  const $ = cheerio.load(/<t(?:able|body)\b/i.test(html) ? html : wrapRows(html));

  // Las filas se encuentran por la convención de nombres de JSF, no por una
  // clase CSS: es lo único que este portal garantiza sin haberlo visto.
  const porIndice = new Map<number, { iterador: string; nodos: Seleccion[] }>();
  $('[id],[name]').each((_, el) => {
    const $el = $(el);
    const m = ID_FILA.exec($el.attr('id') ?? $el.attr('name') ?? '');
    if (m?.[2] === undefined || m[3] === undefined) return;

    const indice = Number(m[3]);
    if (!Number.isInteger(indice)) return;

    const entrada = porIndice.get(indice);
    if (entrada === undefined) porIndice.set(indice, { iterador: m[2], nodos: [$el] });
    else entrada.nodos.push($el);
  });

  const cabeceras = $('thead th')
    .map((_, th) => normalizar($(th).text()))
    .get();

  const indices = [...porIndice.keys()].sort((a, b) => a - b);
  const filas: FilaCrudaPj[] = [];
  for (const indice of indices) {
    const entrada = porIndice.get(indice);
    if (entrada === undefined) continue;
    const fila = leerFila($, entrada.nodos, indice);
    if (fila !== undefined) filas.push(fila);
  }

  const primero = indices[0];

  return {
    filas,
    cabeceras,
    iterador: primero === undefined ? undefined : porIndice.get(primero)?.iterador,
    total: leerTotal($.root().text()),
  };
}

/**
 * Sube desde un componente de la fila hasta el contenedor que la representa.
 *
 * Un `ui:repeat` no envuelve nada por su cuenta —a diferencia de un `dataTable`—,
 * así que el contenedor puede ser un `<tr>` o un `<div>` según cómo esté escrita
 * la plantilla. Se prueban los dos, en ese orden, y se cae al padre inmediato si
 * no hay ninguno. Es una heurística, y vive en una función propia para que se la
 * pueda corregir en un solo lugar cuando haya markup real.
 */
function contenedorDe(nodo: Seleccion): Seleccion {
  const tr = nodo.closest('tr');
  if (tr.length > 0) return tr;
  const div = nodo.closest('div');
  if (div.length > 0) return div;
  return nodo.parent();
}

function leerFila($: cheerio.CheerioAPI, nodos: readonly Seleccion[], indice: number): FilaCrudaPj | undefined {
  const primero = nodos[0];
  if (primero === undefined) return undefined;

  const contenedor = contenedorDe(primero);
  const texto = normalizar(contenedor.text());
  if (texto === '') return undefined;

  const celdas = contenedor
    .find('> td')
    .map((_, td) => normalizar($(td).text()))
    .get();

  return { indice, celdas, texto, documento: leerComandoPj($, contenedor) };
}

/**
 * El comando de descarga de una fila.
 *
 * Igual que en OEFA, el par de negocio se identifica **por estructura**: JSF
 * emite el par del componente pulsado con clave y valor idénticos, y el otro no.
 * Buscar `uuid` por su nombre ataría este parser a un portal; la regla cubre los
 * dos sin tocar nada.
 *
 * La diferencia con OEFA es el `formulario`: acá se conserva, porque la vista
 * tiene tres forms y el POST del documento no va necesariamente al de búsqueda.
 */
export function leerComandoPj($: cheerio.CheerioAPI, contenedor: Seleccion): DocumentoFilaPj {
  const conComando = contenedor
    .find('[onclick]')
    .filter((_, el) => ($(el).attr('onclick') ?? '').includes('jsfcljs'));

  const onclick = conComando.first().attr('onclick');
  if (onclick === undefined) return { estado: 'sin-enlace' };

  const comando = parseJsfcljs(onclick);
  if (comando === undefined) return { estado: 'ilegible', onclick };

  const candidatos = Object.entries(comando.params).filter(([clave, valor]) => clave !== valor);
  const elegido = candidatos.length === 1 ? candidatos[0] : undefined;
  if (elegido === undefined) return { estado: 'ilegible', onclick };

  return { estado: 'ok', uuid: elegido[1], comando: comando.params, formulario: comando.formId };
}

/** Un comando descubierto en la página: contra qué form y con qué pares. */
export interface ComandoDescubierto {
  readonly formulario: string | undefined;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * El control que dispara la búsqueda, descubierto en la página.
 *
 * Se descubre y no se hardcodea porque su id es autogenerado
 * —`formBusqueda:j_idt65` en el fixture de 2016— y un componente agregado más
 * arriba lo desplaza entero. Lo que sí es estable es la etiqueta: el botón dice
 * «Buscar».
 *
 * Devuelve `undefined` si no lo encuentra, y eso **no** es un fallo del parser:
 * el snapshot de 2025 (`01`) no trae el botón porque el portal lo renderiza
 * condicionalmente, y ese es un desenlace legítimo. Quién decide qué hacer con
 * él es `pj.ts`.
 */
export function descubrirBusqueda(html: string): ComandoDescubierto | undefined {
  return descubrirComando(html, ETIQUETA_BUSCAR);
}

/**
 * El control que avanza de página, descubierto en la página de resultados.
 *
 * **Ningún snapshot del archivo trae paginación**, así que esto es lo que menos
 * evidencia tiene de todo el adapter y conviene decirlo acá y no solo en el
 * README. Se busca por etiqueta y se exige que el control lleve un
 * `mojarra.jsfcljs`, que es la única forma de comando que este portal usa en los
 * tres fixtures.
 *
 * `undefined` es un desenlace esperado y `pj.ts` lo convierte en un drift con
 * nombre propio, en vez de recorrer una sola página y dar la corrida por
 * completa: un dataset truncado que se ve entero es exactamente el modo de falla
 * que §6.4 existe para evitar.
 */
export function descubrirPaginacion(html: string): ComandoDescubierto | undefined {
  return descubrirComando(html, ETIQUETA_SIGUIENTE);
}

function descubrirComando(html: string, etiqueta: RegExp): ComandoDescubierto | undefined {
  const $ = cheerio.load(html);

  let encontrado: ComandoDescubierto | undefined;
  $('input[onclick], button[onclick], a[onclick]').each((_, el) => {
    if (encontrado !== undefined) return;

    const $el = $(el);
    const rotulo = $el.attr('value') ?? $el.attr('title') ?? $el.text();
    if (!etiqueta.test(rotulo)) return;

    const comando = parseJsfcljs($el.attr('onclick') ?? '');
    if (comando !== undefined) encontrado = { formulario: comando.formId, params: comando.params };
  });

  return encontrado;
}

/**
 * El total de resultados, leído del texto de la página.
 *
 * Tres formas del mismo tipo de frase, y **ninguna verificada contra este
 * portal**: es una heurística declarada como tal. Que devuelva `undefined` es un
 * desenlace de primera clase y `pj.ts` lo trata como drift explícito — sin total
 * no hay última página, y adivinarla produce un archivo con huecos que parece
 * completo.
 */
export function leerTotal(texto: string): number | undefined {
  const patrones = [
    /(?:se\s+)?encontraron\s+([\d.,]+)/i,
    /([\d.,]+)\s+resultados?\b/i,
    /\(\s*([\d.,]+)\s+registros?\s*\)/i,
  ];

  for (const patron of patrones) {
    const m = patron.exec(texto);
    if (m?.[1] === undefined) continue;
    const n = Number(m[1].replace(/[.,]/g, ''));
    if (Number.isInteger(n)) return n;
  }
  return undefined;
}

/**
 * La identidad del registro: un hash de su contenido.
 *
 * Mismo criterio y mismas razones que en OEFA (§5.8). Acá el argumento es aún
 * más fuerte, porque del identificador de documento de este portal no sabemos
 * nada: ni que esté siempre, ni que sea único. Derivarla del texto de la fila no
 * apuesta a ninguna de las dos cosas.
 */
export function identidadPjDe(texto: string, documentoUuid: string | undefined): string {
  return createHash('sha1')
    .update([texto, documentoUuid ?? ''].join(' '), 'utf8')
    .digest('hex')
    .slice(0, 24);
}

/** Rótulo de cada celda: el encabezado si lo hay, `columnaN` si no. */
export function rotular(celdas: readonly string[], cabeceras: readonly string[]): Record<string, string> {
  const campos: Record<string, string> = {};
  celdas.forEach((valor, i) => {
    const rotulo = cabeceras[i];
    campos[rotulo === undefined || rotulo === '' ? `columna${i + 1}` : rotulo] = valor;
  });
  return campos;
}
