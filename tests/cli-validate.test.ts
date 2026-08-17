/**
 * El parseo de argumentos y el informe sobre un dataset armado a mano.
 *
 * `revisar()` se exporta aparte de `main()` justamente para esto: recibe rutas y
 * devuelve secciones, sin imprimir ni decidir códigos de salida. Lo que se
 * prueba acá es el cableado —que el manifiesto se cruce contra el dataset, que
 * la carpeta ausente deje los chequeos de disco sin evaluar, que una cola
 * truncada llegue al informe— sobre archivos temporales de tres líneas.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SALIDA, parsearArgs, revisar } from '../src/cli/validate.ts';
import type { Hallazgo, Nivel } from '../src/validate/informe.ts';

describe('parsearArgs', () => {
  it('sin argumentos usa los valores por defecto', () => {
    expect(parsearArgs([])).toEqual({
      fuente: 'oefa',
      dataset: 'data/oefa.jsonl',
      manifiesto: 'data/oefa.descargas.jsonl',
      dlq: 'data/oefa.failed.jsonl',
      descargas: 'data/oefa',
      checkpoint: 'data/oefa.scrape.checkpoint.json',
      pageSize: 10,
      hash: false,
      contraElSitio: false,
      ayuda: false,
    });
  });

  /** `exactOptionalPropertyTypes`: la ausencia es ausencia, no `undefined`. */
  it('sin --total la clave no existe en vez de valer undefined', () => {
    expect('total' in parsearArgs([])).toBe(false);
    expect(parsearArgs(['--total', '1753']).total).toBe(1753);
  });

  it('lee las rutas y las banderas', () => {
    expect(parsearArgs(['--dataset', '/tmp/d.jsonl', '--hash', '--contra-el-sitio'])).toMatchObject({
      dataset: '/tmp/d.jsonl',
      hash: true,
      contraElSitio: true,
    });
  });

  /** Una flag mal escrita tiene que fallar, no degradar en silencio a un default. */
  it.each([['--datasett', 'x'], ['--total', '0'], ['--page-size', 'diez']])(
    'rechaza «%s %s»',
    (...args) => {
      expect(() => parsearArgs(args)).toThrow(/Argumentos inválidos/);
    },
  );

  it('reserva un código de salida para «corrió y encontró errores»', () => {
    expect(SALIDA).toEqual({ ok: 0, fallo: 1, uso: 2, conHallazgos: 3 });
  });
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'validate-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const registro = (i: number, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    fuente: 'oefa',
    id: `id-${i}`,
    indice: i,
    pagina: 1,
    capturadoEn: '2026-08-15T00:00:00.000Z',
    documentoUuid: `uuid-${i}`,
    expediente: `exp-${i}`,
    administrados: ['Minera S.A.'],
    unidadFiscalizable: `unidad-${i}`,
    sector: 'Minería',
    resolucion: `00${i}-2016-OEFA/TFA`,
    anioResolucion: 2016,
    ...extra,
  });

function escribir(nombre: string, lineas: readonly string[]): string {
  const ruta = join(dir, nombre);
  writeFileSync(ruta, lineas.length === 0 ? '' : `${lineas.join('\n')}\n`);
  return ruta;
}

const opciones = (extra: Partial<ReturnType<typeof parsearArgs>> = {}): ReturnType<typeof parsearArgs> => ({
  ...parsearArgs([]),
  dataset: join(dir, 'oefa.jsonl'),
  manifiesto: join(dir, 'descargas.jsonl'),
  dlq: join(dir, 'failed.jsonl'),
  descargas: join(dir, 'descargas'),
  checkpoint: join(dir, 'checkpoint.json'),
  ...extra,
});

const todos = (secciones: readonly { hallazgos: readonly Hallazgo[] }[]): Hallazgo[] =>
  secciones.flatMap((s) => [...s.hallazgos]);

const nivelDe = (hallazgos: readonly Hallazgo[], chequeo: string): Nivel | undefined =>
  hallazgos.find((h) => h.chequeo === chequeo)?.nivel;

