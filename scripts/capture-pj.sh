#!/usr/bin/env bash
#
# capture-pj.sh — Captura del markup real de jurisprudencia.pj.gob.pe.
#
# El portal objetivo responde 403 desde Chile (§2.2): el WAF discrimina por
# atributo de la IP de origen, no por características del cliente. Eso deja el
# adapter del bloque 7 sin markup contra el cual escribirse… salvo por una
# fuente que el documento de estrategia no consideró: **el archivo de Wayback
# sirve los snapshots desde web.archive.org, no desde el sitio bloqueado.**
#
# Es evidencia de segunda mano y se declara como tal: son capturas fechadas, no
# el sitio de hoy. Pero es markup que el portal produjo, y eso es cualitativamente
# distinto de deducir su forma desde un scraper de terceros.
#
# Lo que estos fixtures NO tienen, y conviene saberlo antes de buscarlo:
# **ninguno trae filas de resultado.** Wayback captura GETs; en el PJ los
# resultados nacen de un POST de búsqueda. El parser de filas y el comando de
# descarga siguen siendo la superficie no verificada del adapter.
#
# Uso:
#   bash scripts/capture-pj.sh          # desde el archivo — funciona en cualquier red
#   bash scripts/capture-pj.sh --vivo   # además, intenta el sitio real (requiere salida peruana)
#
# Requisitos: curl, perl. Nada más — sin navegador, sin dependencias npm.

set -euo pipefail

HOST="jurisprudencia.pj.gob.pe"
BASE="https://$HOST/jurisprudenciaweb/faces/page"
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
DELAY="${CAPTURE_DELAY:-3}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/fixtures/pj"
mkdir -p "$OUT"

VIVO=0
[[ "${1:-}" == "--vivo" ]] && VIVO=1

paso() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
mal()  { printf '  ✗ %s\n' "$*"; }
nota() { printf '    %s\n' "$*"; }

# El jsessionid que el contenedor reescribe dentro de las URLs sale de los
# fixtures por la misma razón que sale de los de OEFA: identifica una sesión y
# no aporta nada al estudio del protocolo. El ViewState sí se conserva íntegro
# —es el objeto de estudio— y en el PJ además es la evidencia de que el state
# saving es server-side.
redactar() {
  perl -0pi -e 's/;jsessionid=[^"?\/;\s]+/;jsessionid=SESSION_ID_REDACTED/g' "$1"
}

# El sufijo `id_` en la URL de Wayback pide el cuerpo **original**: sin el banner
# del archivo y sin la reescritura de enlaces. Sin él, el fixture guardaría el
# HTML de web.archive.org y los tests validarían al archivo en vez de al portal.
#
# El archivo contesta 503 con cierta frecuencia y **con cuerpo**: un
# `<html><body><h1>503 Service Unavailable` de 107 bytes que curl guarda tan
# contento porque el exit code es 0. Escrito como fixture, un test lo parsea sin
# quejarse y reporta cero forms — el mismo modo de falla silencioso que §2.5
# documenta para la tabla vacía, producido por nosotros.
#
# De ahí las dos guardas: se exige el código 200 **y** que el cuerpo contenga la
# firma del portal antes de aceptarlo como fixture.
del_archivo() {
  local ts="$1" esquema="$2" ruta="$3" destino="$4"
  local url="https://web.archive.org/web/${ts}id_/${esquema}://$HOST/jurisprudenciaweb/faces/page/${ruta}"
  local tmp; tmp="$(mktemp)"
  local codigo

  for intento in 1 2 3 4 5; do
    codigo=$(curl -sL --max-time 90 -o "$tmp" -w '%{http_code}' "$url" || echo 000)
    if [[ "$codigo" == "200" ]] && grep -q 'jurisprudenciaweb' "$tmp"; then
      mv "$tmp" "$OUT/$destino"
      redactar "$OUT/$destino"
      ok "$destino  ($(wc -c < "$OUT/$destino" | tr -d ' ') bytes, snapshot $ts)"
      sleep "$DELAY"
      return 0
    fi
    nota "intento $intento: HTTP $codigo, $(wc -c < "$tmp" | tr -d ' ') bytes — reintentando"
    sleep $(( intento * 5 ))
  done

  rm -f "$tmp"
  mal "no se pudo traer $destino desde el archivo tras 5 intentos"
  return 1
}

paso "Capturando desde el archivo web (web.archive.org)"
del_archivo 20250911112549 https resultado.xhtml                        01-bootstrap-resultado.html
del_archivo 20160916175438 http  resolucion-busqueda-resultado.xhtml    02-busqueda-resultado.html
del_archivo 20160920083131 http  resolucion-busqueda-general-pag.xhtml  03-busqueda-general.html

paso "Lo que el markup confirma"
grep -o '<form id="[^"]*"' "$OUT/02-busqueda-resultado.html" | sed 's/.*id="/    form: /;s/"$//'
if grep -q 'richfaces' "$OUT/01-bootstrap-resultado.html"; then
  ok "RichFaces presente — el PJ NO corre PrimeFaces, al revés de lo que asumía §2.1"
fi
if grep -qE 'javax\.faces\.ViewState" value="-?[0-9]+:-?[0-9]+"' "$OUT/01-bootstrap-resultado.html"; then
  ok "ViewState server-side (handle de dos longs) — §5.1 lo daba por client-side"
else
  nota "el ViewState no tiene forma de handle: revisar si el sitio cambió de state saving"
fi

paso "Estado de acceso al sitio real"
CODIGO=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -A "$UA" "$BASE/resultado.xhtml" || echo 000)
if [[ "$CODIGO" == "200" ]]; then
  ok "$CODIGO — hay acceso desde esta red"
else
  mal "$CODIGO — el portal no responde desde esta red"
  nota "diagnóstico completo: bash scripts/check-access.sh"
  nota "con proxy de salida peruana: PROXY_URL=... npm run smoke:pj"
fi

if (( VIVO )); then
  paso "Captura contra el sitio vivo"
  if [[ "$CODIGO" != "200" ]]; then
    mal "se omite: el sitio devuelve $CODIGO desde esta red"
    nota "los fixtures del archivo quedaron escritos igual"
  else
    JAR="$(mktemp)"
    trap 'rm -f "$JAR"' EXIT
    curl -sL --max-time 60 -A "$UA" -b "$JAR" -c "$JAR" -o "$OUT/00-vivo-resultado.html" "$BASE/resultado.xhtml"
    redactar "$OUT/00-vivo-resultado.html"
    ok "00-vivo-resultado.html  ($(wc -c < "$OUT/00-vivo-resultado.html" | tr -d ' ') bytes)"
    nota "compararlo contra 01-bootstrap-resultado.html dice qué cambió desde 2025-09-11"
  fi
fi

paso "Listo"
nota "fixtures en fixtures/pj/ — ver su README.md por procedencia y alcance"
