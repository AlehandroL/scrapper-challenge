/**
 * El adapter contra el portal falso, sobre sockets reales.
 *
 * Dos modos, y los dos hacen falta. Contra los **fixtures** se verifica que el
 * recorrido entiende el markup que el sitio produjo de verdad. Contra el dataset
 * **sintético** se verifican las condiciones que dos páginas de fixture no
 * pueden mostrar: la última página incompleta, un recorrido entero, y las nueve
 * formas de drift de §6.4 — cada una provocada a propósito, porque una aserción
 * que nunca se vio saltar es una aserción que no se sabe si funciona.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { CircuitBreaker } from '../src/http/circuit-breaker.ts';
import { RateLimiter } from '../src/http/rate-limiter.ts';
import { createSession } from '../src/http/session.ts';
import { silentLogger } from '../src/obs/logger.ts';
import { Metrics } from '../src/obs/metrics.ts';
import { JsfView, type JsfViewOptions } from '../src/jsf/view.ts';
import { createOefaSource } from '../src/sources/oefa.ts';
import {
  PaginaDesalineadaError,
  RangoInvalidoError,
  RecuperacionAgotadaError,
  SinDocumentoError,
  StructuralDriftError,
} from '../src/sources/errors.ts';
import type { RegistroOefa } from '../src/sources/oefa-rows.ts';
import type { Fuente, Pagina } from '../src/sources/types.ts';
import { startJsfServer, uuidSintetico, type JsfTestServer, type OpcionesDataset } from './helpers/jsf-server.ts';

let server: JsfTestServer;
let metrics: Metrics;

afterEach(async () => {
  await server.close();
});

/** Levanta el portal y cablea la fuente contra él. */
async function montar(
  dataset?: OpcionesDataset,
  opts: { pageSize?: number; maxRecuperaciones?: number } = {},
  vista: Partial<JsfViewOptions> = {},
): Promise<Fuente<RegistroOefa>> {
  server = await startJsfServer(dataset === undefined ? {} : { dataset });
  metrics = new Metrics();

  const session = createSession({
    limiter: new RateLimiter({ rps: 1000, burst: 100 }),
    breaker: new CircuitBreaker(),
    metrics,
    logger: silentLogger,
    retryHooks: { sleep: async () => {}, rng: () => 0 },
  });
  const view = new JsfView(
    { session, logger: silentLogger, metrics },
    { pageUrl: server.pageUrl, ...vista },
  );

  return createOefaSource({ view, logger: silentLogger, metrics }, opts);
}

const recolectar = async (fuente: Fuente<RegistroOefa>, opts = {}): Promise<Pagina<RegistroOefa>[]> => {
  const paginas: Pagina<RegistroOefa>[] = [];
  for await (const p of fuente.recorrer(opts)) paginas.push(p);
  return paginas;
};

/** El drift esperado, por su tipo: «falló» no distingue un selector de una sesión. */
const esperarDrift = async (promesa: Promise<unknown>, tipo: string): Promise<void> => {
  await expect(promesa).rejects.toBeInstanceOf(StructuralDriftError);
  await expect(promesa).rejects.toMatchObject({ tipo });
};

describe('recorrido contra los fixtures reales', () => {
  it('lee las dos páginas que los fixtures cubren', async () => {
    const fuente = await montar();
    const paginas = await recolectar(fuente, { hasta: 2 });

    expect(paginas).toHaveLength(2);
    expect(paginas[0]?.total).toBe(1753);
    expect(paginas[0]?.filas).toHaveLength(10);
    expect(paginas[1]?.filas[0]?.registro.indice).toBe(10);
    expect(paginas[0]?.esUltima).toBe(false);
  });

  it('produce registros completos con los campos del portal', async () => {
    const fuente = await montar();
    const [primera] = await recolectar(fuente, { hasta: 1 });
    const registro = primera?.filas[0]?.registro;

    expect(registro).toMatchObject({
      fuente: 'oefa',
      documentoUuid: '153a6d2a-cbed-40ef-b8ef-cd2272b19867',
      indice: 0,
      pagina: 1,
      expediente: '891-08-PRODUCE/DIGSECOVI-Dsvs',
      administrados: ['Corporación del Mar S.A.', 'Austral Group S.A.A.'],
      sector: 'Pesquería',
      resolucion: '264-2012-OEFA/TFA',
      anioResolucion: 2012,
    });
    expect(registro?.id).toMatch(/^[0-9a-f]{24}$/);
  });

  /**
   * La respuesta de la búsqueda ya trae la primera página: pedirla de nuevo
   * gastaría un POST por corrida y apostaría a que el servidor trata el offset 0
   * igual que los demás, que es lo único de la paginación que los fixtures no
   * verificaron.
   */
  it('la primera página sale de la búsqueda y no de un evento extra', async () => {
    const fuente = await montar();
    await recolectar(fuente, { hasta: 1 });

    expect(server.posts).toHaveLength(1);
    expect(server.posts[0]?.fields.get('javax.faces.source')).toBe('listarDetalleInfraccionRAAForm:btnBuscar');
  });

  /**
   * El servidor en modo fixture devuelve siempre las filas 10–19. Pedir la
   * página 3 es entonces el caso del `dt_first` ignorado, contra markup
   * auténtico y gratis.
   */
  it('detecta que el servidor devolvió otro offset', async () => {
    const fuente = await montar();
    await esperarDrift(recolectar(fuente, { hasta: 3 }), 'indices-desalineados');
  });
});

