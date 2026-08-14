/**
 * El consumidor de la cola de fallos.
 *
 * Lo que hay que probar son las dos decisiones que no son obvias. La primera es
 * el **rango**: §5.4 obliga a volver a navegar hasta la página de cada registro,
 * así que sin las páginas anotadas en la cola habría que recorrer el dataset
 * entero para recuperar tres documentos. La segunda es la **reconciliación**: qué
 * queda en el archivo después de reintentar, incluido el caso incómodo de un
 * registro que se recorrió su página y no apareció.
 *
 * El camino completo —fallar, encolar, reintentar, vaciar la cola— se ejercita al
 * final contra el portal falso, que es donde se ve que las piezas encajan.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parsearArgs, planificar, reconciliar } from '../src/cli/retry-failed.ts';
import type { ResumenDescarga } from '../src/cli/download.ts';
import type { EntradaDlq } from '../src/store/dlq.ts';
import { archivosDe, datasetBase, montarDescargas, type Banco } from './helpers/descargas.ts';

let banco: Banco | undefined;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'retry-'));
});

afterEach(async () => {
  await banco?.server.close();
  banco = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const entrada = (id: string, extra: Partial<EntradaDlq> = {}): EntradaDlq => ({
  id,
  tipo: 'pdf',
  error: 'throttled',
  intentos: 1,
  ultimoTs: '2026-08-14T12:00:00.000Z',
  contexto: { pagina: 4, indice: 33 },
  ...extra,
});

const resumen = (resueltos: string[] = []): ResumenDescarga =>
  ({ resueltos: new Set(resueltos) }) as ResumenDescarga;

describe('parsearArgs', () => {
  it('sin argumentos usa los valores por defecto', () => {
    expect(parsearArgs([])).toEqual({
      dlq: 'data/oefa.failed.jsonl',
      destino: 'descargas',
      manifiesto: 'data/oefa.descargas.jsonl',
      maxIntentos: 5,
      dryRun: false,
      ayuda: false,
    });
  });

  it('rechaza un presupuesto de intentos que no es un entero ≥ 1', () => {
    expect(() => parsearArgs(['--max-intentos', '0'])).toThrow(/Argumentos inválidos/);
    expect(() => parsearArgs(['--max-intentos', 'tres'])).toThrow(/Argumentos inválidos/);
  });

  it('rechaza una flag desconocida en vez de ignorarla', () => {
    expect(() => parsearArgs(['--dlqq', 'x'])).toThrow(/Argumentos inválidos/);
  });
});

describe('planificar', () => {
  it('el rango sale de las páginas anotadas: es lo que hace barato el reintento', () => {
    const plan = planificar(
      [
        entrada('a', { contexto: { pagina: 12 } }),
        entrada('b', { contexto: { pagina: 47 } }),
        entrada('c', { contexto: { pagina: 13 } }),
      ],
      5,
    );

    expect(plan.desde).toBe(12);
    expect(plan.hasta).toBe(47);
    expect(plan.pendientes).toHaveLength(3);
  });

  /**
   * Rendirse es una decisión, y borrar la entrada sería perder la evidencia de
   * que el sitio no entrega ese documento.
   */
  it('las que agotaron el presupuesto se conservan sin reintentarse', () => {
    const plan = planificar([entrada('a', { intentos: 5 }), entrada('b', { intentos: 4 })], 5);

    expect(plan.pendientes.map((e) => e.id)).toEqual(['b']);
    expect(plan.agotadas.map((e) => e.id)).toEqual(['a']);
  });

  it('ignora las entradas que no son de un documento', () => {
    expect(planificar([entrada('a', { tipo: 'otra-cosa' })], 5).pendientes).toEqual([]);
  });

  /** Sin página anotada no se sabe dónde vive: se recorre todo antes que
   *  saltearla en silencio. */
  it('una entrada sin página deja el rango abierto', () => {
    const plan = planificar([entrada('a', { contexto: {} }), entrada('b')], 5);

    expect(plan.desde).toBeUndefined();
    expect(plan.hasta).toBeUndefined();
    expect(plan.pendientes).toHaveLength(2);
  });

  it('sin pendientes no hay rango que calcular', () => {
    expect(planificar([], 5)).toEqual({ pendientes: [], agotadas: [] });
  });
});

