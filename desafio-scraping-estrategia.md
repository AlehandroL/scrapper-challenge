# Desafío de Scraping — Hallazgos, Estrategia e Implementación

**Autor:** Alejandro Leiva Ilabaca
**Fecha:** 12 de agosto de 2026
**Objetivo:** Scraper en TypeScript sin automatización de navegador para el portal de Jurisprudencia Nacional Sistematizada del Poder Judicial del Perú.

> **Nota sobre el estado de la evidencia.** Este documento distingue explícitamente entre:
> - ✅ **Verificado** — comprobado con comandos ejecutados, output disponible.
> - 🔶 **Inferido** — deducido del framework identificado y de fuentes secundarias; requiere confirmación contra el sitio.
> - ⬜ **Pendiente** — prueba diseñada pero no ejecutada.
>
> Nada marcado como inferido debe pasar al README público sin verificarse primero.

---

## 1. Resumen ejecutivo

Dos hallazgos determinan toda la estrategia:

1. **El sitio objetivo corre sobre JSF/Mojarra con PrimeFaces**, un framework stateful donde la paginación, los filtros y las descargas no son URLs direccionables sino eventos POST contra un árbol de componentes que vive en el servidor. Resolverlo sin navegador exige replicar el protocolo `ViewState` a mano. Este es el núcleo real del desafío.

2. **El portal está detrás de Radware Cloud WAF y bloquea desde Chile con 403**, y el bloqueo es por origen de la petición, no por características del cliente. Se descartó fingerprinting con evidencia positiva, no por suposición.

La estrategia es desarrollar contra el sitio alternativo (OEFA, mismo stack, acceso abierto) y abstraer la fuente detrás de un adapter. **El protocolo ya está verificado end-to-end contra OEFA** (§2.5): los tres requests que lo definen están replicados sin navegador y guardados como fixtures.

Sobre el acceso al Poder Judicial se tomó una decisión de alcance explícita: **no se contrata VPN ni proxy residencial**, de modo que el diagnóstico queda abierto y el adapter del PJ no se ejercita contra su fuente. Se entrega en cambio `scripts/check-access.sh`, que cierra el diagnóstico en un comando desde cualquier red con salida peruana. El diferencial de la entrega no está en el volumen descargado sino en el diagnóstico documentado, el manejo del rate limiting y las validaciones de integridad.

---

## 2. Hallazgos técnicos

### 2.1 Stack del sitio objetivo

**Identificación:** ✅ La ruta `/jurisprudenciaweb/faces/page/*.xhtml` es la firma canónica de JavaServer Faces. El servlet mapeado en `/faces/*` y la extensión `.xhtml` (Facelets) no aparecen en ningún otro stack.

**Implementación concreta:** ✅ Un scraper público del mismo sitio documenta que el botón "Ver Resolución" invoca:

```javascript
mojarra.jsfcljs(
  document.getElementById('formBusqueda'),
  {'formBusqueda:repeat:0:j_idt158':'formBusqueda:repeat:0:j_idt158',
   'uuid':'47cd6b37-8c7b-4cd0-b46a-adb4755bb161'},
  ''
);
```

El prefijo `mojarra.` confirma **Mojarra** como implementación de JSF (la de referencia, Oracle/Eclipse). El patrón `formBusqueda:repeat:0:...` indica un componente iterativo (`ui:repeat` o `p:dataTable`) sobre un form llamado `formBusqueda`. Cada resultado expone un `uuid` que lo identifica.

**Lo que esto implica:**

| Característica | Consecuencia para el scraper |
|---|---|
| Estado en servidor por sesión | Cookie `JSESSIONID` obligatoria y persistente |
| Token `ViewState` rotativo | Máquina de estados; un token vigente por sesión |
| Paginación por POST | No existe `?page=2`; hay que emitir eventos |
| Respuestas AJAX en XML | El HTML viene dentro de bloques CDATA |
| IDs de componente autogenerados | `j_idt158` cambia entre deploys; prohibido hardcodear |
| Sesión inherentemente serial | La concurrencia requiere sesiones independientes |

✅ **Resuelto contra OEFA** (§2.5), que corre el mismo stack: prefijo `javax.faces.*` (JSF 2.x, **no** Jakarta EE 9+), **PrimeFaces 6.0**, IDs reales de la tabla identificados, y state saving **client-side** — el token es un blob base64 de ~1,5 KB, no un handle corto de servidor. Queda por confirmar que el Poder Judicial coincida en los cuatro puntos; el más probable de divergir es el state saving, y de ahí que `recover()` (§5.1) siga siendo necesario.

### 2.2 Diagnóstico de acceso — jurisprudencia.pj.gob.pe

Diagnóstico por capas, del nivel más bajo al más alto:

