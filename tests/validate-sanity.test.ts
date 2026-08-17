/**
 * Los chequeos estructurales del dataset, cada uno visto fallar.
 *
 * Es el mismo criterio con el que el bloque 4 probó su detección de drift: una
 * aserción que nunca se vio fallar es una aserción que no se sabe si funciona.
 * Un validador es peor que ningún validador cuando dice «✓» por un bug propio,
 * porque además da confianza.
 */

import { describe, expect, it } from 'vitest';

import type { RegistroBase } from '../src/sources/types.ts';
import type { Hallazgo, Nivel } from '../src/validate/informe.ts';
import { RevisionDataset, type TotalDeclarado } from '../src/validate/sanity.ts';

/** Un validador mínimo: acá se prueban los chequeos, no zod. */
const validador = (valor: unknown): RegistroBase | string => {
  if (typeof valor !== 'object' || valor === null) return 'no es un objeto';
  const r = valor as Partial<RegistroBase>;
  if (typeof r.id !== 'string' || typeof r.indice !== 'number') return 'faltan campos';
  return r as RegistroBase;
};

const reg = (indice: number, extra: Partial<RegistroBase> = {}): RegistroBase => ({
  fuente: 'oefa',
  id: `id-${indice}`,
  indice,
  pagina: Math.floor(indice / 10) + 1,
  capturadoEn: '2026-08-15T00:00:00.000Z',
  ...extra,
});

function revisar(valores: readonly unknown[], total?: TotalDeclarado): Hallazgo[] {
  const revision = new RevisionDataset(validador, { pageSize: 10 });
  valores.forEach((valor, i) => revision.agregar(i + 1, valor));
  return revision.hallazgos(total);
}

const nivelDe = (hallazgos: readonly Hallazgo[], chequeo: string): Nivel | undefined =>
  hallazgos.find((h) => h.chequeo === chequeo)?.nivel;

const buscar = (hallazgos: readonly Hallazgo[], chequeo: string): Hallazgo => {
  const h = hallazgos.find((x) => x.chequeo === chequeo);
  if (h === undefined) throw new Error(`no se emitió el chequeo «${chequeo}»`);
  return h;
};

const sano = [reg(0), reg(1), reg(2)];

describe('el caso sano', () => {
  it('no reporta ningún error', () => {
    const hallazgos = revisar(sano, { valor: 3, origen: 'de prueba' });
    expect(hallazgos.filter((h) => h.nivel !== 'ok')).toEqual([]);
  });

  /**
   * El informe tiene forma fija: los mismos nueve chequeos aparecen siempre, en
   * el mismo orden. Un chequeo que solo se emite cuando falla es un chequeo que
   * nadie nota cuando desaparece.
   */
  it('emite los nueve chequeos aunque no haya nada que decir', () => {
    expect(revisar(sano).map((h) => h.chequeo)).toEqual([
      'jsonl-ilegible',
      'dataset-vacio',
      'esquema',
      'id-duplicado',
      'indice-duplicado',
      'pagina-incoherente',
      'fuente-mezclada',
      'indices-ausentes',
      'cobertura',
    ]);
  });
});

describe('integridad de las líneas', () => {
  it('un archivo vacío es un error, no un dataset perfecto', () => {
    const hallazgos = revisar([]);
    expect(nivelDe(hallazgos, 'dataset-vacio')).toBe('error');
  });

  it('cuenta los registros que no validan y cita la línea', () => {
    const hallazgos = revisar([reg(0), { basura: true }, reg(1)]);
    const h = buscar(hallazgos, 'esquema');

    expect(h.nivel).toBe('error');
    expect(h.mensaje).toContain('1 registro(s) no validan');
    expect(h.muestras?.[0]).toContain('línea 2');
  });

  /**
   * `readJsonl` corta en la primera línea rota y el CLI lo trae acá. Una cola
   * truncada por una caída no se repara en silencio: es justamente el hallazgo.
   */
  it('una lectura cortada se reporta como error', () => {
    const revision = new RevisionDataset(validador, { pageSize: 10 });
    revision.agregar(1, reg(0));
    revision.marcarIlegible('Línea 2 de x.jsonl no es JSON válido: {"id":"a"');

    const h = buscar(revision.hallazgos(), 'jsonl-ilegible');
    expect(h.nivel).toBe('error');
    expect(h.mensaje).toContain('Línea 2');
  });
});

