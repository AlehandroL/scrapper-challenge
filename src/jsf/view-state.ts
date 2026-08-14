/**
 * El token `ViewState`: dónde vive y cómo se lo reconoce.
 *
 * Está aparte porque se extrae de dos formatos distintos —atributo de un input
 * en el HTML, id de un `<update>` en el XML— y lo necesitan tanto
 * `partial-response.ts` como `form.ts`. Ponerlo en cualquiera de los dos
 * invertiría la dirección de la dependencia.
 */

import * as cheerio from 'cheerio';

/** Nombre del campo en el form HTML. En el partial-response el id es **otro**. */
export const CAMPO_VIEW_STATE = 'javax.faces.ViewState';

/**
 * En la respuesta el id trae el naming container y un índice:
 *
 *     <update id="j_id1:javax.faces.ViewState:0">
 *
 * Un lookup por id exacto devuelve `undefined` contra toda respuesta real, y el
 * síntoma —token vacío, sesión que parece caída— se confunde con un bloqueo del
 * sitio (§5.2). Por eso se matchea por subcadena y no por igualdad.
 *
 * El prefijo además cambia de familia entre versiones: `javax.*` hasta JSF 2.x,
 * `jakarta.*` desde Jakarta EE 9. Soportar el que todavía no vimos cuesta una
 * alternancia de doce caracteres; descubrir que faltaba cuesta una corrida.
 */
const ID_VIEW_STATE = /(?:^|:)(?:javax|jakarta)\.faces\.ViewState(?::|$)/;

export function esIdViewState(id: string): boolean {
  return ID_VIEW_STATE.test(id);
}

/**
 * Token desde un documento HTML completo: el bootstrap, o la página
 * re-renderizada que devuelve un POST no-ajax.
 *
 * Selector por sufijo y no regex sobre el orden de atributos: Mojarra hoy emite
 * `name` antes que `value`, pero nada lo garantiza. El `.trim()` no es
 * decorativo — un `\n` colado en el POST invalida el token, y el síntoma es una
 * expiración que no se explica.
 */
export function extractViewState(html: string): string | undefined {
  const $ = cheerio.load(html);
  const valor = $(`input[name$="faces.ViewState"]`).first().attr('value');
  const token = valor?.trim();
  return token === undefined || token === '' ? undefined : token;
}
