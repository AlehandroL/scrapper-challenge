/**
 * El checkpoint y su política de reanudación.
 *
 * Lo que se prueba acá no es leer y escribir un JSON: es **cuándo hay que
 * desconfiar de él**. Un checkpoint que se acepta de más hace que la corrida
 * siguiente salte páginas que nunca se leyeron, y el resultado es un dataset con
 * huecos que parece completo — el modo de falla que §6.4 persigue, producido por
 * nosotros y sin ninguna excepción de por medio.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CheckpointInvalidoError,
  borrarCheckpoint,
  esCompatible,
  escribirCheckpoint,
  leerCheckpoint,
  planificarReanudacion,
  type Checkpoint,
} from '../src/store/checkpoint.ts';

let dir: string;
let ruta: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'checkpoint-'));
  ruta = join(dir, 'oefa.checkpoint.json');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const cp = (extra: Partial<Checkpoint> = {}): Checkpoint => ({
  fuente: 'oefa',
  tarea: 'download',
  pageSize: 10,
  total: 1753,
  ultimaPagina: 12,
  registros: 120,
  actualizadoEn: '2026-08-14T12:00:00.000Z',
  ...extra,
});

describe('ida y vuelta', () => {
  it('escribe y relee el mismo estado', () => {
    escribirCheckpoint(ruta, cp());
    expect(leerCheckpoint(ruta)).toEqual(cp());
  });

  it('sin archivo no hay checkpoint, y eso no es un error', () => {
    expect(leerCheckpoint(ruta)).toBeUndefined();
  });

  it('no deja el temporal de la escritura atómica', () => {
    escribirCheckpoint(ruta, cp());
    expect(existsSync(`${ruta}.tmp`)).toBe(false);
  });

  it('borrarCheckpoint es idempotente', () => {
    escribirCheckpoint(ruta, cp());
    borrarCheckpoint(ruta);
    borrarCheckpoint(ruta);
    expect(existsSync(ruta)).toBe(false);
  });

  /**
   * «No hay checkpoint» y «hay uno ilegible» llevan a la misma acción —recorrer
   * de nuevo— pero solo la segunda es un problema. Degradarla a `undefined` es
   * cómo se convive tres meses con un checkpoint que nunca sirvió.
   */
  it.each([
    ['JSON roto', '{no es json'],
    ['campos faltantes', '{"fuente":"oefa"}'],
    ['tipos equivocados', '{"fuente":"oefa","tarea":"scrape","pageSize":"diez","total":1,"ultimaPagina":1,"registros":1,"actualizadoEn":"x"}'],
    ['sin la tarea que lo escribió', '{"fuente":"oefa","pageSize":10,"total":1,"ultimaPagina":1,"registros":1,"actualizadoEn":"x"}'],
  ])('un checkpoint con %s lanza en vez de devolver undefined', (_caso, contenido) => {
    writeFileSync(ruta, contenido);
    expect(() => leerCheckpoint(ruta)).toThrow(CheckpointInvalidoError);
  });

  it('se guarda legible: es lo primero que alguien va a mirar cuando algo no cuadre', () => {
    escribirCheckpoint(ruta, cp());
    expect(readFileSync(ruta, 'utf8')).toContain('\n  "ultimaPagina": 12');
  });
});

describe('esCompatible', () => {
  it('acepta el checkpoint de la misma fuente, comando y tamaño de página', () => {
    expect(esCompatible(cp(), { fuente: 'oefa', tarea: 'download', pageSize: 10 })).toBe(true);
  });

  it.each([
    ['otra fuente', { fuente: 'pj', tarea: 'download', pageSize: 10 }],
    // El caso que importa: los dos comandos recorren la misma fuente y avanzan
    // distinto. Aceptarlo haría que el atrasado se saltee páginas que nunca leyó.
    ['otro comando', { fuente: 'oefa', tarea: 'scrape', pageSize: 10 }],
    ['otro tamaño de página', { fuente: 'oefa', tarea: 'download', pageSize: 20 }],
    ['otro total', { fuente: 'oefa', tarea: 'download', pageSize: 10, total: 1760 }],
  ])('rechaza %s', (_caso, esperado) => {
    expect(esCompatible(cp(), esperado)).toBe(false);
  });
});

describe('planificarReanudacion', () => {
  const pedido = { fuente: 'oefa', tarea: 'download', pageSize: 10 };

  it('sin checkpoint arranca desde el principio', () => {
    expect(planificarReanudacion(undefined, pedido)).toEqual({});
  });

  it('un --desde explícito manda sobre el checkpoint', () => {
    expect(planificarReanudacion(cp(), { ...pedido, desde: 3 })).toEqual({ desde: 3 });
  });

  it('retoma en la página siguiente a la última completada, y valida el total', () => {
    const plan = planificarReanudacion(cp(), pedido);
    expect(plan.desde).toBe(13);
    expect(plan.totalEsperado).toBe(1753);
    expect(plan.mensaje).toContain('13');
  });

  it.each([{ fuente: 'pj' }, { tarea: 'scrape' }])('un checkpoint ajeno (%o) se ignora y se avisa', (ajeno) => {
    const plan = planificarReanudacion(cp(ajeno), pedido);
    expect(plan.desde).toBeUndefined();
    expect(plan.mensaje).toContain('se ignora');
  });

  /**
   * Sin este caso, correr `--hasta 3` dos veces seguidas descargaría el dataset
   * entero la segunda: el checkpoint diría «vas por la 3» y nadie estaría mirando
   * el `--hasta`. Repetir un comando tiene que hacer lo mismo, no algo más grande.
   */
  it('nada pendiente si el checkpoint ya cubre el rango pedido', () => {
    const plan = planificarReanudacion(cp({ ultimaPagina: 3 }), { ...pedido, hasta: 3 });
    expect(plan.nadaPendiente).toContain('3');
    expect(plan.desde).toBeUndefined();
  });

  it('nada pendiente si el checkpoint dice que se completó el recorrido', () => {
    const plan = planificarReanudacion(cp({ ultimaPagina: 176 }), pedido);
    expect(plan.nadaPendiente).toContain('176');
  });

  it('con --hasta abierto sigue desde donde quedó', () => {
    expect(planificarReanudacion(cp({ ultimaPagina: 3 }), { ...pedido, hasta: 9 }).desde).toBe(4);
  });
});
