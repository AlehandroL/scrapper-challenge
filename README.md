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

## Estructura planificada

```
src/
├── http/        # sesión, cookie jar, rate limiter, retry, circuit breaker
├── jsf/         # ViewState, partial-response, serialización de forms, comandos
├── sources/     # adapters por fuente: oefa.ts, pj.ts
├── store/       # JSONL, checkpointing, dead-letter queue
├── validate/    # sanity checks y validación por esquema
└── cli/
```

El criterio: la capa `jsf/` no sabe nada de jurisprudencia ni de resoluciones
ambientales, y la capa `sources/` no sabe nada de reintentos ni de cookies. La
capa de protocolo debe ser reutilizable para el próximo portal legacy.

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

### Bloques 2–8

Pendientes: cliente HTTP, capa JSF, adapters, descarga de PDFs con DLQ y
checkpointing, sanity checks y documentación.
