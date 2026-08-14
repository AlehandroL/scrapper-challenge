# Desafío de scraping — Jurisprudencia Nacional Sistematizada

[![CI](https://github.com/AlehandroL/scrapper-challenge/actions/workflows/ci.yml/badge.svg)](https://github.com/AlehandroL/scrapper-challenge/actions/workflows/ci.yml)

Scraper en TypeScript, **sin automatización de navegador**, para el portal de
Jurisprudencia Nacional Sistematizada del Poder Judicial del Perú.

## El problema real

El portal corre sobre **JSF/Mojarra con PrimeFaces**: un framework *stateful*
donde la paginación, los filtros y las descargas no son URLs direccionables sino
eventos POST contra un árbol de componentes que vive en el servidor. No existe
`?page=2`. Resolverlo sin navegador exige replicar a mano el protocolo del token
`ViewState`, y ese es el núcleo del desafío.

Descubrir la estructura del sitio es parte explícita del enunciado, así que este
repositorio documenta el proceso de descubrimiento —qué se observó, qué se
dedujo, qué hipótesis se descartaron y cuáles se refutaron con evidencia— y no
solo el resultado.

## Dos sitios

| | |
|---|---|
| **Objetivo** | `jurisprudencia.pj.gob.pe` — detrás de Radware Cloud WAF, responde `403` desde Chile |
| **Desarrollo** | `publico.oefa.gob.pe` — mismo stack (Mojarra + PrimeFaces), acceso abierto |

El 403 no es anti-bot: un diagnóstico por capas descartó fingerprinting TLS/JA3,
headers, huella HTTP/2 y allowlist por UA. El discriminante es un atributo de la
IP de origen. Como el trabajo de protocolo es idéntico en ambos sitios y no
requiere IP peruana, el desarrollo se hace contra OEFA y la fuente se abstrae
detrás de un adapter.

**Decisión de alcance declarada:** no se contrata VPN ni proxy residencial para
esta entrega. El diagnóstico de acceso al Poder Judicial queda abierto y el
adapter del PJ no se ejercita contra su fuente. `scripts/check-access.sh` cierra
ese diagnóstico en un comando desde cualquier red con salida peruana. No se
simula cobertura que no se logró.

## Estructura

```
src/
├── http/        ✅ sesión, cookie jar, rate limiter, retry, circuit breaker
├── obs/         ✅ logging estructurado y métricas de la corrida
├── config.ts    ✅ entorno validado con zod
├── jsf/         ✅ ViewState, partial-response, serialización de forms, comandos
├── sources/     ✅ adapter OEFA, parsers y esquema del registro · ⬜ pj.ts
├── store/       ✅ JSONL append + lectura streaming · ⬜ checkpoint, DLQ
├── validate/    ⬜ sanity checks sobre el dataset producido
└── cli/         ✅ scrape · ⬜ download, retry-failed, validate
```

El criterio: la capa `jsf/` no sabe nada de jurisprudencia ni de resoluciones
ambientales, y la capa `sources/` no sabe nada de reintentos ni de cookies. La
capa de protocolo debe ser reutilizable para el próximo portal legacy.

`obs/` no estaba en el plan original. Se agregó porque el logging y las métricas
son transversales: `sources/` y `store/` también van a emitir, así que meterlos
dentro de `http/` habría obligado a sacarlos después.

## Estado

Trabajo en curso, organizado en bloques.

### Bloque 1 — Reversing del protocolo ✅

Los tres requests que definen el protocolo están replicados **sin navegador** y
guardados como fixtures en [`fixtures/oefa/`](fixtures/oefa/):

```bash
bash scripts/capture-oefa.sh     # regenera los fixtures contra el sitio vivo
bash scripts/check-access.sh     # diagnóstico de acceso al Poder Judicial
```

Stack verificado: Mojarra (JSF 2.x, prefijo `javax.faces.*`) + PrimeFaces 6.0,
sobre un dataset de 1.753 registros en 176 páginas.

**Hallazgo con consecuencias de arquitectura:** la descarga de un PDF exige un
`ViewState` alineado con la página donde vive la fila. Verificado con un
experimento controlado —misma sesión, misma fila, mismo conjunto de campos—
variando solo el origen del token: con el de la página 2 el servidor devuelve
`200` y la página re-renderizada; con el de la página 1, el PDF. Esto descarta el
pipeline desacoplado «recolectar todo el metadata primero, descargar después».

Otros dos puntos que cuestan tiempo si se descubren tarde:

- El `ViewState` vuelve en el `partial-response` con id
  `j_id1:javax.faces.ViewState:0`, no `javax.faces.ViewState`. Buscarlo por id
  exacto devuelve `undefined` contra toda respuesta real, y el síntoma se
  confunde con un bloqueo del sitio.
- Sin la cookie `JSESSIONID` la búsqueda funciona igual, pero la paginación
  devuelve `200` con la tabla vacía. No hay excepción: parece que el selector
  dejó de matchear.

El detalle completo, incluidos los modos de falla y lo que los fixtures
demuestran, está en [`fixtures/oefa/README.md`](fixtures/oefa/README.md).

**Limitación conocida:** el reversing se hizo con el formulario vacío. Los cuatro
filtros del portal se reenvían vacíos porque JSF exige el submit completo del
form, pero la búsqueda con valores no está reversada y **el adapter no soporta
filtros**. La interfaz de fuente se expondrá sin parámetros de filtrado en vez de
aceptarlos y descartarlos en silencio.

### Bloque 2 — Cliente HTTP ✅

La capa de transporte: sesión con cookie jar, token bucket con AIMD, política de
reintentos y circuit breaker.

```bash
npm install
npm test              # 70 tests, sin red, ~0,4 s
npm run typecheck
npm run smoke:oefa    # opt-in: un GET real contra OEFA
```

**Esta capa no sabe qué es un `ViewState`.** No menciona JSF, ni OEFA, ni
jurisprudencia, y [`tests/architecture.test.ts`](tests/architecture.test.ts) lo
verifica en cada corrida en vez de dejarlo como promesa de este README.

El reparto de estado es lo que decide la forma de la API: **el cookie jar es por
sesión; el limiter y el breaker son globales.** El jar identifica una sesión JSF;
la tasa y el breaker protegen al servidor, que es uno solo. N sesiones
concurrentes se comportan como N navegadores distintos contra un único servidor
al que entre todas no deben pasarle por encima.

Cuatro decisiones que cuestan tiempo si se descubren tarde:

- **El `acquire()` del limiter va dentro de la función que se reintenta.** Si
  estuviera afuera, los reintentos saltarían el throttling justo cuando el
  servidor pidió bajar el ritmo, y el 429 se auto-perpetuaría.
- **Un 403 aborta la corrida en vez de reintentarse.** Es la lección directa del
  diagnóstico de acceso: el 403 del Poder Judicial resultó ser una regla de
  política del WAF, no una condición transitoria. Insistir no lo cura, y sí es la
  vía más corta para que un throttling temporal escale a un ban de IP.
- **Con `responseType: 'stream'` un 429 también trae cuerpo.** Si no se destruye,
  el socket queda colgado; unos pocos reintentos agotan el pool y los requests se
  cuelgan sin timeout, con un síntoma que no se parece en nada a la causa.
- **Todo camino de error tiene que avisarle al circuit breaker, sin excepción.**
  El del `UnexpectedStatusError` no lo hacía. Un 404 que cayera justo sobre la
  sonda del `half-open` dejaba la sonda «en vuelo» para siempre: el circuito
  rechazaba todo request posterior —de todas las sesiones, porque el breaker es
  global— y ningún cooldown lo curaba. La política vive ahora en el tipo
  (`degradaServidor`, abstracto en `TransportError`) y el reporte en un único
  punto de salida: olvidarse dejó de compilar.

El smoke contra OEFA queda **fuera de `npm test`** a propósito: la suite no debe
depender de la red ni golpear el sitio en cada corrida. Comprueba tres cosas y
ninguna más — 200, `JSESSIONID` en el jar, y que el cuerpo contenga
`javax.faces.ViewState` como subcadena. Extraer y rotar ese token es del bloque 3.

Los logs redactan el `;jsessionid=` que el sitio reescribe dentro de las URLs (se
ve en el `<form action>` de `fixtures/oefa/01-bootstrap.html`). El bloque 1 ya
tuvo que resolverlo para los fixtures; los logs merecen el mismo cuidado, y más
todavía porque suelen terminar en sistemas de terceros:

```bash
LOG_LEVEL=debug npm run smoke:oefa 2>&1 | grep -c 'jsessionid=[A-Za-z0-9]'
```

#### Librerías: lo instalado y lo descartado

El enunciado sugiere `typescript`, `ts-node`, `axios` y `cheerio`. Se conservan
`axios` y `cheerio`; `ts-node` se reemplaza por `tsx`, que cumple el mismo rol sin
la fricción de ESM. Lo agregado:

| Paquete | Por qué |
|---|---|
| `tough-cookie` + `axios-cookiejar-support` | Axios **no tiene** cookie jar. Sin `JSESSIONID` persistente la paginación devuelve `200` con la tabla vacía. El wrapper además captura `Set-Cookie` emitidos **dentro** de cadenas de redirección, que un interceptor casero no ve porque axios las sigue internamente. |
| `zod` | Valida el entorno al arrancar. Un `HTTP_RPS=cinco` sin validar degrada a `setTimeout(NaN)` y cuelga el scraper sin decir por qué. |
| `pino` | Logging estructurado con redacción de identificadores de sesión. |
| `https-proxy-agent` | Proxy por variable de entorno. **No ejercitado contra ningún proxy real**: no se contrató ninguno para esta entrega, y se declara así en vez de presentarse como funcionalidad probada. |

Lo que **no** se instaló importa igual:

| Descartada | Razón |
|---|---|
| `bottleneck`, `p-limit` | El token bucket con AIMD *es* el criterio evaluado «manejo de 429». Ninguna implementa AIMD; delegarlo escondería justamente la respuesta. |
| `axios-retry`, `p-retry` | No pueden expresar el acople con el limiter, la prioridad de `Retry-After`, ni que un 403 aborte en vez de reintentar. |
| `nock`, `msw` | Interceptan a nivel de módulo: no reproducen un socket cortado (`ECONNRESET`) ni ejercitan el jar sobre el camino real de axios. El servidor de pruebas es un `node:http` efímero en puerto 0. |
| `commander`, `yargs` | `util.parseArgs` es nativo desde Node 18.3. |

### Bloque 3 — Capa JSF ✅

El protocolo, ya no como fixtures sino como código: bootstrap, evento AJAX,
submit no-ajax estilo `mojarra.jsfcljs`, y el `ViewState` rotando con un único
token vigente por sesión.

```bash
npm test              # la suite completa, sin red
npm run smoke:jsf     # opt-in: bootstrap → búsqueda → página 2 contra OEFA
```

El smoke recorre el protocolo completo contra el sitio real y comprueba seis
cosas: cookie propagada, `ViewState` presente y rotado en cada respuesta,
`rowCount` 1.753, diez filas por página y páginas sin solapamiento.

**Esta capa no sabe qué es un expediente.** Habla de `ViewState`, de Mojarra y de
PrimeFaces —para eso existe— pero no de jurisprudencia ni de resoluciones
ambientales, y [`tests/architecture.test.ts`](tests/architecture.test.ts) lo
verifica junto con algo más fuerte: **`cheerio` es la única dependencia de
runtime que `src/jsf/` tiene fuera de sí misma.** Todo lo demás —`Session`,
`Logger`, `Metrics`— entra como `import type` y llega inyectado, así que la capa
no puede construirse una sesión por su cuenta ni saltarse el rate limiter.

#### Tres cosas que la implementación descubrió

**La sesión caída no se anuncia como tal.** Se capturó un fixture nuevo
—[`06-view-expired.xml`](fixtures/oefa/06-view-expired.xml), un POST con el token
corrompido— y la respuesta son 113 bytes: `200`, `text/xml`, un `<redirect>` a la
página de inicio. **Sin `<error>`, sin `<error-name>`, y sin que la cadena
`ViewExpiredException` aparezca en ninguna parte.** La forma canónica de JSF es
la otra, así que un parser escrito contra la spec habría recibido acá un
`partial-response` válido con cero `<update>`, sin lanzar nada: cero filas, y el
síntoma de siempre — «el selector dejó de matchear». Las dos señales se tratan
como la misma condición.

**Un `<tr>` suelto se descarta en silencio.** La respuesta de paginación no trae
una tabla: trae una tira de `<tr data-ri="10">` pelados. El algoritmo de parsing
de HTML descarta un `<tr>` fuera de contexto de tabla, así que cargar ese
fragmento devuelve **cero filas** — el mismo síntoma que la sesión perdida, esta
vez causado por nosotros. Envuelto en `<table><tbody>` devuelve las diez. Es un
test, no un comentario.

**`04-download-a.html` empieza con `<?xml`.** Es una página HTML completa —el
resultado de pedir un PDF con el `ViewState` desalineado— pero sus primeros
bytes son `<?xml version='1.0' encoding='UTF-8' ?>` y recién después viene el
`<!DOCTYPE html>`. Detectar un `partial-response` por cómo arranca el cuerpo,
que es lo natural, clasifica mal justo el fixture que representa el peor caso.

#### Decisiones que definen la capa

- **Los errores de protocolo no heredan de `TransportError`.** No es estético:
  `withRetry()` reintenta todo lo que herede de ahí, y un `ViewExpiredError`
  reintentado cinco veces manda cinco veces el mismo token muerto. El arreglo de
  una vista caída no es «mandalo de nuevo» sino «reconstruí la vista y replicá el
  estado de aplicación», y eso no cabe en un `withRetry`.
- **El `;jsessionid=` se saca de las URLs**, y la cookie queda como única fuente
  de verdad de la sesión. Es seguro **porque** el bootstrap asevera que la cookie
  existe: si el sitio propagara la sesión solo por reescritura de URL, falla ahí
  y no trescientas páginas después con la tabla vacía.
- **`recover()` no bota la cookie**, aunque §5.1 lo describiera así. Los
  resultados viven en un bean de sesión: perderla cambia un error ruidoso por
  cero filas silenciosas. Y es innecesario — si la sesión murió de verdad, el GET
  trae un `Set-Cookie` nuevo y el jar la reemplaza solo.
- **La tabla vacía se devuelve como dato, no como excepción.** Esta capa no puede
  distinguir «se perdió la sesión» de «la búsqueda no tuvo resultados»: para eso
  hay que saber que el total esperado era 1.753. Ese contexto vive en `sources/`,
  y ahí van las aserciones duras.

### Bloque 4 — Adapter, parsers y persistencia ✅

El protocolo convertido en datos: bootstrap → búsqueda → una página por evento,
con las filas parseadas, validadas por esquema y escritas en JSONL.

```bash
npm run scrape -- --hasta 3      # tres páginas a data/oefa.jsonl
npm run scrape                   # el dataset completo (176 páginas, ~6 min)
npm run smoke:source             # opt-in: el adapter contra el sitio real
```

**Corrida real, con el output commiteado en [`data/oefa.jsonl`](data/oefa.jsonl):**
las 176 páginas, 1.753 filas recorridas, 177 requests, **cero `429` y cero
reintentos** a 1 req/s. En el archivo quedan **1.749 registros** — la diferencia
son cuatro filas que el propio portal publica repetidas, byte por byte, en la
misma página (una de ellas tres veces); no aportan información y se deduplican al
persistir. 131 registros no tienen documento asociado. La suite son **285 tests
sin red**, incluidos los que ejercitan los dos hallazgos de abajo contra fixtures
reales.

La corrida es **reanudable e idempotente**: antes de arrancar lee las identidades
que el archivo ya tiene y no las reescribe. Repetir el comando completa lo que
falte; correrlo dos veces sobre el mismo rango escribe cero líneas. `Ctrl-C`
corta en el borde de una página, nunca en medio de una escritura.

#### Lo que el sitio enseñó a la fuerza

Las dos correcciones de diseño de este bloque no salieron de leer el portal con
cuidado. Salieron de correrlo entero contra aserciones deliberadamente estrictas
y ver dónde se rompían. **Las dos son la misma equivocación vista desde lados
opuestos: usar el identificador del PDF como si fuera la clave del registro.**

**Corrida 1, registro 37 de 1.753 — hay filas sin documento.** OEFA publica
algunas resoluciones como «Información confidencial»: sin número y sin enlace de
descarga. Son registros legítimos —expediente, administrado, unidad fiscalizable
y sector están completos— a los que el organismo decidió no publicarles el PDF.
La aserción «toda fila tiene uuid» los daba por rotos.

**Corrida 2, registro 277 — y hay documentos compartidos.** Las filas 277 y 278
tienen el mismo expediente, el mismo administrado, la misma resolución y el mismo
PDF; se distinguen por la unidad fiscalizable. Una resolución que alcanza a dos
unidades es un registro por unidad y un solo documento.

Un identificador que a veces falta y a veces se repite no es una clave. El
registro lleva ahora un `id` derivado de su contenido y un `documentoUuid`
opcional, y el parser distingue dos condiciones que antes eran una sola:

| Condición | Significado | Política |
|---|---|---|
| La celda no trae `<a onclick>` | El sitio no publicó el documento | Dato: se persiste y se cuenta |
| Hay `<a onclick>` y no se deja leer | Cambió la forma del `onclick` | Drift: se detiene la corrida |

Ambos casos quedaron capturados como fixtures
([`07`](fixtures/oefa/07-page4-confidencial.xml),
[`08`](fixtures/oefa/08-page28-uuid-repetida.xml)) con tests que los ejercitan sin
red. Vale la pena decir qué se llevó cada opción: aserciones estrictas costaron
dos corridas y un rediseño; escritas flojas desde el principio habrían costado un
dataset con registros faltantes y nadie enterándose.

#### Detección de drift (§6.4)

Nueve condiciones detienen la corrida, cada una con su tipo, su contexto y un
test que la ve saltar —una aserción que nunca se vio fallar es una aserción que
no se sabe si funciona:

| Condición | Qué detecta |
|---|---|
| `sin-filas` | La sesión perdida: sin cookie la paginación devuelve `200` con la tabla vacía |
| `sin-total` | La búsqueda no reportó `rowCount`: sin total no hay última página |
| `pagina-incompleta` | Llegaron menos filas de las que corresponden a ese offset |
| `indices-desalineados` | El servidor ignoró el `dt_first` y re-renderizó otra página |
| `numeracion` | Las celdas se corrieron dentro de la fila |
| `columnas` | Cambió la estructura de la tabla |
| `sin-uuid` | El `onclick` cambió de forma |
| `solapamiento` | La paginación no avanzó: todas las filas ya se habían leído |
| `total-inestable` | El total cambió a mitad de recorrido, invalidando los offsets |
| `page-size` | El widget declara otro tamaño de página que el configurado |

Los rótulos de las columnas, en cambio, **avisan y no detienen**: cambian por una
tilde o un renombre editorial sin que cambie nada más, y una aserción que tumba
la corrida por cosmética es una aserción que alguien va a desactivar.

Dos de estos chequeos hacen falta juntos y ninguno reemplaza al otro.
`indices-desalineados` ve al servidor que ignoró el offset; `solapamiento` ve al
que respetó los `data-ri` pero sirvió el contenido de otra página. Y el
solapamiento se compara contra lo visto **en esta corrida**, nunca contra el
archivo: en una reanudación todo lo del archivo está legítimamente repetido.

#### Decisiones que definen la capa

- **El `ViewState` de cada página viaja con la página, no con el registro.**
  §5.4 probó que la descarga exige un token alineado con la página donde vive la
  fila. Pero es un blob de 1,5 KB y un identificador de sesión: multiplicado por
  1.753 registros infla el JSONL diez veces para guardar algo que no sirve en la
  corrida siguiente. Vive en memoria, en la `Pagina`.
- **La `JsfView` llega inyectada.** `src/sources/` no importa nada de
  `src/http/` —ni siquiera como tipo—, así que el adapter no puede construirse
  una sesión propia ni saltarse el rate limiter. Quien cablea es `cli/`, y
  [`tests/architecture.test.ts`](tests/architecture.test.ts) lo verifica.
- **La recuperación rehace la búsqueda, y después verifica.** `recover()` deja la
  vista lista y el bean de resultados vacío; volver a paginar sin volver a buscar
  devuelve la tabla vacía. El adapter es quien sabe qué se estaba buscando, así
  que la recuperación vive acá. Y el repaginado no es ciego: si el bean quedó en
  la página 1, `indices-desalineados` lo denuncia. Tope de un intento por offset,
  para que una vista que expira siempre en la misma página no cicle.
- **El writer del JSONL es síncrono.** Un `WriteStream` bufferea, y con buffer
  pendiente un `process.exit()` pierde líneas ya reportadas como escritas. A un
  request por segundo el costo de `writeSync` es ruido frente a la latencia de
  red, y a cambio «la llamada volvió» significa «los bytes están en el kernel».
  Un `fsync` por página, no por registro.
- **Al abrir se repara la cola truncada.** Una caída deja media línea al final;
  el siguiente append la concatenaría con el registro nuevo. Se trunca al último
  salto de línea y se reporta cuántos bytes se descartaron. El lector, en cambio,
  es estricto y lanza: para `npm run validate` del bloque 6 una cola truncada
  *es* un hallazgo.

### Bloques 5–8

Pendientes: descarga de PDFs con DLQ y checkpointing, sanity checks sobre el
dataset producido, adapter del Poder Judicial y documentación final.
