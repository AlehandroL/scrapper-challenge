/**
 * Emisión de eventos: los cuerpos POST que JSF/Mojarra entiende.
 *
 * Dos formas, y confundirlas es el error más caro de esta capa:
 *
 * - **AJAX** — lleva los `javax.faces.partial.*` y el header `Faces-Request`.
 *   El servidor responde el diff XML.
 * - **No-ajax** (`mojarra.jsfcljs`) — no lleva ninguno de los dos. El servidor
 *   responde el recurso, o la página entera si algo no cuadra.
 *
 * Este módulo es de **JSF**, no de PrimeFaces: nada acá sabe qué es un
 * `dataTable`. Esa frontera es un archivo y no un párrafo justamente porque el
 * próximo portal legacy puede correr Mojarra con otra librería de componentes,
 * y entonces esto se reusa entero.
 */

import { toSearchParams, type JsfForm } from './form.ts';
import { CAMPO_VIEW_STATE } from './view-state.ts';

/**
 * Los dos headers fijos del POST ajax; el `Referer` se agrega por request.
 *
 * `Faces-Request: partial/ajax` es el que más se omite. Sin él el servidor
 * devuelve la página completa en vez del diff XML, el parser no encuentra
 * `<partial-response>` y el síntoma se confunde con un bloqueo del sitio.
 */
export const CABECERAS_AJAX: Readonly<Record<string, string>> = {
  'Faces-Request': 'partial/ajax',
  'X-Requested-With': 'XMLHttpRequest',
};

export interface AjaxCommand {
  /** `javax.faces.source` — el id del componente que dispara. */
  readonly source: string;
  /** `javax.faces.partial.execute`. Por defecto, `source`. */
  readonly execute?: string;
  /** `javax.faces.partial.render`. Por defecto, `source`. */
  readonly render?: string;
  /** `javax.faces.behavior.event` — `page`, `rowSelect`… Los command button no lo llevan. */
  readonly event?: string;
  /** Pares propios del componente, p.ej. `form:dt_first=10`. */
  readonly params?: Readonly<Record<string, string>>;
}

