/**
 * Los archivos que se entregan, revisados en cada corrida de la suite.
 *
 * El resto de los tests prueba que el validador funcione; éste prueba que el
 * **producto** se sostenga. Es la diferencia entre tener sanity checks y
 * haberlos corrido: `data/oefa.jsonl` y `data/oefa.descargas.jsonl` están
 * commiteados y son la evidencia de la corrida real, así que si alguna vez se
 * regeneran degradados, la suite avisa en el mismo commit y no tres semanas
 * después.
 *
 * Los números están escritos a mano a propósito. Si el organismo publica algo
 * nuevo y el dataset se regenera, este test falla y obliga a actualizarlo junto
 * con el README —que declara los mismos conteos— en vez de dejar que los dos
 * documentos se separen en silencio.
 *
 * No toca la red ni el disco de descargas: los binarios no se versionan, así que
 * los chequeos de integridad de archivos quedan aquí como «no evaluables», que
 * es exactamente lo que corresponde. Con la carpeta al lado se verifican con
 * `npm run validate -- --descargas descargas --hash`.
 */

import { describe, expect, it } from 'vitest';

import { parsearArgs, revisar } from '../src/cli/validate.ts';
import type { Hallazgo } from '../src/validate/informe.ts';

/** El total que el portal declaraba en la corrida: 176 páginas de 10, menos 7. */
const TOTAL_DEL_SITIO = 1753;

/** Cuatro filas que el portal publica repetidas byte por byte se deduplican. */
const REGISTROS = 1749;

const informe = async (): Promise<Hallazgo[]> => {
  const { secciones } = await revisar(parsearArgs(['--total', String(TOTAL_DEL_SITIO)]));
  return secciones.flatMap((s) => [...s.hallazgos]);
};

const buscar = (hallazgos: readonly Hallazgo[], chequeo: string): Hallazgo => {
  const h = hallazgos.find((x) => x.chequeo === chequeo);
  if (h === undefined) throw new Error(`no se emitió el chequeo «${chequeo}»`);
  return h;
};

describe('los archivos entregados', () => {
  it('no tienen ningún error', async () => {
    const errores = (await informe()).filter((h) => h.nivel === 'error');
    expect(errores.map((h) => `${h.chequeo}: ${h.mensaje}`)).toEqual([]);
  });

  it(`cubren las ${TOTAL_DEL_SITIO} filas del sitio con ${REGISTROS} registros`, async () => {
    const hallazgos = await informe();

    expect(buscar(hallazgos, 'dataset-vacio').mensaje).toContain('1.749 registro(s)');
    expect(buscar(hallazgos, 'cobertura').nivel).toBe('ok');
    expect(buscar(hallazgos, 'indices-ausentes').mensaje).toContain(
      `${TOTAL_DEL_SITIO - REGISTROS} posición(es)`,
    );
  });

  /**
   * Los dos avisos son conocidos y están explicados en el README: las filas
   * repetidas que el portal publica, y el documento que dos registros comparten
   * teniendo expedientes distintos. Que la lista sea exacta es lo que hace que un
   * aviso nuevo se note.
   */
  it('tienen exactamente los dos avisos conocidos', async () => {
    const avisos = (await informe()).filter((h) => h.nivel === 'aviso');

    expect(avisos.map((h) => h.chequeo)).toEqual([
      'indices-ausentes',
      'documento-compartido-heterogeneo',
    ]);
  });

  it('el manifiesto se une al dataset por id, sin huérfanos', async () => {
    const hallazgos = await informe();

    expect(buscar(hallazgos, 'manifiesto-huerfano').nivel).toBe('ok');
    expect(buscar(hallazgos, 'manifiesto-uuid').nivel).toBe('ok');
    expect(buscar(hallazgos, 'cobertura-descargas').mensaje).toContain('30 de 1.618');
  });

  /** Sin la carpeta al lado, la integridad de los archivos no se afirma. */
  it('no da por buena la integridad de unos archivos que no versiona', async () => {
    const hallazgos = await informe();

    for (const chequeo of ['archivo-ausente', 'tamano-distinto', 'hash-distinto']) {
      expect(buscar(hallazgos, chequeo).nivel).toBe('no-evaluable');
    }
  });
});
