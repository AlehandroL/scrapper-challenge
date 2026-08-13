#!/usr/bin/env bash
#
# capture-oefa.sh — Reversing reproducible del protocolo JSF de OEFA.
#
# Replica sin navegador los requests que definen el protocolo del portal y deja
# las respuestas crudas en fixtures/oefa/. Es a la vez la evidencia de que el
# protocolo se entendió y la forma de regenerar los fixtures cuando el sitio
# cambie.
#
# El sitio corre Mojarra (JSF 2.x, prefijo javax.faces.*) con PrimeFaces 6.0.
# Ni la paginación ni las descargas son URLs direccionables: son eventos POST
# contra un árbol de componentes, con un token ViewState que viaja en cada
# request.
#
# Secuencia:
#   1. GET  bootstrap        → form, campos, ViewState inicial
#   2. POST búsqueda         → partial-response XML con la primera página
#   3. POST paginación       → segunda página, sin solapamiento
#   4. POST descarga (A)     → experimento: ViewState de la página 2
#   5. POST descarga (B)     → experimento: ViewState de la página 1
#
# Los pasos 4 y 5 son un experimento controlado: mismo conjunto de campos, misma
# fila, misma sesión. La única variable es de qué página proviene el ViewState.
# Sirve para determinar si la descarga exige un token alineado con la página
# donde vive la fila, o si el token es indiferente.
#
# Uso:   bash scripts/capture-oefa.sh
# Requisitos: curl, perl. Nada más — sin navegador, sin dependencias npm.

set -euo pipefail

BASE_URL="https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml"
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
DELAY="${CAPTURE_DELAY:-3}"    # segundos entre requests; política conservadora

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/fixtures/oefa"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"

# El estado vive en el servidor: sin JSESSIONID cada request abre una sesión
# nueva, el bean con los resultados de la búsqueda se pierde y la paginación
# devuelve la tabla vacía (ui-datatable-empty-message) con HTTP 200. Es un modo
# de falla silencioso: parece que el selector dejó de matchear.
#
# Nota de diagnóstico: curl guarda las cookies HttpOnly en el jar con el prefijo
# "#HttpOnly_". Inspeccionar el jar con `grep -v '^#'` las oculta y hace parecer
# que el sitio no usa cookies.
JAR="$TMP/cookies.txt"
COOKIES=(-b "$JAR" -c "$JAR")

paso() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }

# ---------------------------------------------------------------------------
# Extractores
# ---------------------------------------------------------------------------

# En el HTML el token viaja como <input name="javax.faces.ViewState" value="...">
viewstate_html() {
  perl -0777 -ne 'print $1 if /name="javax\.faces\.ViewState"[^>]*value="([^"]*)"/' "$1"
}

# En el partial-response el id NO es "javax.faces.ViewState" sino
# "j_id1:javax.faces.ViewState:0". Buscar por subcadena, nunca por id exacto:
# un lookup exacto devuelve undefined contra toda respuesta real, y el síntoma
# —token vacío, sesión que parece caída— se confunde con un bloqueo del sitio.
viewstate_partial() {
  perl -0777 -ne 'print $1 if /<update id="[^"]*javax\.faces\.ViewState[^"]*"><!\[CDATA\[(.*?)\]\]><\/update>/s' "$1"
}

# JSF procesa el submit completo del form: hay que reenviar todos los campos, no
# solo los del evento. Los ids (j_idt21, j_idt25...) son autogenerados según el
# orden de aparición en el árbol de componentes; agregar un componente más arriba
# los desplaza a todos. Por eso se extraen en cada corrida en vez de hardcodearse.
form_fields() {
  perl -0777 -ne '
    while (/<(input|select)\b([^>]*?)\/?>/gs) {
      my ($tag, $attrs) = ($1, $2);
      next unless $attrs =~ /name="([^"]+)"/;
      my $name = $1;
      next if $name =~ /javax\.faces\.ViewState/;   # se maneja aparte
      if ($tag eq "select") { print "$name=\n"; next; }
      my ($type) = $attrs =~ /type="([^"]+)"/;
      $type = "text" unless defined $type;
      if ($type eq "hidden") {
        my ($val) = $attrs =~ /value="([^"]*)"/;
        $val = "" unless defined $val;
        print "$name=$val\n";
      } elsif ($type eq "text") {
        print "$name=\n";
      }
    }
  ' "$1"
}

