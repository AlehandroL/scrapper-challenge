/**
 * La persistencia contra el sistema de archivos real, en un directorio temporal.
 *
 * Nada de mocks de `node:fs`: lo que hay que probar acá es justamente el
 * comportamiento del sistema de archivos —la escritura que vuelve con los bytes
 * puestos, la cola truncada que sobrevive a una caída— y un mock de módulo
 * reproduce la API pero no el problema. Misma filosofía que el `node:http`
 * efímero de los tests de transporte.
 */

import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  JsonlCorruptoError,
  openJsonlWriter,
  readJsonl,
  readKeys,
  repararCola,
} from '../src/store/jsonl.ts';

let dir: string;
let ruta: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jsonl-'));
  ruta = join(dir, 'salida.jsonl');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const leerTodo = async (): Promise<unknown[]> => {
  const valores: unknown[] = [];
  for await (const { valor } of readJsonl(ruta)) valores.push(valor);
  return valores;
};

const uuidDe = (v: unknown): string | undefined =>
  typeof v === 'object' && v !== null && 'uuid' in v && typeof v.uuid === 'string'
    ? v.uuid
    : undefined;

describe('escritura', () => {
  it('escribe una línea por registro y las relee iguales', async () => {
    const w = openJsonlWriter(ruta);
    w.append({ uuid: 'a', indice: 0 });
    w.append({ uuid: 'b', indice: 1 });
    w.close();

    expect(w.escritas).toBe(2);
    expect(await leerTodo()).toEqual([
      { uuid: 'a', indice: 0 },
      { uuid: 'b', indice: 1 },
    ]);
  });

  /**
   * El campo de administrados del portal trae acentos y un salto de línea real
   * dentro del texto. Es el recordatorio de por qué se serializa con
   * `JSON.stringify` y no concatenando: un `\n` sin escapar parte el registro en
   * dos líneas y el archivo deja de ser JSONL sin que nada avise.
   */
  it('sobrevive a acentos y saltos de línea dentro de un campo', async () => {
    const registro = {
      uuid: 'ñ',
      texto: 'Corporación del Mar S.A.\nAustral Group S.A.A.',
      sector: 'Pesquería',
    };
    const w = openJsonlWriter(ruta);
    w.append(registro);
    w.close();

    expect(
      readFileSync(ruta, 'utf8')
        .split('\n')
        .filter((l) => l !== ''),
    ).toHaveLength(1);
    expect(await leerTodo()).toEqual([registro]);
  });

  it('crea el directorio si no existe', () => {
    const anidada = join(dir, 'a', 'b', 'datos.jsonl');
    const w = openJsonlWriter(anidada);
    w.append({ uuid: 'x' });
    w.close();
    expect(readFileSync(anidada, 'utf8')).toBe('{"uuid":"x"}\n');
  });

  it('append tras close falla en vez de escribir a un descriptor cerrado', () => {
    const w = openJsonlWriter(ruta);
    w.close();
    expect(() => w.append({ uuid: 'a' })).toThrow(/cerrado/);
  });

  it('close es idempotente', () => {
    const w = openJsonlWriter(ruta);
    w.append({ uuid: 'a' });
    w.close();
    expect(() => w.close()).not.toThrow();
  });

  it('agrega al final en vez de pisar lo ya escrito', async () => {
    const primera = openJsonlWriter(ruta);
    primera.append({ uuid: 'a' });
    primera.close();

    const segunda = openJsonlWriter(ruta);
    segunda.append({ uuid: 'b' });
    segunda.close();

    expect(await leerTodo()).toEqual([{ uuid: 'a' }, { uuid: 'b' }]);
  });
});

describe('reparación de la cola', () => {
  /** Lo que deja una caída: la última línea a medio escribir. */
  it('descarta la última línea sin terminar al abrir para escribir', async () => {
    writeFileSync(ruta, '{"uuid":"a"}\n{"uuid":"b"}\n{"uuid":"c"');

    const w = openJsonlWriter(ruta);
    expect(w.bytesReparados).toBe('{"uuid":"c"'.length);
    w.append({ uuid: 'd' });
    w.close();

    expect(await leerTodo()).toEqual([{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'd' }]);
  });

  it('no toca un archivo que termina en salto de línea', () => {
    writeFileSync(ruta, '{"uuid":"a"}\n');
    expect(repararCola(ruta)).toBe(0);
    expect(readFileSync(ruta, 'utf8')).toBe('{"uuid":"a"}\n');
  });

  it.each([
    ['inexistente', false],
    ['vacío', true],
  ])('no hace nada con un archivo %s', (_caso, crear) => {
    if (crear) writeFileSync(ruta, '');
    expect(repararCola(ruta)).toBe(0);
  });

  /** Sin un solo `\n`, todo el archivo es una línea que nunca terminó. */
  it('vacía un archivo que no tiene ningún salto de línea', () => {
    writeFileSync(ruta, '{"uuid":"a"');
    expect(repararCola(ruta)).toBe(11);
    expect(readFileSync(ruta, 'utf8')).toBe('');
  });

  /**
   * La búsqueda va hacia atrás por trozos de 64 KB. Un registro más largo que la
   * ventana es patológico pero posible, y quedarse con «no encontré ningún \n en
   * los últimos 64 KB» borraría el archivo entero.
   */
  it('encuentra el salto de línea aunque el último registro supere la ventana', async () => {
    const largo = JSON.stringify({ uuid: 'a', relleno: 'x'.repeat(200_000) });
    writeFileSync(ruta, `${largo}\n`);
    appendFileSync(ruta, '{"uuid":"cortad');

    expect(repararCola(ruta)).toBe(15);
    expect(await leerTodo()).toHaveLength(1);
  });
});

