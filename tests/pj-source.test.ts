/**
 * El adapter del Poder Judicial contra el portal falso, sobre sockets reales.
 *
 * Estos tests **no prueban que el portal se comporte así**. Ningún snapshot del
 * archivo web trae filas de resultado ni paginación (`fixtures/pj/README.md`),
 * así que el portal falso modela la forma que §2.1 documenta a partir de un
 * scraper público. Lo que prueban es dos cosas que sí valen:
 *
 * 1. Que el adapter hace lo correcto **si** esa forma es la buena.
 * 2. Que ante cada desviación se detiene con el error que nombra la causa, en vez
 *    de escribir un dataset con huecos. Eso último es universal: no depende de
 *    haber acertado la forma.
 *
 * El aporte propio de esta suite es el **LRU de vistas**. El state saving del
 * portal es server-side (verificado en tres snapshots), así que el servidor
 * conserva un número acotado de vistas y desaloja las viejas. En OEFA eso no
 * puede pasar —el token es un blob autocontenido— y `recover()` solo se podía
 * probar corrompiendo el token a mano. Acá la expiración ocurre sola, recorriendo
 * páginas, que es como ocurre en producción.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { CircuitBreaker } from '../src/http/circuit-breaker.ts';
import { RateLimiter } from '../src/http/rate-limiter.ts';
import { createSession } from '../src/http/session.ts';
import { JsfView } from '../src/jsf/view.ts';
import { silentLogger } from '../src/obs/logger.ts';
import { Metrics } from '../src/obs/metrics.ts';
import {
  PaginaDesalineadaError,
  RangoInvalidoError,
  RecuperacionAgotadaError,
  SinDocumentoError,
  StructuralDriftError,
} from '../src/sources/errors.ts';
import { createPjSource } from '../src/sources/pj.ts';
import type { RegistroPj } from '../src/sources/pj-rows.ts';
import type { Fuente, Pagina } from '../src/sources/types.ts';
import { FORM_DETALLE, startPortalPj, type OpcionesPortalPj, type PortalPj } from './helpers/pj-server.ts';

let portal: PortalPj;
let metrics: Metrics;

afterEach(async () => {
  await portal.close();
});

async function montar(
  dataset: OpcionesPortalPj,
  opts: { pageSize?: number; maxRecuperaciones?: number } = {},
): Promise<Fuente<RegistroPj>> {
  portal = await startPortalPj({ dataset });
  metrics = new Metrics();

  const session = createSession({
    limiter: new RateLimiter({ rps: 1000, burst: 100 }),
    breaker: new CircuitBreaker(),
    metrics,
    logger: silentLogger,
    retryHooks: { sleep: async () => {}, rng: () => 0 },
  });
  const view = new JsfView({ session, logger: silentLogger, metrics }, { pageUrl: portal.pageUrl });

  return createPjSource({ view, logger: silentLogger, metrics }, opts);
}

const recorrer = async (fuente: Fuente<RegistroPj>, opts = {}): Promise<Pagina<RegistroPj>[]> => {
  const paginas: Pagina<RegistroPj>[] = [];
  for await (const p of fuente.recorrer(opts)) paginas.push(p);
  return paginas;
};

describe('recorrido', () => {
  it('descubre la búsqueda, pagina y numera las filas de forma global', async () => {
    const fuente = await montar({ total: 25 });
    const paginas = await recorrer(fuente);

    expect(paginas).toHaveLength(3);
    expect(paginas.map((p) => p.filas.length)).toEqual([10, 10, 5]);
    expect(paginas.map((p) => p.numero)).toEqual([1, 2, 3]);
    expect(paginas.every((p) => p.total === 25)).toBe(true);
    expect(paginas.at(-1)?.esUltima).toBe(true);

    // El portal numera por página (`repeat:0` en cada una); el registro lleva el
    // índice global, que es la coordenada que sirve para localizar la fila.
    expect(paginas.flatMap((p) => p.filas.map((f) => f.registro.indice))).toEqual(
      Array.from({ length: 25 }, (_, i) => i),
    );
  });

  it('el POST de búsqueda no lleva ninguna cabecera ni parámetro de ajax', async () => {
    const fuente = await montar({ total: 10 });
    await recorrer(fuente);

    const busqueda = portal.posts[0];
    expect(busqueda).toBeDefined();
    expect([...(busqueda?.keys() ?? [])].filter((k) => k.startsWith('javax.faces.partial'))).toEqual([]);
    // Y sí lleva el form completo, que es lo que JSF exige.
    expect(busqueda?.get(`formBuscador:txtBusqueda`)).toBe('');
    expect(busqueda?.get('javax.faces.ViewState')).toMatch(/^\d+:-\d+$/);
  });

  it('rotula las celdas con los encabezados de la tabla', async () => {
    const fuente = await montar({ total: 3 });
    const [pagina] = await recorrer(fuente);

    expect(Object.keys(pagina?.filas[0]?.registro.campos ?? {})).toEqual([
      'Nro.',
      'Órgano jurisdiccional',
      'Materia',
      'Sumilla',
      'Resolución',
    ]);
    expect(pagina?.filas[0]?.registro.campos['Materia']).toBe('Penal');
  });

  it('deriva el tamaño de página de la primera y no de un supuesto', async () => {
    const fuente = await montar({ total: 12, pageSize: 4 });
    const paginas = await recorrer(fuente);

    expect(paginas.map((p) => p.filas.length)).toEqual([4, 4, 4]);
    expect(paginas.map((p) => p.first)).toEqual([0, 4, 8]);
  });

  it('el rango se recorre desde la 1 porque la paginación es relativa', async () => {
    const fuente = await montar({ total: 30 });
    const paginas = await recorrer(fuente, { desde: 3 });

    // Emite solo la pedida...
    expect(paginas.map((p) => p.numero)).toEqual([3]);
    // ...pero pasó por las dos anteriores, que es lo único correcto con un
    // comando de «siguiente». El contador lo deja a la vista.
    expect(metrics.snapshot().contadores['sources.paginas_descartadas']).toBe(2);
    expect(portal.hits['paginacion']).toBe(2);
  });

  it('un rango pedido de más se acota a la última página', async () => {
    const fuente = await montar({ total: 12 });
    expect((await recorrer(fuente, { hasta: 9999 })).map((p) => p.numero)).toEqual([1, 2]);
  });

  it.each([
    ['desde 0', { desde: 0 }],
    ['desde más allá de la última', { desde: 99 }],
    ['hasta menor que desde', { desde: 3, hasta: 2 }],
  ])('rechaza un rango inválido: %s', async (_caso, opts) => {
    const fuente = await montar({ total: 12 });
    await expect(recorrer(fuente, opts)).rejects.toBeInstanceOf(RangoInvalidoError);
  });

  it('dos recorridos sobre la misma instancia no se pisan el estado', async () => {
    const fuente = await montar({ total: 12 });
    await recorrer(fuente);
    // Sin reiniciar las identidades vistas, la página 1 del segundo recorrido se
    // denunciaría como solapamiento.
    expect((await recorrer(fuente)).map((p) => p.numero)).toEqual([1, 2]);
  });
});

describe('descubrimiento del protocolo', () => {
  it('lee el onclick envuelto en jsf.util.chain, que es como el portal lo emite', async () => {
    const fuente = await montar({ total: 3 });
    const [pagina] = await recorrer(fuente);

    const fila = pagina?.filas[0];
    expect(fila?.descarga).toEqual({
      'formBuscador:repeat:0:j_idt158': 'formBuscador:repeat:0:j_idt158',
      uuid: 'uuid-0',
    });
    expect(fila?.registro.documentoUuid).toBe('uuid-0');
  });

  /**
   * La diferencia estructural con OEFA: el documento no sale por el form de
   * búsqueda. Mandarlo ahí produciría un `200` con la página re-renderizada, o
   * sea el síntoma de §5.4 con otra causa.
   */
  it('el POST del documento va al form que el onclick nombra, no al de la vista', async () => {
    const fuente = await montar({ total: 3 });
    const [pagina] = await recorrer(fuente);
    const fila = pagina?.filas[0];

    expect(fila?.formulario).toBe(FORM_DETALLE);

    const req = fuente.prepararDescarga(pagina!, fila!);
    // El cuerpo lleva el campo identificador de `frmDetalle2`, no el de búsqueda.
    expect(req.body.get(FORM_DETALLE)).toBe(FORM_DETALLE);
    expect(req.body.get('formBuscador:txtBusqueda')).toBeNull();
    expect(req.body.get('javax.faces.ViewState')).toBe(pagina?.viewState);
  });

  it('una fila sin enlace es un dato del sitio y se persiste igual', async () => {
    const fuente = await montar({ total: 3, filasSinDocumento: [1] });
    const [pagina] = await recorrer(fuente);

    expect(pagina?.filas).toHaveLength(3);
    expect(pagina?.filas[1]?.descarga).toBeUndefined();
    expect(pagina?.filas[1]?.registro.documentoUuid).toBeUndefined();
    // Y sigue siendo un registro con contenido, no un hueco.
    expect(pagina?.filas[1]?.registro.texto).toContain('Sumilla');
    expect(metrics.snapshot().contadores['sources.sin_documento']).toBe(1);
  });

  it('pedir el documento de una fila que no lo tiene lanza en vez de emitir el POST', async () => {
    const fuente = await montar({ total: 3, filasSinDocumento: [1] });
    const [pagina] = await recorrer(fuente);

    expect(() => fuente.prepararDescarga(pagina!, pagina!.filas[1]!)).toThrow(SinDocumentoError);
  });

  it('una fila con el onclick ilegible sí es drift: cambió la forma del comando', async () => {
    const fuente = await montar({ total: 3, onclickRoto: [1] });
    await expect(recorrer(fuente)).rejects.toMatchObject({ tipo: 'sin-uuid' });
  });

  it('rechaza descargar una fila que no pertenece a la página', async () => {
    const fuente = await montar({ total: 25 });
    const paginas = await recorrer(fuente);

    expect(() => fuente.prepararDescarga(paginas[0]!, paginas[1]!.filas[0]!)).toThrow(PaginaDesalineadaError);
  });
});