| # | Capa | Prueba | Resultado | Lectura |
|---|---|---|---|---|
| 1 | DNS | `dig +short` | `*.radwarecloud.net` → `185.144.89.123` | ✅ Radware Cloud WAF adelante del origen |
| 2 | TCP | `nc -vz :443` | Conecta | ✅ Sin bloqueo de red |
| 3 | TLS | `openssl s_client` | TLS 1.3, `AES_256_GCM_SHA384`, cadena Sectigo completa, `Verify return code: 0` | ✅ Descartado problema de TLS legacy |
| 4 | HTTP | `curl` con UA por defecto | `403`, `server: rdwr` | ✅ Bloqueo en capa aplicación |
| 5 | HTTP | `curl` + 11 headers de Chrome | `403` | ✅ Headers no son el discriminante |
| 6 | HTTP | `curl --http1.1` | `403` | ✅ Descartada huella HTTP/2 |
| 7 | HTTP | `curl-impersonate` (`curl_chrome116`) | `403` | ✅ **Descartado fingerprinting TLS/JA3** |
| 8 | HTTP | UA de Googlebot | `403` | ✅ Sin allowlist por UA (Radware verifica por rDNS) |
| 9 | HTTP | 3 paths distintos + raíz del host | `403` en todos | ✅ Política de host, no de path |
| 10 | HTTP | `www.pj.gob.pe` (mismo /24 Radware, `.135`) | `302` | ✅ El edge deja pasar tráfico chileno |

**El test decisivo es el 7.** `curl-impersonate` replica el Client Hello de Chrome cifrado por cifrado y extensión por extensión, además del `SETTINGS` frame de HTTP/2 y el orden de headers. Su huella JA3/JA4 es indistinguible de un Chrome real. Recibir el mismo 403 con esa huella significa que **el WAF no está evaluando cómo se conecta el cliente, sino desde dónde**.

**El test 10 refina la conclusión.** `www.pj.gob.pe` y `jurisprudencia.pj.gob.pe` resuelven al mismo bloque `/24` de Radware pero tienen comportamiento distinto (302 vs 403). Radware Cloud se configura por aplicación protegida: la restricción es una regla específica de la app de jurisprudencia, no una política del PoP ni un bloqueo de red contra Chile.

**Conclusión (con el alcance correcto):** el discriminante es un atributo de la IP de origen. Queda por determinar **cuál**: país, ASN, o reputación puntual de la conexión.

### 2.3 Pruebas pendientes para cerrar el diagnóstico

⬜ Estos tres tests son gratuitos y separan las hipótesis restantes antes de comprometer presupuesto:

```bash
URL="https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml"

# A. Otro ASN chileno — hotspot móvil
curl -s -o /dev/null -w '%{http_code}\n' --max-time 15 "$URL"

# B. IP no-chilena y no-peruana — Google Cloud Shell (datacenter EE.UU.)
curl -s -o /dev/null -w '%{http_code}\n' --max-time 15 "$URL"

# C. Salida en Lima — VPN comercial con nodo Perú
curl -s -o /dev/null -w '%{http_code}\n' --max-time 15 "$URL"
```

Matriz de decisión:

| A (móvil CL) | B (EE.UU.) | C (Perú) | Diagnóstico | Solución |
|---|---|---|---|---|
| 200 | — | — | IP/ASN residencial específico | Rotación simple; sin costo geo |
| 403 | 200 | 200 | Denylist contra Chile o ISPs LATAM | Cualquier salida no-chilena (barato) |
| 403 | 403 | 200 | Allowlist solo Perú | IP peruana obligatoria |
| 403 | 403 | 403 | Restricción más profunda | Reevaluar; posible allowlist de rangos estatales |

La hipótesis más probable es la tercera fila, pero **el costo de las tres pruebas es cero y la diferencia presupuestaria entre la segunda y la tercera es significativa**, así que no corresponde asumir.

⬜ **Estado: no ejecutadas — decisión de alcance.** Las tres pruebas exigen salidas de red que no están disponibles desde el entorno de desarrollo: un hotspot móvil de otro ASN, una IP de datacenter estadounidense y una salida en Lima. Se decidió **no contratar VPN ni proxy residencial** para esta entrega y trabajar exclusivamente contra OEFA.

La consecuencia se declara sin adornos: **el diagnóstico de acceso al Poder Judicial queda abierto.** Sabemos qué no es el problema (§2.2 descarta fingerprinting TLS/JA3, headers, huella HTTP/2 y allowlist por UA) y sabemos que el discriminante es un atributo de la IP de origen, pero no cuál de los tres.

Para que cerrarlo sea un comando y no un proyecto, la entrega incluye `scripts/check-access.sh`: reporta IP, país y ASN de origen, prueba el objetivo, prueba `www.pj.gob.pe` como control del mismo bloque `/24` de Radware, e imprime la matriz de decisión de arriba junto al resultado. Cada corrida escribe su propio archivo en `evidencia/`, de modo que los resultados desde distintas redes se acumulan en vez de pisarse.

Quien evalúe esta entrega desde Perú cierra el diagnóstico en un comando:

```bash
bash scripts/check-access.sh
```

### 2.4 Sitio alternativo — publico.oefa.gob.pe

| Prueba | Resultado |
|---|---|
| `curl` sin headers | ✅ `200` |
| `dig +short` | `209.45.104.167` — sin WAF intermediario |
| Stack | ✅ `/repdig/consulta/consultaTfa.xhtml` → Mojarra JSF 2.x + PrimeFaces 6.0 |
| Dataset | ✅ 1.753 registros, 176 páginas de 10 |