# Del onclick de la fila 0: el id del componente de descarga y el uuid del documento.
#   mojarra.jsfcljs(form, {'...:dt:0:j_idt63':'...', 'param_uuid':'153a...'}, '')
row0_command() {
  perl -0777 -ne '
    if (/data-ri="0".*?mojarra\.jsfcljs\([^,]+,\s*\{\x27([^\x27]+)\x27:\x27[^\x27]+\x27,\s*\x27param_uuid\x27:\x27([^\x27]+)\x27\}/s) {
      print "$1\n$2\n";
    }' "$1"
}

# El jsessionid reescrito en las URLs cambia en cada corrida y es un
# identificador de sesión: se normaliza para que los fixtures sean estables y no
# filtren nada.
sanitize() {
  perl -pi -e 's/;jsessionid=[A-F0-9]+/;jsessionid=SESSION_ID_REDACTED/gi' "$1"
}

# ---------------------------------------------------------------------------
# 1. GET inicial
# ---------------------------------------------------------------------------
paso "1/5  GET inicial — bootstrap de la vista"
curl -s --max-time 30 "${COOKIES[@]}" -o "$TMP/01-bootstrap.html" -H "User-Agent: $UA" "$BASE_URL"

VS1="$(viewstate_html "$TMP/01-bootstrap.html")"
[ -n "$VS1" ] || { echo "ERROR: no se encontró el ViewState inicial." >&2; exit 1; }

FORM_ID="$(perl -0777 -ne 'print $1 if /<form[^>]*id="([^"]+)"/' "$TMP/01-bootstrap.html")"
PF_VER="$(perl -0777 -ne 'print $1 if /primefaces&amp;v=([0-9.]+)/' "$TMP/01-bootstrap.html")"

ok "form: $FORM_ID"
ok "PrimeFaces: ${PF_VER:-?}   |   ViewState: ${#VS1} bytes"

FIELDS=()
while IFS= read -r f; do
  [ -n "$f" ] && FIELDS+=(--data-urlencode "$f")
done < <(form_fields "$TMP/01-bootstrap.html")
ok "campos del form reenviados: $(( ${#FIELDS[@]} / 2 ))"

# ---------------------------------------------------------------------------
# 2. POST de búsqueda
# ---------------------------------------------------------------------------
# Faces-Request: partial/ajax es el header que más se omite. Sin él el servidor
# devuelve la página completa en vez del diff XML, el parser no encuentra
# <partial-response> y el síntoma se confunde con un bloqueo.
sleep "$DELAY"
paso "2/5  POST de búsqueda — evento AJAX"
curl -s --max-time 40 "${COOKIES[@]}" -o "$TMP/02-search-partial.xml" \
  -H "User-Agent: $UA" \
  -H 'Content-Type: application/x-www-form-urlencoded; charset=UTF-8' \
  -H 'Faces-Request: partial/ajax' \
  -H 'X-Requested-With: XMLHttpRequest' \
  -H "Referer: $BASE_URL" \
  --data 'javax.faces.partial.ajax=true' \
  --data "javax.faces.source=${FORM_ID}:btnBuscar" \
  --data 'javax.faces.partial.execute=@all' \
  --data "javax.faces.partial.render=${FORM_ID}:pgLista ${FORM_ID}:txtNroexp" \
  --data "${FORM_ID}:btnBuscar=${FORM_ID}:btnBuscar" \
  "${FIELDS[@]}" \
  --data-urlencode "javax.faces.ViewState=$VS1" \
  "$BASE_URL"

grep -q '<partial-response' "$TMP/02-search-partial.xml" \
  || { echo "ERROR: la respuesta no es un partial-response." >&2; exit 1; }

VS2="$(viewstate_partial "$TMP/02-search-partial.xml")"
TOTAL="$(perl -0777 -ne 'print $1 if /rowCount:(\d+)/' "$TMP/02-search-partial.xml")"
FILAS_1="$(grep -o 'data-ri=' "$TMP/02-search-partial.xml" | wc -l | tr -d ' ')"

ok "filas: $FILAS_1   |   total del sitio: ${TOTAL:-?}"
ok "ViewState rotado: ${#VS1} → ${#VS2} bytes"

# ---------------------------------------------------------------------------
# 3. POST de paginación
# ---------------------------------------------------------------------------
sleep "$DELAY"
paso "3/5  POST de paginación — página 2"
curl -s --max-time 40 "${COOKIES[@]}" -o "$TMP/03-page2-partial.xml" \
  -H "User-Agent: $UA" \
  -H 'Content-Type: application/x-www-form-urlencoded; charset=UTF-8' \
  -H 'Faces-Request: partial/ajax' \
  -H 'X-Requested-With: XMLHttpRequest' \
  -H "Referer: $BASE_URL" \
  --data 'javax.faces.partial.ajax=true' \
  --data "javax.faces.source=${FORM_ID}:dt" \
  --data "javax.faces.partial.execute=${FORM_ID}:dt" \
  --data "javax.faces.partial.render=${FORM_ID}:dt" \
  --data 'javax.faces.behavior.event=page' \
  --data "${FORM_ID}:dt_pagination=true" \
  --data "${FORM_ID}:dt_first=10" \
  --data "${FORM_ID}:dt_rows=10" \
  --data "${FORM_ID}:dt_skipChildren=true" \
  --data "${FORM_ID}:dt_encodeFeature=true" \
  "${FIELDS[@]}" \
  --data-urlencode "javax.faces.ViewState=$VS2" \
  "$BASE_URL"

VS3="$(viewstate_partial "$TMP/03-page2-partial.xml")"
RI_1="$(perl -0777 -ne 'print "$1 " while /data-ri="(\d+)"/g' "$TMP/02-search-partial.xml")"
RI_2="$(perl -0777 -ne 'print "$1 " while /data-ri="(\d+)"/g' "$TMP/03-page2-partial.xml")"

ok "índices página 1: $RI_1"
ok "índices página 2: $RI_2"

# ---------------------------------------------------------------------------
# 4 y 5. Descarga — experimento controlado
# ---------------------------------------------------------------------------
# mojarra.jsfcljs(form, params, target) inyecta inputs hidden en el form, hace
# form.submit() (POST NO-ajax) y los remueve. Para replicarlo: POST normal al
# action del form con todos sus campos + los parámetros extra + el ViewState,
# SIN los headers Faces-Request ni los javax.faces.partial.*
#
# Ambos intentos usan la misma fila (la 0, de la página 1) y el mismo conjunto de
# campos. Solo cambia el ViewState. Si únicamente B devuelve el PDF, la descarga
# exige un token alineado con la página donde vive la fila, y un pipeline
# "metadata primero, PDFs después" no funciona sin replicar la paginación.

CMD="$(row0_command "$TMP/02-search-partial.xml")"
COMP_ID="$(printf '%s' "$CMD" | sed -n 1p)"
UUID="$(printf '%s' "$CMD" | sed -n 2p)"
[ -n "$COMP_ID" ] && [ -n "$UUID" ] \
  || { echo "ERROR: no se pudo extraer el comando de descarga de la fila 0." >&2; exit 1; }

paso "4/5  POST de descarga (A) — ViewState de la página 2"
echo "  fila 0 · uuid=$UUID"
echo "  componente=$COMP_ID"

intento_descarga() {
  # $1 = ViewState, $2 = archivo de cuerpo, $3 = archivo de headers
  sleep "$DELAY"
  curl -s --max-time 90 "${COOKIES[@]}" -D "$3" -o "$2" \
    -H "User-Agent: $UA" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -H "Referer: $BASE_URL" \
    "${FIELDS[@]}" \
    --data-urlencode "${COMP_ID}=${COMP_ID}" \
    --data-urlencode "param_uuid=${UUID}" \
    --data-urlencode "javax.faces.ViewState=$1" \
    "$BASE_URL"
}

es_pdf() { [ "$(head -c 5 "$1" 2>/dev/null)" = "%PDF-" ]; }
describe() {
  local ct; ct="$(tr -d '\r' < "$2" | sed -n 's/^[Cc]ontent-[Tt]ype: *//p' | head -1)"
  if es_pdf "$1"; then
    printf 'PDF (%s bytes, content-type: %s)' "$(wc -c < "$1" | tr -d ' ')" "${ct:--}"
  else
    printf 'NO es PDF (%s bytes, content-type: %s)' "$(wc -c < "$1" | tr -d ' ')" "${ct:--}"
  fi
}

intento_descarga "$VS3" "$TMP/dl-a.bin" "$TMP/dl-a.headers"
RES_A="$(describe "$TMP/dl-a.bin" "$TMP/dl-a.headers")"
ok "A → $RES_A"

paso "5/5  POST de descarga (B) — ViewState de la página 1"
intento_descarga "$VS2" "$TMP/dl-b.bin" "$TMP/dl-b.headers"
RES_B="$(describe "$TMP/dl-b.bin" "$TMP/dl-b.headers")"
ok "B → $RES_B"

paso "Resultado del experimento"
if ! es_pdf "$TMP/dl-a.bin" && es_pdf "$TMP/dl-b.bin"; then
  echo "  CONFIRMADO: solo el ViewState alineado con la página de la fila baja el PDF."
  echo "  El ViewState desalineado devuelve HTTP 200 con la página re-renderizada."
  echo "  → Las descargas deben intercalarse con la paginación."
elif es_pdf "$TMP/dl-a.bin" && es_pdf "$TMP/dl-b.bin"; then
  echo "  REFUTADO: ambos ViewStates bajan el PDF. El token no necesita estar"
  echo "  alineado con la página; basta reenviar el form completo."
  echo "  → Metadata y descargas se pueden desacoplar en etapas independientes."
elif ! es_pdf "$TMP/dl-a.bin" && ! es_pdf "$TMP/dl-b.bin"; then
  warn "Ningún intento devolvió PDF. El protocolo de descarga cambió: revisar"
  warn "04-download-a.html antes de escribir el downloader."
else
  warn "Resultado invertido (A sí, B no): inesperado, revisar ambos cuerpos."
fi

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
# El PDF no se versiona (el de prueba pesa 9,3 MB): se guardan sus headers y los
# primeros bytes, que es lo que el validador de integridad necesita conocer.
paso "Escribiendo fixtures"

cp "$TMP/01-bootstrap.html"      "$OUT/01-bootstrap.html"
cp "$TMP/02-search-partial.xml"  "$OUT/02-search-partial.xml"
cp "$TMP/03-page2-partial.xml"   "$OUT/03-page2-partial.xml"

if es_pdf "$TMP/dl-a.bin"; then
  cp "$TMP/dl-a.headers" "$OUT/04-download-a.headers"
  rm -f "$OUT/04-download-a.html"
else
  cp "$TMP/dl-a.bin" "$OUT/04-download-a.html"
  rm -f "$OUT/04-download-a.headers"
fi

{
  tr -d '\r' < "$TMP/dl-b.headers"
  echo "# --- primeros bytes del cuerpo (magic number) ---"
  head -c 8 "$TMP/dl-b.bin" | od -c | head -1
} > "$OUT/05-download-b.headers"

for f in "$OUT"/*.html "$OUT"/*.xml; do
  [ -e "$f" ] && sanitize "$f"
done

for f in "$OUT"/0*; do
  printf '  %-28s %s bytes\n' "$(basename "$f")" "$(wc -c < "$f" | tr -d ' ')"
done

paso "Listo — fixtures/oefa/ regenerado"
