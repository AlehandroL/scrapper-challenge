/**
 * Los chequeos que dependen de saber qué publica OEFA.
 *
 * El que más importa es el del año, porque no es hipotético: en su primera
 * corrida sobre el dataset completo encontró 29 resoluciones con documento
 * publicado que se quedaban sin año, y de ahí salió el arreglo de
 * `anioDeResolucion`. Los casos de abajo son los formatos reales que lo
 * rompieron, no ejemplos inventados.
 */

import { describe, expect, it } from 'vitest';

import type { RegistroOefa } from '../src/sources/oefa-rows.ts';
import type { Hallazgo, Nivel } from '../src/validate/informe.ts';
import { RevisionOefa } from '../src/validate/oefa.ts';

/** `null` significa «el campo no está», que es distinto de «está vacío». */
type Ajuste = Partial<Omit<RegistroOefa, 'documentoUuid' | 'anioResolucion'>> & {
  documentoUuid?: string | null;
  anioResolucion?: number | null;
};

function reg(i: number, ajuste: Ajuste = {}): RegistroOefa {
  const { documentoUuid = `uuid-${i}`, anioResolucion = 2016, ...resto } = ajuste;

  return {
    fuente: 'oefa',
    id: `id-${i}`,
    indice: i,
    pagina: Math.floor(i / 10) + 1,
    capturadoEn: '2026-08-15T00:00:00.000Z',
    expediente: `exp-${i}`,
    administrados: ['Minera S.A.'],
    unidadFiscalizable: `unidad-${i}`,
    sector: 'Minería',
    resolucion: `00${i}-2016-OEFA/TFA`,
    ...resto,
    ...(documentoUuid === null ? {} : { documentoUuid }),
    ...(anioResolucion === null ? {} : { anioResolucion }),
  };
}

function revisar(registros: readonly RegistroOefa[]): Hallazgo[] {
  const revision = new RevisionOefa();
  for (const r of registros) revision.agregar(r);
  return revision.hallazgos();
}

const nivelDe = (hallazgos: readonly Hallazgo[], chequeo: string): Nivel | undefined =>
  hallazgos.find((h) => h.chequeo === chequeo)?.nivel;

const buscar = (hallazgos: readonly Hallazgo[], chequeo: string): Hallazgo => {
  const h = hallazgos.find((x) => x.chequeo === chequeo);
  if (h === undefined) throw new Error(`no se emitió el chequeo «${chequeo}»`);
  return h;
};

describe('el caso sano', () => {
  it('no reporta nada fuera de lo normal', () => {
    expect(revisar([reg(0), reg(1)]).filter((h) => h.nivel !== 'ok')).toEqual([]);
  });

  it('emite los cinco chequeos siempre', () => {
    expect(revisar([reg(0)]).map((h) => h.chequeo)).toEqual([
      'campos-vacios',
      'anio-sin-parsear',
      'sin-documento',
      'documento-compartido',
      'documento-compartido-heterogeneo',
    ]);
  });
});

/**
 * `z.string()` acepta la cadena vacía, así que la validación por registro del
 * bloque 4 deja pasar una celda que el parser leyó en blanco. Es exactamente el
 * «campos obligatorios no nulos» de §6.3, y hace falta acá porque el esquema no
 * lo cubre.
 */
describe('campos obligatorios', () => {
  it('detecta un campo de texto en blanco y dice cuál', () => {
    const h = buscar(revisar([reg(0), reg(1, { expediente: '   ' })]), 'campos-vacios');

    expect(h.nivel).toBe('error');
    expect(h.mensaje).toContain('expediente=1');
    expect(h.muestras).toEqual(['id-1:expediente']);
  });

  it('detecta una fila sin administrados', () => {
    expect(nivelDe(revisar([reg(0, { administrados: [] })]), 'campos-vacios')).toBe('error');
  });
});

describe('el año de la resolución', () => {
  it('es un error cuando la fila tiene documento publicado', () => {
    const h = buscar(
      revisar([reg(0), reg(1, { resolucion: '019-2014/TFA-SEP1', anioResolucion: null })]),
      'anio-sin-parsear',
    );

    expect(h.nivel).toBe('error');
    expect(h.muestras).toEqual(['019-2014/TFA-SEP1']);
  });

  /**
   * Las 131 filas que el portal marca «Información confidencial» no tienen ni
   * número de resolución ni PDF. Contarlas como defecto del parser haría que el
   * chequeo avise siempre, y un chequeo que avisa siempre no lo mira nadie.
   */
  it('no lo es cuando la fila no tiene documento', () => {
    const h = buscar(
      revisar([
        reg(0),
        reg(1, { resolucion: 'Información confidencial', documentoUuid: null, anioResolucion: null }),
      ]),
      'anio-sin-parsear',
    );

    expect(h.nivel).toBe('ok');
    expect(h.mensaje).toContain('1 sin documento');
  });
});

describe('documentos compartidos', () => {
  /**
   * §5.8: una resolución que alcanza a dos unidades fiscalizables es dos
   * registros y un solo PDF. Es un dato del sitio, no un defecto.
   */
  it('cuenta los que dos registros comparten sin marcarlo como problema', () => {
    const h = buscar(
      revisar([reg(0), reg(1, { documentoUuid: 'uuid-0', expediente: 'exp-0', resolucion: '000-2016-OEFA/TFA' })]),
      'documento-compartido',
    );

    expect(h.nivel).toBe('ok');
    expect(h.mensaje).toContain('1 documento(s)');
  });

  /**
   * El caso que el dataset real trajo y que §5.8 no describía: mismo documento,
   * expedientes distintos, seiscientas filas de distancia. La invariante que se
   * puede afirmar es la resolución, no el expediente.
   */
  it('avisa cuando además cambia el expediente', () => {
    const h = buscar(
      revisar([reg(0), reg(1, { documentoUuid: 'uuid-0' })]),
      'documento-compartido-heterogeneo',
    );

    expect(h.nivel).toBe('aviso');
    expect(h.muestras?.[0]).toContain('uuid-0');
    expect(h.muestras?.[0]).toContain('índices 0, 1');
  });
});

describe('lo que expone para los chequeos del manifiesto', () => {
  it('indexa por identidad y cuenta los que tienen documento', () => {
    const revision = new RevisionOefa();
    revision.agregar(reg(0));
    revision.agregar(reg(1, { documentoUuid: null }));

    expect([...revision.porId.keys()]).toEqual(['id-0', 'id-1']);
    expect(revision.conDocumento).toBe(1);
  });
});
