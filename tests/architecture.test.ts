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
const DIR_SOURCES = join(import.meta.dirname, '..', 'src', 'sources');
const DIR_STORE = join(import.meta.dirname, '..', 'src', 'store');
const DIR_VALIDATE = join(import.meta.dirname, '..', 'src', 'validate');

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

/**
 * La otra mitad de la afirmación de §4: «la capa `sources/` no sabe nada de
 * reintentos ni de cookies».
 *
 * Se sostiene con una regla concreta y no con buena voluntad: el adapter recibe
 * la `JsfView` ya construida. No puede armarse una sesión propia, y por lo tanto
 * no puede saltarse el rate limiter ni el circuit breaker aunque alguien tenga
 * apuro. Quien cablea es `cli/`, que es el único lugar donde eso corresponde.
 */
describe('la capa de dominio no conoce el transporte', () => {
  const archivos = archivosDe(DIR_SOURCES);

  it('encuentra la capa de fuentes', () => {
    expect(archivos.map((a) => a.nombre).sort()).toEqual([
      'errors.ts',
      'oefa-rows.ts',
      'oefa.ts',
      'types.ts',
    ]);
  });

  it.each(['axios', 'CookieJar', 'RateLimiter', 'CircuitBreaker', 'withRetry', 'Retry-After'])(
    'src/sources/ no depende de «%s»',
    (termino) => {
      const culpables = archivos
        .filter((a) => soloCodigo(a.contenido).toLowerCase().includes(termino.toLowerCase()))
        .map((a) => a.nombre);

      expect(culpables).toEqual([]);
    },
  );

  it('src/sources/ no importa de src/http/ ni siquiera como tipo', () => {
    const culpables = archivos
      .filter((a) => /from '\.\.\/http\//.test(a.contenido))
      .map((a) => a.nombre);

    expect(culpables).toEqual([]);
  });

  it('src/sources/ no importa de capas superiores', () => {
    const culpables = archivos
      .filter((a) => /from '\.\.\/(store|validate|cli)\//.test(a.contenido))
      .map((a) => a.nombre);

    expect(culpables).toEqual([]);
  });
});

/**
 * `store/` es la capa más fácil de contaminar: cuando haga falta deduplicar por
 * un campo nuevo, la tentación va a ser leerlo acá. Por eso `readKeys` recibe un
 * extractor en vez de conocer `uuid`, y por eso este test existe.
 */
describe('la capa de persistencia no conoce el dominio', () => {
  const archivos = archivosDe(DIR_STORE);

  it('encuentra la capa de persistencia', () => {
    expect(archivos.map((a) => a.nombre).sort()).toEqual([
      'atomico.ts',
      'checkpoint.ts',
      'dlq.ts',
      'files.ts',
      'jsonl.ts',
    ]);
  });

  it.each([
    'oefa',
    'jurisprudencia',
    'expediente',
    'administrado',
    'ViewState',
    'cheerio',
    'uuid',
    // El bloque 5 agregó la escritura de archivos: que `files.ts` valide un
    // `%PDF-` sería el atajo obvio y la primera grieta. El magic lo pasa el
    // llamador, y el día que haya que bajar un XLSX esta capa no se toca.
    'pdf',
  ])(
    'src/store/ no depende de «%s»',
    (termino) => {
      const culpables = archivos
        .filter((a) => soloCodigo(a.contenido).toLowerCase().includes(termino.toLowerCase()))
        .map((a) => a.nombre);

      expect(culpables).toEqual([]);
    },
  );

  it('src/store/ no importa de ninguna otra capa del proyecto', () => {
    const culpables = archivos
      .filter((a) => /from '\.\.?\/(http|jsf|sources|validate|cli|obs)\//.test(a.contenido))
      .map((a) => a.nombre);

    expect(culpables).toEqual([]);
  });
});

/**
 * `validate/` es la capa del bloque 6, y la regla que la ordena es una sola:
 * **no hace I/O**. Recibe datos ya leídos y devuelve hallazgos.
 *
 * No es preferencia estética. Un validador que abre archivos por su cuenta se
 * prueba montando archivos, y probar los tres desenlaces del disco —está, no
 * está, no se pudo mirar— exige entonces un directorio temporal por caso. Con la
 * sonda inyectada, cada uno es una línea. La contrapartida es que el cableado
 * vive en `cli/validate.ts`, que es donde ya vive el de `scrape` y `download`.
 *
 * Y el corolario que importa para el próximo portal: `sanity.ts`, `informe.ts` y
 * `documentos.ts` no saben qué es un expediente. El esquema del registro llega
 * inyectado como función, igual que `store/jsonl.ts` recibe un extractor de
 * clave en vez de conocer `uuid`. Lo específico de OEFA vive en un solo archivo.
 */
describe('la capa de validación no hace I/O', () => {
  const archivos = archivosDe(DIR_VALIDATE);

  it('encuentra la capa de validación', () => {
    expect(archivos.map((a) => a.nombre).sort()).toEqual([
      'documentos.ts',
      'informe.ts',
      'oefa.ts',
      'sanity.ts',
    ]);
  });

  it.each(['node:fs', 'node:path', 'readFileSync', 'axios', 'fetch('])(
    'src/validate/ no depende de «%s»',
    (termino) => {
      const culpables = archivos
        .filter((a) => soloCodigo(a.contenido).includes(termino))
        .map((a) => a.nombre);

      expect(culpables).toEqual([]);
    },
  );

  it('src/validate/ no importa de ninguna otra capa salvo tipos de sources/', () => {
    const culpables: string[] = [];

    for (const { nombre, contenido } of archivos) {
      for (const m of contenido.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+'([^']+)';/gm)) {
        const [, esTipo, origen] = m;
        if (origen === undefined || origen.startsWith('./')) continue;
        if (origen.startsWith('../sources/') && esTipo !== undefined) continue;
        culpables.push(`${nombre} → ${origen}`);
      }
    }

    expect(culpables).toEqual([]);
  });

  /** El dominio, acorralado en un archivo: el resto sirve para el próximo portal. */
  it.each(['expediente', 'administrado', 'resoluci', 'confidencial', 'oefa'])(
    'los chequeos genéricos no mencionan «%s»',
    (termino) => {
      const culpables = archivos
        .filter((a) => a.nombre !== 'oefa.ts')
        .filter((a) => soloCodigo(a.contenido).toLowerCase().includes(termino.toLowerCase()))
        .map((a) => a.nombre);

      expect(culpables).toEqual([]);
    },
  );
});