describe('recorrido completo sobre un dataset sintético', () => {
  it('recorre las tres páginas y cierra con la última incompleta', async () => {
    const fuente = await montar({ total: 23 });
    const paginas = await recolectar(fuente);

    expect(paginas.map((p) => p.filas.length)).toEqual([10, 10, 3]);
    expect(paginas.map((p) => p.esUltima)).toEqual([false, false, true]);
    expect(paginas.flatMap((p) => p.filas.map((f) => f.registro.indice))).toEqual(
      Array.from({ length: 23 }, (_, i) => i),
    );
  });

  it('numera las páginas desde 1 y los índices desde 0', async () => {
    const fuente = await montar({ total: 23 });
    const paginas = await recolectar(fuente);

    expect(paginas[2]?.numero).toBe(3);
    expect(paginas[2]?.first).toBe(20);
    expect(paginas[2]?.filas.map((f) => f.registro.pagina)).toEqual([3, 3, 3]);
  });

  it('cuenta páginas y registros en las métricas', async () => {
    const fuente = await montar({ total: 23 });
    await recolectar(fuente);

    expect(metrics.snapshot().contadores['sources.paginas']).toBe(3);
    expect(metrics.snapshot().contadores['sources.registros']).toBe(23);
  });

  it('un resultado vacío termina sin páginas y sin error', async () => {
    const fuente = await montar({ total: 0 });
    expect(await recolectar(fuente)).toEqual([]);
  });

  it('una única página es también la última', async () => {
    const fuente = await montar({ total: 4 });
    const paginas = await recolectar(fuente);
    expect(paginas).toHaveLength(1);
    expect(paginas[0]?.esUltima).toBe(true);
  });
});

describe('rango del recorrido', () => {
  it('respeta desde y hasta', async () => {
    const fuente = await montar({ total: 100 });
    const paginas = await recolectar(fuente, { desde: 3, hasta: 4 });
    expect(paginas.map((p) => p.numero)).toEqual([3, 4]);
  });

  it('salta directo al offset de la página inicial', async () => {
    const fuente = await montar({ total: 100 });
    await recolectar(fuente, { desde: 5, hasta: 5 });

    const paginacion = server.posts.filter((p) => p.fields.get('javax.faces.behavior.event') === 'page');
    expect(paginacion).toHaveLength(1);
    expect(paginacion[0]?.fields.get('listarDetalleInfraccionRAAForm:dt_first')).toBe('40');
  });

  /** `--hasta 9999` es la forma natural de decir «todas» desde una terminal. */
  it('acota un «hasta» que se pasa del final', async () => {
    const fuente = await montar({ total: 23 });
    expect(await recolectar(fuente, { hasta: 9999 })).toHaveLength(3);
  });

  it.each([
    [{ desde: 0 }],
    [{ desde: 99 }],
    [{ desde: 3, hasta: 2 }],
  ])('rechaza el rango %j', async (opts) => {
    const fuente = await montar({ total: 23 });
    await expect(recolectar(fuente, opts)).rejects.toBeInstanceOf(RangoInvalidoError);
  });
});

