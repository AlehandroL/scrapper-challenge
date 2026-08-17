/**
 * Taxonomía de errores de protocolo JSF.
 *
 * Mismo criterio que `src/http/errors.ts` —la política vive en el tipo— pero
 * **deliberadamente sin herencia común con `TransportError`**, y eso es
 * funcional, no estético: `withRetry()` reintenta todo lo que sea
 * `TransportError` y propaga el resto en el primer throw. Un
 * `ViewExpiredError` que heredara de ahí se reintentaría cinco veces mandando
 * el mismo token muerto, gastando presupuesto para volver a fallar.
 *
 * El arreglo de una vista caída no es «mandalo de nuevo» sino «reconstruí la
 * vista y replicá el estado de aplicación», y eso no cabe en un `withRetry`.
 */

export abstract class JsfProtocolError extends Error {
  /** Discriminante estable para logs y métricas, igual que `TransportError.kind`. */
  abstract readonly kind: string;

  /** Si rehacer el bootstrap tiene alguna chance de cambiar el resultado. */
  abstract readonly recoverable: boolean;

  readonly url: string;

  constructor(message: string, url: string) {
    super(message);
    this.name = new.target.name;
    this.url = url;
  }
}

/**
 * El servidor no pudo restaurar la vista.
 *
 * **Una sola clase para las dos señales, a propósito.** La forma canónica de JSF
 * es `<error><error-name>…ViewExpiredException`, pero no es la única: OEFA
 * responde `200` con `<redirect url="…/consultaInicio.xhtml">` y sin ninguna
 * mención a la excepción (`fixtures/oefa/06-view-expired.xml`, capturado con un
 * `ViewState` corrupto).
 *
 * Separarlas en dos clases invitaría al `catch (e) { if (e instanceof
 * ViewExpiredError) … }` que en este sitio no matchea nunca — que es justo el
 * modo de falla que la captura reveló. La política es idéntica en ambos casos:
 * rehacer el bootstrap. `senal` queda para logs y métricas.
 */
/**
 * Cómo anunció el servidor que la vista no se pudo restaurar.
 *
 * Las tres son la **misma condición** y por eso comparten clase: separarlas en
 * tres tipos invitaría a atrapar una y dejar pasar las otras dos, que es
 * exactamente el error que §5.2 documenta para `<error>` contra `<redirect>`.
 *
 * - `error` — la forma canónica de la spec: `<error-name>ViewExpiredException`.
 *   Es la que uno implementa primero si escribe contra la spec, y contra OEFA no
 *   matchea nunca.
 * - `redirect` — lo que OEFA contesta de verdad: `200`, 113 bytes, un
 *   `<partial-response>` con un `<redirect>` y sin una sola mención a
 *   `ViewExpiredException` (`fixtures/oefa/06-view-expired.xml`).
 * - `pagina-inicial` — la que aparece cuando el protocolo es **no-ajax**: el
 *   servidor devuelve `200` con la página de inicio, que es un cuerpo
 *   perfectamente válido salvo por no traer resultados. No hay XML donde poner
 *   una señal, así que la única evidencia es que la vista volvió al principio.
 *   Es la que corresponde al portal del Poder Judicial (§5.11).
 */
export type SenalVistaCaida = 'error' | 'redirect' | 'pagina-inicial';

export class ViewExpiredError extends JsfProtocolError {
  readonly kind = 'view-expired';
  readonly recoverable = true;
  readonly senal: SenalVistaCaida;
  readonly detalle: string;

  constructor(url: string, senal: SenalVistaCaida, detalle: string) {
    super(`La vista no se pudo restaurar (señal: <${senal}>): ${detalle}`, url);
    this.senal = senal;
    this.detalle = detalle;
  }
}

/**
 * Se esperaba un `<partial-response>` y llegó otra cosa —típicamente la página
 * completa por haber omitido `Faces-Request: partial/ajax`, el header que §5.3
 * identifica como el que más se olvida.
 *
 * No es recuperable: rehacer el bootstrap no lo arregla, porque la causa está
 * en cómo se armó el request.
 */
export class NotPartialResponseError extends JsfProtocolError {
  readonly kind = 'not-partial-response';
  readonly recoverable = false;
  readonly contentType: string | undefined;
  /** Primeros caracteres del cuerpo: sin esto el diagnóstico es adivinanza. */
  readonly muestra: string;

  constructor(url: string, contentType: string | undefined, cuerpo: string) {
    super(
      `La respuesta no es un <partial-response> (content-type: ${contentType ?? 'sin declarar'}). ` +
        'Suele ser el header Faces-Request omitido.',
      url,
    );
    this.contentType = contentType;
    this.muestra = cuerpo.slice(0, 200);
  }
}

export type MotivoBootstrap = 'form-not-found' | 'no-view-state' | 'no-session';

/**
 * El GET inicial no dejó una vista utilizable.
 *
 * `no-session` es el modo de falla silencioso de §2.5 convertido en excepción:
 * sin sesión propagada la paginación devuelve `200` con la tabla vacía y sin
 * error, y se pierde media hora culpando al selector.
 */
export class BootstrapError extends JsfProtocolError {
  readonly kind = 'bootstrap';
  readonly recoverable = false;
  readonly reason: MotivoBootstrap;

  constructor(url: string, reason: MotivoBootstrap, detalle: string) {
    super(`Bootstrap fallido (${reason}): ${detalle}`, url);
    this.reason = reason;
  }
}

/** Se pidió emitir un evento sobre una vista que todavía no hizo bootstrap. */
export class ViewNotReadyError extends JsfProtocolError {
  readonly kind = 'view-not-ready';
  readonly recoverable = false;

  constructor(url: string, operacion: string) {
    super(`\`${operacion}\` requiere un bootstrap previo.`, url);
  }
}

/**
 * La costura para `sources/`: decidir si toca `recover()` sin conocer las clases.
 *
 * Se mira `recoverable` y no la clase concreta a propósito — agregar una
 * condición recuperable nueva no obliga a editar los `catch` de las capas de
 * arriba.
 */
export function isRecoverable(error: unknown): error is JsfProtocolError {
  return error instanceof JsfProtocolError && error.recoverable;
}