Acceso completamente abierto y el mismo protocolo, ahora verificado y no supuesto (§2.5). Es un entorno de desarrollo ideal: ciclo de feedback rápido, sin costo de proxy, y el trabajo de protocolo se transfiere íntegro al sitio objetivo.

### 2.5 Protocolo verificado en OEFA

✅ Los tres requests que definen el protocolo —GET inicial, POST de paginación y descarga de PDF— están replicados sin navegador y guardados como fixtures en `fixtures/oefa/`. `scripts/capture-oefa.sh` los regenera end-to-end contra el sitio vivo.

**Lo que se confirmó tal cual estaba previsto:** la cookie `JSESSIONID` es obligatoria; el HTML de las filas viaja dentro de bloques `CDATA` en un documento XML; los ids de componente son autogenerados y volátiles (los campos de búsqueda se llaman `j_idt21`, `j_idt25`, `j_idt34`); el header `Faces-Request: partial/ajax` es indispensable; y hay que reenviar todos los campos del form, no solo los del evento.

**Lo que la evidencia corrigió:**

| Punto | Lo que se asumía | Lo verificado |
|---|---|---|
| State saving | Server-side (default de Mojarra), con LRU de ~15 vistas | **Client-side**: el token es un blob base64 de ~1,5 KB, no un handle `-834:-112`. No hay expiración por LRU. |
| Vigencia del token | Un solo `ViewState` vigente; el anterior queda inválido al usarse | **Reutilizable dentro de la sesión**: el mismo token sirvió para el POST de paginación y después para la descarga. |
| Id del token en la respuesta | `javax.faces.ViewState` | **`j_id1:javax.faces.ViewState:0`** — ver §5.2, es la corrección de mayor impacto. |
| `content-disposition` en la descarga | — | Existe, pero el filename viene en ISO-8859-1: `"RTFA N? 264-2012.pdf"`. Leerlo como UTF-8 produce mojibake. |

**El hallazgo con más consecuencias de diseño:** la descarga exige un `ViewState` **alineado con la página donde vive la fila**. Se verificó con un experimento controlado —misma sesión, misma fila, mismo conjunto de campos, variando solo el origen del token:

| `ViewState` | Respuesta |
|---|---|
| de la página 2 | `200`, `text/html`, la página re-renderizada, **sin PDF** |
| de la página 1 | `200`, `application/octet-stream`, `%PDF-1.4`, 9,3 MB |

Esto descarta el pipeline desacoplado "recolectar todo el metadata primero, descargar los PDFs después": el downloader tiene que replicar la paginación hasta la página de cada fila. Ver §5.4.

**Un modo de falla que conviene conocer antes de encontrarlo:** sin la cookie de sesión, la búsqueda funciona igual —es autocontenida— pero la paginación devuelve `200` con la tabla vacía (`ui-datatable-empty-message`). Los resultados viven en un bean de sesión; sin cookie, cada request abre una sesión nueva y el bean llega vacío. No hay excepción ni error: parece que el selector dejó de matchear. Es exactamente el tipo de falla silenciosa que §6.4 busca prevenir con aserciones duras.

Detalle de diagnóstico que cuesta caro: `curl` guarda las cookies `HttpOnly` en el jar con prefijo `#HttpOnly_`. Inspeccionar el jar con `grep -v '^#'` las oculta y lleva a concluir que el sitio no usa cookies. La conclusión equivocada sobrevive hasta que la paginación devuelve cero filas.

---

## 3. Estrategia propuesta

### 3.1 Principio rector

**Separar el problema de protocolo del problema de acceso.** El 80% del esfuerzo técnico (ViewState, partial-response, paginación, descargas, rate limiting) es idéntico en ambos sitios y no requiere IP peruana. Bloquearse esperando resolver el acceso antes de empezar a programar es el error de secuenciación más caro disponible.

### 3.2 Fases

**Fase 1 — Reversing del protocolo (contra OEFA)**
Inspección con DevTools: capturar el GET inicial, un POST de paginación y una descarga de PDF. Exportar cada uno como cURL y replicarlos desde terminal hasta obtener respuestas idénticas. Recién entonces escribir código. Entregable: tres requests replicados a mano + fixtures guardados.

**Fase 2 — Cliente HTTP y capa JSF**
Sesión con cookie jar, rate limiter, política de reintentos, y la máquina de estados del ViewState. Esta capa es agnóstica del sitio y es la que se reutiliza en el próximo portal legacy.

**Fase 3 — Adapters por fuente**
`sources/oefa.ts` y `sources/pj.ts` implementando la misma interfaz. Los selectores, IDs de componente y el mapeo de campos viven acá; nada de eso se filtra a las capas inferiores.

**Fase 4 — Descarga de PDFs, resiliencia y persistencia**
Streaming a disco, validación de integridad, backoff adaptativo, dead-letter queue, checkpointing.

**Fase 5 — Validación y documentación**
Sanity checks, tests con fixtures, README, y una corrida real acotada contra ambos sitios con output commiteado.

### 3.3 Manejo de la restricción de acceso

