/**
 * Estado de reanudación: hasta dónde llegó la última corrida (§5.7).
 *
 * Es complementario de la idempotencia por contenido que ya da el JSONL, no un
 * reemplazo. El archivo dice **qué** ya se tiene; el checkpoint dice **dónde**
 * estaba el recorrido. Sin él, una corrida cortada en la página 150 vuelve a
 * emitir 150 eventos de paginación para descubrir que no tiene nada que escribir:
 * el resultado es correcto y el costo, absurdo.
 *
 * §5.7 pide guardar «el hash del conjunto de filtros». Sin filtros reversados
 * (§2.5) ese hash sería una constante, así que acá el papel de invariante lo
 * cumple **el total declarado por el sitio**: si cambió, el organismo publicó
 * algo nuevo, todos los índices se corrieron y retomar en la página 151 leería
 * filas que no son las que faltaban. Un checkpoint que no cuadra se descarta,
 * que es lo correcto y no lo cómodo.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';

import { escribirAtomico } from './atomico.ts';

export interface Checkpoint {
  /** Qué fuente lo escribió. Impide que dos corridas distintas se pisen el estado. */
  readonly fuente: string;
  /**
   * Qué comando lo escribió.
   *
   * No es decorativo: `scrape` y `download` recorren la misma fuente y avanzan a
   * ritmos distintos, así que un checkpoint compartido haría que el que va
   * atrasado se saltee páginas que nunca leyó — el dataset con huecos que parece
   * completo, producido por una comodidad de nombres. Los archivos ya van
   * separados por defecto; esto hace que un `--checkpoint` mal apuntado falle
   * ruidosamente en vez de arruinar la corrida en silencio.
   */
  readonly tarea: string;
  readonly pageSize: number;
  /** El total que el sitio declaró. Es el invariante que valida el resto. */
  readonly total: number;
  /** 1-based, **completada**: la corrida siguiente empieza en la que sigue. */
  readonly ultimaPagina: number;
  /**
   * Si `ultimaPagina` fue la última del recorrido, según la fuente.
   *
   * Lo dice `Pagina.esUltima`, que el adapter calcula con el tamaño de página
   * **real**. Guardarlo evita tener que re-derivarlo acá dividiendo `total` por
   * un `pageSize` que no todas las fuentes publican.
   *
   * Opcional: los checkpoints escritos antes de que existiera este campo siguen
   * siendo válidos y se resuelven por la aritmética de respaldo.
   */
  readonly completo?: boolean;
  /** Acumulado de la corrida, para el reporte. No participa de la validación. */
  readonly registros: number;
  readonly actualizadoEn: string;
}

export class CheckpointInvalidoError extends Error {
  readonly ruta: string;

  constructor(ruta: string, detalle: string) {
    super(`El checkpoint ${ruta} no se puede interpretar: ${detalle}`);
    this.name = new.target.name;
    this.ruta = ruta;
  }
}

/**
 * Lee el checkpoint, o `undefined` si no hay ninguno.
 *
 * **Lanza si el archivo existe pero está roto**, en vez de devolver `undefined`.
 * La diferencia importa: «no hay checkpoint» y «hay uno ilegible» llevan a la
 * misma acción —recorrer desde el principio— pero solo la segunda es un problema,
 * y degradarla a silencio es cómo se convive tres meses con un checkpoint que
 * nunca sirvió.
 */
export function leerCheckpoint(ruta: string): Checkpoint | undefined {
  if (!existsSync(ruta)) return undefined;

  let valor: unknown;
  try {
    valor = JSON.parse(readFileSync(ruta, 'utf8'));
  } catch (error) {
    throw new CheckpointInvalidoError(ruta, error instanceof Error ? error.message : String(error));
  }

  const cp = comoCheckpoint(valor);
  if (cp === undefined) throw new CheckpointInvalidoError(ruta, 'faltan campos o tienen otro tipo');
  return cp;
}

export function escribirCheckpoint(ruta: string, cp: Checkpoint): void {
  escribirAtomico(ruta, `${JSON.stringify(cp, null, 2)}\n`);
}

export function borrarCheckpoint(ruta: string): void {
  rmSync(ruta, { force: true });
}

export interface EsperadoCheckpoint {
  readonly fuente: string;
  readonly tarea: string;
  readonly pageSize: number;
  /** Si todavía no se conoce —el total llega recién con la búsqueda—, se omite
   *  y la compatibilidad se termina de decidir con la primera página. */
  readonly total?: number;
}

/**
 * Si retomar desde este checkpoint puede producir un resultado correcto.
 *
 * El `total` es opcional porque no se conoce antes de emitir la búsqueda, y el
 * `desde` hay que decidirlo antes de eso. El consumidor valida lo que puede acá y
 * termina de validar contra `pagina.total` cuando la primera página llega: si no
 * coincide, descarta el checkpoint y recorre de nuevo desde la página 1.
 */