describe('identidad y alineación', () => {
  it('detecta una identidad repetida: la idempotencia falló', () => {
    const hallazgos = revisar([reg(0), reg(1), reg(2, { id: 'id-0' })]);
    const h = buscar(hallazgos, 'id-duplicado');

    expect(h.nivel).toBe('error');
    expect(h.muestras).toEqual(['id-0']);
  });

  it('detecta dos filas distintas peleando por la misma posición', () => {
    const hallazgos = revisar([reg(0), reg(1), reg(1, { id: 'otro' })]);
    expect(nivelDe(hallazgos, 'indice-duplicado')).toBe('error');
  });

  /**
   * El rastro post-hoc de un `ViewState` desalineado: las filas llegaron con su
   * `data-ri` pero anotadas con un número de página que no les toca.
   */
  it('detecta la página que no se corresponde con la posición', () => {
    const hallazgos = revisar([reg(0), reg(11, { pagina: 1 })]);
    const h = buscar(hallazgos, 'pagina-incoherente');

    expect(h.nivel).toBe('error');
    expect(h.muestras?.[0]).toContain('corresponde 2');
  });

  it('respeta el pageSize configurado', () => {
    const revision = new RevisionDataset(validador, { pageSize: 25 });
    revision.agregar(1, reg(24, { pagina: 1 }));
    expect(nivelDe(revision.hallazgos(), 'pagina-incoherente')).toBe('ok');
  });

  it('detecta un archivo que mezcla fuentes', () => {
    const hallazgos = revisar([reg(0), reg(1, { fuente: 'pj' })]);
    expect(nivelDe(hallazgos, 'fuente-mezclada')).toBe('error');
  });

  it('expone las identidades para cruzarlas contra el manifiesto', () => {
    const revision = new RevisionDataset(validador, { pageSize: 10 });
    revision.agregar(1, reg(0));
    revision.agregar(2, { basura: true });

    expect([...revision.identidades]).toEqual(['id-0']);
    expect(revision.validos).toBe(1);
  });
});

describe('huecos y cobertura', () => {
  /**
   * Un hueco no es necesariamente un defecto: el portal publica filas repetidas
   * byte por byte y la persistencia las deduplica, así que su posición queda
   * vacía. Avisa y no rompe, pero se cuenta: es lo que cierra la resta contra el
   * total.
   */
  it('avisa de las posiciones sin registro sin tumbar la corrida', () => {
    const hallazgos = revisar([reg(0), reg(2)]);
    const h = buscar(hallazgos, 'indices-ausentes');

    expect(h.nivel).toBe('aviso');
    expect(h.muestras).toEqual(['1']);
  });

  it('sin huecos lo dice y no inventa un aviso', () => {
    expect(nivelDe(revisar(sano), 'indices-ausentes')).toBe('ok');
  });

  it('presentes más deduplicadas tiene que dar el total declarado', () => {
    const h = buscar(
      revisar([reg(0), reg(2)], { valor: 3, origen: 'del checkpoint' }),
      'cobertura',
    );

    expect(h.nivel).toBe('ok');
    expect(h.mensaje).toContain('del checkpoint');
  });

  /**
   * El caso que justifica el chequeo: la corrida se cortó en la última página.
   * El archivo es internamente perfecto y le faltan filas igual.
   */
  it('detecta la corrida que no llegó al final', () => {
    const h = buscar(revisar([reg(0), reg(1)], { valor: 10, origen: 'de --total' }), 'cobertura');

    expect(h.nivel).toBe('error');
    expect(h.mensaje).toContain('faltan 8 al final');
  });

  /**
   * Sin total externo el archivo solo prueba una cota inferior. Reportarlo como
   * «✓» sería el modo de falla que este validador existe para no tener.
   */
  it('sin total declarado no pasa: queda sin evaluar', () => {
    const h = buscar(revisar(sano), 'cobertura');

    expect(h.nivel).toBe('no-evaluable');
    expect(h.mensaje).toContain('cota inferior de 3');
  });
});

/**
 * La regresión de un bug propio: acumular las muestras y reportar
 * `muestras.length` informa «5 duplicados» cuando hay ocho, y el número es justo
 * el dato con el que se decide si esto se arregla ahora o después.
 */
describe('el conteo no se topea con las muestras', () => {
  it('cuenta ocho y muestra cinco', () => {
    const repetidos = Array.from({ length: 9 }, (_, i) => reg(i, { id: 'mismo' }));
    const h = buscar(revisar(repetidos), 'id-duplicado');

    expect(h.mensaje).toContain('8 línea(s)');
    expect(h.muestras).toHaveLength(5);
  });
});
