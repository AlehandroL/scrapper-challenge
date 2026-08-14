/**
 * Dead-letter queue: qué falló, por qué, y con qué contexto se puede reintentar.
 *
 * El enunciado lo pide literalmente —«registrar qué documentos fallaron para
 * poder reintentarlos después»— y §5.6 fija el formato. La única desviación
 * respecto de ese formato es la que el bloque 4 obligó a hacer en todas partes:
 * la clave es `id` (la identidad del registro, derivada de su contenido) y no el
 * identificador del documento, que a veces falta y a veces se repite.
 *
 * **`contexto` es lo que la convierte en una cola y no en un listado.** §5.4
 * demostró que la descarga exige un token alineado con la página donde vive la
 * fila, así que reintentar significa volver a navegar hasta esa página. Sin la
 * página anotada, `retry-failed` tendría que recorrer el dataset entero para
 * encontrar tres registros.
 *
 * Se escribe en JSONL por lo mismo que el dataset (§5.7): append incremental,
 * sin releer, y una corrida interrumpida deja un archivo legible.
 */

import { openJsonlWriter, readJsonl, type JsonlWriter } from './jsonl.ts';
import { escribirAtomico } from './atomico.ts';

export interface EntradaDlq {
  /** Identidad del registro que falló. */
  readonly id: string;
  /** Qué se estaba haciendo: `pdf` hoy, otra cosa el día que haya otra cosa. */
  readonly tipo: string;
  /** Discriminante estable, no el mensaje: `throttled`, `network`, `magic`… */
  readonly error: string;
  /** Acumulados entre corridas, no de esta sola: es lo que permite rendirse. */
  readonly intentos: number;
  readonly ultimoTs: string;
  /** Mensaje humano del último fallo. Para leerlo, no para decidir con él. */
  readonly detalle?: string;
  /** Dónde vive el registro: `pagina` e `indice`. Sin esto no se puede re-navegar. */
  readonly contexto?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * El puerto que consume el downloader.
 *
 * Es una interfaz y no la clase concreta porque `retry-failed` necesita recolectar
 * en memoria —reescribe el archivo entero al final— y un test necesita mirar lo
 * registrado sin tocar el disco. Los tres implementan esto.
 */
export interface ColaFallos {
  registrar(entrada: EntradaDlq): void;
}

export interface Dlq extends ColaFallos {
  readonly ruta: string;
  readonly registradas: number;
  close(): void;
}

/**
 * Abre la cola en modo append.
 *
 * `openJsonlWriter` repara la cola truncada al abrir, y acá eso importa más que
 * en el dataset: quien escribe una DLQ es una corrida que ya venía fallando, o
 * sea justo la que tiene más chances de morir a mitad de línea.
 *
 * Se hace `flush()` por entrada y no por lote: son eventos raros, y el valor de
 * la DLQ está en sobrevivir al proceso que la escribió.
 */
export function abrirDlq(ruta: string): Dlq {
  // Perezoso a propósito: una corrida sin fallos no debe dejar un `failed.jsonl`
  // vacío. Un archivo presente invita a pensar que algo falló, y en un repo
  // termina commiteado como si fuera evidencia de algo.
  let writer: JsonlWriter | undefined;
  let registradas = 0;

  return {
    ruta,
    get registradas() {
      return registradas;
    },
    registrar(entrada: EntradaDlq): void {
      writer ??= openJsonlWriter(ruta);
      writer.append(entrada);
      writer.flush();
      registradas += 1;
    },
    close: () => void writer?.close(),
  };
}

/** Recolector en memoria: lo usa quien va a reescribir el archivo entero. */
export function colaEnMemoria(): ColaFallos & { readonly entradas: readonly EntradaDlq[] } {
  const entradas: EntradaDlq[] = [];
  return {
    entradas,
    registrar: (entrada) => void entradas.push(entrada),
  };
}

export class EntradaDlqInvalidaError extends Error {
  readonly ruta: string;
  readonly linea: number;

  constructor(ruta: string, linea: number, detalle: string) {
    super(`Línea ${linea} de ${ruta} no es una entrada de la cola de fallos: ${detalle}`);
    this.name = new.target.name;
    this.ruta = ruta;
    this.linea = linea;
  }
}

/**
 * Lee la cola colapsando por `id`: **la última línea gana**.
 *
 * Es lo que hace que reintentar sea idempotente. Un registro que falla en tres
 * corridas deja tres líneas, y lo que importa es la última —con el conteo de
 * intentos acumulado—, no las tres. El orden de salida es el de la primera
 * aparición, para que un archivo leído dos veces produzca la misma secuencia.
 *
 * Estricto, como `readJsonl`: una línea que no parsea detiene la lectura en vez
 * de saltarse. Quien vaya a mutar el archivo puede repararle la cola antes
 * (`repararCola`), que es la decisión que `jsonl.ts` deja explícitamente en manos
 * del que muta.
 */
export async function leerDlq(ruta: string): Promise<EntradaDlq[]> {
  const porId = new Map<string, EntradaDlq>();

  for await (const { numero, valor } of readJsonl(ruta)) {
    const entrada = comoEntrada(valor);
    if (entrada === undefined) {
      throw new EntradaDlqInvalidaError(ruta, numero, 'faltan campos obligatorios o tienen otro tipo');
    }
    porId.set(entrada.id, entrada);
  }

  return [...porId.values()];
}

/** Deja en el archivo exactamente estas entradas. Escritura atómica: un corte
 *  no puede dejar la cola a medio reescribir y perder lo que faltaba reintentar. */
export function reescribirDlq(ruta: string, entradas: readonly EntradaDlq[]): void {
  escribirAtomico(ruta, entradas.map((e) => `${JSON.stringify(e)}\n`).join(''));
}

function comoEntrada(valor: unknown): EntradaDlq | undefined {
  if (typeof valor !== 'object' || valor === null) return undefined;
  const v = valor as Record<string, unknown>;
  if (typeof v.id !== 'string' || v.id === '') return undefined;
  if (typeof v.tipo !== 'string' || typeof v.error !== 'string') return undefined;
  if (typeof v.intentos !== 'number' || !Number.isInteger(v.intentos)) return undefined;
  if (typeof v.ultimoTs !== 'string') return undefined;
  return v as unknown as EntradaDlq;
}
