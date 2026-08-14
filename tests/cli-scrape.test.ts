/**
 * El parseo de argumentos del CLI.
 *
 * Solo `parsearArgs`: `main()` cablea una sesión HTTP contra el sitio real, y
 * probarlo acá exigiría un doble de todo el stack para verificar cableado que
 * los otros tests ya cubren pieza por pieza. Lo que sí importa probar es que un
 * argumento mal escrito **falle** en vez de degradar en silencio a un default —
 * un `--hastaa 3` ignorado descarga el dataset entero sin que nadie lo pida.
 */

import { describe, expect, it } from 'vitest';

import { SALIDA, parsearArgs } from '../src/cli/scrape.ts';

describe('parsearArgs', () => {
  it('sin argumentos usa los valores por defecto', () => {
    expect(parsearArgs([])).toEqual({
      salida: 'data/oefa.jsonl',
      checkpoint: 'data/oefa.scrape.checkpoint.json',
      maxRecuperaciones: 3,
      reiniciar: false,
      dryRun: false,
      ayuda: false,
    });
  });

  /**
   * `exactOptionalPropertyTypes`: la ausencia es ausencia, no `undefined`.
   *
   * En `--desde` la distinción además decide comportamiento: ausente significa
   * «desde donde diga el checkpoint», y un `1` por defecto habría hecho que la
   * reanudación por página no se activara nunca.
   */
  it.each(['desde', 'hasta'])('sin --%s la clave no existe en vez de valer undefined', (flag) => {
    expect(flag in parsearArgs([])).toBe(false);
    expect(flag in parsearArgs([`--${flag}`, '4'])).toBe(true);
  });

  it('lee el rango, la salida y el presupuesto', () => {
    expect(
      parsearArgs([
        '--desde', '3',
        '--hasta', '9',
        '--salida', '/tmp/x.jsonl',
        '--checkpoint', '/tmp/x.json',
        '--max-recuperaciones', '1',
      ]),
    ).toEqual({
      desde: 3,
      hasta: 9,
      salida: '/tmp/x.jsonl',
      checkpoint: '/tmp/x.json',
      maxRecuperaciones: 1,
      reiniciar: false,
      dryRun: false,
      ayuda: false,
    });
  });

  it.each([['--dry-run', 'dryRun'], ['--help', 'ayuda'], ['--reiniciar', 'reiniciar']])(
    '%s activa %s',
    (flag, campo) => {
      expect(parsearArgs([flag])[campo as 'dryRun' | 'ayuda' | 'reiniciar']).toBe(true);
    },
  );

  it('rechaza una flag desconocida en vez de ignorarla', () => {
    expect(() => parsearArgs(['--hastaa', '3'])).toThrow(/Argumentos inválidos/);
  });

  it('rechaza posicionales sueltos', () => {
    expect(() => parsearArgs(['3'])).toThrow(/Argumentos inválidos/);
  });

  it.each([
    ['--desde', '0'],
    ['--desde', 'dos'],
    ['--hasta', '0'],
    ['--hasta=-1'],
    ['--max-recuperaciones', '1.5'],
  ])('rechaza %s %s', (...args) => {
    expect(() => parsearArgs(args)).toThrow(/entero ≥ 1/);
  });

  it('rechaza un rango invertido antes de tocar la red', () => {
    expect(() => parsearArgs(['--desde', '5', '--hasta', '2'])).toThrow(/menor que --desde/);
  });
});

describe('códigos de salida', () => {
  /**
   * Se exportan para que el operador —y el shell— puedan distinguir «el sitio
   * cambió» de «escribí mal el comando». Un CLI que devuelve 1 para todo obliga
   * a leer la salida para saber qué pasó.
   */
  it('distingue uso incorrecto, fallo e interrupción', () => {
    expect(SALIDA).toEqual({ ok: 0, fallo: 1, uso: 2, interrumpida: 130 });
  });
});