- Desarrollo y tests de integración: OEFA, sin proxy.
- Validación contra el Poder Judicial: proxy configurable por variable de entorno, con salida peruana confirmada.
- El README declara con precisión qué se corrió contra cada sitio. **No se simula cobertura que no se logró**; el diagnóstico documentado vale más que un número inflado de documentos.

**Decisión tomada:** no se contrata VPN ni proxy residencial para esta entrega. El scraper se desarrolla y se valida contra OEFA; el adapter del Poder Judicial se escribe contra el protocolo verificado, pero **no se ejecuta contra el sitio real**. Aplicando el propio criterio del párrafo anterior, se declara así y no de otra forma: el `pj.ts` que se entregue queda como código no ejercitado contra su fuente, y decir lo contrario sería exactamente el número inflado que este documento rechaza.

Lo que sí se entrega para cerrar la brecha es `scripts/check-access.sh` (§2.3), que convierte el diagnóstico pendiente en un comando para quien tenga salida peruana.

---

## 4. Arquitectura

```
src/
├── http/
│   ├── session.ts          # axios + cookie jar + agent/proxy por sesión
│   ├── rate-limiter.ts     # token bucket con ajuste AIMD
│   ├── retry.ts            # backoff exponencial con full jitter
│   └── circuit-breaker.ts  # pausa global ante degradación
├── jsf/
│   ├── view-state.ts       # extracción y rotación del token
│   ├── partial-response.ts # parsing XML → CDATA → HTML
│   ├── form.ts             # serialización de campos del form
│   └── commands.ts         # paginación, mojarra.jsfcljs
├── sources/
│   ├── types.ts            # interfaz común de fuente
│   ├── oefa.ts
│   └── pj.ts
├── store/
│   ├── jsonl.ts            # escritura append + lectura streaming
│   ├── checkpoint.ts       # estado de reanudación
│   └── dlq.ts              # registro de fallos
├── validate/
│   ├── sanity.ts           # chequeos de consistencia del dataset
│   └── schema.ts           # validación por registro (zod)
└── cli/
    ├── scrape.ts
    ├── download.ts
    ├── retry-failed.ts
    └── validate.ts
```

**Criterio de diseño:** la capa `jsf/` no sabe nada de jurisprudencia ni de resoluciones ambientales. La capa `sources/` no sabe nada de reintentos ni de cookies. Que un evaluador pueda ver que `jsf/` es reutilizable para el próximo portal comunica exactamente la capacidad que el rol busca.

---

## 5. Detalles de implementación

### 5.1 Máquina de estados del ViewState

El invariante central: **un solo ViewState vigente por sesión, actualizado en cada respuesta.**

✅ **Ajuste tras verificar (§2.5).** En OEFA el state saving es *client-side*: el token es un blob base64 de ~1,5 KB que serializa el árbol de componentes, no un handle contra un mapa del servidor. Dos consecuencias que suavizan el diagrama de abajo: el token **no se invalida al usarse** (se reutilizó con éxito en dos POSTs consecutivos), y **no hay LRU de vistas** que pueda desalojarlo. Lo que sí sigue siendo obligatorio es la cookie `JSESSIONID`: los resultados de la búsqueda viven en un bean de sesión, y sin ella la paginación devuelve la tabla vacía con `200`.

El modelo estricto de abajo se mantiene como el caso conservador —es el comportamiento con state saving server-side, que el Poder Judicial puede perfectamente usar—, y `recover()` sigue siendo necesario por esa razón. Tratar el token como de un solo uso cuando en realidad es reutilizable no rompe nada; la inversa sí.

```
GET inicial
  → Set-Cookie: JSESSIONID
  → HTML con ViewState = A
       │
       ▼
POST (evento de paginación) con ViewState = A
  → <partial-response> con filas + ViewState = B
       │  (A queda inválido)
       ▼
POST con ViewState = B  ✅
POST con ViewState = A  ❌ ViewExpiredException
```

```typescript
class JsfSession {
  private viewState: string | null = null;

  /** Toda respuesta pasa por acá; el token nunca se actualiza en otro lugar. */
  private absorb(newViewState: string | undefined): void {
    if (newViewState) this.viewState = newViewState;
  }

  /** Reconstruye la sesión tras expiración: nueva cookie, nuevo bootstrap. */
  async recover(): Promise<void> { /* ... */ }
}
```

Con *server-side state saving* (el default en Mojarra), el servidor conserva un número acotado de vistas por sesión en un LRU — típicamente 15. Sesiones muy largas pueden perder vistas antiguas aunque el token sea el más reciente. Por eso `recover()` no es opcional y el checkpointing debe permitir retomar desde una página arbitraria.

### 5.2 Parsing del partial-response

✅ Estructura real, tomada de `fixtures/oefa/02-search-partial.xml`:

```xml
<?xml version='1.0' encoding='UTF-8'?>
<partial-response id="j_id1">
  <changes>
    <update id="listarDetalleInfraccionRAAForm:pgLista"><![CDATA[ <table>...</table> ]]></update>
    <update id="j_id1:javax.faces.ViewState:0"><![CDATA[ wT35Rs4wdvMRGTAPYlWqeBELpr5... ]]></update>
  </changes>
</partial-response>
```