/** Un POST armado y todavía no emitido: la costura que el bloque 5 necesita para streamear. */
export interface JsfRequest {
  readonly url: string;
  readonly body: URLSearchParams;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * El `viewState` es un parámetro explícito y **no** se lee de `form.viewState`.
 *
 * Es deliberado, y es la lección más cara de §2.5: la descarga exige un token
 * alineado con la página donde vive la fila. Que sea un argumento obliga a cada
 * llamador a escribir de dónde lo sacó, y vuelve visible en el código una
 * desalineación que si no es emergente y silenciosa.
 */
export function buildAjaxBody(form: JsfForm, viewState: string, cmd: AjaxCommand): URLSearchParams {
  const extra: Record<string, string> = {
    'javax.faces.partial.ajax': 'true',
    'javax.faces.source': cmd.source,
    'javax.faces.partial.execute': cmd.execute ?? cmd.source,
    'javax.faces.partial.render': cmd.render ?? cmd.source,
  };
  if (cmd.event !== undefined) extra['javax.faces.behavior.event'] = cmd.event;
  Object.assign(extra, cmd.params ?? {});
  extra[CAMPO_VIEW_STATE] = viewState;

  return toSearchParams(form.campos, extra);
}

/**
 * Replica `mojarra.jsfcljs(form, params, target)`, que hace tres cosas: inyecta
 * inputs hidden en el form con los pares recibidos, ejecuta `form.submit()`
 * —POST **no-ajax**— y después los remueve.
 *
 * Sin `Faces-Request` y sin ningún `javax.faces.partial.*`: mandarlos convierte
 * la descarga en una página re-renderizada.
 */
export function buildCommandBody(
  form: JsfForm,
  viewState: string,
  params: Readonly<Record<string, string>>,
): URLSearchParams {
  return toSearchParams(form.campos, { ...params, [CAMPO_VIEW_STATE]: viewState });
}

/** Lo que un `onclick` con `mojarra.jsfcljs` declara: contra qué form, con qué pares. */
export interface ComandoJsfcljs {
  /**
   * El id del form del primer argumento (`document.getElementById('…')`).
   *
   * Se devuelve en vez de descartarse porque **no siempre es el form de la
   * vista**. En OEFA hay uno solo y da igual; la página de resultados del Poder
   * Judicial tiene tres con el mismo token —`formBusqueda`, `frmDetalle` y
   * `frmDetalle2` con `target="_blank"`— y el POST del documento va al que el
   * `onclick` nombre, no al que la vista eligió en el bootstrap.
   *
   * `undefined` si el patrón trae otra cosa en esa posición: es un dato, no un
   * error, y quien llama decide si le sirve el form vigente.
   */
  readonly formId: string | undefined;
  readonly params: Record<string, string>;
}

/**
 * Deshace **un** nivel de escape de un fragmento de JS incrustado en otro.
 *
 * Un nivel, no todos, y la distinción es el corazón de este parser: `\'` significa
 * dos cosas distintas según dónde aparezca. Dentro de un valor es un apóstrofo
 * literal —`'O\'Higgins S.A.'`, y en un corpus de razones sociales aparecen—;
 * dentro de una llamada que viaja como string adentro de otra, es el delimitador
 * de la llamada interna. Desescapar de entrada convierte el primero en un
 * terminador y parte el valor al medio.
 */
const desescapar = (js: string): string => js.replace(/\\(['"\\])/g, '$1');

/**
 * Un valor entre comillas simples que admite comillas escapadas adentro.
 *
 * `(?:[^'\\]|\\.)*` es la forma canónica: cualquier carácter que no sea comilla
 * ni barra, **o** una barra con lo que venga detrás. Un `[^']*` pelado corta el
 * valor en el primer `\'` y devuelve media razón social.
 */
const PAR = /'((?:[^'\\]|\\.)*)'\s*:\s*'((?:[^'\\]|\\.)*)'/g;

function leerLlamada(js: string): ComandoJsfcljs | undefined {
  const objeto = js.match(/mojarra\.jsfcljs\(([^{]*)\{([^}]*)\}/);
  if (objeto === null || objeto[1] === undefined || objeto[2] === undefined) return undefined;

  const pares: Record<string, string> = {};
  for (const par of objeto[2].matchAll(PAR)) {
    if (par[1] !== undefined && par[2] !== undefined) pares[desescapar(par[1])] = desescapar(par[2]);
  }
  if (Object.keys(pares).length === 0) return undefined;

  // El primer argumento suele ser `document.getElementById('x')`, pero también
  // puede ser `this.form` o una variable: en esos casos no hay id que leer y se
  // devuelve `undefined` en vez de inventar uno.
  const form = objeto[1].match(/getElementById\(\s*'([^']+)'/);

  return { formId: form?.[1], params: pares };
}

/**
 * Extrae el form y los pares del `onclick`:
 *
 *     mojarra.jsfcljs(document.getElementById('form'),{'form:dt:0:j_idt63':'…','param_uuid':'153a…'},'')
 *
 * **Sin `JSON.parse`.** La vía obvia —cambiar comillas simples por dobles y
 * parsear— revienta con cualquier apóstrofo dentro de un valor. Los regex hacen
 * lo mismo sin ese riesgo.
 *
 * **Se intenta dos veces, y no es cautela: es que el patrón viene envuelto la
 * mitad de las veces.** En OEFA el `onclick` es la llamada pelada. En el portal
 * objetivo viaja como argumento de un `jsf.util.chain`, o sea **como string
 * adentro de otro string**, con todas sus comillas escapadas:
 *
 *     onclick="jsf.util.chain(this,event,'…',
 *       'mojarra.jsfcljs(document.getElementById(\'formBusqueda\'),
 *          {\'formBusqueda:j_idt65\':\'formBusqueda:j_idt65\'},\'\')');return false"
 *
 * Contra esa cadena la primera pasada no encuentra ningún par —todas las
 * comillas están escapadas— y la segunda, sobre el texto con un nivel de escape
 * menos, la lee entera. El orden importa: desescapar **antes** de intentar
 * partiría en dos cualquier valor con un apóstrofo legítimo, que es lo que la
 * primera pasada preserva. El fixture está en
 * `fixtures/pj/02-busqueda-resultado.html`.
 *
 * Total: devuelve `undefined` si el patrón no está o no trae ningún par, en vez
 * de un objeto vacío que el llamador confundiría con «un comando sin parámetros».
 */
export function parseJsfcljs(onclick: string): ComandoJsfcljs | undefined {
  return leerLlamada(onclick) ?? leerLlamada(desescapar(onclick));
}
