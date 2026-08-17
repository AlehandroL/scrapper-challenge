# Fixtures — jurisprudencia.pj.gob.pe

Markup real del portal objetivo, capturado **desde el archivo web** porque el
sitio responde `403` desde Chile (§2.2). Son la base de los tests del adapter del
Poder Judicial y, sobre todo, la evidencia que corrigió cuatro supuestos sobre
los que ese adapter se iba a escribir.

- **Origen:** `https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/*.xhtml`
- **Vía:** `web.archive.org`, con el sufijo `id_` que pide el cuerpo original
  —sin banner del archivo y sin reescritura de enlaces—
- **Regenerar:** `bash scripts/capture-pj.sh`
- **Stack:** Mojarra (JSF 2.x, prefijo `javax.faces.*`) + **RichFaces 4.2.2.Final**

Los `jsessionid` reescritos en las URLs están reemplazados por
`SESSION_ID_REDACTED`. El `ViewState` se conserva íntegro: es el objeto de
estudio, y en este portal además es la evidencia del state saving.

## Alcance — léase antes de buscar filas

> **Ninguno de estos fixtures trae filas de resultado.** El archivo captura GETs;
> en el PJ los resultados nacen de un POST de búsqueda contra un bean de sesión,
> y un crawler nunca lo emite.
>
> En consecuencia, **el parser de filas y el comando de descarga del adapter del
> PJ son su superficie no verificada.** Están escritos contra la forma que
> documenta §2.1 —`formBusqueda:repeat:0:j_idt158` con un `uuid`, tomado de un
> scraper público de terceros— y no contra markup capturado. El modo de falla
> esperado si esa forma no calza es un `StructuralDriftError` en la primera
> página, con el mensaje nombrando qué mirar; está escrito así a propósito para
> que no se confunda con un bloqueo del sitio.
>
> Estos fixtures son además **capturas fechadas, no el sitio de hoy**. El
> snapshot más nuevo es de septiembre de 2025 y los otros dos de 2016. Que dos
> páginas de 2016 y una de 2025 coincidan en stack, forma del token y estilo de
> `onclick` es lo que hace razonable escribir contra ellas; no las convierte en
> el sitio vivo.

## Archivos

| Archivo | Snapshot | Página |
|---|---|---|
| `01-bootstrap-resultado.html` | `20250911112549` | `resultado.xhtml` — el `GET` de la vista de búsqueda, en su versión más reciente archivada |
| `02-busqueda-resultado.html` | `20160916175438` | `resolucion-busqueda-resultado.xhtml` — la vista con el formulario de búsqueda avanzada completo |
| `03-busqueda-general.html` | `20160920083131` | `resolucion-busqueda-general-pag.xhtml` — el buscador general embebido |

## Lo que cada fixture demuestra

**`01` — el stack no es el que se había asumido.** El documento de estrategia
daba por hecho que el PJ corría PrimeFaces, «mismo stack» que OEFA (§2.1, §2.4).
No hay una sola coincidencia de `PrimeFaces` en el archivo; hay quince de
`RichFaces`, y los recursos estáticos declaran la versión:

```
/org.richfaces.resources/javax.faces.resource/org.richfaces.staticResource/4.2.2.Final/…
```

La consecuencia es concreta y ordena todo el bloque 7: `src/jsf/datatable.ts`
—`rowCount`, `data-ri`, el evento `_pagination`, `ui-datatable-empty-message`—
es de PrimeFaces y **no transfiere**. `src/jsf/commands.ts`, `form.ts`,
`view-state.ts`, `partial-response.ts` y `view.ts` son de JSF y sí. Es
exactamente la frontera que §4 dibujó y `tests/architecture.test.ts` sostiene,
puesta a prueba por un portal de verdad en vez de por un argumento.

**`01` y `02` — el state saving es server-side.** El token no es el blob base64
de ~1,5 KB de OEFA sino el handle de dos longs que Mojarra emite cuando la vista
vive en el servidor:

```
value="8130872589646157352:-5634686416281607506"   (01, 2025)
value="6683792440354491463:-3039913064503156927"   (02, 2016)
value="-4044961355354536447:-6037348839093909630"  (03, 2016)
```

§5.1 mantuvo el modelo estricto —token de un solo uso, LRU de vistas acotado,
`recover()` obligatorio— como «el caso conservador, que el Poder Judicial puede
perfectamente usar». **Lo usa.** Nueve años de snapshots y las tres páginas
coinciden. `recover()` deja de ser una precaución y pasa a ser el camino normal
de una corrida larga contra este portal.

**`02` — hay tres forms, no uno.** Y los tres llevan el mismo `ViewState`:

| Form | Para qué |
|---|---|
| `formBusqueda` | búsqueda y paginación |
| `frmDetalle` | el detalle de la resolución |
| `frmDetalle2` | `target="_blank"` — el que abre el documento |

`parseForm` elige por defecto el primer form **con token** (`form.ts`), que acá
son los tres: sin `formId` explícito la elección sería incidental. Y el POST del
documento no va necesariamente al form de la vista, que es la razón por la que
`JsfView` pasó a conservar todos los forms del bootstrap y `parseJsfcljs` a
devolver el `formId` que el `onclick` nombra en vez de descartarlo.

