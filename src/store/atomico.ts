/**
 * Escritura de un archivo completo sin estado intermedio observable.
 *
 * `writeFileSync` sobre el destino tiene una ventana en la que el archivo existe
 * truncado: un corte de energía ahí deja un checkpoint vacío o una cola de
 * fallos a medias, que es peor que no tenerlos —el que los lea va a creerles—.
 * Escribir a un temporal en el **mismo directorio** y renombrar cierra esa
 * ventana: el `rename` es atómico dentro de un filesystem, así que el destino
 * pasa del contenido viejo al nuevo sin pasar por ningún estado intermedio.
 *
 * El `fsync` va antes del `rename` a propósito. Al revés, el nombre puede quedar
 * apuntando a bytes que todavía no llegaron al disco.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export function escribirAtomico(ruta: string, contenido: string): void {
  mkdirSync(dirname(ruta), { recursive: true });

  const temporal = `${ruta}.tmp`;
  const fd = openSync(temporal, 'w');
  let completo = false;

  try {
    const buf = Buffer.from(contenido, 'utf8');
    let escrito = 0;
    while (escrito < buf.length) {
      escrito += writeSync(fd, buf, escrito, buf.length - escrito);
    }
    fsyncSync(fd);
    completo = true;
  } finally {
    closeSync(fd);
    if (!completo) rmSync(temporal, { force: true });
  }

  // El `rename` va fuera del `try` de arriba a propósito: renombrar con el
  // descriptor todavía abierto falla en Windows, así que el `closeSync` del
  // `finally` tiene que haber corrido primero. Pero eso lo deja también fuera de
  // su limpieza, y un `rename` que falla —permisos del directorio, el destino
  // ocupado, el directorio borrado a mitad— dejaba el `.tmp` huérfano con el
  // contenido nuevo entero adentro. El error se relanza tal cual: Node ya nombra
  // el código y las dos rutas, y qué hacer con un fallo de disco lo decide el
  // llamador.
  try {
    renameSync(temporal, ruta);
  } catch (error) {
    rmSync(temporal, { force: true });
    throw error;
  }
}
