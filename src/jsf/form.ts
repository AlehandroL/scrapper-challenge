/**
 * Descubrimiento y serialización del form.
 *
 * JSF procesa el submit **completo** del form, no un fragmento: hay que
 * reenviar todos los campos —inputs de búsqueda, filtros, hidden— y no solo los
 * parámetros del evento. Por eso esto lo usan los tres tipos de POST.
 *
 * Los ids de componente son autogenerados según el orden de aparición en el
 * árbol (`j_idt21`, `j_idt25`, `j_idt34` en OEFA): agregar un componente más
 * arriba los desplaza a todos. Se descubren en cada bootstrap en vez de
 * hardcodearse, que es la diferencia entre un scraper que avisa y uno que muere
 * en silencio en el próximo deploy.
 *
 * Total: nunca lanza. Devuelve `undefined` si no hay form.
 */

import * as cheerio from 'cheerio';

import { CAMPO_VIEW_STATE } from './view-state.ts';

export interface JsfForm {
  readonly id: string;
  /** Resuelto contra la URL de la página y **sin** el parámetro de path `;jsessionid=`. */
  readonly action: string;
  /** Campos submitables en orden de aparición. **No** incluye el `ViewState`. */
  readonly campos: ReadonlyMap<string, string>;
  readonly viewState: string | undefined;
}

/** Tipos de `<input>` que un navegador no manda salvo que sean el control pulsado. */
const TIPOS_NO_SUBMITABLES = new Set(['submit', 'button', 'image', 'reset', 'file']);

/**
 * Quita el `;jsessionid=` que el contenedor reescribe dentro de las URLs.
 *
 * La cookie es la fuente de verdad de la sesión; el id en la URL es una copia
 * que solo sirve para filtrarse. `TransportError` guarda su `url` **sin**
 * redactar, así que un `console.error(err)` en un CLI lo imprimiría entero, y
 * `redactUrl()` solo cubre el punto de emisión de los logs de `session.ts`.
 *
 * Y además queda rancio: el `action` se parseó en el bootstrap, y si la sesión
 * rotó, ese id ya no vale. Sacarlo en el origen elimina la clase entera de
 * problema — incluida la de los checkpoints y la DLQ, que también persisten
 * URLs.
 *
 * Es seguro **porque** `view.ts` asevera que la cookie existe (§2.5): si la
 * sesión viajara solo por reescritura de URL, sacarlo rompería todo, y ese caso
 * falla ruidosamente en el bootstrap antes de llegar acá.
 */
export function stripJsessionid(url: string): string {
  return url.replace(/;jsessionid=[^?/;]*/i, '');
}

/**
 * Sin `formId` explícito se elige el primer form que **traiga un `ViewState`**,
 * no simplemente el primero del documento.
 *
 * En OEFA da igual: hay un solo form. Pero un portal con un buscador en la
 * cabecera —o con el form de una sesión de login— tiene varios, y solo el que
 * lleva el token es la vista JSF. Quedarse con el primero produce un submit sin
 * token contra un endpoint que no es, y el diagnóstico no se parece en nada a
 * la causa.
 */
function formPorDefecto($: cheerio.CheerioAPI): ReturnType<cheerio.CheerioAPI> {
  const conToken = $('form').filter((_, el) => $(el).find('input[name$="faces.ViewState"]').length > 0);
  return conToken.length > 0 ? conToken.first() : $('form').first();
}

export function parseForm(html: string, pageUrl: string, formId?: string): JsfForm | undefined {
  const $ = cheerio.load(html);

  const form = formId === undefined ? formPorDefecto($) : $(`form#${formId.replace(/:/g, '\\:')}`).first();
  if (form.length === 0) return undefined;

  const id = form.attr('id');
  if (id === undefined) return undefined;

  const action = stripJsessionid(new URL(form.attr('action') ?? pageUrl, pageUrl).toString());

  const campos = new Map<string, string>();
  let viewState: string | undefined;

  form.find('input, select, textarea').each((_, el) => {
    const $el = $(el);
    const nombre = $el.attr('name');
    if (nombre === undefined || nombre === '' || $el.attr('disabled') !== undefined) return;

    if (nombre === CAMPO_VIEW_STATE || nombre.endsWith(`:${CAMPO_VIEW_STATE}`)) {
      // Viaja aparte: el token vigente lo manda la vista, no el HTML que se
      // parseó hace novecientas páginas.
      const token = $el.attr('value')?.trim();
      if (token !== undefined && token !== '') viewState = token;
      return;
    }

    const etiqueta = (el as { tagName?: string }).tagName?.toLowerCase();

    if (etiqueta === 'textarea') {
      campos.set(nombre, $el.text());
      return;
    }

    if (etiqueta === 'select') {
      const seleccionada = $el.find('option[selected]').first();
      const opcion = seleccionada.length > 0 ? seleccionada : $el.find('option').first();
      campos.set(nombre, opcion.attr('value') ?? opcion.text() ?? '');
      return;
    }

    const tipo = ($el.attr('type') ?? 'text').toLowerCase();
    if (TIPOS_NO_SUBMITABLES.has(tipo)) return;
    if ((tipo === 'checkbox' || tipo === 'radio') && $el.attr('checked') === undefined) return;

    campos.set(nombre, $el.attr('value') ?? '');
  });

  return { id, action, campos, viewState };
}

/** Copia los campos base y agrega los extra, sin mutar el form. */
export function toSearchParams(
  campos: ReadonlyMap<string, string>,
  extra?: Readonly<Record<string, string>>,
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [clave, valor] of campos) params.append(clave, valor);
  if (extra !== undefined) for (const [clave, valor] of Object.entries(extra)) params.set(clave, valor);
  return params;
}
