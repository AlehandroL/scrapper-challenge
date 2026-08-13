/**
 * La separación de capas de §4 como aserción, no como promesa del README.
 *
 * «La capa `jsf/` no sabe nada de jurisprudencia ni de resoluciones ambientales.
 * La capa `sources/` no sabe nada de reintentos ni de cookies.» Es fácil
 * escribirlo y fácil que deje de ser cierto en el tercer apuro. Un test lo
 * mantiene honesto: el día que alguien meta un `ViewState` acá, la suite avisa.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR_HTTP = join(import.meta.dirname, '..', 'src', 'http');

function archivosDe(dir: string): { nombre: string; contenido: string }[] {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.ts'))
    .map((nombre) => ({ nombre, contenido: readFileSync(join(dir, nombre), 'utf8') }));
}

/** Se ignoran los comentarios: explicar *por qué* citando el dominio es correcto;
 *  lo que no puede haber es código que dependa de él. */
function soloCodigo(fuente: string): string {
  return fuente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('separación de capas', () => {
  const archivos = archivosDe(DIR_HTTP);

  it('encuentra la capa de transporte', () => {
    expect(archivos.map((a) => a.nombre).sort()).toEqual([
      'circuit-breaker.ts',
      'errors.ts',
      'rate-limiter.ts',
      'retry.ts',
      'session.ts',
    ]);
  });

  it.each(['ViewState', 'partial-response', 'mojarra', 'primefaces', 'oefa', 'jurisprudencia', 'jsessionid'])(
    'src/http/ no depende de «%s»',
    (termino) => {
      const culpables = archivos
        .filter((a) => soloCodigo(a.contenido).toLowerCase().includes(termino.toLowerCase()))
        .map((a) => a.nombre);

      expect(culpables).toEqual([]);
    },
  );

  it('src/http/ no importa de capas superiores', () => {
    const culpables = archivos
      .filter((a) => /from '\.\.\/(sources|jsf|store|validate|cli)\//.test(a.contenido))
      .map((a) => a.nombre);

    expect(culpables).toEqual([]);
  });

  it('src/http/ no parsea HTML: eso es de la capa de arriba', () => {
    const culpables = archivos.filter((a) => a.contenido.includes('cheerio')).map((a) => a.nombre);
    expect(culpables).toEqual([]);
  });
});
