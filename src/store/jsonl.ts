/**
 * Persistencia en JSONL: escritura append, lectura en streaming, e índice de
 * claves para reanudar.
 *
 * **JSONL y no un array JSON** (§5.7). Un `[{…},{…}]` monolítico obliga a
 * mantener todo en memoria y a escribir al final: una caída en el registro 4.000
 * pierde la corrida entera. Una línea por registro permite append incremental,
 * lectura sin cargar el archivo, y reanudación.
 *
 * **Esta capa no sabe de dónde vienen los registros.** No menciona OEFA, ni
 * expedientes, ni ViewStates: recibe objetos y devuelve objetos. Por eso
 * `readKeys` pide un extractor en vez de leer un campo por su nombre — el día
 * que una fuente identifique sus registros de otra manera, este archivo no se
 * toca. Y ese día llegó antes de lo previsto: el bloque 4 cambió la clave de
 * OEFA a mitad de camino sin editar una línea de acá.
 *
 * El writer es **síncrono** y el lector asíncrono, y no es una incoherencia. Un
 * `WriteStream` bufferea: con datos pendientes, un `process.exit()` o una
 * excepción no atrapada pierde líneas que ya se reportaron como escritas. A un
 * request por segundo el costo de `writeSync` es ruido frente a la latencia de
 * red, y a cambio «la llamada volvió» significa «los bytes están en el page
 * cache del kernel».
 */

import { createReadStream } from 'node:fs';
import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

/** Ventana de lectura hacia atrás al buscar el último salto de línea. */
const TROZO_COLA = 64 * 1024;

export class JsonlCorruptoError extends Error {
  readonly ruta: string;
  readonly linea: number;
  readonly muestra: string;

  constructor(ruta: string, linea: number, texto: string) {
    super(`Línea ${linea} de ${ruta} no es JSON válido: ${texto.slice(0, 120)}`);
    this.name = new.target.name;
    this.ruta = ruta;
    this.linea = linea;
    this.muestra = texto.slice(0, 120);
  }
}

export interface JsonlWriter {
  readonly ruta: string;
  /** Cuántas líneas escribió **esta** instancia, no cuántas tiene el archivo. */
  readonly escritas: number;
  /** Bytes que `repararCola` descartó al abrir. Cero en el caso normal. */
  readonly bytesReparados: number;
  append(registro: object): void;
  /** Barrera de disco. El llamador la invoca por lote, no por registro. */
  flush(): void;
  close(): void;
}

export function openJsonlWriter(ruta: string): JsonlWriter {
  mkdirSync(dirname(ruta), { recursive: true });

  // Reparar es una decisión de quien va a mutar el archivo, y por eso ocurre acá
  // y nunca en el lector: `npm run validate` del bloque 6 necesita **ver** la
  // cola truncada, porque ahí eso es un hallazgo y no un inconveniente.
  const bytesReparados = repararCola(ruta);

  // `'a'` hace que el kernel use O_APPEND: la actualización del offset y la
  // escritura son atómicas entre sí.
  const fd = openSync(ruta, 'a');
  let escritas = 0;
  let cerrado = false;

  return {
    ruta,
    bytesReparados,
    get escritas() {
      return escritas;
    },

    append(registro: object): void {
      if (cerrado) throw new Error(`El writer de ${ruta} ya está cerrado`);
      const buf = Buffer.from(`${JSON.stringify(registro)}\n`, 'utf8');

      // `writeSync` devuelve cuántos bytes escribió y **no reintenta**: una
      // escritura corta deja media línea en el archivo. Es la otra fuente de cola
      // truncada además del corte de energía, y la que nadie ve venir. Sin
      // posición explícita: con `'a'`, pasarla rompe el append en Windows.
      let escrito = 0;
      while (escrito < buf.length) {
        escrito += writeSync(fd, buf, escrito, buf.length - escrito);
      }
      escritas += 1;
    },

    flush(): void {
      if (!cerrado) fsyncSync(fd);
    },

    close(): void {
      if (cerrado) return;
      cerrado = true;
      fsyncSync(fd);
      closeSync(fd);
    },
  };
}

/**
 * Descarta una última línea sin terminar y devuelve cuántos bytes tiró.
 *
 * Una caída deja el archivo con media línea al final. Si el siguiente append
 * escribe a continuación, el resultado es una línea que concatena dos registros
 * y que no es JSON válido — y el diagnóstico llega en el bloque 6, lejos de la
 * causa. Truncar al último `\n` deja el archivo consistente sin perder nada más
 * que el registro que nunca terminó de escribirse.
 *
 * Buscar el byte `0x0A` es seguro en UTF-8: los bytes de continuación tienen
 * siempre el bit alto en 1, así que un salto de línea nunca aparece dentro de un
 * carácter multibyte.
 */
