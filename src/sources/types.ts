/**
 * El contrato común de una fuente: lo que `sources/oefa.ts` y `sources/pj.ts`
 * implementan igual, y lo que el CLI y el bloque 5 consumen sin saber cuál es.
 *
 * Dos decisiones definen estos tipos, y las dos vienen de §5.4:
 *
 * 1. **`Fila` separa lo durable de lo efímero.** El `registro` va al JSONL; la
 *    `descarga` —los pares de `mojarra.jsfcljs`— vive solo mientras el token de
 *    su página esté alineado. Persistirla invitaría a reproducirla más tarde
 *    contra un `ViewState` que ya no le corresponde, que es exactamente el
 *    experimento que devolvió `200` con la página re-renderizada y sin PDF.
 * 2. **El `ViewState` vive en la `Pagina`, no en el registro.** Es un blob
 *    base64 de ~1,5 KB y un identificador de sesión: multiplicado por 1.753
 *    registros infla el JSONL diez veces para guardar algo que no sirve en la
 *    corrida siguiente.
 *
 * §2.5 además fija lo que **no** lleva la interfaz: el request de búsqueda con
 * filtros no está reversado, así que `recorrer()` no acepta parámetros de
 * filtrado. Una firma que promete lo que no hace es peor que una que no lo
 * ofrece; filtrar del lado del cliente sobre el dataset completo cubre el caso
 * de uso sin esa deuda.
 */

import { z } from 'zod';

import type { JsfRequest } from '../jsf/commands.ts';

/**
 * Lo que toda fuente produce por fila, con independencia del dominio.
 *
 * **`id` lo deriva el adapter del contenido de la fila, y no es el
 * identificador que el sitio le pone a su documento.** Parecen lo mismo hasta
 * que dejan de serlo, y en OEFA dejan de serlo dos veces: hay filas sin
 * documento —resoluciones publicadas como «Información confidencial»— y hay
 * pares de filas que comparten documento porque una misma resolución alcanza a
 * dos unidades fiscalizables. Un identificador que a veces falta y a veces se
 * repite no puede ser la clave primaria de nada.
 *
 * `indice` es la coordenada dentro de **esta** corrida, no una identidad: es la
 * posición en el resultado de la búsqueda y se corre entera en cuanto el
 * organismo publica algo nuevo. Sirve para verificar la alineación de la
 * paginación y para localizar la fila; no para deduplicar. `pagina` es derivable
 * de `indice`, y se persiste igual porque hace legible una entrada de la DLQ del
 * bloque 5 sin tener que dividir a mano.
 */
export interface RegistroBase {
  readonly fuente: string;
  /** Identidad del registro, derivada de su contenido. Estable entre corridas. */
  readonly id: string;
  /** `data-ri`: posición 0-based dentro del resultado de la búsqueda. */
  readonly indice: number;
  /** 1-based. Derivada de `indice`, se persiste por legibilidad. */
  readonly pagina: number;
  readonly capturadoEn: string;
}

/**
 * §6.7: validación por registro antes de persistir.
 *
 * Los adapters extienden esto con sus campos. Que el esquema viva junto al tipo
 * y no en `validate/` es deliberado: `validate/` es del bloque 6 y opera sobre
 * el dataset ya escrito; esto opera sobre el registro antes de escribirlo, y
 * separarlo del tipo que describe solo garantiza que se desincronicen.
 */
export const RegistroBaseSchema = z.object({
  fuente: z.string().min(1),
  id: z.string().min(1),
  indice: z.number().int().nonnegative(),
  pagina: z.number().int().positive(),
  capturadoEn: z.iso.datetime(),
});

/**
 * Un registro más lo que hace falta para pedir su documento.
 *
 * `descarga` son los pares que el `onclick` traía: el id del componente y el
 * identificador del documento. **Nunca se persisten** — ver el JSDoc del módulo.
 *
 * Es `undefined` cuando la fila no tiene documento. No es un caso teórico: OEFA
 * publica resoluciones marcadas «Información confidencial», sin número y sin
 * enlace. Que el tipo lo diga obliga al consumidor a decidir qué hace con ellas,
 * en vez de descubrirlo con un POST que devuelve una página en vez de un PDF.
 */
export interface Fila<R extends RegistroBase> {
  readonly registro: R;
  readonly descarga: Readonly<Record<string, string>> | undefined;
}

export interface Pagina<R extends RegistroBase> {
  /** 1-based. */
  readonly numero: number;
  /** Offset 0-based con el que se pidió: el `dt_first` del evento. */
  readonly first: number;
  readonly filas: readonly Fila<R>[];
  /** Total que el sitio declaró en la búsqueda. */
  readonly total: number;
  readonly esUltima: boolean;
  /**
   * El token vigente al leer **esta** página (§5.4).
   *
   * Verificado en §2.5: sigue sirviendo para descargar sus filas después de
   * haber avanzado a otra página. Lo que sí lo mata es un `recover()`, y por eso
   * viaja junto a `generacion`.
   */
  readonly viewState: string;
  /** Generación de la vista al leerla. Si cambió, `viewState` está muerto. */
  readonly generacion: number;
}

export interface OpcionesRecorrido {
  /** Página 1-based inclusive. Por defecto, la primera. */
  readonly desde?: number;
  /** Página 1-based inclusive. Por defecto, la última. */
  readonly hasta?: number;
}

export interface Fuente<R extends RegistroBase> {
  readonly nombre: string;
  readonly urlBase: string;

  /**
   * Recorre las páginas en orden, emitiendo cada una entera.
   *
   * Página y no registro suelto: la unidad de alineación del `ViewState` es la
   * página, y el consumidor necesita tenerla completa para poder pedir los
   * documentos de sus filas antes de avanzar.
   *
   * **No devuelve resumen.** `for await…of` descarta el valor de retorno de un
   * generador en silencio, así que un resumen ahí sería invisible la mitad de
   * las veces; el CLI lo arma desde `Metrics` y `pagina.total`.
   */
  recorrer(opts?: OpcionesRecorrido): AsyncGenerator<Pagina<R>, void, void>;

  /**
   * El seam del bloque 5: arma el POST que baja el documento de una fila, con el
   * token de su propia página.
   *
   * Devuelve el request **sin emitir**. Cómo se ejecuta importa y está
   * documentado en la implementación: en resumen, con `session.stream` y no con
   * `view.submitCommand`, que usaría el token vigente en vez del alineado.
   *
   * Lanza si la fila no tiene documento: `fila.descarga === undefined` es la
   * comprobación que corresponde antes de llamar.
   */
  prepararDescarga(pagina: Pagina<R>, fila: Fila<R>): JsfRequest;
}

/** Azúcar para el consumidor que solo quiere persistir y no descargar. */
export function registrosDe<R extends RegistroBase>(pagina: Pagina<R>): readonly R[] {
  return pagina.filas.map((f) => f.registro);
}
