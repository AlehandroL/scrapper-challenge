/**
 * Los chequeos que valen para cualquier fuente: los que se apoyan solo en
 * `RegistroBase`.
 *
 * Deliberadamente **no sabe qué es un expediente**. El validador del registro
 * llega inyectado como función, así que esta capa no importa zod ni conoce el
 * esquema de OEFA; es el mismo criterio con el que `store/jsonl.ts` recibe un
 * extractor de clave en vez de conocer `uuid`. Cuando exista el adapter del
 * Poder Judicial, estos ocho chequeos corren sobre su dataset sin tocarse.
 *
 * **Acumula en vez de recibir el archivo entero.** El CLI le pasa una línea por
 * vez tal como sale de `readJsonl`, y lo que queda en memoria son conjuntos de
 * identidades y contadores, no los registros. Un validador que para revisar un
 * archivo lo carga completo es un validador que deja de servir justo cuando el
 * dataset se pone grande, que es cuando más falta hace.
 *
 * Dónde está el «solapamiento entre páginas consecutivas» que pide §6.3: es
 * `pagina-incoherente` más `indice-duplicado`. En vivo, el adapter lo detecta
 * comparando lo que ya vio (§6.4); acá, sobre el archivo terminado, un
 * `ViewState` desalineado deja el rastro de filas anotadas con un número de
 * página que no se corresponde con su posición, o de dos filas peleando por la
 * misma posición.
 */

import type { RegistroBase } from '../sources/types.ts';

import {
  Contador,
  MAX_MUESTRAS,
  aviso,
  error,
  noEvaluable,
  numero,
  ok,
  type Hallazgo,
} from './informe.ts';

/**
 * Convierte una línea cruda en registro, o devuelve el motivo del rechazo.
 *
 * Devolver el motivo como `string` en vez de lanzar es deliberado: un dataset
 * con 200 líneas inválidas tiene que producir un informe con 200 contadas y
 * cinco de muestra, no una excepción en la primera.
 */
export type Validador<R extends RegistroBase> = (valor: unknown) => R | string;

export interface OpcionesRevision {
  /** Tamaño de página del recorrido: es lo que relaciona `indice` con `pagina`. */
  readonly pageSize: number;
}

/**
 * El total de filas que el sitio declaró, y de dónde salió.
 *
 * Llega al reportar y no al construir porque el CLI puede pedírselo al portal
 * con `--contra-el-sitio`, y para eso conviene haber leído antes el archivo: si
 * no existe, no hay motivo para gastar dos requests.
 */
export interface TotalDeclarado {
  readonly valor: number;
  /** Para el mensaje: «del checkpoint», «que declara el sitio», «de --total». */
  readonly origen: string;
}

export class RevisionDataset<R extends RegistroBase> {
  readonly #validador: Validador<R>;
  readonly #opciones: OpcionesRevision;

  #lineas = 0;
  #validos = 0;
  readonly #invalidos = new Contador();

  readonly #ids = new Set<string>();
  readonly #idsRepetidos = new Contador();

  readonly #indices = new Set<number>();
  readonly #indicesRepetidos = new Contador();

  readonly #incoherentes = new Contador();

  readonly #fuentes = new Set<string>();
  #maxIndice = -1;
  #ilegible: string | undefined;

  constructor(validador: Validador<R>, opciones: OpcionesRevision) {
    this.#validador = validador;
    this.#opciones = opciones;
  }

  /** Las identidades leídas, para cruzar el manifiesto contra el dataset. */
  get identidades(): ReadonlySet<string> {
    return this.#ids;
  }

  get validos(): number {
    return this.#validos;
  }

  /**
   * `readJsonl` es estricto y corta en la primera línea rota. Eso no es un
   * accidente que haya que tapar: una cola truncada **es** el hallazgo, y por eso
   * el CLI la reporta acá en vez de repararla en silencio.
   */
  marcarIlegible(detalle: string): void {
    this.#ilegible = detalle;
  }