describe('lectura', () => {
  it('un archivo inexistente se lee como vacío, no como error', async () => {
    expect(await leerTodo()).toEqual([]);
    expect(await readKeys(ruta, uuidDe)).toEqual(new Set());
  });

  it('ignora las líneas en blanco pero las cuenta para el número de línea', async () => {
    writeFileSync(ruta, '{"uuid":"a"}\n\n{"uuid":"b"}\n');
    const numeros: number[] = [];
    for await (const { numero } of readJsonl(ruta)) numeros.push(numero);
    expect(numeros).toEqual([1, 3]);
  });

  /**
   * Estricto a propósito: saltar una línea rota en silencio es como se pierden
   * cuatrocientos registros sin que nadie se entere.
   */
  it('lanza con el número de línea ante una línea corrupta en el medio', async () => {
    writeFileSync(ruta, '{"uuid":"a"}\nesto no es json\n{"uuid":"c"}\n');
    await expect(leerTodo()).rejects.toBeInstanceOf(JsonlCorruptoError);
    await expect(leerTodo()).rejects.toMatchObject({ linea: 2, muestra: 'esto no es json' });
  });

  it('cortar el recorrido a la mitad no deja el archivo abierto', async () => {
    const w = openJsonlWriter(ruta);
    for (let i = 0; i < 50; i += 1) w.append({ uuid: `u${i}` });
    w.close();

    for await (const { valor } of readJsonl<{ uuid: string }>(ruta)) {
      if (valor.uuid === 'u2') break;
    }
    // Si el descriptor quedara colgado, escribir de nuevo sobre el mismo archivo
    // fallaría en Windows y dejaría un handle en el resto.
    expect(() => openJsonlWriter(ruta).close()).not.toThrow();
  });
});

describe('índice de claves e idempotencia', () => {
  it('junta las claves y descarta los registros que no la tienen', async () => {
    writeFileSync(ruta, '{"uuid":"a"}\n{"sin":"clave"}\n{"uuid":"b"}\n{"uuid":"a"}\n');
    expect(await readKeys(ruta, uuidDe)).toEqual(new Set(['a', 'b']));
  });

  /**
   * La distinción que hace posible reanudar: una cola truncada es el rastro de
   * una caída y el writer la va a reparar; una línea rota en el medio ya es
   * corrupción y merece detener todo.
   */
  it('tolera la última línea truncada y la reporta', async () => {
    writeFileSync(ruta, '{"uuid":"a"}\n{"uuid":"b"}\n{"uuid":"cor');
    const avisos: number[] = [];
    const claves = await readKeys(ruta, uuidDe, { onColaInvalida: (linea) => avisos.push(linea) });

    expect(claves).toEqual(new Set(['a', 'b']));
    expect(avisos).toEqual([3]);
  });

  it('no tolera una línea rota que no es la última', async () => {
    writeFileSync(ruta, '{"uuid":"a"}\nroto\n{"uuid":"b"}\n');
    await expect(readKeys(ruta, uuidDe)).rejects.toBeInstanceOf(JsonlCorruptoError);
  });

  /** §5.7: correr dos veces sobre el mismo rango no duplica registros. */
  it('una segunda corrida sobre el mismo rango no escribe nada', async () => {
    const registros = [{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'c' }];

    const primera = openJsonlWriter(ruta);
    for (const r of registros) primera.append(r);
    primera.close();

    const yaEstan = await readKeys(ruta, uuidDe);
    const segunda = openJsonlWriter(ruta);
    for (const r of registros) if (!yaEstan.has(r.uuid)) segunda.append(r);
    segunda.close();

    expect(segunda.escritas).toBe(0);
    expect(await leerTodo()).toHaveLength(3);
  });
});
