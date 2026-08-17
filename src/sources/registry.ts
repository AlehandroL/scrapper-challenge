/**
 * El registro de fuentes: qué portales conoce el proyecto y cómo se arma cada uno.
 *
 * Existe porque hasta el bloque 6 había una sola fuente y los cuatro CLIs la
 * cableaban directo. Con la segunda, esa forma deja de servir por una razón
 * práctica antes que estética: **un adapter que ningún comando puede invocar es
 * código muerto**, y el del Poder Judicial ya arranca con la desventaja de no
 * haberse ejercitado contra su fuente. Que sea `--fuente pj` y no una edición de
 * `cli/scrape.ts` es lo que lo pone al alcance de quien tenga salida peruana.
 *
 * Lo que el registro **no** hace es construir sesiones ni vistas: recibe la
 * `JsfView` ya armada, igual que los adapters. El cableado de transporte sigue
 * viviendo en `cli/`, que es el único lugar donde corresponde, y por eso este
 * archivo no importa nada de `src/http/`.
 *
 * Las rutas por defecto se derivan del nombre —`data/<fuente>.jsonl`,
 * `data/<fuente>.<tarea>.checkpoint.json`— y no se listan una por una. Es la
 * misma lección de §5.9: `scrape` y `download` avanzan a ritmos distintos sobre
 * la misma fuente, y un checkpoint compartido hace que el atrasado retome donde
 * llegó el otro y se saltee páginas que nunca leyó.
 */

import type { JsfView } from '../jsf/view.ts';
import type { Logger } from '../obs/logger.ts';
import type { Metrics } from '../obs/metrics.ts';
import { URL_OEFA, createOefaSource } from './oefa.ts';
import { RegistroOefaSchema } from './oefa-rows.ts';
import { URL_PJ, createPjSource } from './pj.ts';
import { RegistroPjSchema } from './pj-rows.ts';
import type { Fuente, RegistroBase } from './types.ts';

export const FUENTES = ['oefa', 'pj'] as const;
export type NombreFuente = (typeof FUENTES)[number];

export interface DepsFuente {
  readonly view: JsfView;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

export interface OpcionesFuente {
  readonly pageSize?: number;
  readonly maxRecuperaciones?: number;
}

export interface DescriptorFuente {
  readonly nombre: NombreFuente;
  readonly urlBase: string;
  /**
   * Tamaño de página, cuando el portal lo tiene fijo y verificado.
   *
   * `undefined` significa «se deriva de la primera página», y no es un descuido:
   * en OEFA el widget de PrimeFaces declara su `rows` en el script de
   * configuración y se puede aseverar contra él; el portal del Poder Judicial no
   * publica nada equivalente. Poner un número igual sería inventar el dato que
   * traduce número de página a offset, que es el peor lugar donde inventar.
   */
  readonly pageSize: number | undefined;
  /**
   * Qué tan ejercitado está el adapter contra su propia fuente.
   *
   * Está en el descriptor y no en un comentario porque los CLIs lo **imprimen**
   * antes de arrancar. Un adapter no verificado que corre sin decirlo es
   * exactamente la cobertura simulada que §3.3 rechaza; dicho en pantalla, quien
   * lo corre sabe qué está midiendo.
   */
  readonly evidencia: string;
  /** Valida un registro leído del archivo. Lo usa `cli/validate.ts`. */
  readonly validarRegistro: (valor: unknown) => RegistroBase | string;
  readonly crear: (deps: DepsFuente, opts?: OpcionesFuente) => Fuente<RegistroBase>;
}

const DESCRIPTORES: Record<NombreFuente, DescriptorFuente> = {
  oefa: {
    nombre: 'oefa',
    urlBase: URL_OEFA,
    pageSize: 10,
    evidencia:
      'verificada contra el sitio vivo: corrida completa de 176 páginas y 1.753 filas, ' +
      'más 30 documentos descargados',
    validarRegistro: (valor) => validar(RegistroOefaSchema, valor),
    crear: (deps, opts = {}) =>
      createOefaSource(deps, {
        pageSize: opts.pageSize ?? 10,
        ...(opts.maxRecuperaciones === undefined ? {} : { maxRecuperaciones: opts.maxRecuperaciones }),
      }),
  },
  pj: {
    nombre: 'pj',
    urlBase: URL_PJ,
    pageSize: undefined,
    evidencia:
      'NO ejercitado contra su fuente: el portal responde 403 desde Chile y no se contrató proxy (§3.3). ' +
      'Escrito contra markup real del archivo web (fixtures/pj/); las filas de resultado y la paginación ' +
      'siguen sin verificar',
    validarRegistro: (valor) => validar(RegistroPjSchema, valor),
    crear: (deps, opts = {}) =>
      createPjSource(deps, {
        ...(opts.pageSize === undefined ? {} : { pageSize: opts.pageSize }),
        ...(opts.maxRecuperaciones === undefined ? {} : { maxRecuperaciones: opts.maxRecuperaciones }),
      }),
  },
};

export const esNombreFuente = (valor: string): valor is NombreFuente =>
  (FUENTES as readonly string[]).includes(valor);

/**
 * El descriptor de una fuente por su nombre.
 *
 * Lanza con la lista completa en el mensaje en vez de caer a OEFA en silencio:
 * un `--fuente pjj` que descarga el portal equivocado es más caro que uno que no
 * arranca.
 */
export function descriptorDe(nombre: string): DescriptorFuente {
  if (!esNombreFuente(nombre)) {
    throw new Error(`Fuente desconocida «${nombre}». Disponibles: ${FUENTES.join(', ')}.`);
  }
  return DESCRIPTORES[nombre];
}

/** `data/oefa.jsonl`, `data/pj.jsonl`. */
export const salidaPorDefecto = (fuente: string): string => `data/${fuente}.jsonl`;

/** `data/oefa.scrape.checkpoint.json`. Uno por comando: ver §5.9. */
export const checkpointPorDefecto = (fuente: string, tarea: string): string =>
  `data/${fuente}.${tarea}.checkpoint.json`;

/** `data/oefa.descargas.jsonl` — el manifiesto de documentos bajados. */
export const manifiestoPorDefecto = (fuente: string): string => `data/${fuente}.descargas.jsonl`;

/** `data/oefa.failed.jsonl` — la cola de fallos del bloque 5. */
export const colaPorDefecto = (fuente: string): string => `data/${fuente}.failed.jsonl`;

/** `data/oefa/` — el directorio de documentos. */
export const documentosPorDefecto = (fuente: string): string => `data/${fuente}`;

function validar(
  esquema: { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { issues: { path: PropertyKey[]; message: string }[] } } },
  valor: unknown,
): RegistroBase | string {
  const resultado = esquema.safeParse(valor);
  if (resultado.success) return resultado.data as RegistroBase;
  return (resultado.error?.issues ?? [])
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join(' | ');
}
