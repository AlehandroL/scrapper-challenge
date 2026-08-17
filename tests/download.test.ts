/**
 * El engine de descarga contra el portal falso, sobre sockets reales.
 *
 * El test que da sentido a todos los demás es el de la alineación del
 * `ViewState` (§5.4). El portal falso recuerda con qué offset generó cada token y
 * entrega el documento solo si la fila pedida cae en esa ventana; fuera de ella
 * devuelve `200` con `text/html` y la página re-renderizada, que es exactamente
 * lo que el sitio real contestó en el experimento del bloque 1. Sin eso, estos
 * tests pasarían con un downloader que manda cualquier token, y el fallo se
 * descubriría al abrir los archivos.
 *
 * El resto cubre las tres cosas que el bloque agrega y que no se pueden verificar
 * mirando el código: que un cuerpo que no es el documento no llegue nunca al
 * disco, que lo que falla quede accionable en la cola, y que repetir el comando
 * no vuelva a bajar nada.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { estadoVacio, nombreDeArchivoOefa } from '../src/cli/download.ts';
import { CircuitBreaker } from '../src/http/circuit-breaker.ts';
import { AccessDeniedError, CircuitOpenError } from '../src/http/errors.ts';
import { StructuralDriftError } from '../src/sources/errors.ts';
import type { RegistroOefa } from '../src/sources/oefa-rows.ts';
import {
  archivosDe,
  contenidoDe,
  datasetBase as dataset,
  montarDescargas,
  recolectarPaginas as recolectar,
  type Banco,
} from './helpers/descargas.ts';
import { uuidSintetico } from './helpers/jsf-server.ts';

let banco: Banco | undefined;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'descargas-'));
});

afterEach(async () => {
  // Puede no haber servidor: los tests de nombres de archivo son puros y no
  // montan nada.
  await banco?.server.close();
  banco = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** Monta el banco en el directorio temporal de este test y lo deja cerrable. */
const montar = async (...args: Parametros): Promise<Banco> => {
  banco = await montarDescargas(dir, ...args);
  return banco;
};

type Parametros =
  Parameters<typeof montarDescargas> extends [string, ...infer Resto] ? Resto : never;

const archivos = (): string[] => archivosDe(dir);
const contenido = (nombre: string): string => contenidoDe(dir, nombre);

describe('descarga contra los fixtures reales', () => {
  it('baja los documentos de la primera página y los deja validados', async () => {
    const { correr } = await montar();
    const resumen = await correr({ hasta: 1 });

    expect(resumen.descargados).toBe(10);
    expect(resumen.fallidos).toBe(0);
    expect(archivos()).toHaveLength(10);
    for (const nombre of archivos()) expect(contenido(nombre).startsWith('%PDF-')).toBe(true);
  });

  it('el manifiesto mapea cada registro a su archivo, con tamaño y hash', async () => {
    const { correr, manifiesto } = await montar();
    await correr({ hasta: 1 });

    expect(manifiesto).toHaveLength(10);
    for (const entrada of manifiesto) {
      expect(entrada.archivo).toContain(entrada.documentoUuid);
      expect(entrada.bytes).toBe(contenido(entrada.archivo).length);
      expect(entrada.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entrada.pagina).toBe(1);
    }
  });

  /**
   * El header existe pero no sirve para nombrar: OEFA lo manda en ISO-8859-1 y
   * sin RFC 5987, así que leerlo como UTF-8 produce mojibake. Se guarda como dato
   * de trazabilidad y el nombre se construye desde nuestro propio metadata.
   */
  it('anota el content-disposition crudo sin usarlo para nombrar', async () => {
    const { correr, manifiesto } = await montar();
    await correr({ hasta: 1 });

    expect(manifiesto[0]?.nombreServidor).toBe('attachment;filename="RTFA N° 264-2012.pdf"');
    expect(manifiesto[0]?.archivo).not.toContain('RTFA');
  });
});

/**
 * El experimento controlado de §5.4, reproducido sin red.
 *
 * Es la razón por la que el downloader recorre y baja intercalado en vez de
 * hacerlo en dos etapas, y por la que `prepararDescarga` recibe la página entera
 * en vez de la fila sola.
 */