**`02` — la búsqueda es un POST no-ajax.** En OEFA es un evento AJAX que devuelve
un `<partial-response>`; acá es `mojarra.jsfcljs` y devuelve la página entera:

```html
<input type="submit" name="formBusqueda:j_idt65" value="Buscar"
  onclick="jsf.util.chain(this,event,'this.form.target=\'_self\';RichFaces.$(\'panelStatus\').show();',
           'mojarra.jsfcljs(document.getElementById(\'formBusqueda\'),
              {\'formBusqueda:j_idt65\':\'formBusqueda:j_idt65\',\'formBusqueda:j_idt66\':\'\'},\'\')');return false" />
```

**Ese `onclick` rompía `parseJsfcljs`.** El patrón viene envuelto en
`jsf.util.chain(...)` y con las comillas escapadas como `\'`. El regex de pares
—`/'([^']*)'\s*:\s*'([^']*)'/g`— no matchea ninguno: la función devolvía
`undefined` y `leerComando` habría clasificado **toda** fila del PJ como
`estado: 'ilegible'`, o sea drift en la primera fila de la primera página. Es un
defecto real de la capa de protocolo, encontrado por markup real y no por
revisión de código. Corregido en el bloque 7 y cubierto por
`tests/jsf-commands.test.ts`.

**Ningún fixture muestra la paginación, y conviene decirlo en voz alta** porque
el primer borrador de este archivo afirmó lo contrario. El snapshot `03` se había
leído como «la vista paginada» por el `-pag` de su URL; mirado el elemento, es un
buscador general embebido cuyo botón abre los resultados en otra pestaña:

```js
// input[type=image], name="formBusqueda:j_idt16"
jsf.util.chain(this, event, "this.form.target='_blank'",
  "mojarra.jsfcljs(document.getElementById('formBusqueda'), {
     'formBusqueda:j_idt16': 'formBusqueda:j_idt16',
     'forward': 'buscar',
     'formBusqueda:j_idt18': '21',
     'formBusqueda:j_idt19': 'DESC'
   }, '')")
```

`21` y `DESC` son parámetros de **esa búsqueda** —probablemente una materia y un
orden—, no un offset y una dirección de página. Se buscaron controles de
paginación en los tres snapshots —`rf-ds`, `dataScroller`, «siguiente»,
«anterior», «página»— y no hay ninguno: la única coincidencia es la clase CSS
`piePagina` del pie de página.

Lo que `03` sí aporta, y por eso se conserva:

- `forward` es un par con **nombre estable** dentro de un comando cuyos otros
  tres ids son autogenerados. Es la primera señal de que el PJ enruta por un
  parámetro de negocio y no solo por el componente pulsado.
- `this.form.target='_blank'` aparece acá y en `frmDetalle2`: el portal usa el
  target del form para decidir a dónde va la respuesta, y un cliente sin
  navegador tiene que saber que eso **no cambia el request** —solo dónde lo
  pintaría el browser—.
- Es la tercera muestra independiente del `ViewState` server-side, con nueve años
  de distancia de las otras dos.

**Cómo pagina el Poder Judicial es, entonces, desconocido.** El adapter emite el
comando que §2.1 documenta a partir de un scraper público
(`formBusqueda:repeat:0:…`) y trata cualquier desviación como drift explícito.
Cerrarlo cuesta un POST desde una red con acceso — es el punto 2 de «Qué falta
para cerrar».

**`02` — los filtros del PJ sí tienen nombres estables.** Al revés que OEFA, donde
tres de los cuatro son `j_idt21`, `j_idt25`, `j_idt34`:

```
formBusqueda:buCorte   buEspecialidad  buSala      buTipoRecurso
buTipoResolucion       buAnio          buNcpp      buNlpt
buPalabraClaveValue    buPretensionValue           txtBusqueda
```

Cada uno viene apareado con un `…Input` de RichFaces (`rf-sel-inp`, `rf-au-inp`):
el visible lleva la etiqueta y el hidden el valor que viaja. **Aun así el adapter
no expone filtros**, por la misma razón que en OEFA: el request de búsqueda con
valores no está reversado, y una firma que promete lo que no hace es peor que una
que no lo ofrece (§2.5). La diferencia es que acá el siguiente paso está a la
vista — se conocen los nombres, falta emitir el POST y comparar.

## Qué falta para cerrar

Tres cosas, todas del mismo tipo: exigen una salida de red con acceso al portal.

1. Un POST de búsqueda capturado → la forma real de las filas, el total y el
   tamaño de página.
2. Un POST de paginación → **cómo pagina el portal**, que hoy no lo sabe nadie:
   ningún snapshot trae controles de paginación.
3. Un POST de descarga → confirmar el `uuid`, el form de destino y si el
   `ViewState` tiene que estar alineado con la página como en OEFA (§5.4).

Los tres los ejercita `npm run smoke:pj` de una sola corrida, y
`bash scripts/capture-pj.sh --vivo` deja el markup capturado al lado de estos
fixtures para poder comparar.
