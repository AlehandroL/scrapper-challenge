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
const DIR_JSF = join(import.meta.dirname, '..', 'src', 'jsf');

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

/**
 * Lo mismo, un piso más arriba. La capa `jsf/` es protocolo puro: habla de
 * ViewState, de Mojarra y de PrimeFaces —para eso existe— pero no puede saber
 * qué es un expediente ni una resolución. Que sea reutilizable en el próximo
 * portal legacy es la afirmación de §4, y acá deja de ser una promesa.
 */
describe('la capa de protocolo no conoce el dominio', () => {
  const archivos = archivosDe(DIR_JSF);

  it('encuentra la capa JSF', () => {
    expect(archivos.map((a) => a.nombre).sort()).toEqual([
      'commands.ts',
      'datatable.ts',
      'errors.ts',
      'form.ts',
      'partial-response.ts',
      'view-state.ts',
      'view.ts',
    ]);
  });

  it.each([
    'oefa',
    'jurisprudencia',
    'expediente',
    'administrado',
    'resoluci',
    'listarDetalleInfraccion',
    'txtNroexp',
    'idsector',
    'pgLista',
    'btnBuscar',
    'param_uuid',
  ])('src/jsf/ no depende de «%s»', (termino) => {
    const culpables = archivos
      .filter((a) => soloCodigo(a.contenido).toLowerCase().includes(termino.toLowerCase()))
      .map((a) => a.nombre);

    expect(culpables).toEqual([]);
  });

  it('src/jsf/ no importa de capas superiores', () => {
    const culpables = archivos
      .filter((a) => /from '\.\.\/(sources|store|validate|cli)\//.test(a.contenido))
      .map((a) => a.nombre);

    expect(culpables).toEqual([]);
  });

  /**
   * `cheerio` es la única dependencia de runtime que esta capa tiene fuera de sí
   * misma: todo lo demás —`Session`, `Logger`, `Metrics`, axios— entra como
   * `import type` y llega inyectado. Es la inyección de dependencias verificada
   * en vez de prometida, y de paso garantiza que `jsf/` no pueda construirse una
   * sesión por su cuenta y saltarse el rate limiter.
   */
  it('src/jsf/ solo importa cheerio en runtime; el resto son tipos', () => {
    const culpables: string[] = [];

    for (const { nombre, contenido } of archivos) {
      for (const m of contenido.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+'([^']+)';/gm)) {
        const [, esTipo, origen] = m;
        if (origen === undefined || origen.startsWith('./')) continue;
        if (origen === 'cheerio' || esTipo !== undefined) continue;
        culpables.push(`${nombre} → ${origen}`);
      }
    }

    expect(culpables).toEqual([]);
  });
});
