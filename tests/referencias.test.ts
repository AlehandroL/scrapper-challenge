/**
 * Las referencias «§» del código, resolubles.
 *
 * Los comentarios citan secciones del documento de estrategia con la forma
 * `5.4`, precedida del signo de sección. Ese documento vive en `planes/` y no
 * está versionado a propósito, así que sin un índice cada cita es un puntero
 * que el lector no puede seguir: `docs/referencias.md` dice qué afirma cada
 * sección y dónde está reproducida dentro del repo.
 *
 * Un índice de ese tipo se pudre sin ayuda. La cita nueva se escribe en el
 * archivo donde hace falta y nadie se acuerda de la tabla — que es el mismo
 * modo de falla que el bloque 8 encontró en el README y en la bitácora. Este
 * test lo cierra: toda etiqueta citada en el repo tiene que tener su fila.
 *
 * La dirección opuesta no se exige. Una fila sin citas no le miente a nadie;
 * una cita sin fila sí.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const RAIZ = join(import.meta.dirname, '..');
const INDICE = join(RAIZ, 'docs', 'referencias.md');

/** Dónde se buscan citas. `fixtures/` entra solo por sus README. */
const DIRECTORIOS = ['src', 'scripts', 'tests', 'docs', 'fixtures'];
const EXTENSIONES = new Set(['.ts', '.sh', '.md']);

/** El signo de sección seguido de un número: `§5.4`, `§4`, `§10.2.3`. */
const CITA = /§\d+(?:\.\d+)*/g;

interface Cita {
  readonly etiqueta: string;
  readonly donde: string;
}

function* archivos(dir: string): Generator<string> {
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const ruta = join(dir, entrada.name);
    if (entrada.isDirectory()) yield* archivos(ruta);
    else if (EXTENSIONES.has(extname(entrada.name))) yield ruta;
  }
}

function citasDelRepo(): Cita[] {
  const encontradas: Cita[] = [];

  for (const dir of DIRECTORIOS) {
    for (const ruta of archivos(join(RAIZ, dir))) {
      if (ruta === INDICE) continue;

      const lineas = readFileSync(ruta, 'utf8').split('\n');
      for (const [i, linea] of lineas.entries()) {
        for (const m of linea.matchAll(CITA)) {
          encontradas.push({ etiqueta: m[0], donde: `${relative(RAIZ, ruta)}:${i + 1}` });
        }
      }
    }
  }

  return encontradas;
}

describe('las referencias «§» se pueden resolver', () => {
  const indice = readFileSync(INDICE, 'utf8');
  const cubiertas = new Set([...indice.matchAll(CITA)].map((m) => m[0]));
  const citas = citasDelRepo();

  it('el índice existe y tiene filas', () => {
    expect(cubiertas.size).toBeGreaterThan(20);
  });

  it('el repo cita al menos las secciones que motivaron el índice', () => {
    expect(citas.length).toBeGreaterThan(100);
  });

  /**
   * El mensaje de fallo nombra archivo y línea porque el que rompe esto es el
   * que acaba de escribir la cita, y lo que necesita es saber dónde la escribió.
   */
  it('cada etiqueta citada tiene su fila en docs/referencias.md', () => {
    const huerfanas = citas
      .filter((c) => !cubiertas.has(c.etiqueta))
      .map((c) => `${c.donde} cita ${c.etiqueta}`);

    expect([...new Set(huerfanas)]).toEqual([]);
  });
});
