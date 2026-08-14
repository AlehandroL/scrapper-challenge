/**
 * Escritura de un stream a disco: temporal, validación de cabecera, y recién
 * entonces el destino final.
 *
 * §5.4 pide exactamente esta secuencia y por una razón concreta: estos portales
 * responden `HTTP 200` con HTML de error o de sesión expirada en lugar del
 * binario. `fixtures/oefa/04-download-a.html` **es** ese caso —200,
 * `content-type: text/html`, y el cuerpo es la página de resultados—. Escribir
 * primero y mirar después deja un `.pdf` que es una página web ocupando el lugar
 * del documento válido y bloqueando su reintento: el archivo existe, así que la
 * corrida siguiente lo omite.
 *
 * Por eso la validación ocurre **antes de tocar el destino** y el nombre final
 * aparece con un `rename`, que es atómico dentro del mismo directorio. Un archivo
 * con este nombre es un archivo completo y verificado; no hay estado intermedio
 * observable.
 *
 * **Esta capa no sabe qué es un PDF.** El magic lo pasa el llamador, igual que
 * `readKeys` recibe el extractor de clave en vez de conocer el campo: el día que
 * haya que bajar un XLSX este archivo no se toca.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';

/** Sufijo del archivo a medio bajar. Visible a propósito: un `.parcial` que
 *  sobrevive a la corrida es evidencia de un corte, no basura anónima. */
export const SUFIJO_TEMPORAL = '.parcial';

export type MotivoInvalido = 'magic' | 'tamano';

/**
 * El cuerpo llegó, pero no es lo que se pidió.
 *
 * No hereda de `TransportError`: no es un fallo de transporte —el servidor
 * contestó 200— y hacerlo lo metería en la política de reintentos, que es
 * justamente lo que no corresponde. Quién decide si esto se reintenta, se
 * registra o detiene la corrida es el consumidor.
 */
export class ArchivoInvalidoError extends Error {
  readonly motivo: MotivoInvalido;
  readonly ruta: string;

  constructor(ruta: string, motivo: MotivoInvalido, detalle: string) {
    super(`El cuerpo descargado para ${ruta} no es válido (${motivo}): ${detalle}`);
    this.name = new.target.name;
    this.motivo = motivo;
    this.ruta = ruta;
  }
}

export interface ResumenArchivo {
  readonly bytes: number;
  /** Hash del contenido. Lo consume el sanity check del bloque 6 sin releer nada. */
  readonly sha256: string;
}

export interface OpcionesGuardado {
  /**
   * Los primeros bytes que el cuerpo debe traer, en latin1 (`'%PDF-'`).
   *
   * Se compara sobre bytes crudos y no sobre texto decodificado: un binario
   * pasado por `toString('utf8')` puede perder los bytes que justamente se
   * quieren mirar.
   */
  readonly magic?: string;
  /** Mínimo plausible. Un cuerpo de 40 bytes con el magic correcto sigue sin ser un documento. */
  readonly tamanoMinimo?: number;
}

/**
 * Escribe `origen` en `destino` y devuelve cuánto pesó y su hash.
 *
 * Lanza `ArchivoInvalidoError` si el magic o el tamaño no dan. En cualquier
 * fallo —también los de red a mitad de cuerpo— destruye el stream y borra el
 * temporal, de modo que el destino nunca existe a medias.
 *
 * **Destruir el stream no es opcional**: §5.6 lo anotó al implementar el bloque
 * 2. Un cuerpo en streaming que no se drena deja el socket colgado; unos pocos
 * casos agotan el pool de conexiones y los requests siguientes se cuelgan sin
 * timeout, con un síntoma que no se parece en nada a la causa.
 */