describe('alineación del ViewState (§5.4)', () => {
  it('con el token de la página de la fila devuelve el documento', async () => {
    const { fuente, view } = await montar(dataset());
    const [pagina] = await recolectar(fuente, { hasta: 1 });
    const fila = pagina?.filas[0];

    const res = await view.streamCommand(
      view.prepareCommand(fila?.descarga ?? {}, { viewState: pagina?.viewState ?? '' }),
    );

    expect(res.headers['content-type']).toBe('application/octet-stream');
  });

  it('con el de otra página devuelve 200 y text/html, sin PDF', async () => {
    const { fuente, view } = await montar(dataset());
    const [primera, segunda] = await recolectar(fuente, { hasta: 2 });
    const fila = primera?.filas[0];

    // Misma sesión, misma fila, mismos campos: lo único que cambia es de qué
    // página viene el token. Es el experimento del bloque 1, palabra por palabra.
    const res = await view.streamCommand(
      view.prepareCommand(fila?.descarga ?? {}, { viewState: segunda?.viewState ?? '' }),
    );

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('el engine baja páginas sucesivas sin desalinearse', async () => {
    const { correr, manifiesto } = await montar(dataset({ total: 25 }));
    const resumen = await correr({ hasta: 3 });

    expect(resumen.descargados).toBe(25);
    expect(manifiesto.map((e) => e.pagina)).toEqual([
      ...Array<number>(10).fill(1),
      ...Array<number>(10).fill(2),
      ...Array<number>(5).fill(3),
    ]);
    // Cada archivo tiene adentro el documento que le corresponde: contar bien
    // archivos equivocados es el fallo que esto descarta.
    expect(contenido(manifiesto[14]?.archivo ?? '')).toContain(`documento=${uuidSintetico(14)}`);
  });
});

describe('lo que el sitio publica sin documento', () => {
  it('las filas sin enlace se cuentan y no van a la cola', async () => {
    const { correr, fallos } = await montar(dataset({ filasSinDocumento: [3, 7] }));
    const resumen = await correr({ hasta: 1 });

    expect(resumen.sinDocumento).toBe(2);
    expect(resumen.descargados).toBe(8);
    expect(fallos).toHaveLength(0);
  });

  /**
   * Filas 277 y 278 del sitio real: una resolución que alcanza a dos unidades
   * fiscalizables. Dos registros, un PDF. El documento se baja una vez y las dos
   * líneas del manifiesto apuntan al mismo archivo — que es también la razón por
   * la que el nombre sale del identificador del documento y no del registro.
   */
  it('dos registros con el mismo documento comparten una sola descarga', async () => {
    const { correr, manifiesto } = await montar(dataset({ documentoCompartido: [5] }));
    const resumen = await correr({ hasta: 1 });

    expect(resumen.descargados).toBe(9);
    expect(resumen.compartidos).toBe(1);
    expect(archivos()).toHaveLength(9);
    expect(manifiesto).toHaveLength(10);
    expect(manifiesto[5]?.archivo).toBe(manifiesto[4]?.archivo);
    expect(manifiesto[5]?.id).not.toBe(manifiesto[4]?.id);
  });
});

describe('idempotencia', () => {
  it('correr dos veces no vuelve a bajar nada', async () => {
    const { correr } = await montar(dataset());
    await correr({ hasta: 1 });
    const segunda = await correr({ hasta: 1 });

    expect(segunda.descargados).toBe(0);
    expect(segunda.omitidos).toBe(10);
    expect(archivos()).toHaveLength(10);
  });

  /** Sin manifiesto pero con los archivos en disco: se reconoce lo que hay en vez
   *  de bajar nueve megas de nuevo por cada uno. */
  it('reconoce los archivos ya presentes aunque se pierda el manifiesto', async () => {
    const { correr } = await montar(dataset());
    await correr({ hasta: 1 });

    const resumen = await correr({ hasta: 1, estado: estadoVacio() });

    expect(resumen.descargados).toBe(0);
    expect(resumen.omitidos).toBe(10);
  });

  it('si el archivo del manifiesto ya no está, se vuelve a bajar', async () => {
    const { correr, manifiesto } = await montar(dataset());
    await correr({ hasta: 1 });
    rmSync(join(dir, manifiesto[0]?.archivo ?? ''));

    const resumen = await correr({ hasta: 1 });

    expect(resumen.descargados).toBe(1);
  });

  it('--dry-run cuenta lo que bajaría y no toca el disco', async () => {
    const { correr, manifiesto } = await montar(dataset());
    const resumen = await correr({ hasta: 1, dryRun: true });

    expect(resumen.pendientes).toBe(10);
    expect(resumen.descargados).toBe(0);
    expect(archivos()).toEqual([]);
    expect(manifiesto).toEqual([]);
  });
});

describe('cuerpos que no son el documento', () => {
  it('un 200 con HTML no llega al disco y queda en la cola', async () => {
    const { correr, fallos, server } = await montar(dataset());
    server.desalinearDescargas();

    const resumen = await correr({ hasta: 1, maxInvalidasSeguidas: 99 });

    expect(resumen.descargados).toBe(0);
    expect(resumen.fallidos).toBe(10);
    expect(archivos()).toEqual([]);
    expect(fallos[0]).toMatchObject({ tipo: 'pdf', error: 'documento-magic', intentos: 1 });
    expect(fallos[0]?.contexto).toMatchObject({ pagina: 1 });
  });

  it('un cuerpo con el magic correcto pero de cuatro bytes tampoco pasa', async () => {
    const { correr, fallos, server } = await montar(dataset());
    server.descargasCortas();

    const resumen = await correr({ hasta: 1, maxInvalidasSeguidas: 99 });

    expect(resumen.fallidos).toBe(10);
    expect(fallos[0]?.error).toBe('documento-tamano');
    expect(archivos()).toEqual([]);
  });

  /**
   * Una sesión caída durante la descarga **no lanza**: contesta 200 con la página
   * de inicio. Sin este corte, la corrida sigue mil setecientas filas produciendo
   * cero PDFs y una cola que nadie va a poder consumir.
   */
  it('tres inválidas seguidas detienen la corrida como drift', async () => {
    const { correr, server } = await montar(dataset());
    server.desalinearDescargas();

    const promesa = correr({ hasta: 1 });

    await expect(promesa).rejects.toBeInstanceOf(StructuralDriftError);
    await expect(promesa).rejects.toMatchObject({ tipo: 'descarga-no-pdf' });
  });

  /**
   * Cuatro inválidas en una página de diez, pero nunca tres seguidas: la corrida
   * no se detiene. El contador mide una condición sostenida —la vista caída, el
   * POST que cambió de forma—, no un total; sin el reinicio, cualquier corrida
   * larga con fallos dispersos terminaría abortando por un umbral que nunca quiso
   * decir eso.
   */
  it('un éxito reinicia el contador de inválidas', async () => {
    const { correr, fallos, server } = await montar(dataset());
    server.descargasNoPdf([0, 1, 3, 4]);

    const resumen = await correr({ hasta: 1 });

    expect(resumen.fallidos).toBe(4);
    expect(resumen.descargados).toBe(6);
    expect(fallos.every((f) => f.error === 'documento-magic')).toBe(true);
  });
});

describe('fallos de transporte', () => {
  it('un 429 agota los reintentos y va a la cola sin detener la corrida', async () => {
    const { correr, fallos, server, metrics } = await montar(dataset());
    server.fallarDescargas(429);

    const resumen = await correr({ hasta: 1 });

    expect(resumen.fallidos).toBe(10);
    expect(fallos[0]).toMatchObject({ error: 'throttled', intentos: 5 });
    expect(metrics.snapshot().contadores['descargas.error.throttled']).toBe(10);
  });

  it('un 500 también, con su propio presupuesto', async () => {
    const { correr, fallos, server } = await montar(dataset());
    server.fallarDescargas(503);

    await correr({ hasta: 1 });

    expect(fallos[0]).toMatchObject({ error: 'server-unavailable', intentos: 4 });
  });

  /** §5.6: el 403 es una decisión de política del servidor, no una condición
   *  transitoria. Insistir es la vía más corta al ban de IP. */
  it('un 403 detiene la corrida entera', async () => {
    const { correr, server, fallos } = await montar(dataset());
    server.fallarDescargas(403);

    await expect(correr({ hasta: 1 })).rejects.toBeInstanceOf(AccessDeniedError);
    expect(fallos).toHaveLength(0);
  });

  it('el circuito abierto por degradación sostenida también', async () => {
    const { correr, server } = await montar(dataset(), { breaker: new CircuitBreaker() });
    server.fallarDescargas(503);

    await expect(correr({ hasta: 1 })).rejects.toBeInstanceOf(CircuitOpenError);
  });
});

describe('límites y barreras', () => {
  it('--max-descargas corta donde dice y no cierra la página', async () => {
    const { correr, completadas } = await montar(dataset());
    const resumen = await correr({ maxDescargas: 3 });

    expect(resumen.descargados).toBe(3);
    expect(resumen.limiteAlcanzado).toBe(true);
    // La página quedó a medias: darla por completada haría que el checkpoint se
    // saltee las filas que faltaban, y nadie se enteraría.
    expect(completadas).toEqual([]);
  });

  it('la página se marca completada solo cuando se procesó entera', async () => {
    const { correr, completadas } = await montar(dataset({ total: 25 }));
    await correr({ hasta: 3 });
    expect(completadas).toEqual([1, 2, 3]);
  });

  it('la interrupción corta en el borde de un documento', async () => {
    let bajados = 0;
    const { correr, completadas } = await montar(dataset());
    const resumen = await correr({ debeParar: () => ++bajados > 4 });

    expect(resumen.interrumpido).toBe(true);
    expect(resumen.descargados).toBeLessThan(10);
    expect(completadas).toEqual([]);
    // Lo que se alcanzó a bajar está entero: no hay temporales dando vueltas.
    expect(archivos().every((n) => !n.endsWith('.parcial'))).toBe(true);
  });

  it('el filtro deja pasar solo los registros pedidos', async () => {
    const { fuente, correr } = await montar(dataset());
    const [pagina] = await recolectar(fuente, { hasta: 1 });
    const elegido = pagina?.filas[6]?.registro.id ?? '';

    const resumen = await correr({ hasta: 1, filtro: (r) => r.id === elegido });

    expect(resumen.descargados).toBe(1);
    expect(resumen.registros).toBe(1);
    expect(archivos()).toHaveLength(1);
  });
});

describe('checkpoint obsoleto', () => {
  it('un total distinto al esperado corta antes de bajar nada', async () => {
    const { correr } = await montar(dataset({ total: 25 }));
    const resumen = await correr({ totalEsperado: 1753, desde: 2 });

    expect(resumen.totalCambio).toBe(true);
    expect(resumen.descargados).toBe(0);
    expect(archivos()).toEqual([]);
  });

  it('el total que coincide sigue de largo', async () => {
    const { correr } = await montar(dataset({ total: 25 }));
    const resumen = await correr({ totalEsperado: 25, desde: 3 });

    expect(resumen.totalCambio).toBe(false);
    expect(resumen.descargados).toBe(5);
  });
});

describe('nombres de archivo', () => {
  it('el identificador del documento va primero y el resto es legible', () => {
    const registro = { documentoUuid: 'abc', resolucion: '264-2012-OEFA/TFA' } as RegistroOefa;
    expect(nombreDeArchivoOefa(registro, 'abc')).toBe('abc_264-2012-oefa-tfa.pdf');
  });

  it('sin resolución cae al expediente, y sin ninguno de los dos al identificador solo', () => {
    const conExpediente = { expediente: '2007-053', resolucion: '' } as RegistroOefa;
    expect(nombreDeArchivoOefa(conExpediente, 'abc')).toBe('abc_2007-053.pdf');
    expect(nombreDeArchivoOefa({ expediente: '', resolucion: '' } as RegistroOefa, 'abc')).toBe(
      'abc.pdf',
    );
  });

  it('no deja escapar la barra del número de resolución a una ruta', () => {
    const registro = { resolucion: '../../etc/passwd' } as RegistroOefa;
    expect(nombreDeArchivoOefa(registro, 'abc')).toBe('abc_etc-passwd.pdf');
  });
});

describe('archivos a medio bajar', () => {
  it('no queda ningún .parcial después de una corrida con fallos', async () => {
    const { correr, server } = await montar(dataset());
    server.desalinearDescargas();

    await correr({ hasta: 1, maxInvalidasSeguidas: 99 });

    expect(existsSync(dir)).toBe(true);
    expect(archivos()).toEqual([]);
  });
});
