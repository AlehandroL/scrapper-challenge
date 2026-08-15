/**
 * El manifiesto contra el dataset y contra el disco.
 *
 * La regla que ordena estos tests viene de §5.9: **«está en el manifiesto» no
 * alcanza para dar un documento por bajado**. Los tres desenlaces del disco
 * —está, no está, y no se pudo mirar— tienen que distinguirse, porque el tercero
 * reportado como éxito es la clase de informe que da confianza sin haber mirado
 * nada.
 *
 * El acceso al disco llega inyectado, así que acá no se crea un solo archivo: la
 * sonda es una función y los casos se arman en una línea.
 */

import { describe, expect, it } from 'vitest';

import { revisarDocumentos, type EntradaDocumento, type Sonda } from '../src/validate/documentos.ts';
import type { Hallazgo, Nivel } from '../src/validate/informe.ts';

const entrada = (id: string, extra: Partial<EntradaDocumento> = {}): EntradaDocumento => ({
  id,
  documentoUuid: `uuid-${id}`,
  archivo: `uuid-${id}_resolucion.pdf`,
  bytes: 9_377_728,
  sha256: `sha-${id}`,
  ...extra,
});

const dataset = (...ids: readonly string[]): ReadonlyMap<string, { readonly documentoUuid?: string }> =>
  new Map(ids.map((id) => [id, { documentoUuid: `uuid-${id}` }]));

/** Una sonda que responde desde un objeto: el disco, sin disco. */
const sondaDe = (archivos: Readonly<Record<string, { bytes: number; sha256?: string }>>): Sonda =>
  (archivo) => Promise.resolve(archivos[archivo]);

const nivelDe = (hallazgos: readonly Hallazgo[], chequeo: string): Nivel | undefined =>
  hallazgos.find((h) => h.chequeo === chequeo)?.nivel;

const buscar = (hallazgos: readonly Hallazgo[], chequeo: string): Hallazgo => {
  const h = hallazgos.find((x) => x.chequeo === chequeo);
  if (h === undefined) throw new Error(`no se emitió el chequeo «${chequeo}»`);
  return h;
};

const enDisco = {
  'uuid-a_resolucion.pdf': { bytes: 9_377_728, sha256: 'sha-a' },
  'uuid-b_resolucion.pdf': { bytes: 9_377_728, sha256: 'sha-b' },
};

describe('el caso sano', () => {
  it('no reporta nada con el manifiesto, el dataset y el disco de acuerdo', async () => {
    const hallazgos = await revisarDocumentos([entrada('a'), entrada('b')], {
      registros: dataset('a', 'b'),
      conDocumento: 2,
      sonda: sondaDe(enDisco),
      pendientes: 0,
    });

    expect(hallazgos.filter((h) => h.nivel !== 'ok')).toEqual([]);
  });

  it('emite los once chequeos siempre, en el mismo orden', async () => {
    const hallazgos = await revisarDocumentos([entrada('a')], {
      registros: dataset('a'),
      conDocumento: 1,
    });

    expect(hallazgos.map((h) => h.chequeo)).toEqual([
      'manifiesto-invalido',
      'manifiesto-vacio',
      'manifiesto-duplicado',
      'manifiesto-huerfano',
      'manifiesto-uuid',
      'archivo-compartido',
      'cobertura-descargas',
      'archivo-ausente',
      'tamano-distinto',
      'hash-distinto',
      'dlq-pendientes',
    ]);
  });
});

describe('el manifiesto contra el dataset', () => {
  it('detecta una entrada cuyo registro no está en el dataset', async () => {
    const hallazgos = await revisarDocumentos([entrada('a'), entrada('z')], {
      registros: dataset('a'),
      conDocumento: 1,
    });

    expect(nivelDe(hallazgos, 'manifiesto-huerfano')).toBe('error');
    expect(buscar(hallazgos, 'manifiesto-huerfano').muestras).toEqual(['z']);
  });

  it('detecta un documento que no es el que el registro declara', async () => {
    const hallazgos = await revisarDocumentos([entrada('a', { documentoUuid: 'otro' })], {
      registros: dataset('a'),
      conDocumento: 1,
    });

    const h = buscar(hallazgos, 'manifiesto-uuid');
    expect(h.nivel).toBe('error');
    expect(h.muestras?.[0]).toContain('manifiesto otro');
  });

  it('detecta una identidad anotada dos veces', async () => {
    const hallazgos = await revisarDocumentos([entrada('a'), entrada('a')], {
      registros: dataset('a'),
      conDocumento: 1,
    });

    expect(nivelDe(hallazgos, 'manifiesto-duplicado')).toBe('error');
  });

  it('cuenta las líneas que no tenían la forma esperada', async () => {
    const hallazgos = await revisarDocumentos([entrada('a')], {
      registros: dataset('a'),
      conDocumento: 1,
      invalidas: 2,
    });

    expect(nivelDe(hallazgos, 'manifiesto-invalido')).toBe('error');
  });

  /**
   * Dos registros que comparten un PDF son dos entradas y un archivo. Que el
   * conteo lo diga evita que alguien lea «30 entradas, 29 archivos» como pérdida.
   */
  it('reconoce el archivo que dos entradas comparten', async () => {
    const hallazgos = await revisarDocumentos(
      [entrada('a'), entrada('b', { archivo: 'uuid-a_resolucion.pdf' })],
      { registros: dataset('a', 'b'), conDocumento: 2 },
    );

    const h = buscar(hallazgos, 'archivo-compartido');
    expect(h.nivel).toBe('ok');
    expect(h.mensaje).toContain('1 archivo(s) para 2 entrada(s)');
  });

  it('reporta la cobertura sin exigir que esté todo bajado', async () => {
    const hallazgos = await revisarDocumentos([entrada('a')], {
      registros: dataset('a'),
      conDocumento: 1_618,
    });

    const h = buscar(hallazgos, 'cobertura-descargas');
    expect(h.nivel).toBe('ok');
    expect(h.mensaje).toContain('1 de 1.618');
  });
});