export function esCompatible(cp: Checkpoint, esperado: EsperadoCheckpoint): boolean {
  if (cp.fuente !== esperado.fuente) return false;
  if (cp.tarea !== esperado.tarea) return false;
  if (cp.pageSize !== esperado.pageSize) return false;
  if (esperado.total !== undefined && cp.total !== esperado.total) return false;
  return cp.ultimaPagina >= 1;
}

export interface PeticionReanudacion {
  readonly fuente: string;
  readonly tarea: string;
  readonly pageSize: number;
  /** Lo que el usuario pidió explícitamente. Si está, manda sobre el checkpoint. */
  readonly desde?: number;
  readonly hasta?: number;
}

export interface PlanReanudacion {
  readonly desde?: number;
  /** Contra qué comparar el total de la primera página. */
  readonly totalEsperado?: number;
  readonly mensaje?: string;
  /** Si está, no hay nada que hacer y este es el motivo. */
  readonly nadaPendiente?: string;
}

/**
 * Desde qué página arrancar, mirando el checkpoint.
 *
 * Los tres casos de «nada pendiente» son los que evitan que repetir un comando
 * haga algo distinto la segunda vez. Sin el del `--hasta`, correr `--hasta 3` dos
 * veces seguidas recorrería el dataset entero la segunda: el checkpoint diría
 * «vas por la 3» y nadie estaría mirando el `--hasta`. Sin el de `completo`,
 * repetir una corrida ya terminada salía por error en vez de por «no hay nada
 * que hacer».
 *
 * Es política, no estado, y por eso es una función pura que se puede probar sin
 * tocar el disco. Los dos CLIs la comparten: que `scrape` y `download` reanuden
 * distinto sería una fuente de sorpresas gratuita.
 */
export function planificarReanudacion(
  cp: Checkpoint | undefined,
  pedido: PeticionReanudacion,
): PlanReanudacion {
  if (pedido.desde !== undefined) return { desde: pedido.desde };
  if (cp === undefined) return {};
  if (
    !esCompatible(cp, { fuente: pedido.fuente, tarea: pedido.tarea, pageSize: pedido.pageSize })
  ) {
    return {
      mensaje:
        'el checkpoint es de otra fuente, de otro comando o de otro tamaño de página: se ignora',
    };
  }

  const desde = cp.ultimaPagina + 1;

  // Que el recorrido haya terminado lo dice la fuente —`Pagina.esUltima`—, no
  // una división. Derivarlo de `total / pageSize` exige conocer el tamaño de
  // página, y hay fuentes que no lo publican: el Poder Judicial lo deriva en
  // runtime y hasta acá llegaba como `0`, así que `ultima` daba `Infinity` y la
  // guarda de abajo no disparaba nunca.
  //
  // El síntoma no era un rearranque de más, que sería tolerable: el `desde`
  // resultante superaba la última página, la fuente lo rechazaba con
  // `RangoInvalidoError` y el CLI salía con código 2 —«uso incorrecto»— por
  // repetir un comando que la vez anterior había terminado bien. Y como el
  // checkpoint no se borra en ese camino, se repetía en cada corrida.
  //
  // Va **antes** que `--hasta`: un recorrido terminado no tiene nada pendiente,
  // pida lo que pida el usuario. Pedir `--hasta 200` sobre un dataset de 176
  // páginas no vuelve pendientes las 24 que no existen.
  if (cp.completo === true) {
    return { nadaPendiente: `el checkpoint dice que la página ${cp.ultimaPagina} fue la última` };
  }

  if (pedido.hasta !== undefined && desde > pedido.hasta) {
    return { nadaPendiente: `el checkpoint ya cubre hasta la página ${cp.ultimaPagina}` };
  }

  // Respaldo para los checkpoints escritos antes de que existiera `completo`, y
  // solo cuando el tamaño de página se conoce: dividir por cero da `Infinity`,
  // que es exactamente el bug que esta guarda evita.
  if (pedido.hasta === undefined && pedido.pageSize > 0) {
    const ultima = Math.max(1, Math.ceil(cp.total / pedido.pageSize));
    if (desde > ultima) {
      return { nadaPendiente: `el checkpoint dice que se completaron las ${ultima} páginas` };
    }
  }

  return { desde, totalEsperado: cp.total, mensaje: `checkpoint: se retoma en la página ${desde}` };
}

function comoCheckpoint(valor: unknown): Checkpoint | undefined {
  if (typeof valor !== 'object' || valor === null) return undefined;
  const v = valor as Record<string, unknown>;

  const entero = (x: unknown): boolean => typeof x === 'number' && Number.isInteger(x) && x >= 0;
  if (typeof v.fuente !== 'string' || v.fuente === '') return undefined;
  if (typeof v.tarea !== 'string' || v.tarea === '') return undefined;
  if (!entero(v.pageSize) || !entero(v.total) || !entero(v.ultimaPagina) || !entero(v.registros))
    return undefined;
  if (typeof v.actualizadoEn !== 'string') return undefined;
  // Ausente es válido —checkpoint viejo—; presente y no booleano, no.
  if (v.completo !== undefined && typeof v.completo !== 'boolean') return undefined;

  return v as unknown as Checkpoint;
}
