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

/**
 * Extrae los pares del `onclick`:
 *
 *     mojarra.jsfcljs(document.getElementById('form'),{'form:dt:0:j_idt63':'…','param_uuid':'153a…'},'')
 *
 * **Sin `JSON.parse`.** La vía obvia —cambiar comillas simples por dobles y
 * parsear— revienta con cualquier apóstrofo dentro de un valor, y en un corpus
 * de razones sociales aparecen. Dos regex hacen lo mismo sin ese riesgo.
 *
 * Total: devuelve `undefined` si el patrón no está, en vez de un `{}` que el
 * llamador confundiría con «un comando sin parámetros».
 */
export function parseJsfcljs(onclick: string): Record<string, string> | undefined {
  const objeto = onclick.match(/mojarra\.jsfcljs\([^{]*\{([^}]*)\}/);
  if (objeto === null || objeto[1] === undefined) return undefined;

  const pares: Record<string, string> = {};
  for (const par of objeto[1].matchAll(/'([^']*)'\s*:\s*'([^']*)'/g)) {
    if (par[1] !== undefined && par[2] !== undefined) pares[par[1]] = par[2];
  }
  return Object.keys(pares).length === 0 ? undefined : pares;
}
