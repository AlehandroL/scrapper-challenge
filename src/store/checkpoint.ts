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
 * Los dos casos de «nada pendiente» son los que evitan que repetir un comando
 * haga algo distinto la segunda vez. Sin el primero, correr `--hasta 3` dos veces
 * seguidas recorrería el dataset entero la segunda: el checkpoint diría «vas por
 * la 3» y nadie estaría mirando el `--hasta`.
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
  if (!esCompatible(cp, { fuente: pedido.fuente, tarea: pedido.tarea, pageSize: pedido.pageSize })) {
    return { mensaje: 'el checkpoint es de otra fuente, de otro comando o de otro tamaño de página: se ignora' };
  }

  const desde = cp.ultimaPagina + 1;
  const ultima = Math.max(1, Math.ceil(cp.total / pedido.pageSize));

  if (pedido.hasta !== undefined && desde > pedido.hasta) {
    return { nadaPendiente: `el checkpoint ya cubre hasta la página ${cp.ultimaPagina}` };
  }
  if (pedido.hasta === undefined && desde > ultima) {
    return { nadaPendiente: `el checkpoint dice que se completaron las ${ultima} páginas` };
  }

  return { desde, totalEsperado: cp.total, mensaje: `checkpoint: se retoma en la página ${desde}` };
}

function comoCheckpoint(valor: unknown): Checkpoint | undefined {
  if (typeof valor !== 'object' || valor === null) return undefined;
  const v = valor as Record<string, unknown>;

  const entero = (x: unknown): boolean => typeof x === 'number' && Number.isInteger(x) && x >= 0;
  if (typeof v.fuente !== 'string' || v.fuente === '') return undefined;
  if (typeof v.tarea !== 'string' || v.tarea === '') return undefined;
  if (!entero(v.pageSize) || !entero(v.total) || !entero(v.ultimaPagina) || !entero(v.registros)) return undefined;
  if (typeof v.actualizadoEn !== 'string') return undefined;

  return v as unknown as Checkpoint;
}
