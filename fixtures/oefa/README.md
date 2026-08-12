# Fixtures — publico.oefa.gob.pe

Respuestas HTTP reales del Repositorio Digital de OEFA, capturadas sin navegador.
Son la base de los tests sin red: cuando el sitio cambie, el ciclo de corrección
baja de minutos a segundos porque el parser se puede ejercitar contra estos
archivos.

- **Origen:** `https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml`
- **Captura:** 12-ago-2026, desde Santiago de Chile (AS267724)
- **Regenerar:** `bash scripts/capture-oefa.sh`
- **Stack:** Mojarra (JSF 2.x, prefijo `javax.faces.*`) + PrimeFaces 6.0

Los `jsessionid` reescritos en las URLs están reemplazados por
`SESSION_ID_REDACTED`. El token `javax.faces.ViewState` sí se conserva íntegro:
es el objeto de estudio y no identifica a nadie.

## Archivos

| Archivo | Request que lo produjo |
|---|---|
| `01-bootstrap.html` | `GET` inicial. Form, campos de búsqueda, `ViewState` inicial y la config de los widgets de PrimeFaces. |
| `02-search-partial.xml` | `POST` de búsqueda (evento AJAX). `partial-response` con las 10 primeras filas y `rowCount:1753`. |
| `03-page2-partial.xml` | `POST` de paginación. Segunda página, `data-ri` 10–19. |
| `04-download-a.html` | Intento de descarga con el `ViewState` **desalineado**. HTTP 200 con la página re-renderizada en vez del PDF. |
| `05-download-b.headers` | Headers del intento con el `ViewState` **alineado**: el PDF real (9,3 MB). |

El PDF no se versiona por tamaño; de `05` interesan los headers y el magic number.

## Lo que cada fixture demuestra

**`01` — los ids de componente son volátiles.** Los campos de búsqueda se llaman
`j_idt21`, `j_idt25`, `j_idt34`: JSF los autogenera según el orden de aparición en
el árbol de componentes. Agregar un componente más arriba en la página los
desplaza a todos. Hardcodearlos garantiza que el scraper muera silenciosamente en
el próximo deploy. Solo `txtNroexp`, `idsector` y `dt` tienen id explícito y son
estables.

**`02` — el id del `ViewState` en la respuesta no es el del formulario.** En el
HTML el campo se llama `javax.faces.ViewState`, pero en el `partial-response`
vuelve como:

```xml
<update id="j_id1:javax.faces.ViewState:0"><![CDATA[ ... ]]></update>
```

Un lookup por id exacto (`updates.get('javax.faces.ViewState')`) devuelve
`undefined` contra toda respuesta real. Hay que buscar por subcadena. El síntoma
de equivocarse —token vacío, sesión que parece caída— se confunde fácilmente con
un bloqueo del sitio.

El HTML de las filas viene dentro de bloques `CDATA` en un documento XML: aplicar
un parser de HTML sobre el cuerpo crudo devuelve cero filas. Requiere dos pasadas.

**`03` — la paginación no solapa.** Los `data-ri` van 0–9 en `02` y 10–19 en `03`.
Es el sanity check de desalineación del `ViewState`, comprobable ya sobre los
fixtures y sin tocar la red. Ojo: esta respuesta solo actualiza el componente
`dt`, así que **no** trae `rowCount`; el total del dataset solo aparece en la
respuesta de búsqueda.

**`04` y `05` — la descarga exige un `ViewState` alineado.** Los dos se
capturaron en la misma sesión, con la misma fila y el mismo conjunto de campos.
La única variable es de qué página proviene el token:

| | `ViewState` | Resultado |
|---|---|---|
| `04` | de la página 2 | HTTP 200, `text/html`, página re-renderizada, sin PDF |
| `05` | de la página 1 | HTTP 200, `application/octet-stream`, `%PDF-1.4`, 9,3 MB |

Consecuencia de diseño: un pipeline "recolectar todo el metadata primero,
descargar los PDFs después" no funciona sin volver a replicar la paginación hasta
la página donde vive cada fila.

`04` es además el fixture del peor modo de falla del scraper: **HTTP 200 con HTML
donde debería haber un binario**. Sin validar el magic number `%PDF-`, se acumulan
archivos `.pdf` que son páginas web.

**`05` — el `content-disposition` existe pero no es confiable.**

```
content-disposition: attachment;filename="RTFA N? 264-2012.pdf"
```

El `º` de `Nº` viene codificado en ISO-8859-1, no en RFC 5987, así que leerlo como
UTF-8 produce mojibake. Es una razón más para nombrar los archivos desde nuestro
propio metadata (`${uuid}_${slug}.pdf`) y guardar el mapeo autoritativo en el
JSONL, en vez de confiar en el header.

## Un modo de falla que estos fixtures no capturan

Sin la cookie `JSESSIONID`, la búsqueda funciona igual (es autocontenida) pero la
paginación devuelve **HTTP 200 con la tabla vacía**:

```xml
<update id="listarDetalleInfraccionRAAForm:dt"><![CDATA[
  <tr class="ui-widget-content ui-datatable-empty-message"><td colspan="7"></td></tr>
]]></update>
```

Los resultados viven en un bean de sesión en el servidor: sin cookie, cada request
abre una sesión nueva y el bean llega vacío. No hay error, no hay excepción —
parece que el selector dejó de matchear. Vale la pena una aserción dura sobre el
conteo de filas antes de culpar al parser.

Detalle de diagnóstico que cuesta caro: `curl` guarda las cookies `HttpOnly` en el
jar con el prefijo `#HttpOnly_`. Inspeccionar el jar con `grep -v '^#'` las oculta
y hace parecer que el sitio no usa cookies en absoluto.
