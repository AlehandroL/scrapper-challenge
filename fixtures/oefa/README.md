# Fixtures — publico.oefa.gob.pe

Respuestas HTTP reales del Repositorio Digital de OEFA, capturadas sin navegador.
Son la base de los tests sin red: cuando el sitio cambie, el ciclo de corrección
baja de minutos a segundos porque el parser se puede ejercitar contra estos
archivos.

- **Origen:** `https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml`
- **Captura:** 12-ago-2026, desde Santiago de Chile (AS267724)
- **Regenerar:** `bash scripts/capture-oefa.sh`
- **Stack:** Mojarra (JSF 2.x, prefijo `javax.faces.*`) + PrimeFaces 6.0

> **Alcance: búsqueda sin filtros.** Los fixtures se capturaron con el formulario
> vacío, que devuelve el dataset completo (1.753 registros). El portal expone
> cuatro filtros —`txtNroexp`, el `select` `idsector` y tres campos de texto con
> ids autogenerados (`j_idt21`, `j_idt25`, `j_idt34`)— que se reenvían vacíos en
> cada POST porque JSF exige el submit completo del form, pero **el request de
> búsqueda con valores no está reversado y el adapter no soporta filtros.**
>
> La interfaz de fuente se expone sin parámetros de filtrado en vez de aceptarlos
> y descartarlos en silencio. Recorrer el dataset completo y filtrar del lado del
> cliente cubre el caso de uso sin esa deuda.
>
> Para agregarlos: capturar un POST de búsqueda con valores, comparar contra
> `02-search-partial.xml` y verificar que `rowCount` baja de forma consistente.
> El punto a confirmar es si el filtro reinicia la paginación en el servidor; si
> no lo hace, el offset queda desalineado y se leen filas del resultado anterior.

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
| `06-view-expired.xml` | `POST` de paginación con el `ViewState` corrupto. Cómo se ve una sesión caída. |
| `07-page4-confidencial.xml` | `POST` de paginación a la página 4. Dos filas publicadas como «Información confidencial», sin enlace de descarga. |
| `08-page28-uuid-repetida.xml` | `POST` de paginación a la página 28. Dos filas distintas que comparten el mismo documento. |

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

El `°` de `N°` es el byte `0xB0` crudo —ISO-8859-1, no RFC 5987—, así que leerlo
como UTF-8 produce mojibake. Acá quedó guardado como `N?` porque la terminal que
capturó los headers no supo dibujarlo; el byte del archivo es el correcto, y el
bloque 5 lo confirmó contra el sitio vivo. Es una razón más para nombrar los archivos desde nuestro
propio metadata (`${uuid}_${slug}.pdf`) y guardar el mapeo autoritativo en el
JSONL, en vez de confiar en el header.

**`06` — la sesión caída no dice que es una sesión caída.** Se capturó
corrompiendo un tramo del blob base64 del token, conservando el largo, de modo
que llegara bien formado como parámetro pero imposible de deserializar. La
respuesta completa son 113 bytes:

```xml
<partial-response id="j_id1"><redirect url="/repdig/consulta/consultaInicio.xhtml"></redirect></partial-response>
```

`HTTP 200`, `content-type: text/xml`. **No hay `<error>`, no hay `<error-name>`,
y la cadena `ViewExpiredException` no aparece en ninguna parte.** La forma
canónica de JSF —`<error><error-name>javax.faces.application.ViewExpiredException`—
es la que documenta la spec y la que casi todo el mundo implementa; este sitio
resuelve la misma condición con un `<redirect>`.

La consecuencia es concreta: un parser que solo mire `<error-name>` recibe acá un
`partial-response` perfectamente válido, con cero `<update>` y ningún error. No
lanza nada. Devuelve cero filas, y el síntoma vuelve a ser «el selector dejó de
matchear». Por eso el `<redirect>` se trata como señal de sesión caída y no como
una respuesta vacía más.

Detalle que importa para la máquina de estados: esta respuesta **no trae
`ViewState`**. Absorber un `undefined` como si fuera un token nuevo dejaría la
vista sin token y convertiría una condición recuperable en uno de esos errores
que no se entienden.

**`07` — no todas las filas tienen documento.** Capturado en el bloque 4, y no
por diseño: la primera corrida completa se detuvo en el registro 37 de 1.753
contra una aserción propia que daba por sentado que toda fila tenía un enlace de
descarga.

```html
<td …>3739-2009-PRODUCE/DIGSECOVI-Dsvs</td>
<td …>Tecnologías en Favor del Medio Ambiente S.A.C.</td>
…
<td …>Información confidencial</td>   <!-- número de resolución -->
<td …>Información confidencial</td>   <!-- archivo: sin <a>, sin onclick -->
```

Dos de las diez filas de esa página vienen así. Son registros **legítimos**
—expediente, administrado, unidad fiscalizable y sector están completos— a los
que el organismo decidió no publicarles la resolución.

La corrección de diseño que forzó vale más que el fixture: **la identidad de un
registro y el identificador de su documento son dos cosas distintas**, y
conflarlas funciona exactamente hasta la primera fila sin PDF. Ahora el registro
lleva `uuid` (identidad, derivada del contenido cuando no hay documento) y
`documentoUuid` (opcional). Y el parser distingue dos condiciones que antes eran
una sola:

| Condición | Significado | Política |
|---|---|---|
| No hay `<a onclick>` | El sitio no publicó el documento | Dato: se persiste el registro y se cuenta |
| Hay `<a onclick>` y no se deja leer | Cambió la forma del `onclick` | Drift: se detiene la corrida |

Colapsarlas en «no hay uuid» obliga a elegir entre perder registros legítimos o
dejar de detectar que el sitio cambió. Con la distinción no hay que elegir.

**`08` — y tampoco es único.** La corrida siguiente se detuvo veinticuatro
páginas más adelante, contra la otra mitad del mismo supuesto. Las filas 277 y
278 comparten expediente, administrado, resolución **y documento**:

| | fila 277 | fila 278 |
|---|---|---|
| Expediente | `2007-053` | `2007-053` |
| Administrado | Compañía Minera Atacocha S.A.A. | Compañía Minera Atacocha S.A.A. |
| Resolución | `068-2013-OEFA/TFA` | `068-2013-OEFA/TFA` |
| Documento | `85116078-…` | `85116078-…` |
| **Unidad fiscalizable** | **Atacocha Concesión de Beneficio Chicrin N° 2** | **Atacocha y Concesión de Beneficio Chicrin N° 12** |

Una misma resolución alcanzando a dos unidades fiscalizables: un registro por
unidad, un solo PDF. Perfectamente coherente con el dominio, y letal para un
esquema que use el identificador del documento como clave primaria.

Los dos fixtures juntos dicen lo mismo desde los dos lados: **el identificador
del documento no es una clave**. A veces falta y a veces se repite. La identidad
del registro se deriva de su contenido —expediente, administrados, unidad,
sector, resolución y documento cuando lo hay— y el `documentoUuid` queda como un
atributo más.

Vale anotar cómo aparecieron los dos: no salieron de leer el sitio con cuidado,
sino de correrlo entero contra aserciones deliberadamente estrictas. Cada una
falló donde tenía que fallar, con el número de fila y el motivo. Una aserción que
se relaja después de ver la evidencia costó dos corridas; la misma aserción
escrita floja desde el principio habría costado un dataset con registros
faltantes y nadie enterándose.

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
