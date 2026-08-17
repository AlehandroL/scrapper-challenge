/**
 * El manifiesto: que describa el dataset, y que describa el disco.
 *
 * §5.9 dejó la regla escrita después de tropezarla: **«está en el manifiesto» no
 * alcanza para dar un documento por bajado.** Un archivo borrado a mano no se
 * vuelve a pedir nunca, y el manifiesto termina siendo la descripción prolija de
 * una carpeta que no existe. Por eso los chequeos de integridad miran el disco y
 * no se conforman con el `sha256` que la propia corrida anotó.
 *
 * Y por eso mismo, si la carpeta no está, esos chequeos se reportan
 * `no-evaluable` y nunca `ok`: el modo de falla que se quiere evitar es
 * exactamente el de creerle a un informe que no miró nada.
 *
 * El acceso al disco llega **inyectado** como sonda. Esta capa no importa `fs`:
 * el CLI decide si la sonda hace un `stat` o si además re-lee y re-hashea los
 * 232 MB, y los tests le pasan una función y ejercitan los tres desenlaces sin
 * crear un solo archivo.
 */

import { Contador, aviso, error, noEvaluable, numero, ok, type Hallazgo } from './informe.ts';

/**
 * Lo que estos chequeos necesitan de una línea del manifiesto.
 *
 * Es un subconjunto estructural de `EntradaManifiesto` (`src/cli/download.ts`) y
 * no un import: `validate/` no puede depender de `cli/`, y describir acá lo
 * mínimo deja el chequeo utilizable por cualquier fuente que escriba un
 * manifiesto con esta forma.
 */
