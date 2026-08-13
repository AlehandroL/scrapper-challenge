/**
 * Configuración por variables de entorno, validada con zod.
 *
 * Se valida en vez de leer `process.env` suelto por la misma razón que §6.7
 * valida cada registro: un `HTTP_RPS=cinco` que se convierte en `NaN` degrada el
 * limiter a un `setTimeout(NaN)` y el scraper se cuelga sin decir por qué.
 * Fallar al arrancar cuesta un segundo; fallar en la página 900, una corrida.
 */

import { z } from 'zod';

/** Mismo User-Agent que `scripts/capture-oefa.sh`: los fixtures del bloque 1 se
 *  capturaron con este, y cambiarlo introduciría una variable no controlada al
 *  comparar el comportamiento del código contra la evidencia guardada. */
export const USER_AGENT_POR_DEFECTO =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const booleano = (porDefecto: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? porDefecto : v === '1' || v.toLowerCase() === 'true'));

const EnvSchema = z.object({
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'silent']).default('info'),
  LOG_PRETTY: booleano(Boolean(process.stdout.isTTY)),

  HTTP_RPS: z.coerce.number().positive().default(1),
  HTTP_MIN_RPS: z.coerce.number().positive().default(0.2),
  HTTP_MAX_RPS: z.coerce.number().positive().default(5),
  HTTP_BURST: z.coerce.number().positive().default(2),
  HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  HTTP_MAX_RETRY_AFTER_MS: z.coerce.number().int().positive().default(120_000),
  HTTP_USER_AGENT: z.string().min(1).default(USER_AGENT_POR_DEFECTO),

  /**
   * §3.3 y §5.5. Sin proxy contratado para esta entrega, así que este camino
   * **no está ejercitado contra ningún proxy real**: queda declarado como tal en
   * el README en vez de presentarse como funcionalidad probada.
   *
   * Cuando se use: la IP debe ser fija durante toda la vida de la sesión. La
   * rotación por request —default de los proveedores residenciales— es
   * incompatible con JSF, porque el `JSESSIONID` queda asociado a un nodo y
   * cambiar de IP provoca expiración inmediata.
   */
  PROXY_URL: z.string().url().optional(),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const resultado = EnvSchema.safeParse(env);
  if (!resultado.success) {
    const detalle = resultado.error.issues
      .map((i) => `  ${i.path.join('.') || '(raíz)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuración inválida en el entorno:\n${detalle}`);
  }
  if (resultado.data.HTTP_MIN_RPS > resultado.data.HTTP_MAX_RPS) {
    throw new Error('Configuración inválida: HTTP_MIN_RPS no puede superar a HTTP_MAX_RPS.');
  }
  return resultado.data;
}