describe('revisar', () => {
  it('cruza el manifiesto contra el dataset', async () => {
    escribir('oefa.jsonl', [registro(0), registro(1)]);
    escribir('descargas.jsonl', [
      JSON.stringify({
        id: 'id-0',
        documentoUuid: 'uuid-0',
        archivo: 'uuid-0.pdf',
        bytes: 1024,
        sha256: 'abc',
      }),
    ]);

    const hallazgos = todos((await revisar(opciones({ total: 2 }))).secciones);

    expect(nivelDe(hallazgos, 'manifiesto-huerfano')).toBe('ok');
    expect(nivelDe(hallazgos, 'cobertura')).toBe('ok');
    expect(hallazgos.filter((h) => h.nivel === 'error')).toEqual([]);
  });

  /**
   * El lector es estricto a propósito (§5.7): una caída deja media línea y el
   * writer la repara al abrir, pero para el validador esa cola truncada **es**
   * un hallazgo y no algo que haya que arreglar en silencio.
   */
  it('una cola truncada llega al informe como error', async () => {
    escribir('oefa.jsonl', [registro(0), '{"id":"id-1","indi']);

    const hallazgos = todos((await revisar(opciones())).secciones);
    expect(nivelDe(hallazgos, 'jsonl-ilegible')).toBe('error');
  });

  it('sin carpeta de descargas los chequeos de disco no pasan: quedan sin evaluar', async () => {
    escribir('oefa.jsonl', [registro(0)]);
    escribir('descargas.jsonl', []);

    const hallazgos = todos((await revisar(opciones())).secciones);
    expect(nivelDe(hallazgos, 'archivo-ausente')).toBe('no-evaluable');
  });

  /** El checkpoint es la tercera fuente del total, detrás del sitio y de --total. */
  it('saca el total del checkpoint cuando no se lo pasan', async () => {
    escribir('oefa.jsonl', [registro(0), registro(1)]);
    writeFileSync(
      join(dir, 'checkpoint.json'),
      JSON.stringify({
        fuente: 'oefa',
        tarea: 'scrape',
        pageSize: 10,
        total: 2,
        ultimaPagina: 1,
        registros: 2,
        actualizadoEn: '2026-08-15T00:00:00.000Z',
      }),
    );

    const hallazgos = todos((await revisar(opciones())).secciones);
    const cobertura = hallazgos.find((h) => h.chequeo === 'cobertura');

    expect(cobertura?.nivel).toBe('ok');
    expect(cobertura?.mensaje).toContain('del checkpoint de «scrape»');
  });

  it('un checkpoint roto se anota como nota y no rompe la revisión', async () => {
    escribir('oefa.jsonl', [registro(0)]);
    writeFileSync(join(dir, 'checkpoint.json'), '{ no es json');

    const { secciones, nota } = await revisar(opciones());

    expect(nota).toContain('checkpoint ilegible');
    expect(nivelDe(todos(secciones), 'cobertura')).toBe('no-evaluable');
  });

  /**
   * La consulta al portal llega inyectada, así que el modo `--contra-el-sitio`
   * se prueba sin red: lo que importa verificar es que el total del sitio gane
   * sobre las otras fuentes y que su sección se agregue al informe.
   */
  it('el total que devuelve el sitio manda sobre --total', async () => {
    escribir('oefa.jsonl', [registro(0), registro(1)]);

    const { secciones } = await revisar(opciones({ total: 99 }), (identidades) =>
      Promise.resolve({
        total: 2,
        hallazgos: [{ nivel: 'ok', chequeo: 'sitio-total', mensaje: `${identidades.size} en el archivo` }],
      }),
    );

    expect(secciones).toHaveLength(3);
    const cobertura = todos(secciones).find((h) => h.chequeo === 'cobertura');
    expect(cobertura?.nivel).toBe('ok');
    expect(cobertura?.mensaje).toContain('que el portal declara ahora');
  });

  it('un portal que no responde queda como error y no tumba el resto del informe', async () => {
    escribir('oefa.jsonl', [registro(0)]);

    const { secciones } = await revisar(opciones(), () => Promise.reject(new Error('ECONNRESET')));
    const hallazgos = todos(secciones);

    expect(nivelDe(hallazgos, 'sitio-alcanzable')).toBe('error');
    expect(nivelDe(hallazgos, 'esquema')).toBe('ok');
  });
});
