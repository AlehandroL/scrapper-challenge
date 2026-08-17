/**
 * Taxonomía de errores de la capa de fuente.
 *
 * **Sin herencia común con `TransportError` ni con `JsfProtocolError`**, y por la
 * misma razón funcional que documenta `jsf/errors.ts`: `withRetry()` reintenta
 * todo lo que sea `TransportError`, e `isRecoverable()` decide si el adapter
 * rehace el bootstrap. Un drift estructural que heredara de cualquiera de los
 * dos se reintentaría cinco veces contra un sitio que cambió, o haría que el
 * adapter intente recuperarse de algo que ninguna sesión nueva arregla.
 *
 * Un drift no se cura reintentando: se cura mirando el sitio. Por eso sale
 * derecho hasta el CLI y detiene la corrida.
 */

/** Contexto del hallazgo. Sin esto, un drift es un mensaje y no un diagnóstico. */
export type ContextoDrift = Readonly<Record<string, string | number | boolean>>;

export abstract class SourceError extends Error {
  /** Discriminante estable para logs y métricas, igual que `TransportError.kind`. */
  abstract readonly kind: string;

  readonly fuente: string;

  constructor(message: string, fuente: string) {
    super(message);
    this.name = new.target.name;
    this.fuente = fuente;
  }
}

/**
 * Los tipos de drift que §6.4 pide detectar, más los que la implementación
 * encontró.
 *
 * Que sea una unión cerrada y no un string libre es lo que permite que un test
 * asevere *cuál* drift saltó. «Falló con StructuralDriftError» no distingue un
 * selector obsoleto de una sesión perdida, y son arreglos distintos.
 */
export type TipoDrift =
  | 'sin-filas'
  | 'sin-total'
  | 'pagina-incompleta'
  | 'indices-desalineados'
  | 'numeracion'
  | 'columnas'
  | 'sin-uuid'
  | 'solapamiento'
  | 'total-inestable'
  | 'page-size'
  | 'registro-invalido'
  /**
   * La descarga devolvió algo que no es el documento, varias veces seguidas.
   *
   * Una sola vez es un fallo y va a la cola de reintentos; N seguidas es el
   * sitio diciendo otra cosa —la vista se cayó, o cambió la forma del POST de
   * descarga— y seguir pidiendo mil setecientas filas para acumular mil
   * setecientos fallos es exactamente el modo de falla que §6.4 existe para
   * cortar.
   */
  | 'descarga-no-pdf'
  /**
   * No se encontró en la página el control que dispara la búsqueda.
   *
   * Los tres tipos que siguen son del adapter del Poder Judicial y comparten
   * causa: ese portal no expone su protocolo en un script de configuración como
   * PrimeFaces, así que el adapter **descubre** los comandos leyendo los
   * `onclick` de la página. Cuando el descubrimiento falla hay que decir *cuál*
   * falló, porque cada uno se cierra capturando un request distinto.
   */
  | 'busqueda-no-descubierta'
  /** No se encontró el control de «página siguiente». Ver §5.11. */
  | 'paginacion-no-descubierta'
  /**
   * La página de resultados no trae ningún componente con la forma
   * `form:iterador:N:componente`, que es como se reconocen las filas.
   */
  | 'sin-iterador';

/**
 * El peor modo de falla de un scraper no es la excepción: es seguir corriendo
 * tres semanas escribiendo datos vacíos sin que nadie lo note (§6.4). Esta clase
 * es la conversión de ese silencio en ruido.
 */
export class StructuralDriftError extends SourceError {
  readonly kind = 'drift';
  readonly tipo: TipoDrift;
  readonly contexto: ContextoDrift;

  constructor(fuente: string, tipo: TipoDrift, detalle: string, contexto: ContextoDrift = {}) {
    super(`Drift estructural (${tipo}): ${detalle}`, fuente);
    this.tipo = tipo;
    this.contexto = contexto;
  }
}

export type MotivoAgotamiento = 'presupuesto' | 'mismo-offset';

/**
 * Se agotó el presupuesto de recuperaciones de §5.1, o el mismo offset falló dos
 * veces.
 *
 * El segundo motivo es el que importa: sin él, una vista que expira
 * determinísticamente en la página 87 cicla recuperándose siempre del mismo
 * lugar hasta agotar el presupuesto global, gastando un bootstrap y una búsqueda
 * por vuelta para volver a fallar igual.
 */
export class RecuperacionAgotadaError extends SourceError {
  readonly kind = 'recuperacion-agotada';
  readonly motivo: MotivoAgotamiento;
  readonly pagina: number;

  constructor(fuente: string, motivo: MotivoAgotamiento, pagina: number, detalle: string) {
    super(`No se pudo recuperar la vista en la página ${pagina} (${motivo}): ${detalle}`, fuente);
    this.motivo = motivo;
    this.pagina = pagina;
  }
}

export type MotivoDesalineacion = 'generacion' | 'fila-ajena';

/**
 * Uso indebido del seam de descarga: se pidió el documento de una fila con un
 * token que no le corresponde.
 *
 * Es la lección de §5.4 convertida en tipo. El experimento controlado mostró que
 * con el `ViewState` de la página 2 el servidor devuelve `200` con la página
 * re-renderizada y **sin PDF** — un fallo que sin esta guarda se descubre al
 * abrir el archivo, no al bajarlo.
 */
export class PaginaDesalineadaError extends SourceError {
  readonly kind = 'pagina-desalineada';
  readonly motivo: MotivoDesalineacion;

  constructor(fuente: string, motivo: MotivoDesalineacion, detalle: string) {
    super(`La página y la fila no están alineadas (${motivo}): ${detalle}`, fuente);
    this.motivo = motivo;
  }
}

/** Rango de páginas fuera de lo que la fuente puede servir. */
export class RangoInvalidoError extends SourceError {
  readonly kind = 'rango-invalido';

  constructor(fuente: string, detalle: string) {
    super(`Rango de recorrido inválido: ${detalle}`, fuente);
  }
}

/**
 * Se pidió el documento de una fila que no tiene ninguno.
 *
 * Existe separado de `PaginaDesalineadaError` porque no es un error de
 * alineación sino de expectativa: el sitio publica resoluciones como
 * «Información confidencial», sin enlace de descarga. El bloque 5 tiene que
 * saltearlas, no reintentarlas.
 */
export class SinDocumentoError extends SourceError {
  readonly kind = 'sin-documento';
  readonly id: string;

  constructor(fuente: string, id: string) {
    super(`El registro ${id} no tiene documento descargable`, fuente);
    this.id = id;
  }
}