describe('drift', () => {
  it('sin el control «Buscar» no adivina: lo dice', async () => {
    // Es el caso del snapshot de 2025, donde la celda del botón viene vacía
    // porque el portal lo renderiza condicionalmente.
    const fuente = await montar({ total: 12, sinBotonBuscar: true });
    await expect(recorrer(fuente)).rejects.toMatchObject({ tipo: 'busqueda-no-descubierta' });
  });

  it('sin iterador de resultados se detiene: así se reconocen las filas', async () => {
    const fuente = await montar({ total: 12, sinIterador: true });
    await expect(recorrer(fuente)).rejects.toMatchObject({ tipo: 'sin-iterador' });
  });

  it('sin total declarado se detiene: sin total no hay última página', async () => {
    const fuente = await montar({ total: 12, sinTotal: true });
    await expect(recorrer(fuente)).rejects.toMatchObject({ tipo: 'sin-total' });
  });

  it('sin control de paginación se detiene en vez de dar la corrida por completa', async () => {
    const fuente = await montar({ total: 30, sinPaginacion: true });
    await expect(recorrer(fuente)).rejects.toMatchObject({ tipo: 'paginacion-no-descubierta' });
  });

  it('índices que no arrancan donde corresponde se denuncian', async () => {
    const fuente = await montar({ total: 12, indicesCorridos: 5 });
    await expect(recorrer(fuente)).rejects.toMatchObject({ tipo: 'indices-desalineados' });
  });

  /**
   * El oráculo que importa cuando la paginación es relativa: si el servidor no
   * avanzó, los índices siguen alineados —arrancan en 0 igual— y lo único que lo
   * delata es que las identidades ya se vieron.
   */
  it('una paginación que no avanza se detecta por solapamiento', async () => {
    const fuente = await montar({ total: 30, noAvanza: true });
    await expect(recorrer(fuente)).rejects.toMatchObject({ tipo: 'solapamiento' });
  });

  it('sin cookie de sesión el bootstrap falla y no recorre 30 páginas vacías', async () => {
    portal = await startPortalPj({ dataset: { total: 12 } });
    portal.dropSessions();

    const session = createSession({
      limiter: new RateLimiter({ rps: 1000, burst: 100 }),
      breaker: new CircuitBreaker(),
      metrics: new Metrics(),
      logger: silentLogger,
      retryHooks: { sleep: async () => {}, rng: () => 0 },
    });
    const view = new JsfView({ session, logger: silentLogger, metrics: new Metrics() }, { pageUrl: portal.pageUrl });
    const fuente = createPjSource({ view, logger: silentLogger, metrics: new Metrics() });

    await expect(recorrer(fuente)).rejects.toMatchObject({ kind: 'bootstrap' });
  });

  it('filas idénticas dentro de una página avisan, no detienen', async () => {
    const fuente = await montar({ total: 6, filasIdenticas: [3] });
    const paginas = await recorrer(fuente);

    expect(paginas[0]?.filas).toHaveLength(6);
    expect(metrics.snapshot().contadores['sources.filas_identicas']).toBe(1);
  });
});

