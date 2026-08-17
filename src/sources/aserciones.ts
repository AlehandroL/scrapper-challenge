/**
 * Las aserciones duras de §6.4, en un módulo que no sabe de qué portal habla.
 *
 * Vivían dentro del adapter de OEFA, y ahí estaban bien: el comentario de
 * `oefa.ts` explica que las aserciones necesitan **contexto** —cuántas filas se
 * esperaban, en qué offset, cuántas van vistas— y que ese contexto solo existe
 * en la capa de fuente. Lo que la aparición del segundo portal dejó claro es que
 * el contexto es del *recorrido*, no del portal: un offset, un tamaño de página,
 * un total y un conjunto de identidades ya leídas. Nada de eso menciona un
 * expediente ni una resolución.
 *
 * Lo que **no** se extrajo, y conviene decir por qué: la máquina de recorrido.
 * Los dos portales difieren de verdad —OEFA busca por evento AJAX y pagina con
 * el `_first` de un `p:dataTable`; el otro corre RichFaces, busca con un POST
 * no-ajax y ni siquiera sabemos cómo pagina—. Un motor común los metería a los
 * dos en el molde del que sí está verificado, que es la forma más cara de
 * equivocarse: el molde equivocado no falla, produce datos.
 *
 * Van en **dos fases y no en una** porque entre ellas pasa algo: la forma de la
 * página la declara el servidor (cuántas filas, en qué offset) y se puede
 * aseverar apenas se parsea la tabla; la identidad de cada fila la deriva el
 * adapter de su contenido, y en el camino corren las aserciones por fila —número
 * de columnas, enlace ilegible, esquema— que son propias de cada portal. Una
 * sola función obligaría a construir los registros antes de saber si la página
 * siquiera tenía la cantidad correcta de filas, y el primer error reportado
 * pasaría a ser «esta fila trae 5 columnas» cuando la causa es «llegaron 3 filas
 * de 10». El orden de los mensajes es el diagnóstico.
 *
 * El reparto error/aviso se conserva exacto, porque cada lado se ganó su lugar:
 *
 * - **Error** lo que significa que el recorrido dejó de ser confiable. Un drift
 *   no se cura reintentando; se cura mirando el sitio.
 * - **Aviso** lo que el sitio hace y a nosotros nos toca registrar. La versión
 *   original de la aserción de filas repetidas detenía la corrida, y la página 28
 *   de OEFA la detuvo con dos filas perfectamente legítimas. Una aserción que se
 *   relaja después de romper una corrida real es peor que la que nació blanda:
 *   enseña a desconfiar de todas.
 */

import { StructuralDriftError, type ContextoDrift, type TipoDrift } from './errors.ts';

/** Lo que el adapter aporta y no depende del portal. */
export interface ContextoPagina {
  readonly fuente: string;
  /** 1-based. */
  readonly numero: number;
  /** Offset 0-based con el que se pidió la página. */
  readonly first: number;
  readonly pageSize: number;
  /** Total declarado por el sitio en la búsqueda. */
  readonly total: number;
  /**
   * Con qué número arrancan los índices de **esta** página. Por defecto, `first`.
   *
   * No todos los portales numeran igual, y la diferencia importa porque de eso
   * depende la aserción de alineación. Un `p:dataTable` emite `data-ri` global
   * —la página 2 arranca en 10— y ahí `indiceBase === first`. Un `ui:repeat`
   * numera **dentro de la iteración**, así que cada página arranca en 0 y
   * exigirle el offset global sería denunciar como desalineada toda página
   * después de la primera.
   *
   * Que sea explícito y no inferido es deliberado: inferirlo del primer índice
   * recibido convertiría la aserción en una tautología —siempre alinearía— y
   * perdería justamente el oráculo que existe para detectar el bean reiniciado.
   */
  readonly indiceBase?: number;
}

/** Un hallazgo que no detiene la corrida pero tiene que quedar contado. */
export interface Aviso {
  readonly detalle: string;
  readonly contexto: ContextoDrift;
  /** Contador de `Metrics` que le corresponde. */
  readonly metrica: string;
}

/** Cuántas filas corresponden a esta página. La última no es un caso especial. */
export const filasEsperadas = (ctx: ContextoPagina): number =>
  Math.min(ctx.pageSize, ctx.total - ctx.first);

const contextoBase = (ctx: ContextoPagina): ContextoDrift => ({
  pagina: ctx.numero,
  first: ctx.first,
  esperadas: filasEsperadas(ctx),
});

/**
 * Fase 1 — la forma de la página, tal como la declaró el servidor.
 *
 * `marcadaVacia` es la señal que el portal usa para «sin resultados»
 * (`ui-datatable-empty-message` en PrimeFaces; otra cosa en otra librería).
 * Distinguirla de «cero filas y ninguna marca» es lo que separa una sesión
 * perdida de un selector obsoleto, que son arreglos distintos.
 */