export function repararCola(ruta: string): number {
  if (!existsSync(ruta)) return 0;

  const fd = openSync(ruta, 'r+');
  try {
    const { size } = fstatSync(fd);
    if (size === 0) return 0;

    // Hacia atrás por trozos: un registro más largo que la ventana es
    // patológico pero posible, y quedarse con «no encontré ningún \n en los
    // últimos 64 KB» borraría el archivo entero.
    let fin = size;
    while (fin > 0) {
      const largo = Math.min(TROZO_COLA, fin);
      const inicio = fin - largo;
      const buf = Buffer.alloc(largo);
      readSync(fd, buf, 0, largo, inicio);

      const pos = buf.lastIndexOf(0x0a);
      if (pos !== -1) {
        const sobrantes = size - (inicio + pos + 1);
        if (sobrantes > 0) ftruncateSync(fd, inicio + pos + 1);
        return sobrantes;
      }
      fin = inicio;
    }

    // Ni un solo salto de línea en todo el archivo: es una línea sin terminar.
    ftruncateSync(fd, 0);
    return size;
  } finally {
    closeSync(fd);
  }
}

export interface LineaJsonl<T> {
  /** 1-based, contando también las líneas en blanco. */
  readonly numero: number;
  readonly valor: T;
}

/**
 * Lee el archivo línea por línea, **estricto**.
 *
 * Una línea inválida lanza en vez de saltarse. Saltar en silencio es como se
 * pierden cuatrocientos registros sin que nadie se entere, que es el modo de
 * falla que §6.4 combate en el otro extremo del pipeline. Un archivo
 * inexistente, en cambio, no es un error: es un archivo vacío.
 */
export async function* readJsonl<T = unknown>(
  ruta: string,
): AsyncGenerator<LineaJsonl<T>, void, void> {
  if (!existsSync(ruta)) return;

  const stream = createReadStream(ruta, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let numero = 0;

  try {
    for await (const linea of rl) {
      numero += 1;
      if (linea.trim() === '') continue;
      yield { numero, valor: parsear<T>(ruta, numero, linea) };
    }
  } finally {
    // El `finally` cubre también el `break` del consumidor: sin esto, un
    // recorrido parcial deja el descriptor abierto hasta el GC.
    rl.close();
    stream.destroy();
  }
}

export interface OpcionesKeys {
  /**
   * Se invoca si la **última** línea no parsea. Es el rastro de una caída, no
   * corrupción: se reporta y se sigue.
   */
  readonly onColaInvalida?: (linea: number, muestra: string) => void;
}

/**
 * Las claves ya presentes en el archivo: la base de la idempotencia de §5.7.
 *
 * Tolera que **solo la última** línea sea inválida —es el rastro de una caída, y
 * el writer la va a reparar al abrir— pero no una línea intermedia, que ya no es
 * un artefacto de interrupción sino corrupción real.
 *
 * La clave la extrae el llamador. Así esta capa no necesita saber qué campo
 * identifica a un registro, y la fuente que mañana lo cambie no obliga a tocar
 * este archivo.
 */
export async function readKeys(
  ruta: string,
  clave: (valor: unknown) => string | undefined,
  opts: OpcionesKeys = {},
): Promise<ReadonlySet<string>> {
  const claves = new Set<string>();
  if (!existsSync(ruta)) return claves;

  const stream = createReadStream(ruta, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  // Se procesa con una línea de retraso: hasta que llega la siguiente no se sabe
  // que la anterior no era la última, y solo la última merece indulgencia.
  let pendiente: { numero: number; texto: string } | undefined;
  let numero = 0;

  const absorber = (entrada: { numero: number; texto: string }): void => {
    const valor = parsear<unknown>(ruta, entrada.numero, entrada.texto);
    const k = clave(valor);
    if (k !== undefined) claves.add(k);
  };

  try {
    for await (const linea of rl) {
      numero += 1;
      if (linea.trim() === '') continue;
      if (pendiente !== undefined) absorber(pendiente);
      pendiente = { numero, texto: linea };
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (pendiente !== undefined) {
    try {
      absorber(pendiente);
    } catch (error) {
      if (!(error instanceof JsonlCorruptoError)) throw error;
      opts.onColaInvalida?.(error.linea, error.muestra);
    }
  }

  return claves;
}

function parsear<T>(ruta: string, numero: number, linea: string): T {
  try {
    return JSON.parse(linea) as T;
  } catch {
    throw new JsonlCorruptoError(ruta, numero, linea);
  }
}