describe('detección de drift (§6.4)', () => {
  /**
   * §2.5 con precisión: la **búsqueda** funciona sin cookie —es autocontenida—
   * pero los resultados quedan en un bean de sesión, así que la **paginación**
   * contesta 200 con la tabla vacía. Sin excepción y sin error: el peor modo de
   * falla del proyecto, y el que el adapter existe para convertir en ruido.
   */
  it('la tabla vacía por sesión perdida no pasa como cero filas', async () => {
    const fuente = await montar({ total: 23 }, {}, { requireSessionCookie: false });
    server.dropSessions();

    const it = fuente.recorrer()[Symbol.asyncIterator]();
    const primera = await it.next();
    expect(primera.value?.filas).toHaveLength(10);

    await esperarDrift(it.next(), 'sin-filas');
  });

  it('una página incompleta que no es la última', async () => {
    const fuente = await montar({ total: 23, filasPorRespuesta: 8 });
    await esperarDrift(recolectar(fuente), 'pagina-incompleta');
  });

  it('el servidor que ignora el offset pedido', async () => {
    const fuente = await montar({ total: 23, offsetFijo: 0 });
    await esperarDrift(recolectar(fuente), 'indices-desalineados');
  });

  /**
   * Los `data-ri` llegan correctos y el contenido es el de otra página. Es el
   * caso que el chequeo de índices no puede ver y que solo el solapamiento de
   * identificadores detecta — el chequeo que §6.3 pide explícitamente.
   */
  it('los índices correctos con el contenido de otra página', async () => {
    const fuente = await montar({ total: 23, uuidsDesde: 0 });
    await esperarDrift(recolectar(fuente), 'solapamiento');
  });

  /**
   * Dos filas que comparten documento **no** son un duplicado: la página 28 del
   * sitio real trae dos unidades fiscalizables bajo la misma resolución. La
   * primera versión de este adapter detenía la corrida ahí; ahora la identidad
   * sale del contenido y las dos filas son legítimamente distintas.
   */
  it('dos filas con el mismo documento no detienen la corrida', async () => {
    const fuente = await montar({ total: 23, documentoCompartido: [5] });
    const paginas = await recolectar(fuente);
    const filas = paginas.flatMap((p) => p.filas);

    expect(filas).toHaveLength(23);
    // Comparten documento y **no** identidad: se distinguen por su contenido,
    // igual que las dos unidades fiscalizables de la página 28 del sitio real.
    expect(new Set(filas.map((f) => f.registro.id)).size).toBe(23);
    expect(new Set(filas.map((f) => f.registro.documentoUuid)).size).toBe(22);
  });

  /** Una fila idéntica repetida no aporta información: se avisa y se sigue. */
  it('una fila idéntica repetida avisa pero no detiene', async () => {
    const fuente = await montar({ total: 23, filasIdenticas: [5] });
    const paginas = await recolectar(fuente);

    expect(paginas.flatMap((p) => p.filas)).toHaveLength(23);
    expect(metrics.snapshot().contadores['sources.filas_identicas']).toBe(1);
  });

  /**
   * La corrida real trajo una página con la misma fila **tres** veces (offsets
   * 520, 521 y 522). Informar solo la primera repetición haría pensar que faltó
   * un registro cuando faltaron dos.
   */
  it('cuenta todas las repeticiones de una página, no solo la primera', async () => {
    const fuente = await montar({ total: 23, filasIdenticas: [5, 6] });
    await recolectar(fuente);

    expect(metrics.snapshot().contadores['sources.filas_identicas']).toBe(2);
  });

  it('un cambio en la cantidad de columnas', async () => {
    const fuente = await montar({ total: 23, columnas: 6 });
    await esperarDrift(recolectar(fuente), 'columnas');
  });

  it('la numeración que dejó de seguir al índice', async () => {
    const fuente = await montar({ total: 23, nroCorrido: true });
    await esperarDrift(recolectar(fuente), 'numeracion');
  });

  /**
   * Un enlace que está y no se deja leer significa que cambió la forma del
   * `onclick`. Es lo único que la ausencia de enlace **no** significa.
   */
  it('un enlace de descarga con la forma cambiada', async () => {
    const fuente = await montar({ total: 23, onclickRoto: [4] });
    await esperarDrift(recolectar(fuente), 'sin-uuid');
  });

  it('la búsqueda que no reporta el total', async () => {
    const fuente = await montar({ total: 23, sinTotal: true });
    await esperarDrift(recolectar(fuente), 'sin-total');
  });

  /** Con el tamaño equivocado todos los offsets quedan corridos. */
  it('el tamaño de página declarado que no coincide con el configurado', async () => {
    const fuente = await montar({ total: 100, pageSize: 20 }, { pageSize: 10 });
    await esperarDrift(recolectar(fuente), 'page-size');
  });

  /**
   * Los rótulos cambian por una tilde o un renombre editorial sin que cambie
   * nada más. Que tumben la corrida es cómo se llega a que alguien desactive el
   * chequeo; se avisa y se sigue.
   */
  it('los rótulos cambiados avisan pero no detienen', async () => {
    const cabeceras = ['Nro.', 'N° de expediente', 'Administrado', 'Unidad', 'Sector', 'Resolución', 'Archivo'];
    const fuente = await montar({ total: 12, cabeceras });

    expect(await recolectar(fuente)).toHaveLength(2);
    expect(metrics.snapshot().contadores['sources.drift_warn']).toBeGreaterThan(0);
  });
});

