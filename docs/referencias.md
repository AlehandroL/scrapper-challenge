# Índice de referencias «§»

Los comentarios del código citan secciones con la forma `§5.4`. Apuntan al documento de
estrategia con el que se planificó el trabajo, que vive en `planes/` y **no está
versionado**: es material de planificación interno y se sacó del repo en el bloque 1 a
propósito.

Las citas se conservan porque son la trazabilidad de cada decisión —y porque la bitácora
las usa con el mismo sentido—, pero un `§5.4` suelto no le sirve a quien lee el código sin
tener el documento. Esta tabla lo cierra: **qué dice cada sección y dónde está reproducido
su contenido dentro del repo.** No hace falta el documento para seguir el hilo.

[`tests/referencias.test.ts`](../tests/referencias.test.ts) exige que toda etiqueta citada
en `src/`, `scripts/`, `tests/` o `docs/` tenga su fila acá. El índice no se puede quedar
atrás sin que la suite avise.

## Hallazgos y estrategia

| § | Qué dice | Dónde está reproducido |
|---|---|---|
| **§2.1** Stack del sitio objetivo | Cómo se identificó JSF/Mojarra: la ruta `/faces/*.xhtml` es la firma canónica, y el `onclick` de la fila invoca `mojarra.jsfcljs`. Corregida en el bloque 7 — el Poder Judicial corre RichFaces 4.2.2 y guarda el estado en el servidor, no PrimeFaces. | [bitácora, Bloque 1](bitacora.md#bloque-1--reversing-del-protocolo-) · [Bloque 7, «Cuatro supuestos refutados»](bitacora.md#cuatro-supuestos-refutados-por-el-markup-del-propio-portal) |
| **§2.2** Diagnóstico de acceso al PJ | Las pruebas por capas —DNS, TCP, TLS, headers, HTTP/1.1, `curl-impersonate`— que descartan todo salvo una hipótesis: el discriminante es un atributo de la IP de origen. | [proceso.md, «El diagnóstico de acceso»](proceso.md#el-diagnóstico-de-acceso-y-lo-que-enseñó) |
| **§2.3** Pruebas pendientes del diagnóstico | Los tres orígenes de red —otro ASN, datacenter no peruano, salida en Lima— que separan país, ASN y reputación. No se ejecutaron. | [`scripts/check-access.sh`](../scripts/check-access.sh) (cabecera) · [proceso.md](proceso.md#el-diagnóstico-de-acceso-y-lo-que-enseñó) |
| **§2.4** Sitio alternativo — `publico.oefa.gob.pe` | El otro portal del enunciado: abierto, sin WAF intermediario, mismo Mojarra. Empezó como sitio de desarrollo y terminó siendo el principal de la entrega. Igual que la §2.1, daba por hecho que el Poder Judicial corría el mismo stack. | [README](../README.md) (encabezado) · [bitácora, Bloque 7](bitacora.md#bloque-7--adapter-del-poder-judicial-) |
| **§2.5** Protocolo verificado en OEFA | Los tres requests replicados sin navegador, y lo que la evidencia corrigió: state saving *client-side*, token reutilizable dentro de la sesión, `JSESSIONID` obligatoria, y la búsqueda sin filtros reversada —de ahí que la interfaz de fuente no acepte filtros—. | [bitácora, Bloque 1](bitacora.md#bloque-1--reversing-del-protocolo-) · [proceso.md, «Lo que la evidencia corrigió»](proceso.md#2-lo-que-la-evidencia-corrigió) · [`fixtures/oefa/README.md`](../fixtures/oefa/README.md) |
| **§3.3** Manejo de la restricción de acceso | No se contrata VPN ni proxy para esta entrega: OEFA queda como sitio principal y el adapter del Poder Judicial se declara como código no ejercitado contra su fuente, en vez de simular cobertura. | [README, «Limitaciones conocidas»](../README.md#limitaciones-conocidas) · [bitácora, «Lo que no se verificó»](bitacora.md#lo-que-no-se-verificó-dicho-como-corresponde) |
| **§4** Arquitectura | El árbol de capas `http/` · `jsf/` · `sources/` · `store/` · `validate/` · `obs/`, y la afirmación que lo ordena: `jsf/` no sabe de dominio y sirve para el próximo portal legacy. | [proceso.md, «Arquitectura»](proceso.md#arquitectura) · [`tests/architecture.test.ts`](../tests/architecture.test.ts) |

## Detalles de implementación

| § | Qué dice | Dónde está reproducido |
|---|---|---|
| **§5.1** Máquina de estados del ViewState | Un solo token vigente por sesión, actualizado en cada respuesta. El modelo estricto se mantiene como caso conservador —y resultó ser el caso real del Poder Judicial, que guarda estado en el servidor—, con `recover()` para la vista caída. | [bitácora, Bloque 3](bitacora.md#bloque-3--capa-jsf-) · [«Decisiones que definen la capa»](bitacora.md#decisiones-que-definen-la-capa) |
| **§5.2** Parsing del `partial-response` | XML → `CDATA` → HTML, y el id real del token: `j_id1:javax.faces.ViewState:0`, no `javax.faces.ViewState`. | [bitácora, Bloque 1](bitacora.md#bloque-1--reversing-del-protocolo-) · [«Tres cosas que la implementación descubrió»](bitacora.md#tres-cosas-que-la-implementación-descubrió) |
| **§5.3** Emisión de eventos de paginación | El cuerpo del POST que pagina un `p:dataTable` de PrimeFaces, con `dt_first` y el form completo reenviado. | [bitácora, Bloque 3](bitacora.md#bloque-3--capa-jsf-) |
| **§5.4** Descarga de PDFs e ids volátiles | `mojarra.jsfcljs` es un POST **no-ajax** con los pares del `onclick`, y **exige un `ViewState` alineado con la página donde vive la fila**: con el de otra página el servidor devuelve `200` y la página re-renderizada en vez del PDF. Es lo que descarta el pipeline «recolectar todo primero, descargar después». | [bitácora, Bloque 1](bitacora.md#bloque-1--reversing-del-protocolo-) · [Bloque 5, «La restricción que ordena el bloque»](bitacora.md#la-restricción-que-ordena-el-bloque) |
| **§5.5** Concurrencia | La sesión JSF es serial por construcción: el paralelismo son N sesiones independientes, no un mutex. Con proxy, cada sesión necesita IP fija durante toda su vida. | [bitácora, Bloque 2](bitacora.md#bloque-2--cliente-http-) · [README, «Limitaciones conocidas» (4)](../README.md#limitaciones-conocidas) |
| **§5.6** Rate limiting y manejo del 429 | Token bucket con AIMD, full jitter, prioridad del `Retry-After` y circuit breaker. El 429 se previene con throttling; los reintentos solo lo curan. Si el limitador es el WAF, el castigo puede escalar de 429 a ban de IP. | [bitácora, Bloque 2](bitacora.md#bloque-2--cliente-http-) · [Bloque 5, «Qué detiene la corrida y qué solo se anota»](bitacora.md#qué-detiene-la-corrida-y-qué-solo-se-anota) |
| **§5.7** Persistencia y reanudación | JSONL y no un array JSON monolítico; checkpoint por fuente; idempotencia: correr dos veces el mismo rango no duplica registros ni vuelve a bajar archivos íntegros. | [bitácora, «Reanudación por página»](bitacora.md#reanudación-por-página) · [README, «Los datos»](../README.md#los-datos) |
| **§5.8** El id del documento no es una clave | Hay filas sin documento —«Información confidencial»— y documentos que alcanzan a más de una fila. Un identificador que a veces falta y a veces se repite no puede ser clave primaria. | [bitácora, Bloque 4, «Lo que el sitio enseñó a la fuerza»](bitacora.md#lo-que-el-sitio-enseñó-a-la-fuerza) |
| **§5.9** Lo que la descarga agregó al diseño | El manifiesto como mapeo autoritativo `id → archivo`, y la regla que salió de tropezarla: «está en el manifiesto» no es «está en disco». | [bitácora, Bloque 5, «Un comando, un producto»](bitacora.md#un-comando-un-producto) |
| **§5.10** Lo que el validador encontró | Las aserciones no valen por estar escritas: valen por haberse corrido contra el dataset completo. Los fixtures cubren lo que alguien pensó en capturar. | [bitácora, «Encontró un defecto en su primera corrida»](bitacora.md#encontró-un-defecto-en-su-primera-corrida) |
| **§5.11** El markup estaba en otra parte | El supuesto de que sin acceso a la red del portal no había markup es falso: el archivo web sirve lo que el WAF no, y ese markup refutó cuatro supuestos del adapter. | [bitácora, «El archivo web sirve lo que el WAF no»](bitacora.md#el-archivo-web-sirve-lo-que-el-waf-no) · [proceso.md](proceso.md#el-markup-que-estaba-en-otra-parte) |

## Elementos para la evaluación

| § | Qué dice | Dónde está reproducido |
|---|---|---|
| **§6.1** Mapeo criterio → evidencia | La tabla que contesta, criterio por criterio del enunciado, dónde está la evidencia en la entrega. | [README, «Criterio → evidencia»](../README.md#criterio--evidencia) |
| **§6.2** La sección «cómo descubrí el protocolo» | El enunciado dice que descubrir la estructura del sitio es parte del desafío, así que el razonamiento se documenta en vez de entregar solo el resultado limpio. | [`docs/proceso.md`](proceso.md) |
| **§6.3** Sanity checks como comando ejecutable | Los chequeos sobre lo entregado como `npm run validate` con informe legible, y no como un párrafo del README. | [README, «Cómo se valida»](../README.md#cómo-se-valida) · [bitácora, Bloque 6](bitacora.md#bloque-6--sanity-checks-sobre-lo-entregado-) |
| **§6.4** Detección de drift | El peor modo de falla de un scraper no es la excepción: es seguir corriendo tres semanas escribiendo datos vacíos. Aserciones duras que detienen la corrida antes de persistir. | [bitácora, Bloque 4](bitacora.md#bloque-4--adapter-parsers-y-persistencia-) · [proceso.md, «Aserciones y drift»](proceso.md#aserciones-y-drift) |
| **§6.5** Tests con fixtures reales | Respuestas HTTP reales guardadas en `fixtures/` y tests que las parsean sin tocar la red. Permite CI, y cuando el sitio cambie el ciclo de corrección baja de minutos a segundos. | [`fixtures/oefa/README.md`](../fixtures/oefa/README.md) · [`fixtures/pj/README.md`](../fixtures/pj/README.md) · [README, «Estructura»](../README.md#estructura) |
| **§6.6** Observabilidad | Logging estructurado con `pino` y métricas por corrida —páginas/minuto, tasa de 429, tasa del limiter, expiraciones recuperadas—, con redacción de identificadores de sesión. | [proceso.md, «Arquitectura»](proceso.md#arquitectura) · [README, «Variables de entorno»](../README.md#variables-de-entorno) |
| **§6.7** Validación por esquema | `zod` sobre cada registro parseado **antes** de persistirlo, y sobre el entorno al arrancar. | [bitácora, Bloque 4](bitacora.md#bloque-4--adapter-parsers-y-persistencia-) · [README, «Variables de entorno»](../README.md#variables-de-entorno) |
| **§7** Riesgos y decisiones abiertas | La tabla de riesgos del plan. El primero —«acceso al PJ no resuelto a tiempo»— se materializó, y así quedó declarado. | [README, «Limitaciones conocidas»](../README.md#limitaciones-conocidas) |

## Una que no es de este documento

| Referencia | Qué es |
|---|---|
| **RFC 9110 §10.2.3** | El `Retry-After`, en sus dos formas: `delta-seconds` o fecha HTTP. Es una cita externa a la norma, no al documento de estrategia — [rfc-editor.org](https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3). La usa [`src/http/retry.ts`](../src/http/retry.ts). |
