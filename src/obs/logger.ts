/**
 * Logging estructurado (§6.6) con redacción de identificadores de sesión.
 *
 * El sitio reescribe `;jsessionid=<ID>` **dentro de las URLs** del HTML — se ve
 * en el `<form action>` de `fixtures/oefa/01-bootstrap.html`. Cualquier log que
 * imprima una URL cruda filtra un identificador de sesión válido. El bloque 1 ya
 * tuvo que resolverlo para los fixtures (`sanitize()` en
 * `scripts/capture-oefa.sh`); acá aplica el mismo cuidado a los logs, que además
 * suelen terminar en sistemas de terceros.
 */

import { pino, transport as crearTransport, type Logger } from 'pino';

export type { Logger };

/** JSF reescribe el id de sesión como parámetro de path, antes de `?`. */
const JSESSIONID_EN_URL = /;jsessionid=[^?#/\s]*/gi;

export function redactUrl(url: string): string {
  return url.replace(JSESSIONID_EN_URL, ';jsessionid=REDACTED');
}

export interface LoggerOptions {
  readonly level: string;
  readonly pretty: boolean;
}

type Transport = ReturnType<typeof crearTransport>;

/**
 * Los transports vivos de la corrida, para poder cerrarlos antes de salir.
 *
 * `pino-pretty` corre en un **worker thread**: `logger.warn()` deja la línea en
 * un buffer compartido y devuelve enseguida, mientras el worker la imprime
 * cuando llega. `process.exit()` no lo espera. Se veía en la corrida del portal
 * caído: el último «fallo de red» salía *después* del `✗` final —que va por
 * `console.error`, sincrónico— y con unas pocas líneas más en vuelo se habría
 * perdido directamente. Justo las del final, que son las que explican por qué la
 * corrida terminó.
 *
 * Es un `Set` y no una variable suelta para que un segundo `createLogger()` no
 * deje al primero sin cerrar.
 */
const TRANSPORTS = new Set<Transport>();

export function createLogger(opts: LoggerOptions): Logger {
  const base = {
    level: opts.level,
    // `redact` cubre los headers; las URLs se limpian en el punto de emisión con
    // `redactUrl()`, porque pino redacta rutas de objeto y no subcadenas.
    redact: {
      paths: ['req.headers.cookie', 'res.headers["set-cookie"]', 'headers.cookie', 'cookie'],
      censor: '[REDACTED]',
    },
  };

  if (!opts.pretty) return pino(base);

  // El transport se construye acá en vez de declararlo en las opciones para
  // quedarse con la referencia: sin ella no hay a quién pedirle el cierre.
  const destino = crearTransport({
    target: 'pino-pretty',
    options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
  });
  TRANSPORTS.add(destino);
  return pino(base, destino);
}

/**
 * Espera a que salga lo que quedó en vuelo, sin cerrar nada.
 *
 * Se llama antes de imprimir el resumen o el error final: el flush no reordena
 * lo ya escrito, así que la única forma de que el bloque humano quede **después**
 * de los logs que lo explican es vaciar la cola antes de escribirlo.
 */
export function vaciarLogs(logger: Logger, timeoutMs = 1_000): Promise<void> {
  return conTimeout((listo) => logger.flush(() => listo()), timeoutMs);
}

/** Cierra los transports. Va al final de cada CLI, justo antes de `process.exit()`. */
export async function cerrarLogs(timeoutMs = 2_000): Promise<void> {
  const pendientes = [...TRANSPORTS];
  TRANSPORTS.clear();
  await Promise.all(
    pendientes.map((destino) =>
      conTimeout((listo) => {
        destino.on('close', listo);
        destino.on('error', listo);
        destino.end();
      }, timeoutMs),
    ),
  );
}

/**
 * El logger nunca puede colgar la salida del proceso: si el worker no contesta,
 * se sale igual. Perder una línea es malo; no terminar nunca es peor.
 */
function conTimeout(iniciar: (listo: () => void) => void, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let resuelto = false;
    const listo = (): void => {
      if (resuelto) return;
      resuelto = true;
      clearTimeout(reloj);
      resolve();
    };
    // El timer va **ref'd** a propósito. `pino.transport()` hace `unref()` del
    // worker para que el logging nunca sostenga el proceso, así que mientras se
    // espera este vaciado no queda nada más en el event loop: con un guardia
    // `unref`'d, Node ve la cola vacía y termina con código 0 en silencio, sin
    // llegar a imprimir el resumen ni el error. Pasó exactamente eso al probarlo.
    const reloj = setTimeout(listo, timeoutMs);
    iniciar(listo);
  });
}

/** Para tests y para cualquier uso donde el logging sería ruido. */
export const silentLogger: Logger = pino({ level: 'silent' });
