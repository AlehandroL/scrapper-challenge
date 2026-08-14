/**
 * La cola de fallos: lo que hace que «reintentar después» sea una operación y no
 * una intención.
 *
 * Dos comportamientos cargan con casi todo el peso. El colapso por `id` es lo que
 * hace idempotente el reintento —un documento que falla en tres corridas es una
 * entrada con tres intentos, no tres entradas—, y la reescritura atómica es lo
 * que impide que un corte durante el `retry-failed` deje la cola a medias y se
 * pierda lo que faltaba reintentar.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EntradaDlqInvalidaError,
  abrirDlq,
  colaEnMemoria,
  leerDlq,
  reescribirDlq,
  type EntradaDlq,
} from '../src/store/dlq.ts';

let dir: string;
let ruta: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dlq-'));
  ruta = join(dir, 'failed.jsonl');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entrada = (id: string, extra: Partial<EntradaDlq> = {}): EntradaDlq => ({
  id,
  tipo: 'pdf',
  error: 'throttled',
  intentos: 1,
  ultimoTs: '2026-08-14T12:00:00.000Z',
  ...extra,
});

describe('escritura', () => {
  it('registra una línea por fallo y la relee igual', async () => {
    const dlq = abrirDlq(ruta);
    dlq.registrar(entrada('a', { contexto: { pagina: 12, indice: 117 } }));
    dlq.registrar(entrada('b', { error: 'documento-magic' }));
    dlq.close();

    expect(dlq.registradas).toBe(2);
    expect(await leerDlq(ruta)).toEqual([
      entrada('a', { contexto: { pagina: 12, indice: 117 } }),
      entrada('b', { error: 'documento-magic' }),
    ]);
  });

  /**
   * Una corrida sin fallos no debe dejar un `failed.jsonl` vacío dando vueltas:
   * un archivo presente invita a pensar que algo falló, y en un repo termina
   * commiteado.
   */
  it('no crea el archivo si no se registró nada', () => {
    const dlq = abrirDlq(ruta);
    dlq.close();
    expect(existsSync(ruta)).toBe(false);
  });

  /** El valor de la cola está en sobrevivir al proceso que la escribió. */
  it('cada entrada queda en disco sin esperar al close', async () => {
    const dlq = abrirDlq(ruta);
    dlq.registrar(entrada('a'));
    expect(await leerDlq(ruta)).toHaveLength(1);
    dlq.close();
  });

  it('la cola en memoria acumula sin tocar el disco', () => {
    const cola = colaEnMemoria();
    cola.registrar(entrada('a'));
    cola.registrar(entrada('b'));

    expect(cola.entradas.map((e) => e.id)).toEqual(['a', 'b']);
    expect(existsSync(ruta)).toBe(false);
  });
});

describe('lectura', () => {
  it('un archivo inexistente es una cola vacía, no un error', async () => {
    expect(await leerDlq(ruta)).toEqual([]);
  });

  it('colapsa por id quedándose con la última: es lo que hace envejecer los intentos', async () => {
    const dlq = abrirDlq(ruta);
    dlq.registrar(entrada('a', { intentos: 1 }));
    dlq.registrar(entrada('b', { intentos: 1 }));
    dlq.registrar(entrada('a', { intentos: 4, error: 'network' }));
    dlq.close();

    const leidas = await leerDlq(ruta);
    expect(leidas).toHaveLength(2);
    expect(leidas[0]).toMatchObject({ id: 'a', intentos: 4, error: 'network' });
    // El orden es el de la primera aparición: leer dos veces produce lo mismo.
    expect(leidas.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('una línea sin los campos obligatorios detiene la lectura en vez de saltearse', async () => {
    writeFileSync(ruta, `${JSON.stringify(entrada('a'))}\n{"id":"b"}\n`);
    await expect(leerDlq(ruta)).rejects.toBeInstanceOf(EntradaDlqInvalidaError);
  });

  it('una línea que no es JSON también', async () => {
    writeFileSync(ruta, `${JSON.stringify(entrada('a'))}\nesto no es json\n`);
    await expect(leerDlq(ruta)).rejects.toThrow(/no es JSON válido/);
  });
});

describe('reescritura', () => {
  it('deja exactamente las entradas pedidas', async () => {
    const dlq = abrirDlq(ruta);
    dlq.registrar(entrada('a'));
    dlq.registrar(entrada('b'));
    dlq.registrar(entrada('c'));
    dlq.close();

    reescribirDlq(ruta, [entrada('b', { intentos: 2 })]);

    expect(await leerDlq(ruta)).toEqual([entrada('b', { intentos: 2 })]);
  });

  it('vaciar la cola deja un archivo vacío, no uno con basura', async () => {
    reescribirDlq(ruta, [entrada('a')]);
    reescribirDlq(ruta, []);

    expect(readFileSync(ruta, 'utf8')).toBe('');
    expect(await leerDlq(ruta)).toEqual([]);
  });

  it('no deja el temporal de la escritura atómica', () => {
    reescribirDlq(ruta, [entrada('a')]);
    expect(existsSync(`${ruta}.tmp`)).toBe(false);
  });
});