/**
 * La vista caída, que es lo que el state saving server-side hace posible.
 *
 * En OEFA el token es un blob base64 autocontenido: el servidor no guarda nada y
 * no hay nada que perder, así que la expiración solo se podía provocar
 * corrompiendo el token a mano. Acá el servidor **sí** guarda la vista, y cuando
 * la pierde —sesión caducada, contenedor reciclado, LRU lleno por otro trabajo de
 * la misma sesión— lo anuncia de la peor forma posible: `200`, la página de
 * inicio, ninguna excepción y ningún XML donde poner una señal.
 *
 * Que el adapter distinga eso de «el portal cambió» es lo que estos tests miden.
 */
describe('vista caída (state saving server-side)', () => {
  it('el LRU desaloja vistas viejas sin que un recorrido secuencial lo note', async () => {
    // El recorrido siempre emite con el token más nuevo, así que el desalojo
    // ocurre y no le toca. Vale aseverarlo: es la razón por la que la expiración
    // se modela aparte y no bajando `vistasRetenidas`.
    const fuente = await montar({ total: 40, vistasRetenidas: 2 });
    const paginas = await recorrer(fuente);

    expect(portal.desalojos()).toBeGreaterThan(0);
    expect(paginas).toHaveLength(4);
    expect(metrics.snapshot().contadores['sources.recuperaciones']).toBeUndefined();
  });

  it('se recupera de una sesión que caduca a mitad de corrida', async () => {
    const fuente = await montar({ total: 40, expirarEnPagina: 2 });
    const paginas = await recorrer(fuente);

    expect(metrics.snapshot().contadores['jsf.view_expired']).toBe(1);
    expect(metrics.snapshot().contadores['sources.recuperaciones']).toBe(1);

    // Y el dataset sale entero, en orden y sin repetidos pese a la reconstrucción.
    const indices = paginas.flatMap((p) => p.filas.map((f) => f.registro.indice));
    expect(indices).toEqual(Array.from({ length: 40 }, (_, i) => i));
    expect(new Set(paginas.flatMap((p) => p.filas.map((f) => f.registro.id))).size).toBe(40);
  });

  it('la recuperación rehace la búsqueda y vuelve a avanzar hasta donde estaba', async () => {
    const fuente = await montar({ total: 40, expirarEnPagina: 3 });
    await recorrer(fuente);

    // Un bootstrap y una búsqueda de más: si el adapter repaginara sin volver a
    // buscar, el bean llegaría vacío y la tabla saldría sin filas.
    expect(portal.hits['bootstrap']).toBe(2);
    expect(portal.hits['busqueda']).toBe(2);
  });

  it('el presupuesto de recuperaciones corta en vez de ciclar para siempre', async () => {
    const fuente = await montar({ total: 60, expirarEnPagina: 2, expirarVeces: 9 }, { maxRecuperaciones: 2 });
    await expect(recorrer(fuente)).rejects.toBeInstanceOf(RecuperacionAgotadaError);
  });

  it('una página leída antes del recover ya no sirve para descargar', async () => {
    const fuente = await montar({ total: 40, expirarEnPagina: 2 });
    const paginas = await recorrer(fuente);

    // La generación de la vista subió con la reconstrucción: el token de la
    // primera página ya no restaura esas filas, y pedir su documento con él
    // devolvería la página re-renderizada en vez del PDF (§5.4).
    expect(paginas[0]?.generacion).toBe(1);
    expect(() => fuente.prepararDescarga(paginas[0]!, paginas[0]!.filas[0]!)).toThrow(PaginaDesalineadaError);
    // La última, en cambio, se leyó con la vista vigente y sí sirve.
    const ultima = paginas.at(-1)!;
    expect(() => fuente.prepararDescarga(ultima, ultima.filas[0]!)).not.toThrow();
  });
});

