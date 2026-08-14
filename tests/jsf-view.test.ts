/**
 * `JsfView` sobre sockets reales, contra el portal JSF falso.
 *
 * Lo que se ejercita acá es lo que ningún test puro puede: que el cuerpo que
 * sale por el cable tenga la forma correcta, que el cookie jar propague la
 * sesión, y que las señales de sesión caída se conviertan en excepciones en vez
 * de en cero filas.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CircuitBreaker } from '../src/http/circuit-breaker.ts';
import { RateLimiter } from '../src/http/rate-limiter.ts';
import { createSession, type Session } from '../src/http/session.ts';
import { withRetry } from '../src/http/retry.ts';
import { silentLogger } from '../src/obs/logger.ts';
import { Metrics } from '../src/obs/metrics.ts';
import { pageCommand } from '../src/jsf/datatable.ts';
import { BootstrapError, NotPartialResponseError, ViewExpiredError, isRecoverable } from '../src/jsf/errors.ts';
import { JsfView, type JsfViewOptions } from '../src/jsf/view.ts';
import { RUTA_VISTA, startJsfServer, type JsfTestServer } from './helpers/jsf-server.ts';

const FORM_ID = 'listarDetalleInfraccionRAAForm';
const TABLE_ID = `${FORM_ID}:dt`;

let server: JsfTestServer;
let metrics: Metrics;

beforeEach(async () => {
  server = await startJsfServer();
  metrics = new Metrics();
});

afterEach(() => server.close());

function sesion(): Session {
  return createSession({
    limiter: new RateLimiter({ rps: 1000, burst: 100 }),
    breaker: new CircuitBreaker(),
    metrics,
    logger: silentLogger,
    retryHooks: { sleep: async () => {}, rng: () => 0 },
  });
}

function vista(opts: Partial<JsfViewOptions> = {}): JsfView {
  return new JsfView(
    { session: sesion(), logger: silentLogger, metrics },
    { pageUrl: server.pageUrl, ...opts },
  );
}

const paginar = (first: number) => pageCommand({ tableId: TABLE_ID, first, rows: 10 });

describe('bootstrap', () => {
  it('deja el form, los campos y el token', async () => {
    const v = vista();
    const form = await v.bootstrap();

    expect(form.id).toBe(FORM_ID);
    expect(form.campos.size).toBe(7);
    expect(v.viewState).toBe(server.tokenActual());
    expect(v.snapshot().generation).toBe(1);
  });

  /**
   * El fixture trae el `action` reescrito con `;jsessionid=`. Que el POST llegue
   * a la ruta limpia lo prueba **en el cable**, no en una string: `pathname`
   * conserva los parámetros de path, así que si no se hubiera quitado, esta
   * igualdad fallaría.
   */
  it('el POST no lleva el jsessionid en la URL', async () => {
    const v = vista();
    await v.bootstrap();
    await v.submitAjax(paginar(0));

    expect(server.pageUrl).toContain(RUTA_VISTA);
    expect(v.form!.action.endsWith(RUTA_VISTA)).toBe(true);
    expect(server.posts[0]!.path).toBe(RUTA_VISTA);
  });

  /**
   * §2.5 convertido en excepción. Sin sesión propagada la paginación devuelve
   * 200 con la tabla vacía y sin error: más vale fallar acá.
   */
  it('sin cookie de sesión falla duro, no en la página 300', async () => {
    server.dropSessions();
    await expect(vista().bootstrap()).rejects.toThrow(BootstrapError);
    await expect(vista().bootstrap()).rejects.toMatchObject({ reason: 'no-session', recoverable: false });
  });

  it('la aserción de cookie se puede desactivar para el caso sin cookies', async () => {
    server.dropSessions();
    await expect(vista({ requireSessionCookie: false }).bootstrap()).resolves.toBeDefined();
  });
});

describe('forma del POST en el cable', () => {
  it('reenvía los 7 campos del form más los 10 del evento y el token', async () => {
    const v = vista();
    await v.bootstrap();
    await v.submitAjax(paginar(10));

    const enviado = server.posts[0]!.fields;
    expect([...enviado.entries()]).toHaveLength(18);
    expect(enviado.get(FORM_ID)).toBe(FORM_ID);
    expect(enviado.get(`${FORM_ID}:dt_scrollState`)).toBe('0,0');
    expect(enviado.get(`${TABLE_ID}_first`)).toBe('10');
    expect(enviado.get('javax.faces.behavior.event')).toBe('page');
  });

  it('manda Faces-Request y un Referer sin jsessionid', async () => {
    const v = vista();
    await v.bootstrap();
    await v.submitAjax(paginar(0));

    const headers = server.posts[0]!.headers;
    expect(headers['faces-request']).toBe('partial/ajax');
    expect(headers['x-requested-with']).toBe('XMLHttpRequest');
    expect(headers['referer']).not.toContain('jsessionid');
  });

  it('el submit no-ajax no manda Faces-Request', async () => {
    const v = vista();
    await v.bootstrap();
    await v.submitCommand({ param_uuid: 'abc' });

    expect(server.posts[0]!.headers['faces-request']).toBeUndefined();
    expect(server.posts[0]!.fields.get('param_uuid')).toBe('abc');
  });
});