describe('recuperación de la vista caída (§5.1)', () => {
  it('reconstruye, rehace la búsqueda y termina el recorrido', async () => {
    const fuente = await montar({ total: 23 });
    server.expirarEnOffset(10);

    const paginas = await recolectar(fuente);

    expect(paginas.map((p) => p.filas.length)).toEqual([10, 10, 3]);
    const contadores = metrics.snapshot().contadores;
    expect(contadores['sources.recuperaciones']).toBe(1);
    // Dos bootstraps: el inicial y el de `recover()`. Y dos búsquedas, porque
    // rehacer el estado de aplicación es del adapter y no de `jsf/`.
    expect(contadores['jsf.bootstraps']).toBe(2);
    expect(contadores['sources.busquedas']).toBe(2);
  });

  it('la generación sube y las páginas posteriores la reflejan', async () => {
    const fuente = await montar({ total: 23 });
    server.expirarEnOffset(10);
    const paginas = await recolectar(fuente);

    expect(paginas[0]?.generacion).toBe(1);
    expect(paginas[1]?.generacion).toBe(2);
  });

  /**
   * El tope por offset es el que evita el ciclo: sin él, una vista que expira
   * determinísticamente en la misma página se recupera una y otra vez gastando
   * un bootstrap y una búsqueda por vuelta para volver a fallar igual.
   */
  it('se rinde si el mismo offset falla después de recuperarse', async () => {
    const fuente = await montar({ total: 23 });
    server.expirarEnOffset(10, Infinity);

    const error = await recolectar(fuente).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RecuperacionAgotadaError);
    expect(error).toMatchObject({ motivo: 'mismo-offset' });
  });

  it('agota el presupuesto tras varias recuperaciones en offsets distintos', async () => {
    const fuente = await montar({ total: 100 }, { maxRecuperaciones: 1 });
    const it = fuente.recorrer()[Symbol.asyncIterator]();
    await it.next();

    server.expirarEnOffset(10);
    await it.next();
    server.expirarEnOffset(20);

    await expect(it.next()).rejects.toMatchObject({ motivo: 'presupuesto' });
  });

  /**
   * Un total distinto tras la re-búsqueda invalida todos los offsets que
   * quedaban: seguir produce un archivo con huecos que parece completo.
   */
  it('detecta que el total cambió entre búsquedas', async () => {
    const fuente = await montar({ total: 100 });
    const it = fuente.recorrer()[Symbol.asyncIterator]();
    await it.next();

    server.ajustarDataset({ total: 300 });
    server.expirarEnOffset(10);

    await expect(it.next()).rejects.toMatchObject({ tipo: 'total-inestable' });
  });

  /** El drift no se cura reintentando: sale derecho sin gastar recuperaciones. */
  it('no intenta recuperarse de un drift estructural', async () => {
    const fuente = await montar({ total: 23, columnas: 5 });

    await esperarDrift(recolectar(fuente), 'columnas');
    expect(metrics.snapshot().contadores['sources.recuperaciones']).toBeUndefined();
  });
});