describe('el manifiesto contra el disco', () => {
  it('detecta el archivo que el manifiesto declara y el disco no tiene', async () => {
    const hallazgos = await revisarDocumentos([entrada('a'), entrada('b')], {
      registros: dataset('a', 'b'),
      conDocumento: 2,
      sonda: sondaDe({ 'uuid-a_resolucion.pdf': { bytes: 9_377_728, sha256: 'sha-a' } }),
    });

    const h = buscar(hallazgos, 'archivo-ausente');
    expect(h.nivel).toBe('error');
    expect(h.muestras).toEqual(['uuid-b_resolucion.pdf']);
  });

  it('detecta el archivo que quedó de otro tamaño', async () => {
    const hallazgos = await revisarDocumentos([entrada('a')], {
      registros: dataset('a'),
      conDocumento: 1,
      sonda: sondaDe({ 'uuid-a_resolucion.pdf': { bytes: 512, sha256: 'sha-a' } }),
    });

    const h = buscar(hallazgos, 'tamano-distinto');
    expect(h.nivel).toBe('error');
    expect(h.mensaje).toContain('1 archivo(s)');
    expect(h.muestras?.[0]).toContain('disco 512 B');
  });

  /**
   * El caso que el tamaño no ve: mismo peso, otro contenido. Es la única forma
   * de detectar un archivo que se corrompió sin cambiar de largo.
   */
  it('detecta el archivo cuyo contenido cambió sin cambiar de tamaño', async () => {
    const hallazgos = await revisarDocumentos([entrada('a')], {
      registros: dataset('a'),
      conDocumento: 1,
      sonda: sondaDe({ 'uuid-a_resolucion.pdf': { bytes: 9_377_728, sha256: 'otro' } }),
    });

    expect(nivelDe(hallazgos, 'hash-distinto')).toBe('error');
  });

  it('sin carpeta, los tres chequeos quedan sin evaluar y ninguno pasa', async () => {
    const hallazgos = await revisarDocumentos([entrada('a')], {
      registros: dataset('a'),
      conDocumento: 1,
    });

    for (const chequeo of ['archivo-ausente', 'tamano-distinto', 'hash-distinto']) {
      expect(nivelDe(hallazgos, chequeo)).toBe('no-evaluable');
    }
  });

  /**
   * La sonda barata solo hace `stat`. Que el hash quede «no evaluable» y no «ok»
   * es la diferencia entre saber que los archivos están íntegros y saber que
   * pesan lo que decían.
   */
  it('sin --hash, la integridad por contenido queda sin evaluar', async () => {
    const hallazgos = await revisarDocumentos([entrada('a')], {
      registros: dataset('a'),
      conDocumento: 1,
      sonda: sondaDe({ 'uuid-a_resolucion.pdf': { bytes: 9_377_728 } }),
    });

    expect(nivelDe(hallazgos, 'tamano-distinto')).toBe('ok');
    expect(nivelDe(hallazgos, 'hash-distinto')).toBe('no-evaluable');
  });
});

describe('el manifiesto vacío y la cola', () => {
  it('avisa en vez de dar por buenos chequeos que no corrieron', async () => {
    const hallazgos = await revisarDocumentos([], {
      registros: dataset('a'),
      conDocumento: 1,
      pendientes: 0,
    });

    expect(nivelDe(hallazgos, 'manifiesto-vacio')).toBe('aviso');
    expect(hallazgos.filter((h) => h.nivel === 'ok').map((h) => h.chequeo)).toEqual([
      'manifiesto-invalido',
      'cobertura-descargas',
      'dlq-pendientes',
    ]);
  });

  it('avisa de los documentos que quedaron pendientes', async () => {
    const hallazgos = await revisarDocumentos([entrada('a')], {
      registros: dataset('a'),
      conDocumento: 1,
      pendientes: 3,
    });

    const h = buscar(hallazgos, 'dlq-pendientes');
    expect(h.nivel).toBe('aviso');
    expect(h.mensaje).toContain('retry-failed');
  });

  it('una cola ilegible no es una cola vacía', async () => {
    const hallazgos = await revisarDocumentos([entrada('a')], {
      registros: dataset('a'),
      conDocumento: 1,
    });

    expect(nivelDe(hallazgos, 'dlq-pendientes')).toBe('no-evaluable');
  });
});
