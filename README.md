# Desafío de scraping — Jurisprudencia Nacional Sistematizada

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
├── sources/     ⬜ adapters por fuente: oefa.ts, pj.ts
├── store/       ⬜ JSONL, checkpointing, dead-letter queue
├── validate/    ⬜ sanity checks y validación por esquema
└── cli/         ⬜
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

Tres decisiones que cuestan tiempo si se descubren tarde:

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
npm test              # 142 tests, sin red
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

### Bloques 4–8

Pendientes: adapters por fuente, descarga de PDFs con DLQ y checkpointing,
sanity checks y documentación.