describe('rotación del ViewState (§5.1)', () => {
  it('el token se actualiza con cada respuesta y el siguiente POST usa el nuevo', async () => {
    const v = vista();
    await v.bootstrap();
    const inicial = v.viewState;

    await v.submitAjax(paginar(0));
    const despuesDeBuscar = v.viewState;
    expect(despuesDeBuscar).not.toBe(inicial);

    await v.submitAjax(paginar(10));
    expect(server.posts[1]!.fields.get('javax.faces.ViewState')).toBe(despuesDeBuscar);
    expect(v.viewState).not.toBe(despuesDeBuscar);
    expect(metrics.snapshot().contadores['jsf.view_state_rotado']).toBe(2);
  });

  it('el snapshot no filtra el token', async () => {
    const v = vista();
    await v.bootstrap();
    expect(JSON.stringify(v.snapshot())).not.toContain(v.viewState!);
    expect(v.snapshot().viewStateLength).toBeGreaterThan(0);
  });
});

describe('sesión caída', () => {
  /**
   * La forma que OEFA usa de verdad: 200, `<redirect>`, sin `<error>` ni
   * mención a ViewExpiredException. Si esto no se tradujera a excepción, el
   * llamador leería un partial-response válido con cero updates.
   */
  it('un <redirect> se traduce a ViewExpiredError', async () => {
    const v = vista();
    await v.bootstrap();
    server.expireViewState();

    await expect(v.submitAjax(paginar(10))).rejects.toThrow(ViewExpiredError);
    expect(metrics.snapshot().contadores['jsf.view_expired']).toBe(1);
  });

  it('también reconoce la forma canónica con <error>', async () => {
    server.expireAs('error');
    const v = vista();
    await v.bootstrap();
    server.expireViewState();

    await expect(v.submitAjax(paginar(10))).rejects.toMatchObject({ senal: 'error' });
  });

  it('es recuperable, y la costura no depende de la clase', async () => {
    const v = vista();
    await v.bootstrap();
    server.expireViewState();

    const error = await v.submitAjax(paginar(10)).catch((e: unknown) => e);
    expect(isRecoverable(error)).toBe(true);
  });

  /** El `<redirect>` no trae token: absorberlo borraría el vigente. */
  it('una respuesta sin ViewState no borra el token vigente', async () => {
    const v = vista();
    await v.bootstrap();
    const antes = v.viewState;
    server.expireViewState();

    await v.submitAjax(paginar(10)).catch(() => {});
    expect(v.viewState).toBe(antes);
  });
});

describe('recover()', () => {
  it('deja la vista utilizable de nuevo', async () => {
    const v = vista();
    await v.bootstrap();
    server.expireViewState();
    await expect(v.submitAjax(paginar(10))).rejects.toThrow(ViewExpiredError);

    await v.recover();
    expect(v.snapshot().generation).toBe(2);
    await expect(v.submitAjax(paginar(10))).resolves.toBeDefined();
    expect(metrics.snapshot().contadores['jsf.recuperaciones']).toBe(1);
  });

  /**
   * No bota la cookie a propósito: los resultados viven en un bean de sesión, y
   * perderla convierte un error ruidoso en cero filas silenciosas.
   */
  it('no descarta la cookie de sesión', async () => {
    const session = sesion();
    const v = new JsfView({ session, logger: silentLogger, metrics }, { pageUrl: server.pageUrl });

    await v.bootstrap();
    const antes = (await session.cookies(server.pageUrl)).map((c) => c.key);
    await v.recover();
    const despues = (await session.cookies(server.pageUrl)).map((c) => c.key);

    expect(antes).toContain('JSESSIONID');
    expect(despues).toContain('JSESSIONID');
  });
});

describe('respuestas que no son partial-response', () => {
  it('la página completa se traduce a NotPartialResponseError', async () => {
    const v = vista();
    await v.bootstrap();
    server.forceFullPage();

    const error = await v.submitAjax(paginar(0)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotPartialResponseError);
    expect((error as NotPartialResponseError).recoverable).toBe(false);
    // El cuerpo empieza con <?xml pero es HTML: la muestra lo deja a la vista.
    expect((error as NotPartialResponseError).muestra).toContain('<?xml');
    expect((error as NotPartialResponseError).contentType).toContain('text/html');
  });
});

describe('tabla vacía', () => {
  /**
   * El modo de falla de §2.5 con la aserción desactivada: el servidor contesta
   * 200 y la tabla vacía. `jsf/` lo devuelve como dato —no puede distinguirlo de
   * una búsqueda legítimamente sin resultados—; la aserción dura es de
   * `sources/`, que sí conoce el total esperado.
   */
  it('llega como dato y no como excepción', async () => {
    server.dropSessions();
    const v = vista({ requireSessionCookie: false });
    await v.bootstrap();

    const partial = await v.submitAjax(paginar(10));
    const { isEmptyTable, readRowIndices } = await import('../src/jsf/datatable.ts');
    const tabla = partial.updates.get(TABLE_ID) ?? '';
    expect(isEmptyTable(tabla)).toBe(true);
    expect(readRowIndices(tabla)).toEqual([]);
  });
});

describe('la capa de transporte no reintenta errores de protocolo', () => {
  /**
   * `withRetry` reintenta lo que herede de `TransportError` y propaga el resto
   * en el primer throw. Es la razón por la que `JsfProtocolError` es una
   * jerarquía aparte, y es justo el invariante que se rompe el día que alguien
   * busque un ancestro común «para unificar el manejo de errores».
   */
  it('un ViewExpiredError sale al primer intento', async () => {
    let llamadas = 0;
    await expect(
      withRetry(async () => {
        llamadas += 1;
        throw new ViewExpiredError('http://x/', 'redirect', '/login.xhtml');
      }),
    ).rejects.toThrow(ViewExpiredError);
    expect(llamadas).toBe(1);
  });
});