export async function guardarStream(
  origen: Readable,
  destino: string,
  opts: OpcionesGuardado = {},
): Promise<ResumenArchivo> {
  const { magic, tamanoMinimo = 0 } = opts;
  const temporal = `${destino}${SUFIJO_TEMPORAL}`;

  mkdirSync(dirname(destino), { recursive: true });
  const fd = openSync(temporal, 'w');

  const hash = createHash('sha256');
  let bytes = 0;
  let cabecera: Buffer = Buffer.alloc(0);
  let validada = magic === undefined;
  let completo = false;

  try {
    for await (const trozo of origen) {
      const buf = Buffer.isBuffer(trozo) ? trozo : Buffer.from(String(trozo), 'binary');

      // Hasta tener suficientes bytes para decidir no se escribe nada: un cuerpo
      // que llega en trozos de 3 bytes no debe dejar medio HTML en el temporal.
      if (!validada && magic !== undefined) {
        cabecera = cabecera.length === 0 ? buf : Buffer.concat([cabecera, buf]);
        if (cabecera.length < magic.length) continue;
        assertMagic(cabecera, magic, destino);
        validada = true;
        bytes += escribir(fd, cabecera);
        hash.update(cabecera);
        cabecera = Buffer.alloc(0);
        continue;
      }

      bytes += escribir(fd, buf);
      hash.update(buf);
    }

    // El cuerpo terminó sin alcanzar el largo del magic: sigue sin ser válido, y
    // sin este caso un `200` con cuerpo vacío pasaría como descarga exitosa.
    if (!validada && magic !== undefined) assertMagic(cabecera, magic, destino);

    if (bytes < tamanoMinimo) {
      throw new ArchivoInvalidoError(destino, 'tamano', `${bytes} byte(s), el mínimo es ${tamanoMinimo}`);
    }

    fsyncSync(fd);
    completo = true;
  } finally {
    closeSync(fd);
    if (!completo) {
      origen.destroy();
      rmSync(temporal, { force: true });
    }
  }

  renameSync(temporal, destino);
  return { bytes, sha256: hash.digest('hex') };
}

function assertMagic(cabecera: Buffer, magic: string, destino: string): void {
  const leido = cabecera.subarray(0, magic.length).toString('latin1');
  if (leido === magic) return;
  throw new ArchivoInvalidoError(
    destino,
    'magic',
    `empieza con ${JSON.stringify(leido)} y debía empezar con ${JSON.stringify(magic)}`,
  );
}

/**
 * `writeSync` **no reintenta** y puede escribir de menos. Es la misma trampa que
 * documenta `jsonl.ts`: una escritura corta deja el archivo incompleto sin que
 * nadie lance nada.
 */
function escribir(fd: number, buf: Buffer): number {
  let escrito = 0;
  while (escrito < buf.length) {
    escrito += writeSync(fd, buf, escrito, buf.length - escrito);
  }
  return buf.length;
}

/** Tamaño en disco, o `undefined` si no existe. */
export function tamanoDe(ruta: string): number | undefined {
  return statSync(ruta, { throwIfNoEntry: false })?.size;
}

/** Presente y con un tamaño plausible: la base de la idempotencia de §5.7. */
export function existeArchivo(ruta: string, tamanoMinimo = 0): boolean {
  const bytes = tamanoDe(ruta);
  return bytes !== undefined && bytes >= tamanoMinimo;
}

/**
 * Relee un archivo ya presente para poder anotarlo sin volver a bajarlo.
 *
 * Solo hace falta cuando el archivo está en disco pero no en el índice —alguien
 * borró el manifiesto, o la corrida murió entre el `rename` y la línea—. Releer
 * nueve megas es caro; bajarlos de nuevo, veinte veces más.
 */
export async function resumenDe(ruta: string): Promise<ResumenArchivo | undefined> {
  const bytes = tamanoDe(ruta);
  if (bytes === undefined) return undefined;

  const hash = createHash('sha256');
  for await (const trozo of createReadStream(ruta)) hash.update(trozo as Buffer);
  return { bytes, sha256: hash.digest('hex') };
}

/**
 * Un fragmento seguro para un nombre de archivo.
 *
 * Descompone y saca los diacríticos en vez de sustituirlos uno por uno: así
 * `Nº 264-2012-OEFA/TFA` no depende de una tabla de reemplazos que siempre
 * termina incompleta. La barra del número de resolución es el caso que obliga a
 * hacer esto: sin sanitizar, abre un directorio inexistente.
 */
export function sanitizar(texto: string, max = 80): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, max)
    .replace(/-+$/, '');
}