describe('esquema del registro', () => {
  it('el texto de la fila es la base de la identidad y es estable', async () => {
    const primera = await montar({ total: 3 });
    const a = await recorrer(primera);
    await portal.close();

    const segunda = await montar({ total: 3 });
    const b = await recorrer(segunda);

    expect(a[0]?.filas.map((f) => f.registro.id)).toEqual(b[0]?.filas.map((f) => f.registro.id));
  });

  it('todos los registros pasan el esquema antes de emitirse', async () => {
    const fuente = await montar({ total: 12 });
    const paginas = await recorrer(fuente);

    for (const pagina of paginas) {
      for (const { registro } of pagina.filas) {
        expect(registro.fuente).toBe('pj');
        expect(registro.id).toMatch(/^[0-9a-f]{24}$/);
        expect(registro.texto.length).toBeGreaterThan(0);
        expect(new Date(registro.capturadoEn).toString()).not.toBe('Invalid Date');
      }
    }
    expect(paginas.flatMap((p) => p.filas)).toHaveLength(12);
  });

  it('no lanza StructuralDriftError en el camino feliz', async () => {
    const fuente = await montar({ total: 25 });
    const paginas = await recorrer(fuente);
    expect(paginas).toHaveLength(3);
    expect(Object.keys(metrics.snapshot().contadores).filter((k) => k.startsWith('sources.drift.'))).toEqual([]);
    expect(StructuralDriftError.name).toBe('StructuralDriftError');
  });
});