**El id del ViewState no es `javax.faces.ViewState`.** JSF lo emite como `j_id1:javax.faces.ViewState:0`, con el prefijo del naming container y un índice. Un lookup por id exacto devuelve `undefined` contra toda respuesta real, y el síntoma —token vacío, sesión que parece caída— se confunde con un bloqueo del sitio. Hay que buscar por subcadena.

Requiere dos pasadas de parsing. Aplicar cheerio directamente sobre el cuerpo devuelve cero filas, porque el HTML está encapsulado en CDATA dentro de un documento XML.

```typescript
import * as cheerio from 'cheerio';

export interface PartialResponse {
  updates: Map<string, string>;
  viewState?: string;
  redirect?: string;
  error?: string;
}

export function parsePartialResponse(xml: string): PartialResponse {
  const $xml = cheerio.load(xml, { xmlMode: true });

  const updates = new Map<string, string>();
  $xml('update').each((_, el) => {
    const id = $xml(el).attr('id');
    if (id) updates.set(id, $xml(el).text());  // .text() resuelve el CDATA
  });

  return {
    updates,
    viewState: findViewState(updates),
    redirect: $xml('redirect').attr('url'),
    error:    $xml('error-name').text() || undefined,
  };
}

/**
 * El id real incluye el naming container y un índice:
 *   j_id1:javax.faces.ViewState:0
 * Buscar por id exacto devuelve undefined contra toda respuesta real.
 * El prefijo además cambia entre versiones: javax.* (JSF ≤2.x) /
 * jakarta.* (Jakarta EE 9+), así que se matchea el sufijo de ambos.
 */
const VIEW_STATE_ID = /(?:^|:)(?:javax|jakarta)\.faces\.ViewState(?::|$)/;

function findViewState(updates: Map<string, string>): string | undefined {
  for (const [id, value] of updates) {
    if (VIEW_STATE_ID.test(id)) return value;
  }
  return undefined;
}
```

`<redirect>` y `<error>` son las señales explícitas de sesión caída: hay que manejarlas, no dejarlas pasar como respuesta vacía.

### 5.3 Emisión de eventos de paginación

✅ Cuerpo verificado para un `p:dataTable` de PrimeFaces (`application/x-www-form-urlencoded`). En OEFA `<formId>` es `listarDetalleInfraccionRAAForm` y `<tableId>` es `dt`:

```
javax.faces.partial.ajax=true
javax.faces.source=<formId>:<tableId>
javax.faces.partial.execute=<formId>:<tableId>
javax.faces.partial.render=<formId>:<tableId>
javax.faces.behavior.event=page
<formId>:<tableId>_pagination=true
<formId>:<tableId>_first=<offset>
<formId>:<tableId>_rows=<pageSize>
<formId>:<tableId>_skipChildren=true
<formId>:<tableId>_encodeFeature=true
<formId>=<formId>
javax.faces.ViewState=<token vigente>
```

Comprobado en `fixtures/oefa/03-page2-partial.xml`: con `_first=10` la respuesta trae los `data-ri` 10–19, sin solapamiento con la página anterior.

Headers obligatorios:

```
Content-Type:     application/x-www-form-urlencoded; charset=UTF-8
Faces-Request:    partial/ajax
X-Requested-With: XMLHttpRequest
Referer:          <URL de la página>
```

**`Faces-Request: partial/ajax` es el header que más se omite.** Sin él, el servidor responde la página completa en vez del diff XML, el parser no encuentra `<partial-response>` y el síntoma se confunde con un bloqueo.

Además hay que reenviar **todos los campos del form original** (inputs de búsqueda, filtros, hidden fields), no solo los parámetros del evento. JSF procesa el submit completo del form, no un fragmento.

### 5.4 Descarga de PDFs y extracción de IDs volátiles

`mojarra.jsfcljs(form, params, target)` hace tres cosas: inyecta inputs hidden en el form con los pares recibidos, ejecuta `form.submit()` (POST **no-ajax**) y luego los remueve. Para replicarlo: POST normal al `action` del form con todos sus campos + los parámetros extra + el ViewState, **sin** los headers `Faces-Request` ni los `javax.faces.partial.*`.

✅ Verificado en OEFA, donde el parámetro del documento se llama `param_uuid` (en el Poder Judicial, `uuid`):

```
<formId>=<formId>
<formId>:dt:<rowIndex>:<botonId>=<formId>:dt:<rowIndex>:<botonId>
param_uuid=<uuid del documento>
… resto de campos del form …
javax.faces.ViewState=<token de la página donde vive la fila>
```

**El ViewState tiene que estar alineado con la página de la fila.** Verificado con un experimento controlado (§2.5): misma sesión, misma fila, mismo conjunto de campos, variando solo el origen del token. Con el de la página 2 el servidor devuelve `200` con la página re-renderizada; con el de la página 1, el PDF. Tiene sentido: `dt:0:...` referencia la fila por índice dentro del árbol de componentes, y ese índice solo significa lo correcto en el estado que corresponde.

Consecuencia para la arquitectura: **no se puede recolectar todo el metadata primero y descargar los PDFs en una etapa posterior e independiente.** El downloader tiene que emitir los eventos de paginación hasta la página de cada fila antes de pedir su documento. La alternativa —descargar intercalado con el recorrido— es más simple y es la que conviene por defecto; un `retry-failed` que reprocese fallos sueltos necesita saber re-navegar hasta la página del registro.