describe('reconciliar', () => {
  const plan = { pendientes: [entrada('a'), entrada('b')], agotadas: [entrada('z', { intentos: 9 })] };
  const ahora = '2026-08-14T13:00:00.000Z';

  it('lo que se resolvió sale de la cola', () => {
    const quedan = reconciliar(plan, resumen(['a', 'b']), [], true, ahora);
    expect(quedan.map((e) => e.id)).toEqual(['z']);
  });

  it('lo que volvió a fallar queda con la entrada nueva', () => {
    const nuevo = entrada('a', { intentos: 3, error: 'network' });
    const quedan = reconciliar(plan, resumen(['b']), [nuevo], true, ahora);

    expect(quedan).toEqual([nuevo, plan.agotadas[0]]);
  });

  /**
   * El registro se movió de página o el organismo lo despublicó. Las dos cosas
   * son información: marcarlo es lo que evita que quede dando vueltas para
   * siempre con el mismo error de hace tres semanas.
   */
  it('lo que no apareció se marca no-encontrado y envejece', () => {
    const quedan = reconciliar(plan, resumen(['b']), [], true, ahora);

    expect(quedan[0]).toMatchObject({ id: 'a', error: 'no-encontrado', intentos: 2, ultimoTs: ahora });
  });

  /** Si la corrida se cortó, no se llegó a mirar: la entrada se conserva tal cual. */
  it('una corrida incompleta no marca a nadie como no-encontrado', () => {
    const quedan = reconciliar(plan, resumen([]), [], false, ahora);

    expect(quedan.map((e) => e.id)).toEqual(['a', 'b', 'z']);
    expect(quedan[0]).toEqual(entrada('a'));
  });
});

describe('el camino completo, contra el portal falso', () => {
  it('falla, encola, reintenta y la cola queda vacía', async () => {
    banco = await montarDescargas(dir, datasetBase({ total: 25 }));

    // 1. El sitio devuelve 503 en todas las descargas: la página se recorre bien
    //    y los diez documentos terminan en la cola.
    banco.server.fallarDescargas(503);
    const primera = await banco.correr({ hasta: 1 });

    expect(primera.descargados).toBe(0);
    expect(banco.fallos).toHaveLength(10);
    expect(archivosDe(dir)).toEqual([]);

    // 2. El plan sale de la cola: una sola página, porque es la única anotada.
    const plan = planificar(banco.fallos, 5);
    expect(plan).toMatchObject({ desde: 1, hasta: 1 });

    // 3. El sitio se recupera y se reintenta solo lo pendiente.
    banco.server.fallarDescargas(undefined);
    const pendientes = new Set(plan.pendientes.map((e) => e.id));
    const segunda = await banco.correr({
      desde: plan.desde ?? 1,
      hasta: plan.hasta ?? 1,
      filtro: (registro) => pendientes.has(registro.id),
      intentosPrevios: new Map(plan.pendientes.map((e) => [e.id, e.intentos])),
    });

    expect(segunda.descargados).toBe(10);
    expect(archivosDe(dir)).toHaveLength(10);
    expect(reconciliar(plan, segunda, [], true, '2026-08-14T13:00:00.000Z')).toEqual([]);
  });

  it('lo que sigue fallando vuelve a la cola con los intentos acumulados', async () => {
    banco = await montarDescargas(dir, datasetBase({ total: 25 }));

    banco.server.fallarDescargas(503);
    await banco.correr({ hasta: 1 });

    const plan = planificar(banco.fallos, 99);
    const yaEncoladas = plan.pendientes.length;
    const elegida = plan.pendientes[0] ?? entrada('?');

    // El sitio sigue caído: se reintenta uno solo y vuelve a fallar.
    const segunda = await banco.correr({
      hasta: 1,
      filtro: (registro) => registro.id === elegida.id,
      intentosPrevios: new Map([[elegida.id, elegida.intentos]]),
    });

    const nuevos = banco.fallos.slice(yaEncoladas);
    expect(segunda.descargados).toBe(0);
    expect(nuevos).toHaveLength(1);
    // Lo que hace que la cola envejezca: sin acumular, un documento imposible se
    // reintenta para siempre y nunca llega a agotar el presupuesto.
    expect(nuevos[0]?.intentos).toBeGreaterThan(elegida.intentos);

    expect(reconciliar({ pendientes: [elegida], agotadas: [] }, segunda, nuevos, true, 'x')).toEqual(nuevos);
  });
});
