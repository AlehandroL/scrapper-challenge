/**
 * La escritura de un cuerpo descargado a disco, contra el sistema de archivos
 * real y con streams reales.
 *
 * Lo que hay que probar acá es el invariante que evita el peor artefacto del
 * bloque 5: **el destino nunca existe a medias**. Un `.pdf` que en realidad es
 * una página de error no solo es basura; es basura que la corrida siguiente va a
 * tomar por buena y saltear, y el diagnóstico llega semanas después al abrirlo.
 */

import { Readable } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ArchivoInvalidoError,
  SUFIJO_TEMPORAL,
  existeArchivo,
  guardarStream,
  resumenDe,
  sanitizar,
  tamanoDe,
} from '../src/store/files.ts';

let dir: string;
let destino: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'files-'));
  destino = join(dir, 'sub', 'doc.pdf');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const PDF = '%PDF-1.4\ncuerpo de prueba, solo ASCII para que latin1 y utf8 coincidan\n%%EOF\n';

/** Un stream que entrega el cuerpo en trozos del tamaño pedido. */
const enTrozos = (texto: string, tam: number): Readable => {
  const buf = Buffer.from(texto, 'latin1');
  const trozos: Buffer[] = [];
  for (let i = 0; i < buf.length; i += tam) trozos.push(buf.subarray(i, i + tam));
  return Readable.from(trozos);
};