El identificador de componente (`j_idt158` en el ejemplo) es autogenerado por JSF según el orden de aparición en el árbol. **Agregar un componente más arriba en la página desplaza todos los IDs posteriores.** Hardcodearlo garantiza que el scraper muera silenciosamente en el próximo deploy — el sitio ya presenta páginas en V1.0.29 y otras en V1.1.1, evidencia de que hay releases activos.

```typescript
/** Extrae los parámetros de la llamada a mojarra.jsfcljs en el onclick. */
export function extractCommandParams(onclick: string): Record<string, string> {
  const m = onclick.match(/mojarra\.jsfcljs\([^,]+,\s*(\{[\s\S]*?\})\s*,/);
  if (!m) throw new Error(`onclick sin patrón mojarra.jsfcljs: ${onclick.slice(0, 120)}`);
  return JSON.parse(m[1].replace(/'/g, '"'));  // objeto JS con comillas simples → JSON
}
```

**Validación de integridad del PDF.** Estos portales responden HTTP 200 con HTML de error o de sesión expirada en lugar del binario. Sin verificación se acumulan archivos `.pdf` que son páginas web:

```typescript
const PDF_MAGIC = '%PDF-';

function assertIsPdf(head: Buffer, contentType?: string): void {
  if (head.subarray(0, 5).toString('latin1') !== PDF_MAGIC) {
    throw new InvalidPdfError(`Respuesta no es PDF (content-type: ${contentType})`);
  }
}
```

Descargar con `responseType: 'stream'`, escribir a un archivo temporal, validar los primeros bytes y el tamaño mínimo, y recién entonces renombrar al destino final. Así nunca queda un archivo corrupto ocupando el lugar de uno válido y bloqueando el reintento.

✅ El fixture `04-download-a.html` es exactamente ese caso: `200`, `content-type: text/html`, y el cuerpo es la página de resultados. Sirve para testear el validador sin tocar la red.

Nombres de archivo: `${uuid}_${slug(titulo).slice(0, 80)}.pdf`, sanitizando caracteres inválidos. El `uuid` va primero para garantizar unicidad; el mapeo autoritativo `uuid → filename` se guarda en el JSONL, no se infiere del nombre.

Conviene además **no confiar en el `content-disposition`**. OEFA sí lo manda, pero con el filename en ISO-8859-1 y sin la codificación de RFC 5987:

```
content-disposition: attachment;filename="RTFA N? 264-2012.pdf"
```

El `º` de `Nº` leído como UTF-8 produce mojibake, y el nombre tampoco garantiza unicidad entre resoluciones. Construir el nombre desde nuestro propio metadata evita las dos cosas.

### 5.5 Concurrencia

La sesión JSF es serial por construcción. Cinco requests paralelos con el mismo token producen un éxito y cuatro `ViewExpiredException`, más un estado local corrupto por escrituras concurrentes del ViewState.

✅ Confirmado en OEFA por la vía negativa: los resultados de la búsqueda viven en un bean asociado a la cookie `JSESSIONID`, y la paginación depende de ese estado. Que el ViewState resulte reutilizable (§5.1) no cambia el diseño: el estado compartido sigue siendo la sesión, no el token.

**No se resuelve con un mutex** (eso deja el rendimiento igual que serial). Se resuelve con **N sesiones independientes**: cada worker con su propio cookie jar, su propio GET de bootstrap, su propio ViewState y un rango de páginas asignado. Se comportan como N navegadores distintos.

Cuando haya proxy de por medio, cada sesión necesita **IP fija durante toda su vida** (sticky session). La rotación de IP por request —comportamiento por defecto de los proveedores residenciales— es incompatible con el modelo stateful: el `JSESSIONID` queda asociado a un nodo y a una IP, y cambiarla provoca expiración inmediata.

### 5.6 Rate limiting y manejo del 429

El enunciado destaca explícitamente los 429 en las descargas, lo que lo convierte en un criterio calificado. Consideración adicional derivada del diagnóstico: **si el rate limiting proviene del WAF y no de la aplicación Java, el castigo por exceso puede escalar de 429 temporal a bloqueo de IP.** Eso eleva el costo de una política agresiva.

| Mecanismo | Función | Por qué importa |
|---|---|---|
| Token bucket global | Regula la tasa de forma centralizada | El 429 se **previene** con throttling; los reintentos solo lo **curan** |
| Backoff exponencial | `base × 2^intento`, con tope | Cede espacio de forma creciente |
| **Full jitter** | `random(0, min(cap, base × 2^n))` | Sin jitter, N workers reintentan sincronizados y se auto-perpetúan |
| `Retry-After` | Prioridad sobre el cálculo propio | El servidor está diciendo explícitamente cuánto esperar |
| **AIMD** | 429 → tasa ÷ 2; N éxitos → tasa + δ | El scraper encuentra el límite solo, sin número mágico hardcodeado |
| Circuit breaker | Pausa global si la tasa de 429 supera un umbral | Válvula de seguridad ante degradación del servidor |
| Dead-letter queue | `failed.jsonl` con motivo e intentos | Requisito explícito del enunciado |