export function verificarForma(
  indices: readonly number[],
  ctx: ContextoPagina,
  marcadaVacia: boolean,
): void {
  const esperadas = filasEsperadas(ctx);
  const base = contextoBase(ctx);

  // 1. Cero filas. El modo de falla más caro del proyecto (§2.5): sin cookie la
  //    paginación contesta 200 con la tabla vacía, sin excepción, y el síntoma se
  //    confunde con «el selector dejó de matchear».
  if (indices.length === 0) {
    throw drift(
      ctx.fuente,
      'sin-filas',
      marcadaVacia
        ? 'la tabla llegó marcada como vacía en medio de un resultado con registros: ' +
            'la sesión se perdió o el bean se reinició'
        : 'cero filas sin marca de tabla vacía: el selector quedó obsoleto',
      { ...base, marcadaVacia },
    );
  }

  // 2. Cantidad exacta. Comparar contra `min(pageSize, total - first)` cubre la
  //    última página sin un caso especial que después haya que recordar mantener.
  if (indices.length !== esperadas) {
    throw drift(ctx.fuente, 'pagina-incompleta', `llegaron ${indices.length} filas y correspondían ${esperadas}`, {
      ...base,
      observadas: indices.length,
    });
  }

  // 3. Los índices. Es el oráculo del bean reiniciado: si el servidor ignoró el
  //    offset pedido, los índices arrancan en 0 aunque se hayan pedido en 1.730.
  const desde = ctx.indiceBase ?? ctx.first;
  const desalineado = indices.findIndex((valor, i) => valor !== desde + i);
  if (desalineado !== -1) {
    throw drift(
      ctx.fuente,
      'indices-desalineados',
      `se esperaban índices desde ${desde} y la fila ${desalineado} llegó con ${indices[desalineado]}`,
      { ...base, primerIndice: indices[0] ?? -1, indiceBase: desde },
    );
  }
}

/** Una fila ya construida, reducida a lo que la fase 2 necesita. */
export interface FilaAseverable {
  /** El índice global que el servidor le asignó dentro del resultado. */
  readonly indice: number;
  /** La identidad derivada del contenido. Nunca el identificador del documento (§5.8). */
  readonly id: string;
}

/**
 * Fase 2 — las identidades, ya derivadas del contenido de cada fila.
 *
 * **Muta `vistos`** con las identidades de la página, y solo si llegó al final:
 * una página que no pasó no puede dejar rastro, o el reintento se denunciaría a
 * sí mismo como solapamiento.
 */
export function verificarIdentidades(
  filas: readonly FilaAseverable[],
  ctx: ContextoPagina,
  vistos: Set<string>,
): Aviso[] {
  const base = contextoBase(ctx);
  const avisos: Aviso[] = [];
  const ids = filas.map((f) => f.id);

  // 4. Identidades repetidas dentro de la página. **Aviso, no error**, y la razón
  //    es que ya se probó al revés: la primera versión detenía la corrida, y la
  //    página 28 del sitio real la detuvo — dos filas con el mismo expediente,
  //    administrado, resolución y documento, distinguidas solo por la unidad
  //    fiscalizable. Con la identidad derivada del contenido esas dos filas son
  //    distintas y no llegan acá; lo que sí llega es una fila **idéntica**
  //    repetida, que no aporta información y se deduplica sola al persistir.
  const repetidas = filas.filter((f, i) => ids.indexOf(f.id) !== i);
  if (repetidas.length > 0) {
    // Se informan todas y no solo la primera: en la corrida real hubo una página
    // con la misma fila tres veces, y un mensaje que nombra una sola hace pensar
    // que faltó un registro cuando faltaron dos.
    avisos.push({
      detalle: `${repetidas.length} fila(s) idénticas a otra de la misma página`,
      contexto: { ...base, indices: repetidas.map((f) => f.indice).join(', ') },
      metrica: 'sources.filas_identicas',
    });
  }

  // 5. Solapamiento contra lo ya recorrido (§6.3). Es el único oráculo que ve el
  //    caso del servidor que respeta los índices pero sirve otro contenido, que
  //    el chequeo de índices no puede distinguir. Se compara contra lo visto **en
  //    esta corrida**, nunca contra el archivo: en una corrida reanudada todo lo
  //    del archivo es legítimamente repetido.
  const yaVistos = ids.filter((id) => vistos.has(id));
  if (yaVistos.length === ids.length) {
    throw drift(
      ctx.fuente,
      'solapamiento',
      `las ${ids.length} filas de la página ${ctx.numero} ya se habían leído: la paginación no avanzó`,
      base,
    );
  }
  if (yaVistos.length > 0) {
    avisos.push({
      detalle: `${yaVistos.length} fila(s) repetidas respecto de páginas anteriores`,
      contexto: base,
      metrica: 'sources.duplicados',
    });
  }

  for (const id of ids) vistos.add(id);
  return avisos;
}

/**
 * El chequeo del tamaño de página, aparte de las dos fases.
 *
 * Va suelto porque **solo se puede correr sobre la respuesta de la búsqueda**: la
 * de paginación es una tira de filas peladas, sin el script que declara la
 * configuración del widget. Meterlo en `verificarForma` obligaría a pasarle un
 * `undefined` en todas las páginas menos la primera, y un parámetro que casi
 * siempre es `undefined` termina ignorándose.
 */
export function verificarPageSize(fuente: string, declarado: number | undefined, configurado: number): void {
  if (declarado === undefined || declarado === configurado) return;
  throw drift(
    fuente,
    'page-size',
    `el widget declara ${declarado} filas por página y se configuró ${configurado}: ` +
      'todos los offsets quedarían corridos',
    { declarado, configurado },
  );
}

function drift(fuente: string, tipo: TipoDrift, detalle: string, contexto: ContextoDrift): StructuralDriftError {
  return new StructuralDriftError(fuente, tipo, detalle, contexto);
}