describe('el seam de descarga (§5.4)', () => {
  it('arma el POST no-ajax con el token de la página de la fila', async () => {
    const fuente = await montar({ total: 23 });
    const [primera] = await recolectar(fuente, { hasta: 1 });
    const fila = primera?.filas[0];
    if (primera === undefined || fila === undefined) throw new Error('sin página');

    const req = fuente.prepararDescarga(primera, fila);

    expect(req.body.get('javax.faces.ViewState')).toBe(primera.viewState);
    expect(req.body.get('param_uuid')).toBe(uuidSintetico(0));
    // Un `javax.faces.partial.*` o un `Faces-Request` convierten la descarga en
    // una página re-renderizada.
    expect(req.body.get('javax.faces.partial.ajax')).toBeNull();
    expect(Object.keys(req.headers)).toEqual(['Referer']);
  });

  it('el token de la página sigue sirviendo después de avanzar', async () => {
    const fuente = await montar({ total: 23 });
    const paginas = await recolectar(fuente);
    const primera = paginas[0];
    const fila = primera?.filas[0];
    if (primera === undefined || fila === undefined) throw new Error('sin página');

    // Verificado en §2.5: el PDF de la fila 0 se bajó con la sesión ya en la
    // página 2. Lo que invalida el token es `recover()`, no avanzar.
    expect(() => fuente.prepararDescarga(primera, fila)).not.toThrow();
  });

  it('rechaza una página emitida antes de una recuperación', async () => {
    const fuente = await montar({ total: 23 });
    const it = fuente.recorrer()[Symbol.asyncIterator]();
    const primera = (await it.next()).value;
    server.expirarEnOffset(10);
    await it.next();

    const fila = primera?.filas[0];
    if (primera === undefined || fila === undefined) throw new Error('sin página');

    expect(() => fuente.prepararDescarga(primera, fila)).toThrow(PaginaDesalineadaError);
    expect(() => fuente.prepararDescarga(primera, fila)).toThrow(/generación/);
  });

  it('rechaza pedir el documento de una fila que no lo tiene', async () => {
    const fuente = await montar({ total: 23, filasSinDocumento: [3] });
    const [primera] = await recolectar(fuente, { hasta: 1 });
    const fila = primera?.filas.find((f) => f.registro.indice === 3);
    if (primera === undefined || fila === undefined) throw new Error('sin página');

    expect(fila.descarga).toBeUndefined();
    expect(() => fuente.prepararDescarga(primera, fila)).toThrow(SinDocumentoError);
  });

  it('rechaza cruzar la fila de una página con el token de otra', async () => {
    const fuente = await montar({ total: 23 });
    const paginas = await recolectar(fuente);
    const primera = paginas[0];
    const filaDeOtra = paginas[1]?.filas[0];
    if (primera === undefined || filaDeOtra === undefined) throw new Error('sin páginas');

    expect(() => fuente.prepararDescarga(primera, filaDeOtra)).toThrow(PaginaDesalineadaError);
  });
});

/**
 * El hallazgo de la primera corrida completa contra el sitio real: la página 4
 * trae dos resoluciones publicadas como «Información confidencial», sin enlace
 * de descarga. Con la aserción original —«toda fila tiene uuid»— la corrida se
 * detenía ahí, en el registro 37 de 1.753.
 *
 * Son registros legítimos y se persisten; lo que no tienen es documento. La
 * distinción vive en el tipo, así que el bloque 5 no puede olvidarse de ella.
 */
describe('registros sin documento', () => {
  it('se recorren y se persisten como cualquier otro', async () => {
    const fuente = await montar({ total: 23, filasSinDocumento: [3, 4] });
    const paginas = await recolectar(fuente);

    expect(paginas.flatMap((p) => p.filas)).toHaveLength(23);
    expect(metrics.snapshot().contadores['sources.sin_documento']).toBe(2);
  });

  it('conservan sus campos y quedan sin identificador de documento', async () => {
    const fuente = await montar({ total: 23, filasSinDocumento: [3] });
    const [primera] = await recolectar(fuente, { hasta: 1 });
    const registro = primera?.filas.find((f) => f.registro.indice === 3)?.registro;

    expect(registro?.documentoUuid).toBeUndefined();
    expect(registro?.sector).toBe('Pesquería');
    expect(registro?.expediente).not.toBe('');
  });

  /**
   * La identidad no puede ser el `indice`: es la posición dentro del resultado y
   * se corre entera en cuanto el organismo publica algo nuevo, así que la
   * corrida siguiente duplicaría todo lo desplazado. Se deriva del contenido y
   * se marca como tal.
   */
  it('reciben una identidad igual que cualquier otro registro', async () => {
    const fuente = await montar({ total: 23, filasSinDocumento: [3] });
    const [primera] = await recolectar(fuente, { hasta: 1 });
    const registro = primera?.filas.find((f) => f.registro.indice === 3)?.registro;

    expect(registro?.id).toMatch(/^[0-9a-f]{24}$/);
  });

  it('la fila con documento conserva el uuid del sitio como atributo', async () => {
    const fuente = await montar({ total: 23, filasSinDocumento: [3] });
    const [primera] = await recolectar(fuente, { hasta: 1 });
    const registro = primera?.filas[0]?.registro;

    expect(registro?.documentoUuid).toBe(uuidSintetico(0));
    // La identidad es propia y no el uuid del sitio: ese se repite entre filas.
    expect(registro?.id).not.toBe(uuidSintetico(0));
  });
});