describe('guardarStream', () => {
  it('escribe el cuerpo, crea el directorio y devuelve bytes y hash', async () => {
    const { bytes, sha256 } = await guardarStream(Readable.from([Buffer.from(PDF)]), destino, {
      magic: '%PDF-',
      tamanoMinimo: 10,
    });

    expect(readFileSync(destino, 'latin1')).toBe(PDF);
    expect(bytes).toBe(Buffer.byteLength(PDF));
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('no deja rastro del temporal', async () => {
    await guardarStream(Readable.from([Buffer.from(PDF)]), destino, { magic: '%PDF-' });
    expect(existsSync(`${destino}${SUFIJO_TEMPORAL}`)).toBe(false);
  });

  /**
   * El fallo que quedaba fuera de la limpieza: el del `rename` final.
   *
   * Corre después del `closeSync` —renombrar con el descriptor abierto falla en
   * Windows—, así que también quedaba fuera del `finally` que borra el temporal.
   * Un `.parcial` sobreviviente se lee como la evidencia de un corte, y acá era
   * exactamente lo contrario: el contenido ya estaba entero, validado y
   * `fsync`-eado, solo que con el nombre equivocado.
   *
   * El caso se arma sin mocks: si el destino ya es un directorio, el `rename` de
   * un archivo sobre él falla de verdad en el sistema de archivos real.
   */
  it('no deja el temporal si el rename final falla', async () => {
    mkdirSync(destino, { recursive: true });

    await expect(
      guardarStream(Readable.from([Buffer.from(PDF)]), destino, { magic: '%PDF-' }),
    ).rejects.toThrow();
    expect(existsSync(`${destino}${SUFIJO_TEMPORAL}`)).toBe(false);
  });

  /**
   * El caso de `fixtures/oefa/04-download-a.html`: HTTP 200, `text/html`, y el
   * cuerpo es la página de resultados. Sin esta validación se acumulan archivos
   * `.pdf` que son páginas web.
   */
  it('rechaza un cuerpo que no empieza con el magic y no toca el destino', async () => {
    const html = "<?xml version='1.0'?><!DOCTYPE html><html><body>página completa</body></html>";

    await expect(
      guardarStream(Readable.from([Buffer.from(html)]), destino, { magic: '%PDF-' }),
    ).rejects.toMatchObject({ name: 'ArchivoInvalidoError', motivo: 'magic' });
    expect(existsSync(destino)).toBe(false);
    expect(existsSync(`${destino}${SUFIJO_TEMPORAL}`)).toBe(false);
  });

  /**
   * El magic puede quedar repartido entre dos chunks. La versión ingenua —mirar
   * solo el primero— rechaza cuerpos válidos, y la otra versión ingenua —escribir
   * y validar después— deja medio HTML en el temporal.
   */
  it('valida el magic aunque llegue partido en varios chunks', async () => {
    const { bytes } = await guardarStream(enTrozos(PDF, 2), destino, {
      magic: '%PDF-',
      tamanoMinimo: 10,
    });
    expect(bytes).toBe(Buffer.byteLength(PDF));
    expect(readFileSync(destino, 'latin1')).toBe(PDF);
  });

  it('un cuerpo más corto que el magic tampoco pasa', async () => {
    await expect(
      guardarStream(Readable.from([Buffer.from('%PD')]), destino, { magic: '%PDF-' }),
    ).rejects.toMatchObject({ motivo: 'magic' });
    expect(existsSync(destino)).toBe(false);
  });

  it('rechaza un cuerpo por debajo del tamaño mínimo', async () => {
    await expect(
      guardarStream(Readable.from([Buffer.from('%PDF-')]), destino, {
        magic: '%PDF-',
        tamanoMinimo: 1024,
      }),
    ).rejects.toMatchObject({ name: 'ArchivoInvalidoError', motivo: 'tamano' });
    expect(existsSync(destino)).toBe(false);
  });

  /**
   * §5.6: un cuerpo en streaming que no se drena deja el socket colgado, y unos
   * pocos casos agotan el pool. Es el fallo cuyo síntoma —requests que se cuelgan
   * sin timeout— no se parece en nada a la causa.
   */
  it('destruye el stream cuando el cuerpo no sirve', async () => {
    const origen = Readable.from([Buffer.from('no soy un pdf, ni de lejos')]);

    await expect(guardarStream(origen, destino, { magic: '%PDF-' })).rejects.toBeInstanceOf(
      ArchivoInvalidoError,
    );
    expect(origen.destroyed).toBe(true);
  });

  it('un corte a mitad de cuerpo no deja el destino a medias', async () => {
    const origen = new Readable({
      read() {
        this.push(Buffer.from('%PDF-1.4\n'));
        this.destroy(new Error('ECONNRESET simulado'));
      },
    });

    await expect(guardarStream(origen, destino, { magic: '%PDF-' })).rejects.toThrow(
      'ECONNRESET simulado',
    );
    expect(existsSync(destino)).toBe(false);
    expect(existsSync(`${destino}${SUFIJO_TEMPORAL}`)).toBe(false);
  });

  it('sin magic acepta cualquier cuerpo', async () => {
    const { bytes } = await guardarStream(Readable.from([Buffer.from('lo que sea')]), destino);
    expect(bytes).toBe(10);
  });

  it('sobrescribe un destino previo de una sola vez', async () => {
    writeFileSync(destino.replace('/sub/', '/'), 'x');
    await guardarStream(Readable.from([Buffer.from(PDF)]), destino, { magic: '%PDF-' });
    await guardarStream(Readable.from([Buffer.from(`${PDF}segunda`)]), destino, { magic: '%PDF-' });
    expect(readFileSync(destino, 'latin1')).toBe(`${PDF}segunda`);
  });
});

describe('inspección de lo ya escrito', () => {
  it('tamanoDe y existeArchivo distinguen ausente de presente y de chico', async () => {
    expect(tamanoDe(destino)).toBeUndefined();
    expect(existeArchivo(destino)).toBe(false);

    await guardarStream(Readable.from([Buffer.from(PDF)]), destino, { magic: '%PDF-' });

    expect(tamanoDe(destino)).toBe(Buffer.byteLength(PDF));
    expect(existeArchivo(destino, 10)).toBe(true);
    expect(existeArchivo(destino, 10_000)).toBe(false);
  });

  it('resumenDe recalcula lo mismo que devolvió la escritura', async () => {
    const escrito = await guardarStream(enTrozos(PDF, 7), destino, { magic: '%PDF-' });
    expect(await resumenDe(destino)).toEqual(escrito);
  });

  it('resumenDe de un archivo inexistente es undefined', async () => {
    expect(await resumenDe(join(dir, 'no-existe.pdf'))).toBeUndefined();
  });
});

describe('sanitizar', () => {
  /** La barra del número de resolución es el caso que obliga a hacer esto: sin
   *  sanitizar, `264-2012-OEFA/TFA` abre un directorio que no existe. */
  it('convierte un número de resolución en un fragmento de nombre seguro', () => {
    expect(sanitizar('264-2012-OEFA/TFA')).toBe('264-2012-oefa-tfa');
  });

  it('saca los diacríticos en vez de reemplazarlos uno por uno', () => {
    expect(sanitizar('Resolución N° 12 — Añá')).toBe('resolucion-n-12-ana');
  });

  it('recorta al máximo pedido sin dejar un guion colgando', () => {
    expect(sanitizar('a'.repeat(50) + ' b', 51)).toBe('a'.repeat(50));
  });

  it('un texto sin nada aprovechable queda vacío, no queda en guiones', () => {
    expect(sanitizar('///---')).toBe('');
  });
});
