/**
 * El vocabulario del informe: qué es un hallazgo y cómo se imprime.
 *
 * Cuatro niveles y no dos, porque «pasó» y «no se pudo mirar» no son lo mismo y
 * confundirlos es la forma más barata de tener un validador que miente. Si la
 * carpeta de descargas no existe, el chequeo de integridad de los archivos no
 * pasó: no corrió. Un `✓` ahí sería peor que no tener el chequeo, porque además
 * da confianza.
 *
 * `ok` cubre tanto «no encontré nada» como «encontré esto y está bien que sea
 * así» —los 131 registros que OEFA publica sin documento son un dato del sitio,
 * no un defecto del scraper—. Lo que distingue a un `aviso` es que pide una
 * mirada humana sin poder afirmar que algo esté roto.
 *
 * Esta capa no lee archivos ni emite requests: recibe datos y devuelve
 * hallazgos. El I/O es del CLI, y `tests/architecture.test.ts` lo verifica.
 */

export type Nivel = 'error' | 'aviso' | 'ok' | 'no-evaluable';

export type Contexto = Readonly<Record<string, string | number | boolean>>;

/** Cuántos ejemplos se guardan de un hallazgo que afecta a muchos registros. */
export const MAX_MUESTRAS = 5;

export interface Hallazgo {
  readonly nivel: Nivel;
  /** Slug estable: es lo que un script grepea, así que no cambia por redacción. */
  readonly chequeo: string;
  readonly mensaje: string;
  readonly contexto?: Contexto;
  /** Acotadas a `MAX_MUESTRAS`: un informe que escupe 1.749 ids no lo lee nadie. */
  readonly muestras?: readonly string[];
}

export interface Seccion {
  readonly titulo: string;
  readonly hallazgos: readonly Hallazgo[];
}

export interface Extra {
  readonly contexto?: Contexto;
  readonly muestras?: readonly string[];
}

function crear(nivel: Nivel, chequeo: string, mensaje: string, extra: Extra = {}): Hallazgo {
  return {
    nivel,
    chequeo,
    mensaje,
    // `exactOptionalPropertyTypes`: un `contexto: undefined` explícito no compila.
    ...(extra.contexto === undefined ? {} : { contexto: extra.contexto }),
    ...(extra.muestras === undefined ? {} : { muestras: extra.muestras }),
  };
}

export const error = (chequeo: string, mensaje: string, extra?: Extra): Hallazgo =>
  crear('error', chequeo, mensaje, extra);

export const aviso = (chequeo: string, mensaje: string, extra?: Extra): Hallazgo =>
  crear('aviso', chequeo, mensaje, extra);

export const ok = (chequeo: string, mensaje: string, extra?: Extra): Hallazgo =>
  crear('ok', chequeo, mensaje, extra);

export const noEvaluable = (chequeo: string, mensaje: string, extra?: Extra): Hallazgo =>
  crear('no-evaluable', chequeo, mensaje, extra);

/**
 * Cuántos y cuáles, separados.
 *
 * Existe porque la versión obvia —acumular las muestras y reportar
 * `muestras.length`— informa «5 registros inválidos» cuando hay trescientos, y
 * el número es justo el dato con el que se decide si esto se arregla ahora o
 * después. Un tope de muestras que además tope el conteo es peor que no tener
 * tope.
 */
export class Contador {
  #cuenta = 0;
  readonly #muestras: string[] = [];

  anotar(muestra: string): void {
    this.#cuenta += 1;
    if (this.#muestras.length < MAX_MUESTRAS) this.#muestras.push(muestra);
  }

  get cuenta(): number {
    return this.#cuenta;
  }

  get vacio(): boolean {
    return this.#cuenta === 0;
  }

  get muestras(): readonly string[] {
    return this.#muestras;
  }
}

/**
 * Separador de miles, que a partir de cuatro dígitos importa: 1749 y 17490 se
 * confunden de un vistazo y 1.749 y 17.490 no.
 *
 * A mano y no con `toLocaleString`: el formato queda igual en cualquier máquina
 * y en cualquier Node, y los tests que miran el mensaje no dependen de qué
 * locale tenga instalado quien corre la suite.
 */
export const numero = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

const SIMBOLO: Readonly<Record<Nivel, string>> = {
  error: '✗',
  aviso: '⚠',
  ok: '✓',
  'no-evaluable': '–',
};

/** Las líneas de una sección, con el slug alineado para que se lea como lista. */
export function lineasDe(hallazgos: readonly Hallazgo[]): string[] {
  const ancho = hallazgos.reduce((max, h) => Math.max(max, h.chequeo.length), 0);

  return hallazgos.map((h) => {
    const muestras =
      h.muestras === undefined || h.muestras.length === 0 ? '' : ` · ej.: ${h.muestras.join(', ')}`;
    return `  ${SIMBOLO[h.nivel]} ${h.chequeo.padEnd(ancho)}  ${h.mensaje}${muestras}`;
  });
}

export function contar(secciones: readonly Seccion[]): Readonly<Record<Nivel, number>> {
  const cuenta: Record<Nivel, number> = { error: 0, aviso: 0, ok: 0, 'no-evaluable': 0 };
  for (const seccion of secciones) {
    for (const h of seccion.hallazgos) cuenta[h.nivel] += 1;
  }
  return cuenta;
}

export const hayErrores = (secciones: readonly Seccion[]): boolean => contar(secciones).error > 0;

export function resumen(secciones: readonly Seccion[]): string {
  const c = contar(secciones);
  return `${c.error} error(es) · ${c.aviso} aviso(s) · ${c.ok} ok · ${c['no-evaluable']} no evaluable(s)`;
}

/** El informe entero en texto plano. El CLI imprime lo mismo con títulos en negrita. */
export function render(secciones: readonly Seccion[]): string {
  const bloques = secciones.map((s) => [s.titulo, ...lineasDe(s.hallazgos)].join('\n'));
  return [...bloques, resumen(secciones)].join('\n\n');
}
