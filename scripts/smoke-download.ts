/**
 * smoke-download.ts — La descarga contra el sitio vivo, y el experimento de §5.4
 * convertido en comprobación ejecutable.
 *
 * Deliberadamente **fuera de `npm test`**, igual que los otros tres smokes: la
 * suite no debe depender de la red ni golpear el sitio en cada corrida.
 *
 * El paso 1 es el que justifica el archivo. La restricción que ordena todo el
 * bloque 5 —que la descarga exige un `ViewState` alineado con la página donde
 * vive la fila— se verificó en el bloque 1 a mano, con dos `curl` y una
 * comparación de headers. Acá se reproduce con el mismo código que corre en
 * producción: misma sesión, misma fila, mismo conjunto de campos, variando solo
 * de qué página viene el token. Si el sitio cambiara de comportamiento, esto lo
 * dice en veinte segundos.
 *
 * El paso 2 baja dos documentos de verdad y reporta lo que el manifiesto guarda.
 * Dos y no más: pesan unos 9 MB cada uno.
 *
 * Uso:   npm run smoke:download
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../src/config.ts';
import { CircuitBreaker } from '../src/http/circuit-breaker.ts';
import { RateLimiter } from '../src/http/rate-limiter.ts';
import { createSession } from '../src/http/session.ts';
import { JsfView } from '../src/jsf/view.ts';
import { createLogger } from '../src/obs/logger.ts';
import { Metrics } from '../src/obs/metrics.ts';
import { URL_OEFA, createOefaSource } from '../src/sources/oefa.ts';
import type { RegistroOefa } from '../src/sources/oefa-rows.ts';
import type { Pagina } from '../src/sources/types.ts';
import { colaEnMemoria } from '../src/store/dlq.ts';
import { descargar, nombreDeArchivoOefa, type EntradaManifiesto } from '../src/cli/download.ts';

const paso = (s: string): void => console.log(`\n\x1b[1m${s}\x1b[0m`);
const ok = (s: string): void => console.log(`  ✓ ${s}`);
const mal = (s: string): void => console.log(`  ✗ ${s}`);

async function main(): Promise<number> {
  const config = loadConfig();
  const metrics = new Metrics();
  const logger = createLogger({ level: config.LOG_LEVEL, pretty: config.LOG_PRETTY });

  const session = createSession(
    {
      limiter: new RateLimiter({
        rps: config.HTTP_RPS,
        minRps: config.HTTP_MIN_RPS,
        maxRps: config.HTTP_MAX_RPS,
        burst: config.HTTP_BURST,
      }),
      breaker: new CircuitBreaker(),
      metrics,
      logger,
    },
    {
      timeoutMs: config.HTTP_TIMEOUT_MS,
      userAgent: config.HTTP_USER_AGENT,
      ...(config.PROXY_URL === undefined ? {} : { proxyUrl: config.PROXY_URL }),
    },
  );

  const view = new JsfView({ session, logger, metrics }, { pageUrl: URL_OEFA });
  const fuente = createOefaSource({ view, logger, metrics }, { pageSize: 10 });
  const destino = mkdtempSync(join(tmpdir(), 'smoke-descargas-'));

  try {
    paso('1/2  El experimento de §5.4: el mismo documento con dos tokens distintos');

    const paginas: Pagina<RegistroOefa>[] = [];
    for await (const p of fuente.recorrer({ hasta: 2 })) paginas.push(p);

    const primera = paginas[0];
    const segunda = paginas[1];
    const fila = primera?.filas.find((f) => f.descarga !== undefined);
    if (primera === undefined || segunda === undefined || fila?.descarga === undefined) {
      mal('no se pudo armar el experimento: la página 1 no trajo ninguna fila con documento');
      return 1;
    }

    ok(`fila elegida: data-ri ${fila.registro.indice} · ${fila.registro.resolucion}`);

    // Con el token de la página 2: el servidor re-renderiza la página y no manda
    // el documento. El cuerpo llega en streaming, así que se destruye a mano.
    const desalineada = await view.streamCommand(view.prepareCommand(fila.descarga, segunda.viewState));
    desalineada.data.destroy();
    const tipoDesalineado = String(desalineada.headers['content-type'] ?? '');

    // Con el de la página 1: el PDF.
    const alineada = await view.streamCommand(view.prepareCommand(fila.descarga, primera.viewState));
    const cabecera: Buffer = await new Promise((resolve) => {
      alineada.data.once('data', (trozo: Buffer) => {
        alineada.data.destroy();
        resolve(trozo);
      });
    });
    const tipoAlineado = String(alineada.headers['content-type'] ?? '');
    const magic = cabecera.subarray(0, 5).toString('latin1');

    console.log(`    token de la página 2 → ${desalineada.status} ${tipoDesalineado}`);
    console.log(`    token de la página 1 → ${alineada.status} ${tipoAlineado} · ${JSON.stringify(magic)}`);
    console.log(`    content-disposition  → ${String(alineada.headers['content-disposition'] ?? '(ausente)')}`);

    paso('2/2  Dos descargas reales, con validación y manifiesto');

    const manifiesto: EntradaManifiesto[] = [];
    const resumen = await descargar(
      {
        fuente,
        emisor: view,
        dlq: colaEnMemoria(),
        logger,
        metrics,
        anotar: (entrada) => void manifiesto.push(entrada),
      },
      { destino, nombreDeArchivo: nombreDeArchivoOefa, hasta: 1, maxDescargas: 2 },
    );

    for (const entrada of manifiesto) {
      console.log(`    ${entrada.archivo}`);
      console.log(`      ${(entrada.bytes / 1e6).toFixed(2)} MB · sha256 ${entrada.sha256.slice(0, 16)}…`);
      console.log(`      servidor: ${entrada.nombreServidor ?? '(sin content-disposition)'}`);
    }

    paso('Comprobaciones');
    const comprobaciones: [string, boolean][] = [
      ['el token desalineado devuelve HTML en vez del documento', tipoDesalineado.includes('text/html')],
      ['el token alineado devuelve un binario', !tipoAlineado.includes('text/html')],
      ['el cuerpo alineado empieza con %PDF-', magic === '%PDF-'],
      ['se bajaron los dos documentos pedidos', resumen.descargados === 2],
      ['ninguno falló', resumen.fallidos === 0],
      ['los dos pesan más de 100 KB', manifiesto.every((e) => e.bytes > 100_000)],
      ['el manifiesto tiene el hash de cada uno', manifiesto.every((e) => e.sha256.length === 64)],
    ];
    for (const [etiqueta, pasa] of comprobaciones) (pasa ? ok : mal)(etiqueta);

    paso('Métricas de la corrida');
    const s = metrics.snapshot();
    console.log(`  requests=${s.requests}  ok=${s.ok}  429=${s.throttled}  reintentos=${s.reintentos}`);
    console.log(`  latencia p50=${s.latenciaP50Ms} ms  p95=${s.latenciaP95Ms} ms`);
    console.log(`  contadores: ${JSON.stringify(s.contadores)}`);

    const fallidas = comprobaciones.filter(([, pasa]) => !pasa);
    if (fallidas.length > 0) {
      paso(`FALLÓ — ${fallidas.length} comprobación(es)`);
      return 1;
    }
    paso('OK — la alineación del ViewState se comporta como en el bloque 1');
    return 0;
  } finally {
    // Los archivos son de un directorio temporal: el smoke verifica, no entrega.
    rmSync(destino, { recursive: true, force: true });
  }
}

main().then(
  (codigo) => process.exit(codigo),
  (error: unknown) => {
    console.error('\n✗ El smoke falló:', error instanceof Error ? `${error.name}: ${error.message}` : error);
    process.exit(1);
  },
);
