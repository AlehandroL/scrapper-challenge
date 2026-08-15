/**
 * Lo que solo se puede afirmar sabiendo qué publica OEFA.
 *
 * Separado de `sanity.ts` por la misma razón por la que `sources/` separa
 * `types.ts` de `oefa.ts`: los chequeos estructurales sirven para cualquier
 * portal y estos no. El día que exista `pj.ts` habrá un `validate/pj.ts` al lado,
 * y el resto de la capa no se toca.
 *
 * Los tres chequeos de acá salieron de mirar el dataset real, no de imaginar
 * qué podría fallar:
 *
 * - **El esquema no alcanza para «campo obligatorio no nulo» (§6.3).** `z.string()`
 *   acepta la cadena vacía, así que una celda que el parser leyó en blanco pasa
 *   la validación por registro del bloque 4 sin ruido.
 * - **El año de la resolución es el «porcentaje de fechas parseadas» de §6.3**, y
 *   en su primera corrida encontró un defecto real del parser: 29 resoluciones
 *   con documento publicado se quedaban sin año porque el portal las escribe
 *   `019-2014/TFA-SEP1`, sin el `-OEFA` que el regex daba por descontado.
 * - **El documento compartido no siempre es local.** §5.8 lo describió con las
 *   filas 277 y 278: mismo expediente, misma resolución, distinta unidad
 *   fiscalizable. Pero el dataset tiene además un par de registros con el mismo
 *   documento y **expedientes distintos**, separados por seiscientas filas. La
 *   invariante que se puede afirmar es la resolución, no el expediente.
 */

import type { RegistroOefa } from '../sources/oefa-rows.ts';

import { Contador, MAX_MUESTRAS, aviso, error, numero, ok, type Hallazgo } from './informe.ts';

/** Los que el parser siempre debería traer con contenido. */
const CAMPOS_TEXTO = ['expediente', 'unidadFiscalizable', 'sector', 'resolucion'] as const;

export class RevisionOefa {
  readonly #porId = new Map<string, RegistroOefa>();
  readonly #porUuid = new Map<string, RegistroOefa[]>();

  /** El desglose por campo; el total y las muestras los lleva `#vaciosTotal`. */
  readonly #vacios = new Map<string, number>();
  readonly #vaciosTotal = new Contador();

  #conDocumento = 0;
  #sinDocumento = 0;
  #sinAnioSinDocumento = 0;
  readonly #sinAnioConDocumento = new Contador();

  /** El dataset indexado por identidad: es lo que cruza el manifiesto. */
  get porId(): ReadonlyMap<string, RegistroOefa> {
    return this.#porId;
  }

  get conDocumento(): number {
    return this.#conDocumento;
  }

  agregar(registro: RegistroOefa): void {
    this.#porId.set(registro.id, registro);

    for (const campo of CAMPOS_TEXTO) {
      if (registro[campo].trim() === '') this.#contarVacio(campo, registro.id);
    }
    if (registro.administrados.length === 0) this.#contarVacio('administrados', registro.id);

    if (registro.documentoUuid === undefined) {
      this.#sinDocumento += 1;
      if (registro.anioResolucion === undefined) this.#sinAnioSinDocumento += 1;
      return;
    }

    this.#conDocumento += 1;
    const grupo = this.#porUuid.get(registro.documentoUuid);
    if (grupo === undefined) this.#porUuid.set(registro.documentoUuid, [registro]);
    else grupo.push(registro);

    if (registro.anioResolucion === undefined) this.#sinAnioConDocumento.anotar(registro.resolucion);
  }

  hallazgos(): Hallazgo[] {
    const compartidos = [...this.#porUuid.values()].filter((g) => g.length > 1);
    const heterogeneos = compartidos.filter((g) => this.#difierenEnLoQueNoDeberian(g));

    return [
      this.#vaciosTotal.vacio
        ? ok('campos-vacios', 'ningún campo obligatorio quedó en blanco')
        : error(
            'campos-vacios',
            `${numero(this.#vaciosTotal.cuenta)} campo(s) obligatorios en blanco: ` +
              [...this.#vacios].map(([campo, n]) => `${campo}=${n}`).join(', '),
            { muestras: this.#vaciosTotal.muestras },
          ),

      this.#sinAnioConDocumento.vacio
        ? ok(
            'anio-sin-parsear',
            `los ${numero(this.#conDocumento)} registro(s) con documento tienen año de resolución` +
              (this.#sinAnioSinDocumento === 0
                ? ''
                : `; los ${numero(this.#sinAnioSinDocumento)} sin documento tampoco tienen número`),
          )
        : error(
            'anio-sin-parsear',
            `${numero(this.#sinAnioConDocumento.cuenta)} resolución(es) con documento publicado no ` +
              'entregaron año: el parser no cubre su formato',
            { muestras: this.#sinAnioConDocumento.muestras },
          ),

      ok(
        'sin-documento',
        `${numero(this.#sinDocumento)} registro(s) sin documento publicado, de ` +
          `${numero(this.#porId.size)}: el portal los marca «Información confidencial»`,
      ),

      ok(
        'documento-compartido',
        `${numero(compartidos.length)} documento(s) alcanzan a más de un registro: ` +
          'una resolución por unidad fiscalizable, se baja una sola vez',
      ),

      heterogeneos.length === 0
        ? ok('documento-compartido-heterogeneo', 'los documentos compartidos coinciden en expediente y resolución')
        : aviso(
            'documento-compartido-heterogeneo',
            `${numero(heterogeneos.length)} documento(s) compartidos por registros que no ` +
              'comparten expediente o resolución: vale la pena mirarlos a mano',
            {
              muestras: heterogeneos
                .slice(0, MAX_MUESTRAS)
                .map((g) => `${g[0]?.documentoUuid ?? '?'} (índices ${g.map((r) => r.indice).join(', ')})`),
            },
          ),
    ];
  }

  /**
   * Un documento compartido es normal; que además cambie de expediente o de
   * resolución no lo es tanto. No se afirma que esté mal —el portal tiene
   * resoluciones que acumulan expedientes—, así que avisa y no rompe.
   */
  #difierenEnLoQueNoDeberian(grupo: readonly RegistroOefa[]): boolean {
    return (
      new Set(grupo.map((r) => r.expediente)).size > 1 || new Set(grupo.map((r) => r.resolucion)).size > 1
    );
  }

  #contarVacio(campo: string, id: string): void {
    this.#vacios.set(campo, (this.#vacios.get(campo) ?? 0) + 1);
    this.#vaciosTotal.anotar(`${id}:${campo}`);
  }
}