```typescript
/** Full jitter: el delay es aleatorio entre 0 y el tope exponencial, no tope + ruido. */
function backoffMs(attempt: number, baseMs = 1000, capMs = 60_000): number {
  return Math.random() * Math.min(capMs, baseMs * 2 ** attempt);
}

/** AIMD: bajada agresiva ante congestión, subida cauta ante éxito sostenido. */
class AdaptiveRate {
  constructor(private rps: number, private readonly min = 0.2, private readonly max = 5) {}
  onThrottled() { this.rps = Math.max(this.min, this.rps / 2); }
  onSuccessStreak() { this.rps = Math.min(this.max, this.rps + 0.1); }
}
```

Diferenciar códigos: `429` → backoff + reducción de tasa; `403` → posible ban, detener y alertar; `503` → backoff largo; `ECONNRESET`/timeout → reintento inmediato acotado. Tratarlos todos igual es el error frecuente.

Formato de la DLQ:

```json
{"uuid":"47cd...","tipo":"pdf","error":"HTTP_429","intentos":5,"ultimoTs":"2026-08-12T14:22:01Z"}
```

Con `npm run retry-failed` consumiéndola. El enunciado pide literalmente "registrar qué documentos fallaron para poder reintentarlos después".

### 5.7 Persistencia y reanudación

**JSONL, no un array JSON.** Un `[{...}, {...}]` monolítico obliga a mantener todo en memoria y a escribir al final: una caída en el registro 4.000 pierde la corrida completa. JSONL permite append incremental, lectura en streaming y reanudación.

Checkpoint por fuente: última página completada, timestamp, conteo acumulado, hash del conjunto de filtros. Al reiniciar, el scraper retoma desde ahí y omite PDFs ya presentes y validados en disco.

**Idempotencia:** correr el scraper dos veces sobre el mismo rango no debe duplicar registros ni redescargar archivos íntegros.

---

## 6. Elementos diferenciadores para la evaluación

La mayoría de las entregas serán un script funcional. Lo que las distingue:

### 6.1 Mapeo criterio → evidencia

| Criterio del enunciado | Evidencia concreta en la entrega |
|---|---|
| Funcionalidad | Corrida real con output commiteado; conteos verificables |
| Manejo de 429 | AIMD + full jitter + `Retry-After` + circuit breaker + DLQ + `retry-failed` |
| Código limpio | Separación transporte / protocolo / dominio / persistencia |
| Robustez | Recuperación de `ViewExpiredException`, validación de PDFs, detección de drift |
| Documentación | README con el proceso de descubrimiento, no solo instrucciones |

### 6.2 La sección "cómo descubrí el protocolo"

El enunciado dice explícitamente que descubrir la estructura del sitio *es parte del desafío*. Documentar el razonamiento —qué se observó en DevTools, cómo se dedujo el ciclo del ViewState, qué request se replicó primero, qué hipótesis se descartaron— demuestra el proceso que el rol busca contratar. Vale más que doscientas líneas adicionales de código.

Lo mismo aplica al diagnóstico de acceso de la §2.2: la tabla completa de diez pruebas, con la conclusión de que `curl-impersonate` descarta fingerprinting, es un artefacto que casi nadie va a incluir. La alternativa típica —"el sitio requiere VPN, usé el alternativo"— describe el mismo hecho sin demostrar ninguna capacidad.

### 6.3 Sanity checks como comando ejecutable

El correo del rol menciona explícitamente la disciplina de validar con sanity checks. Entregarlos como `npm run validate` con reporte legible, y no como un párrafo del README:

- Total reportado por el sitio vs. registros capturados
- UUIDs duplicados
- Solapamiento entre páginas consecutivas (síntoma clásico de desalineación del ViewState)
- Porcentaje de fechas parseadas correctamente
- PDFs con magic byte válido y tamaño sobre el mínimo
- Campos obligatorios no nulos por registro

### 6.4 Detección de drift

El peor modo de falla de un scraper no es la excepción: es seguir corriendo tres semanas escribiendo datos vacíos sin que nadie lo note. Aserciones duras en los puntos críticos:

```typescript
if (filas.length === 0) {
  throw new StructuralDriftError('0 filas: selector obsoleto o sesión inválida');
}
if (!esUltimaPagina && filas.length !== pageSize) {
  throw new StructuralDriftError(`Página incompleta: ${filas.length}/${pageSize}`);
}
if (columnasDetectadas.length !== columnasEsperadas.length) {
  throw new StructuralDriftError('Cambió la estructura de la tabla');
}
```

Esto responde directamente al requisito de "continuidad operativa" del rol.

### 6.5 Tests con fixtures reales

Respuestas HTTP reales guardadas en `fixtures/` (partial-response completo, fila individual, respuesta 429, HTML de sesión expirada) y tests que parsean esos archivos sin tocar la red. Permite CI, y cuando el sitio cambie el ciclo de corrección baja de minutos a segundos.

### 6.6 Observabilidad