export interface EntradaDocumento {
  readonly id: string;
  readonly documentoUuid: string;
  readonly archivo: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** Lo que el disco dice de un archivo. Sin `sha256`, la sonda no lo recalculó. */
export interface EnDisco {
  readonly bytes: number;
  readonly sha256?: string;
}

/** `undefined` ⇒ el archivo no está. */
export type Sonda = (archivo: string) => Promise<EnDisco | undefined>;

export interface ContextoDocumentos {
  /** El dataset indexado por identidad. */
  readonly registros: ReadonlyMap<string, { readonly documentoUuid?: string }>;
  /** Cuántos registros del dataset tienen documento publicado. */
  readonly conDocumento: number;
  /** Ausente ⇒ no se pudo mirar el disco: la carpeta de destino no existe. */
  readonly sonda?: Sonda;
  /** Entradas en la cola de fallos. Ausente ⇒ no se pudo leer. */
  readonly pendientes?: number;
  /** Líneas del manifiesto que no tenían la forma esperada. */
  readonly invalidas?: number;
}

export async function revisarDocumentos(
  entradas: readonly EntradaDocumento[],
  ctx: ContextoDocumentos,
): Promise<Hallazgo[]> {
  const forma =
    ctx.invalidas === undefined || ctx.invalidas === 0
      ? ok('manifiesto-invalido', `${numero(entradas.length)} entrada(s) con la forma esperada`)
      : error(
          'manifiesto-invalido',
          `${numero(ctx.invalidas)} línea(s) del manifiesto sin la forma esperada`,
        );

  if (entradas.length === 0) {
    return [
      forma,
      aviso('manifiesto-vacio', 'el manifiesto no tiene entradas: no se descargó ningún documento'),
      ...[
        'manifiesto-duplicado',
        'manifiesto-huerfano',
        'manifiesto-uuid',
        'archivo-compartido',
      ].map((c) => noEvaluable(c, 'sin entradas que revisar')),
      ok('cobertura-descargas', `0 de ${numero(ctx.conDocumento)} registro(s) con documento`),
      ...['archivo-ausente', 'tamano-distinto', 'hash-distinto'].map((c) =>
        noEvaluable(c, 'sin entradas que revisar'),
      ),
      colaDeFallos(ctx.pendientes),
    ];
  }

  const vistos = new Set<string>();
  const duplicados = new Contador();
  const huerfanos = new Contador();
  const uuidDistinto = new Contador();
  const porArchivo = new Map<string, EntradaDocumento[]>();

  for (const entrada of entradas) {
    if (vistos.has(entrada.id)) duplicados.anotar(entrada.id);
    else vistos.add(entrada.id);

    const registro = ctx.registros.get(entrada.id);
    if (registro === undefined) huerfanos.anotar(entrada.id);
    else if (registro.documentoUuid !== entrada.documentoUuid) {
      uuidDistinto.anotar(
        `${entrada.id}: manifiesto ${entrada.documentoUuid}, dataset ${registro.documentoUuid ?? '(ninguno)'}`,
      );
    }

    const grupo = porArchivo.get(entrada.archivo);
    if (grupo === undefined) porArchivo.set(entrada.archivo, [entrada]);
    else grupo.push(entrada);
  }

  const compartidos = [...porArchivo.values()].filter((g) => g.length > 1).length;

  return [
    forma,
    ok('manifiesto-vacio', `${numero(entradas.length)} entrada(s)`),

    duplicados.vacio
      ? ok('manifiesto-duplicado', 'ninguna identidad aparece dos veces')
      : error(
          'manifiesto-duplicado',
          `${numero(duplicados.cuenta)} entrada(s) repiten una identidad`,
          {
            muestras: duplicados.muestras,
          },
        ),

    huerfanos.vacio
      ? ok(
          'manifiesto-huerfano',
          `las ${numero(entradas.length)} entradas tienen su registro en el dataset`,
        )
      : error(
          'manifiesto-huerfano',
          `${numero(huerfanos.cuenta)} entrada(s) apuntan a una identidad que el dataset no tiene`,
          { muestras: huerfanos.muestras },
        ),

    uuidDistinto.vacio
      ? ok('manifiesto-uuid', 'el documento de cada entrada coincide con el del registro')
      : error(
          'manifiesto-uuid',
          `${numero(uuidDistinto.cuenta)} entrada(s) declaran un documento distinto al del registro`,
          { muestras: uuidDistinto.muestras },
        ),

    ok(
      'archivo-compartido',
      `${numero(porArchivo.size)} archivo(s) para ${numero(entradas.length)} entrada(s)` +
        (compartidos === 0
          ? ''
          : `; ${numero(compartidos)} lo comparten dos registros y se bajó una vez`),
    ),

    ok(
      'cobertura-descargas',
      `${numero(vistos.size)} de ${numero(ctx.conDocumento)} registro(s) con documento` +
        (vistos.size < ctx.conDocumento ? ' — el resto no se pidió' : ''),
    ),

    ...(await revisarDisco(porArchivo, ctx.sonda)),

    colaDeFallos(ctx.pendientes),
  ];
}

async function revisarDisco(
  porArchivo: ReadonlyMap<string, readonly EntradaDocumento[]>,
  sonda: Sonda | undefined,
): Promise<Hallazgo[]> {
  if (sonda === undefined) {
    const motivo = 'no se pudo mirar el disco: la carpeta de descargas no existe';
    return ['archivo-ausente', 'tamano-distinto', 'hash-distinto'].map((c) =>
      noEvaluable(c, motivo),
    );
  }

  const ausentes = new Contador();
  const tamanos = new Contador();
  const hashes = new Contador();
  let hasheados = 0;
  let presentes = 0;

  for (const [archivo, grupo] of porArchivo) {
    const disco = await sonda(archivo);
    if (disco === undefined) {
      ausentes.anotar(archivo);
      continue;
    }
    presentes += 1;

    for (const entrada of grupo) {
      if (entrada.bytes !== disco.bytes) {
        tamanos.anotar(
          `${archivo}: manifiesto ${numero(entrada.bytes)} B, disco ${numero(disco.bytes)} B`,
        );
      }
      if (disco.sha256 !== undefined && entrada.sha256 !== disco.sha256) hashes.anotar(archivo);
    }
    if (disco.sha256 !== undefined) hasheados += 1;
  }

  return [
    ausentes.vacio
      ? ok(
          'archivo-ausente',
          `los ${numero(porArchivo.size)} archivo(s) del manifiesto están en disco`,
        )
      : error(
          'archivo-ausente',
          `${numero(ausentes.cuenta)} archivo(s) del manifiesto no están en disco`,
          {
            muestras: ausentes.muestras,
          },
        ),

    tamanos.vacio
      ? ok(
          'tamano-distinto',
          `${numero(presentes)} archivo(s) con el tamaño que el manifiesto declara`,
        )
      : error(
          'tamano-distinto',
          `${numero(tamanos.cuenta)} archivo(s) con un tamaño distinto al declarado`,
          {
            muestras: tamanos.muestras,
          },
        ),

    hasheados === 0
      ? noEvaluable(
          'hash-distinto',
          'la sonda no recalculó hashes: usar --hash para releer los archivos',
        )
      : hashes.vacio
        ? ok(
            'hash-distinto',
            `${numero(hasheados)} archivo(s) con el sha256 que el manifiesto declara`,
          )
        : error(
            'hash-distinto',
            `${numero(hashes.cuenta)} archivo(s) con un sha256 distinto al declarado`,
            {
              muestras: hashes.muestras,
            },
          ),
  ];
}

/**
 * La cola no es un chequeo del dataset sino del estado de la corrida, y por eso
 * avisa en vez de romper: lo que hay que hacer con ella es `retry-failed`, no
 * arreglar un archivo.
 */
function colaDeFallos(pendientes: number | undefined): Hallazgo {
  if (pendientes === undefined)
    return noEvaluable('dlq-pendientes', 'la cola de fallos no se pudo leer');
  if (pendientes === 0) return ok('dlq-pendientes', 'la cola de fallos está vacía');
  return aviso(
    'dlq-pendientes',
    `${numero(pendientes)} documento(s) pendientes en la cola: correr «npm run retry-failed»`,
  );
}
