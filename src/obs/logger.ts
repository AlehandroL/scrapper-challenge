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

import { pino, type Logger } from 'pino';

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

export function createLogger(opts: LoggerOptions): Logger {
  return pino({
    level: opts.level,
    // `redact` cubre los headers; las URLs se limpian en el punto de emisión con
    // `redactUrl()`, porque pino redacta rutas de objeto y no subcadenas.
    redact: {
      paths: ['req.headers.cookie', 'res.headers["set-cookie"]', 'headers.cookie', 'cookie'],
      censor: '[REDACTED]',
    },
    ...(opts.pretty
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
      : {}),
  });
}

/** Para tests y para cualquier uso donde el logging sería ruido. */
export const silentLogger: Logger = pino({ level: 'silent' });