Logging estructurado (`pino`) con métricas por corrida: páginas/minuto, tasa de 429, tasa de éxito de descargas, tasa actual del limiter, expiraciones de ViewState recuperadas. Un scraper que reporta su propia salud es un scraper que se puede operar.

### 6.7 Validación por esquema

`zod` sobre cada registro parseado antes de persistirlo. Barato de implementar y comunica directamente el requisito de "que los datos tengan sentido".

---

## 7. Riesgos y decisiones abiertas

| Riesgo | Impacto | Mitigación |
|---|---|---|
| ~~Acceso al PJ no resuelto a tiempo~~ **Materializado** (§3.3) | Entrega validada solo contra OEFA | Adapter escrito contra el protocolo verificado + diagnóstico documentado + `check-access.sh`; declarado con precisión y sin simular cobertura |
| IP de datacenter bloqueada por ASN pese a geo correcta | VPS peruano inútil | Probar VPS antes de comprometerse; fallback a residencial |
| Challenge JavaScript de Radware tras pasar el filtro geo | Bloqueo sin navegador | Resolver el challenge una vez manualmente e inyectar la cookie, documentando TTL y limitación |
| Rate limiting del WAF escala a ban de IP | Pérdida de acceso | Política conservadora por defecto, circuit breaker, AIMD |
| OEFA con protocolo divergente | Menos transferencia al PJ | La capa `jsf/` es genérica; solo cambia el adapter |

**Decisión abierta:** cuánto invertir en acceso al PJ. Un mes de proxy residencial para un demo es un gasto menor; el criterio propuesto es confirmar la hipótesis con VPN de prueba (costo cero) antes de contratar nada.

---

## 8. Plan de trabajo

Estimación total: **8–12 horas efectivas**. El punto de rendimiento decreciente llega rápido: el diferencial está en el diagnóstico, los sanity checks y el README, no en el volumen descargado. El enunciado es explícito en que no se requiere descargar todo.

| Bloque | Contenido | Horas | Estado |
|---|---|---|---|
| 1 | Cerrar diagnóstico de acceso (§2.3) + reversing del protocolo en OEFA | 2 | ✅ Protocolo verificado (§2.5) con fixtures y script de captura. Diagnóstico de acceso **no cerrado por decisión de alcance**; entregado `check-access.sh` para cerrarlo desde una red con salida peruana. |
| 2 | Cliente HTTP: sesión, cookie jar, rate limiter, retry | 2 | Pendiente |
| 3 | Capa JSF: ViewState, partial-response, comandos | 2 | Pendiente |
| 4 | Adapter OEFA + parsers + persistencia JSONL | 2 | Pendiente |
| 5 | Descarga de PDFs, DLQ, checkpointing | 1.5 | Pendiente — ver la restricción de alineación del ViewState (§5.4) |
| 6 | Sanity checks, tests con fixtures, drift detection | 1.5 | Pendiente — fixtures ya disponibles |
| 7 | Adapter PJ + ~~validación con salida peruana~~ | 1 | Pendiente — sin validación contra el sitio real (§3.3) |
| 8 | README y documentación del proceso | 1.5 | Pendiente |

---

## 9. Preguntas para el equipo

Para la entrevista técnica, o antes si corresponde:

1. **Egress geo-restringido:** ¿tienen infraestructura propia por país, contratan proxies residenciales, o cada scraper resuelve su acceso? ¿Quién absorbe el costo por GB?
2. **Cambios de sitio:** cuando un portal cambia y rompe un scraper, ¿cómo se factura la corrección — dentro del alcance de la tarea original o como tarea nueva?
3. **Monitoreo:** ¿existe alerting sobre las corridas o cada scraper reporta por su cuenta?
4. **Volumen:** ¿qué cadencia de tareas manejan por mes? (Relevante para dimensionar la regularidad del ingreso bajo modalidad por tarea.)
5. **Frecuencia de ejecución:** ¿corridas incrementales periódicas o cargas completas? Cambia el diseño del checkpointing y la deduplicación.

La primera pregunta es la más informativa: la respuesta indica si hay infraestructura madura o si construirla es parte no declarada del trabajo.

---

## Anexo — Comandos de diagnóstico reutilizables

```bash
HOST="jurisprudencia.pj.gob.pe"
URL="https://$HOST/jurisprudenciaweb/faces/page/resultado.xhtml"

dig +short "$HOST"                                    # ¿WAF/CDN adelante?
nc -vz "$HOST" 443                                    # capa TCP
openssl s_client -connect "$HOST:443" -servername "$HOST" </dev/null 2>&1 | \
  grep -E 'Protocol|Cipher|Verify return code'        # capa TLS
curl -s -o /dev/null -w '%{http_code}\n' "$URL"       # capa HTTP
curl -sI "$URL" | grep -i '^server'                   # identificar el WAF

# Descartar fingerprinting de cliente (huella TLS/HTTP2 de Chrome real)
docker run --rm lwthiker/curl-impersonate:0.6-chrome \
  curl_chrome116 -s -o /dev/null -w '%{http_code}\n' "$URL"
```

Secuencia aplicable a cualquier fuente nueva. Cinco minutos que evitan días de diagnóstico equivocado — en este caso, evitaron invertir en soluciones anti-bot para un problema que no era anti-bot.
