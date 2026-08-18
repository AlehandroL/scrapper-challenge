# Desafío de scraping — Registro de Infractores Ambientales (OEFA)

[![CI](https://github.com/AlehandroL/scrapper-challenge/actions/workflows/ci.yml/badge.svg)](https://github.com/AlehandroL/scrapper-challenge/actions/workflows/ci.yml)

Scraper en TypeScript, **sin automatización de navegador**, para portales que corren
JSF/Mojarra — un framework *stateful* donde la paginación y las descargas no son URLs sino
eventos POST contra un árbol de componentes que vive en el servidor.

**Sitio principal:** [`publico.oefa.gob.pe`](https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml),
el alternativo que ofrece el enunciado. Es el que se recorrió entero, del que se
descargaron documentos y contra el que corre la validación. El portal del Poder Judicial
exige salida de red peruana, no se contrató VPN para esta entrega, y su adapter queda como
secundario — ver [limitaciones conocidas](#limitaciones-conocidas).

## Quickstart

Requiere **Node ≥ 20**. No hay servicios que levantar ni credenciales que configurar.

```bash
npm ci        # instalar — ~2 s, sin build
npm test      # 575 tests sin red: verifica la instalación sin depender del portal
```

Eso ya prueba que la instalación quedó bien, y no depende del portal. Contra el sitio, los
tres comandos que muestran el recorrido entero:

```bash
# 1. recorrido: 30 registros nuevos a un archivo aparte, + informe de corrida
npm run scrape -- --hasta 3 --salida data/demo.jsonl

# 2. descarga: 2 PDFs a data/demo/, con su manifiesto y sha256
npm run download -- --max-descargas 2 --destino data/demo --manifiesto data/demo.descargas.jsonl

# 3. informe de validación sobre la entrega: 25 chequeos, 0 errores
npm run validate
```

Cada uno imprime su propio informe al cerrar: requests, `429`, reintentos, latencias
p50/p95 y contadores por capa.

**Los dos primeros escriben a `data/demo*` a propósito**, y vale la pena saber por qué: la
entrega —[`data/oefa.jsonl`](data/oefa.jsonl) y su manifiesto— **viene commiteada**, y
`scrape` es idempotente. Contra las rutas por defecto, el paso 1 recorre las tres páginas,
encuentra que ya están todas y cierra con `0 registro(s) nuevo(s), 1.749 omitido(s)`: no
falla —hizo los 4 requests y parseó las 3 páginas— pero no hay cómo distinguirlo de que no
hizo nada. Apuntando a un archivo nuevo se ve el trabajo, y la entrega queda intacta para
que el paso 3 la valide limpia. (`--reiniciar` logra lo mismo sobre las rutas por defecto;
por qué el destino de la descarga también importa está en
[cómo se valida](#cómo-se-valida).)

**Si el portal no responde**, el error lo dice con todas las letras y sugiere el `curl` de
comprobación. El diagnóstico completo —incluido si está caído para todos o filtrado contra
tu IP— es un comando:

```bash
bash scripts/check-access.sh
```

OEFA es un portal público de disponibilidad irregular: se lo vio caído para todo el mundo
—`ECONNREFUSED` desde 15 nodos externos, con el control del mismo `/24` respondiendo— más
de una vez durante el desarrollo. Nada de la verificación sin red depende de él.

## Qué produjo

| | |
|---|---|
| **Dataset** | [`data/oefa.jsonl`](data/oefa.jsonl) — 1.749 registros, de 1.753 filas recorridas en 176 páginas |
| **Documentos** | [`data/oefa.descargas.jsonl`](data/oefa.descargas.jsonl) — 30 PDFs, 232,6 MB, con tamaño y `sha256` |
| **Corrida del dataset** | 177 requests a 1 req/s, **cero 429 y cero reintentos**, ~6 min |
| **Suite** | 575 tests **sin red**, ~2 s, contra Node 20, 22 y 24 en CI |
| **Sanity checks** | `npm run validate` — 25 chequeos, 0 errores y 2 avisos conocidos sobre lo entregado |

## Cómo se corre

Sin `--hasta`, `scrape` recorre el dataset completo: 176 páginas, ~6 minutos. Es
**reanudable e idempotente**: repetirlo completa lo que falte sin duplicar registros ni
volver a pedir páginas ya leídas. Esa es la propiedad que hace que un clon recién bajado
—que ya trae el dataset— reporte `0 registro(s) nuevo(s)`; ver el
[quickstart](#quickstart).

```bash
npm run download -- --max-descargas 2  # dos PDFs a data/oefa/ — pesan ~9 MB cada uno
```

Este sí escribe archivos nuevos en un clon limpio: los binarios no se versionan, así que
`data/oefa/` ni siquiera existe, y las 30 entradas del manifiesto commiteado se saltean por
id —bajando dos que todavía no estaban—. Lo que falle queda en una cola y se reintenta con
`npm run retry-failed`. Ojo con el efecto sobre el informe: crear `data/oefa/` habilita el
chequeo de integridad, que a partir de ahí reporta los 30 PDFs ausentes —ver
[cómo se valida](#cómo-se-valida)—.

Verificación sin red:

```bash
npm test             # 575 tests, ~2 s
npm run typecheck    # tsc --noEmit
npm run lint         # oxlint
npm run format:check # prettier --check
```

Todos los comandos aceptan `--help`.

## Estructura

```
src/
  cli/        scrape · download · retry-failed · validate
  sources/    adapters OEFA y PJ · parsers de fila · aserciones de drift
  jsf/        ViewState · partial-response · forms · comandos
  http/       sesión · cookie jar · token bucket AIMD · retry · circuit breaker
  store/      JSONL · archivos · cola de fallos · checkpoint
  validate/   sanity checks, sin I/O
  obs/        logging · métricas
tests/        575 tests, ninguno toca la red
fixtures/     markup real de los dos portales, versionado
scripts/      captura de fixtures, smokes contra el sitio vivo, diagnóstico de acceso
docs/         el proceso, la bitácora y el índice de referencias «§»
```

`jsf/` no sabe nada de resoluciones ambientales y `sources/` no sabe nada de reintentos ni
de cookies. [`tests/architecture.test.ts`](tests/architecture.test.ts) lo verifica en cada
corrida; el detalle está en [`docs/proceso.md`](docs/proceso.md#arquitectura).

Los comentarios del código citan secciones con la forma `§5.4`: apuntan al documento de
estrategia con el que se planificó el trabajo, que no se versiona.
[`docs/referencias.md`](docs/referencias.md) dice qué afirma cada una y dónde está
reproducida acá dentro, y un test exige que no quede ninguna sin fila.

## Referencia

### Comandos

| Comando | Red | Qué hace |
|---|---|---|
| `npm test` | no | La suite completa: 575 tests, ~2 s |
| `npm run typecheck` | no | `tsc --noEmit` |
| `npm run lint` | no | `oxlint` sobre `src/`, `tests/` y `scripts/` |
| `npm run format` | no | `prettier --write` sobre los `.ts`. `format:check` es la variante que no escribe |
| `npm run scrape` | sí | Recorre la fuente y escribe el dataset JSONL |
| `npm run download` | sí | Recorre y baja los documentos intercalado, con manifiesto y cola de fallos |
| `npm run retry-failed` | sí | Consume la cola: re-navega hasta la página de cada registro |
| `npm run validate` | opcional | Sanity checks sobre lo escrito; `--contra-el-sitio` agrega 2 requests |
| `npm run smoke:oefa` | sí | Transporte: `200`, `JSESSIONID` en el jar, token en el cuerpo |
| `npm run smoke:jsf` | sí | Protocolo: bootstrap → búsqueda → página 2, con el token rotando |
| `npm run smoke:source` | sí | El adapter contra las dos condiciones que los fixtures no cubren |
| `npm run smoke:download` | sí | La descarga, y el experimento del `ViewState` desalineado |
| `npm run smoke:pj` | sí | El adapter secundario contra su sitio. Requiere salida peruana |
| `bash scripts/capture-oefa.sh` | sí | Regenera los fixtures de OEFA |
| `bash scripts/capture-pj.sh` | sí | Regenera los fixtures del PJ desde el archivo web |
| `bash scripts/check-access.sh` | sí | Diagnóstico de acceso en cuatro capas. `--sin-terceros` lo deja local |

**Los cinco smokes quedan fuera de `npm test` a propósito.** La suite no debe depender de
la red ni golpear un sitio real en cada push: sería exactamente lo que el rate limiter
existe para evitar. CI corre los cinco pasos sin red —`typecheck`, `lint`, `format:check`,
`test` y `validate`— contra Node 20, 22 y 24.

### Flags

Los cuatro CLIs aceptan `--fuente oefa|pj` (por defecto `oefa`), `--help` y, salvo
`validate`, `--dry-run`. Las rutas por defecto se derivan del nombre de la fuente.

| CLI | Flags propios |
|---|---|
| `scrape` | `--desde <n>` · `--hasta <n>` · `--salida <ruta>` · `--checkpoint <ruta>` · `--max-recuperaciones <n>` · `--reiniciar` |
| `download` | `--desde` · `--hasta` · `--destino <dir>` · `--manifiesto <ruta>` · `--dlq <ruta>` · `--checkpoint <ruta>` · `--max-descargas <n>` · `--reiniciar` |
| `retry-failed` | `--dlq` · `--destino` · `--manifiesto` · `--max-intentos <n>` |
| `validate` | `--dataset <ruta>` · `--manifiesto` · `--dlq` · `--descargas <dir>` · `--checkpoint` · `--page-size <n>` · `--total <n>` · `--hash` · `--contra-el-sitio` |

### Variables de entorno

Se validan con `zod` al arrancar ([`src/config.ts`](src/config.ts)) en vez de leerse
sueltas: un `HTTP_RPS=cinco` sin validar degrada el limiter a un `setTimeout(NaN)` y cuelga
el scraper sin decir por qué.

| Variable | Default | Para qué |
|---|---|---|
| `HTTP_RPS` | `1` | Tasa inicial del token bucket |
| `HTTP_MIN_RPS` / `HTTP_MAX_RPS` | `0.2` / `5` | Piso y techo del ajuste AIMD |
| `HTTP_BURST` | `2` | Tokens de ráfaga |
| `HTTP_TIMEOUT_MS` | `30000` | Timeout por request |
| `HTTP_MAX_RETRY_AFTER_MS` | `120000` | Tope al `Retry-After` del servidor |
| `HTTP_USER_AGENT` | el de `capture-oefa.sh` | Cambiarlo introduce una variable no controlada al comparar contra los fixtures |
| `PROXY_URL` | — | Salida por proxy. **No ejercitado contra ningún proxy real** |
| `LOG_LEVEL` | `info` | `trace`…`silent` |
| `LOG_PRETTY` | según TTY | Formato legible en vez de JSON |

## Los datos

Se entregan dos JSONL —no un array JSON: un `[{…}, {…}]` monolítico obliga a mantener todo
en memoria y a escribir al final, y una caída en el registro 1.700 pierde la corrida
entera—.

**Un registro** de [`data/oefa.jsonl`](data/oefa.jsonl):

```json
{
  "fuente": "oefa",
  "id": "e41f437005ce5c0fe1adb1ee",
  "indice": 0,
  "pagina": 1,
  "capturadoEn": "2026-08-15T19:58:24.469Z",
  "documentoUuid": "153a6d2a-cbed-40ef-b8ef-cd2272b19867",
  "expediente": "891-08-PRODUCE/DIGSECOVI-Dsvs",
  "administrados": ["Corporación del Mar S.A.", "Austral Group S.A.A."],
  "unidadFiscalizable": "Planta Playa Lado Norte Puerto Malabrigo",
  "sector": "Pesquería",
  "resolucion": "264-2012-OEFA/TFA",
  "anioResolucion": 2012
}
```

`id` es un hash del contenido, estable entre corridas. **No es el `documentoUuid`**: hay
131 registros sin documento —el portal los marca «Información confidencial»— y hay
documentos que alcanzan a más de un registro. Tampoco sirve `indice`, que es la posición
dentro del resultado y se corre entera en cuanto el organismo publica algo nuevo.

**Una entrada** del manifiesto [`data/oefa.descargas.jsonl`](data/oefa.descargas.jsonl):

```json
{
  "id": "e41f437005ce5c0fe1adb1ee",
  "fuente": "oefa",
  "documentoUuid": "153a6d2a-cbed-40ef-b8ef-cd2272b19867",
  "pagina": 1,
  "indice": 0,
  "archivo": "153a6d2a-cbed-40ef-b8ef-cd2272b19867_264-2012-oefa-tfa.pdf",
  "bytes": 9377728,
  "sha256": "3c175af6a0460268345a3ed1eaab69b0acaed0f100993204de444a11eb29ba14",
  "nombreServidor": "attachment;filename=\"RTFA N° 264-2012.pdf\"",
  "descargadoEn": "2026-08-14T21:07:42.879Z"
}
```

**Los binarios no se versionan** —los 30 PDFs pesan 232,6 MB— pero el manifiesto sí: es la
evidencia de qué se bajó, cuánto pesaba y con qué hash, y permite re-verificar los archivos
sin volver a pedirlos. `nombreServidor` se guarda como dato y no se usa para nombrar: el
`content-disposition` real trae el filename en ISO-8859-1 y no garantiza unicidad. El
nombre se construye desde nuestro propio metadata.

## Cómo se valida

```bash
npm run validate                        # dataset y manifiesto
npm run validate -- --hash              # además, re-lee cada archivo y recalcula su sha256
npm run validate -- --contra-el-sitio   # además, le pregunta el total al portal: 2 requests
```

**El nivel que importa es el cuarto: «no evaluable».** Un chequeo que no pudo correr no es
un chequeo que pasó. Si la carpeta de descargas no está —y en un clon limpio no está,
porque los binarios no se versionan— la integridad de los archivos se reporta `–` y nunca
`✓`. Un informe que dice «los 30 archivos están bien» sin haber abierto uno es peor que no
tener informe, porque además da confianza.

Ese nivel tiene una consecuencia que conviene anticipar, porque en la práctica sorprende:
**basta con que `data/oefa/` exista para que los `–` se vuelvan `✗`.** Una descarga parcial
en un clon recién bajado —`npm run download -- --max-descargas 2` contra el destino por
defecto— crea la carpeta con dos archivos, y a partir de ahí la sonda sí puede mirar el
disco y reporta que los otros 30 del manifiesto no están. Es el chequeo haciendo
exactamente su trabajo: antes no sabía, ahora sabe. Por eso el [quickstart](#quickstart)
manda la demo a `data/demo/`, y por eso la re-verificación de los 30 PDFs entregados pide
apuntar `--descargas` a donde estén de verdad.

Lo mismo con la cobertura: sin un total declarado, el archivo solo prueba una **cota
inferior**, y una corrida cortada en la última página se ve idéntica a una completa. De ahí
sale `--contra-el-sitio`.

Hay un tercer camino para ese total, y es el que deja el [quickstart](#quickstart) sin
pedir nada extra: cualquier `scrape` —aunque sea de tres páginas— anota en su checkpoint el
total que declaró el portal, y `validate` lo levanta de ahí. En un clon recién bajado la
cobertura sale `–`; después de correr el paso 1, sale
`✓ 1.749 presente(s) + 4 deduplicada(s) = 1.753, el total del checkpoint de «scrape»`. Sin
red, `--total <n>` hace lo mismo a mano.

Hay además un test que corre este mismo informe sobre los archivos commiteados y exige cero
errores: tener sanity checks y haberlos corrido no son lo mismo.

> Los 30 PDFs de la corrida quedaron localmente en `descargas/`, la ruta anterior a que
> hubiera dos fuentes. Para re-verificarlos:
> `npm run validate -- --descargas descargas --hash`. Una corrida nueva los escribe en
> `data/oefa/`, que es el default.

## Criterio → evidencia

| Criterio del enunciado | Dónde está |
|---|---|
| **Funcionalidad** | Corrida real con output commiteado: [`data/oefa.jsonl`](data/oefa.jsonl) (1.749 registros de 176 páginas) y 30 documentos con hash. Reproducible con `npm run scrape` |
| **Manejo de 429** | Token bucket con **AIMD** + **full jitter** + prioridad de `Retry-After` + circuit breaker global + cola de fallos + `npm run retry-failed`. Escrito a mano en [`src/http/`](src/http/) porque delegarlo a `bottleneck` escondería justo lo que se evalúa |
| **Código limpio** | Separación transporte / protocolo / dominio / persistencia, sostenida por [`tests/architecture.test.ts`](tests/architecture.test.ts) y puesta a prueba contra un segundo portal. `oxlint` y `prettier --check` corren en CI junto al `tsc` en modo estricto máximo |
| **Robustez** | Recuperación de la vista caída en sus tres formas, validación de magic bytes del PDF, escritura atómica, checkpointing, y **diez condiciones de drift** que detienen la corrida antes de escribir datos vacíos |
| **Documentación** | Este README, [`docs/proceso.md`](docs/proceso.md), la [bitácora](docs/bitacora.md), y los README de [`fixtures/oefa/`](fixtures/oefa/README.md) y [`fixtures/pj/`](fixtures/pj/README.md) |

## Limitaciones conocidas

**1. El adapter del Poder Judicial no se ejercitó contra su fuente.** El portal responde
`403` sin salida de red peruana y **no se contrató VPN ni proxy para esta entrega**: se
tomó el sitio alternativo del enunciado como principal. El adapter existe, está escrito
contra markup real recuperado del archivo web y tiene tests, pero su cobertura es desigual:

| Superficie | Estado |
|---|---|
| Ids del form, campos de búsqueda, state saving, los tres forms, forma del `onclick`, descubrimiento del botón «Buscar» | verificado contra markup real |
| Forma de las filas, comando de paginación, POST de descarga | **sin verificar** — el archivo web captura GETs y ahí los resultados nacen de un POST |

No hay un solo id de componente hardcodeado, y cada fallo de descubrimiento es un error que
nombra qué request hay que capturar para cerrarlo. Cada fuente declara su estado de
evidencia y **el CLI lo imprime antes de tocar la red**. Para quien tenga salida peruana,
el cierre son dos comandos:

```bash
bash scripts/check-access.sh    # IP, país, ASN, los dos portales y sus controles
npm run smoke:pj                # ejercita el adapter entero contra el sitio vivo
```

**2. El diagnóstico de acceso al PJ queda abierto.** Se sabe qué *no* es el problema —ni
fingerprinting TLS/JA3, ni headers, ni huella HTTP/2, ni allowlist por UA— y que el
discriminante es un atributo de la IP de origen. No se sabe cuál de los tres: país, ASN o
reputación puntual.

**3. No hay filtros.** El reversing se hizo con el formulario vacío, que devuelve el
dataset completo. Los cuatro filtros del portal se reenvían vacíos porque JSF exige el
submit completo del form, pero la búsqueda con valores no está reversada. La interfaz de
fuente **se expone sin parámetros de filtrado** en vez de aceptarlos y descartarlos en
silencio.

**4. El camino del proxy nunca corrió contra un proxy real.** `PROXY_URL` está implementado
y `https-proxy-agent` instalado, pero no se contrató ninguno. Cuando se use, la IP debe ser
**fija durante toda la vida de la sesión**: la rotación por request —default de los
proveedores residenciales— es incompatible con JSF, porque el `JSESSIONID` queda asociado a
un nodo y cambiar de IP provoca expiración inmediata.

Y una limitación conocida dentro de la limitación: el mismo `HttpsProxyAgent` se monta como
`httpAgent` y como `httpsAgent`. Para un target `http://` corresponde `HttpProxyAgent` —el
primero siempre emite `CONNECT`—, así que un proxy hacia un destino sin TLS, o un redirect
https→http, no está cubierto. No se arregló porque agregar una dependencia para un camino
que nunca se ejercitó compra menos que declararlo; queda anotado también en
[`src/http/session.ts`](src/http/session.ts).

## Documentación

- **[`docs/proceso.md`](docs/proceso.md)** — cómo se descubrió el protocolo, qué supuestos
  refutó el sitio, la arquitectura y el diagnóstico de acceso.
- **[`docs/bitacora.md`](docs/bitacora.md)** — el registro bloque a bloque del desarrollo.
- **[`docs/referencias.md`](docs/referencias.md)** — qué afirma cada `§N.N` que cita el código y
  dónde está reproducida en el repo.
- **[`fixtures/oefa/README.md`](fixtures/oefa/README.md)** y
  **[`fixtures/pj/README.md`](fixtures/pj/README.md)** — qué demuestra cada fixture.
