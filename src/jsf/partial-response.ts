/**
 * Parsing del `<partial-response>`: XML → CDATA → HTML.
 *
 * Requiere dos pasadas. Aplicar un parser de HTML sobre el cuerpo crudo
 * devuelve cero filas, porque el HTML viaja encapsulado en bloques `CDATA`
 * dentro de un documento XML. Acá se hace la primera; la segunda —parsear el
 * HTML de adentro— es de `datatable.ts` y del bloque 4.
 *
 * **Este módulo es total: nunca lanza.** Si el cuerpo no es un partial-response
 * devuelve `esPartial: false` y todo lo demás vacío. Quién decide si eso es un
 * error es `view.ts`, que es el único que sabe qué se estaba pidiendo: un
 * partial-response sin `<update>` es un dato para el parser y un problema para
 * la vista.
 *
 * De la spec se leen `<update>`, `<redirect>` y `<error>`. `<eval>`,
 * `<insert>`, `<delete>` y `<attributes>` se ignoran deliberadamente: el parser
 * es total, así que su presencia no rompe nada, y soportarlos sin un caso de uso
 * sería completitud por completitud.
 */

import * as cheerio from 'cheerio';

import { esIdViewState } from './view-state.ts';

export interface PartialError {
  readonly name: string;
  readonly message: string;
}

export interface PartialResponse {
  /** `false` si el cuerpo no era un `<partial-response>`. */
  readonly esPartial: boolean;
  /** id del `<update>` → contenido del CDATA, en orden de aparición y sin tocar. */
  readonly updates: ReadonlyMap<string, string>;
  readonly viewState: string | undefined;
  readonly redirect: string | undefined;
  readonly error: PartialError | undefined;
}

const VACIO: PartialResponse = {
  esPartial: false,
  updates: new Map(),
  viewState: undefined,
  redirect: undefined,
  error: undefined,
};

/**
 * Chequeo barato antes de cargar cheerio sobre lo que puede ser una página
 * entera.
 *
 * **No se mira si el cuerpo arranca con `<?xml`.** Sería lo natural y está mal:
 * `fixtures/oefa/04-download-a.html` es una página HTML completa que empieza
 * con `<?xml version='1.0' encoding='UTF-8' ?>` y sigue con `<!DOCTYPE html>`.
 * Esa heurística la clasificaría como partial-response y el error aparecería
 * mucho más tarde, disfrazado de otra cosa.
 */
export function looksLikePartialResponse(cuerpo: string): boolean {
  return cuerpo.includes('<partial-response');
}

export function parsePartialResponse(cuerpo: string): PartialResponse {
  if (!looksLikePartialResponse(cuerpo)) return VACIO;

  const $ = cheerio.load(cuerpo, { xmlMode: true });

  const updates = new Map<string, string>();
  let viewState: string | undefined;

  $('update').each((_, el) => {
    const id = $(el).attr('id');
    if (id === undefined) return;
    // `.text()` resuelve el CDATA: en xmlMode htmlparser2 lo representa como un
    // nodo con un hijo de texto, y la recursión de cheerio lo alcanza.
    const contenido = $(el).text();
    if (esIdViewState(id)) {
      const token = contenido.trim();
      if (token !== '') viewState = token;
    }
    updates.set(id, contenido);
  });

  const redirect = $('redirect').first().attr('url');

  // El `<error>` de la spec: <error><error-name/><error-message/></error>.
  const errorName = $('error-name').first().text().trim();
  const error =
    errorName === ''
      ? undefined
      : { name: errorName, message: $('error-message').first().text().trim() };

  return { esPartial: true, updates, viewState, redirect, error };
}

/**
 * Busca un `<update>` por id: exacto primero, por sufijo después.
 *
 * El prefijo del naming container puede cambiar entre deploys sin que cambie el
 * componente, que es la misma razón por la que el `ViewState` se busca por
 * subcadena.
 */
export function findUpdate(res: PartialResponse, id: string): string | undefined {
  const exacto = res.updates.get(id);
  if (exacto !== undefined) return exacto;
  for (const [clave, valor] of res.updates) {
    if (clave.endsWith(`:${id}`) || clave === id) return valor;
  }
  return undefined;
}