  /** Devuelve el registro si validó, para que los chequeos de dominio lo reciban tipado. */
  agregar(linea: number, valor: unknown): R | undefined {
    this.#lineas += 1;

    const resultado = this.#validador(valor);
    if (typeof resultado === 'string') {
      this.#invalidos.anotar(`línea ${linea}: ${resultado}`);
      return undefined;
    }

    this.#validos += 1;
    this.#fuentes.add(resultado.fuente);

    if (this.#ids.has(resultado.id)) this.#idsRepetidos.anotar(resultado.id);
    else this.#ids.add(resultado.id);

    if (this.#indices.has(resultado.indice))
      this.#indicesRepetidos.anotar(String(resultado.indice));
    else this.#indices.add(resultado.indice);

    const esperada = Math.floor(resultado.indice / this.#opciones.pageSize) + 1;
    if (esperada !== resultado.pagina) {
      this.#incoherentes.anotar(
        `indice ${resultado.indice} dice página ${resultado.pagina}, corresponde ${esperada}`,
      );
    }

    if (resultado.indice > this.#maxIndice) this.#maxIndice = resultado.indice;

    return resultado;
  }

  hallazgos(total?: TotalDeclarado): Hallazgo[] {
    const ausentes = this.#ausentes();
    const cota = this.#maxIndice + 1;

    return [
      this.#ilegible === undefined
        ? ok('jsonl-ilegible', `${numero(this.#lineas)} línea(s) parsean como JSON`)
        : error('jsonl-ilegible', `el archivo se cortó al leerlo: ${this.#ilegible}`),

      this.#validos === 0
        ? error('dataset-vacio', 'el archivo no tiene ningún registro válido')
        : ok('dataset-vacio', `${numero(this.#validos)} registro(s)`),

      this.#invalidos.vacio
        ? ok('esquema', `${numero(this.#validos)} registro(s) validan contra el esquema`)
        : error('esquema', `${numero(this.#invalidos.cuenta)} registro(s) no validan`, {
            muestras: this.#invalidos.muestras,
          }),

      this.#idsRepetidos.vacio
        ? ok('id-duplicado', `${numero(this.#ids.size)} identidad(es) distintas, sin repetir`)
        : error(
            'id-duplicado',
            `${numero(this.#idsRepetidos.cuenta)} línea(s) repiten una identidad ya escrita: la idempotencia falló`,
            { muestras: this.#idsRepetidos.muestras },
          ),

      this.#indicesRepetidos.vacio
        ? ok('indice-duplicado', 'ninguna posición del resultado aparece dos veces')
        : error(
            'indice-duplicado',
            `${numero(this.#indicesRepetidos.cuenta)} posición(es) repetidas: dos filas distintas en el mismo offset`,
            { muestras: this.#indicesRepetidos.muestras },
          ),

      this.#incoherentes.vacio
        ? ok(
            'pagina-incoherente',
            `«pagina» concuerda con «indice» en las ${numero(this.#validos)} filas`,
          )
        : error(
            'pagina-incoherente',
            `${numero(this.#incoherentes.cuenta)} fila(s) con la página desalineada de su posición`,
            { muestras: this.#incoherentes.muestras },
          ),

      this.#fuentes.size <= 1
        ? ok('fuente-mezclada', `una sola fuente: ${[...this.#fuentes].join('') || '(ninguna)'}`)
        : error('fuente-mezclada', `el archivo mezcla ${this.#fuentes.size} fuentes`, {
            muestras: [...this.#fuentes].slice(0, MAX_MUESTRAS),
          }),

      ausentes.length === 0
        ? ok('indices-ausentes', `las posiciones 0–${Math.max(cota - 1, 0)} están todas`)
        : aviso(
            'indices-ausentes',
            `${numero(ausentes.length)} posición(es) sin registro entre 0 y ${cota - 1}: ` +
              'esperable si el portal publicó filas repetidas byte por byte, que se deduplican al persistir',
            { muestras: ausentes.slice(0, MAX_MUESTRAS).map(String) },
          ),

      this.#cobertura(ausentes.length, cota, total),
    ];
  }

  /**
   * La cobertura es el único chequeo que necesita un dato externo al archivo, y
   * por eso es el único que puede quedar sin evaluar.
   *
   * Sin el total declarado por el sitio, el archivo solo prueba hasta dónde
   * llegó: `max(indice) + 1` es una **cota inferior**, no el total. Una corrida
   * cortada en la última página da un número más chico y se ve igual de completa.
   * Reportarlo como `✓` sería exactamente la clase de confianza infundada que
   * §6.4 existe para evitar.
   */
  #cobertura(ausentes: number, cota: number, total: TotalDeclarado | undefined): Hallazgo {
    const desglose = `${numero(this.#validos)} presente(s) + ${numero(ausentes)} deduplicada(s)`;

    if (total === undefined) {
      return noEvaluable(
        'cobertura',
        `sin total declarado: el archivo solo prueba una cota inferior de ${numero(cota)} fila(s) ` +
          `recorridas (${desglose}). Pasar --total <n>, o --contra-el-sitio para pedírselo al portal`,
      );
    }

    if (cota === total.valor) {
      return ok('cobertura', `${desglose} = ${numero(total.valor)}, el total ${total.origen}`);
    }

    return error(
      'cobertura',
      `el total ${total.origen} es ${numero(total.valor)} y el archivo llega hasta la fila ` +
        `${numero(cota)} (${desglose}): faltan ${numero(total.valor - cota)} al final`,
      { contexto: { total: total.valor, cota } },
    );
  }

  #ausentes(): number[] {
    const faltan: number[] = [];
    for (let i = 0; i <= this.#maxIndice; i += 1) {
      if (!this.#indices.has(i)) faltan.push(i);
    }
    return faltan;
  }
}
