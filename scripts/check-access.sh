#!/usr/bin/env bash
#
# check-access.sh — Cierra el diagnóstico de acceso al portal del Poder Judicial.
#
# El portal del Poder Judicial responde 403 desde Chile. Un diagnóstico por capas
# descartó fingerprinting TLS/JA3 con curl-impersonate y dejó una única hipótesis
# viva: el discriminante es un atributo de la IP de origen (país, ASN o
# reputación). Separar esas tres hipótesis exige correr esta misma prueba desde
# redes distintas.
#
# NO SE EJECUTARON esas pruebas en la entrega: requieren un hotspot móvil de otro
# ASN, una IP de datacenter estadounidense y una VPN con salida en Lima. Contratar
# esa infraestructura quedó fuera del alcance de esta entrega. El script
# existe para que cualquiera con esas salidas de red cierre el diagnóstico en un
# comando — en particular quien evalúe esta entrega desde Perú.
#
# Las tres primeras capas miran el problema desde UN punto de vista: el tuyo. Eso
# no alcanza para distinguir «me bloquearon a mí» de «está caído para todos»,
# porque las dos cosas producen el mismo síntoma acá. La cuarta capa varía el
# origen sin moverte: pide a nodos de check-host.net repartidos por el mundo que
# intenten el mismo TCP:443, y sondea junto a cada objetivo un CONTROL que se
# espera que conecte. Sin ese control el sondeo puede mentir en silencio: «nadie
# llega» también es lo que se ve si el que está roto es el servicio de terceros.
#
# Esa capa manda los nombres de host —públicos, de portales estatales— a un
# servicio de terceros. Se puede omitir con --sin-terceros.
#
# Uso:
#   bash scripts/check-access.sh                 # las cuatro capas (~30 s)
#   bash scripts/check-access.sh --sin-terceros  # solo lo local (~5 s)
#
# Correrlo desde cada red disponible. Cada corrida escribe su propio archivo en
# evidencia/, nombrado por fecha y país, de modo que los resultados se acumulan
# en vez de pisarse. Después se leen todos juntos contra la matriz de decisión.
#
# Requisitos: curl. Nada más.

set -uo pipefail

PJ_URL="https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml"
PJ_ROOT="https://www.pj.gob.pe/"
OEFA_URL="https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml"
TIMEOUT=20

# Vecino de publico.oefa.gob.pe en 209.45.104.0/24, el datacenter propio de OEFA.
# Es el control que separa «cayó el host» de «cayó el segmento» de «me filtran».
OEFA_VECINO="209.45.104.100"

CH="https://check-host.net"
CH_NODES=15
TERCEROS=1

for arg in "$@"; do
  case "$arg" in
    --sin-terceros) TERCEROS=0 ;;
    -h|--help) sed -n '3,33p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "opción desconocida: $arg" >&2; exit 64 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/evidencia"

# --- Origen de la petición -------------------------------------------------
# El país y el ASN son la variable independiente de todo este experimento.
IPINFO="$(curl -s --max-time "$TIMEOUT" https://ipinfo.io/json 2>/dev/null)"
field() { printf '%s' "$IPINFO" | sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" | head -1; }

IP="$(field ip)";       [ -n "$IP" ]      || IP="desconocida"
PAIS="$(field country)"; [ -n "$PAIS" ]   || PAIS="XX"
ORG="$(field org)";      [ -n "$ORG" ]    || ORG="desconocida"
CIUDAD="$(field city)"

STAMP="$(date -u +%Y%m%d-%H%M)"
OUTFILE="$ROOT/evidencia/acceso-${STAMP}-${PAIS}.txt"

# --- Pruebas locales -------------------------------------------------------
probe() {
  # $1 = etiqueta, $2 = URL. Devuelve "codigo|servidor".
  local code server
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$2" 2>/dev/null)"
  server="$(curl -sI --max-time "$TIMEOUT" "$2" 2>/dev/null \
            | tr -d '\r' | sed -n 's/^[Ss]erver: *//p' | head -1)"
  [ -n "$code" ]   || code="000"
  [ -n "$server" ] || server="-"
  printf '%s|%s' "$code" "$server"
}

PJ="$(probe pj "$PJ_URL")";        PJ_CODE="${PJ%%|*}";     PJ_SRV="${PJ##*|}"
ROOTR="$(probe root "$PJ_ROOT")";  ROOT_CODE="${ROOTR%%|*}"
OEFA="$(probe oefa "$OEFA_URL")";  OEFA_CODE="${OEFA%%|*}"

# --- Cuarta capa: el mismo destino, muchos orígenes ------------------------
# Un solo punto de vista no distingue un bloqueo de una caída. Varios sí, y el
# control es lo que hace que «nadie llega» signifique algo.
ch_submit() {
  # $1 = host:puerto. Devuelve el request_id, o vacío si el servicio no responde.
  curl -s -H "Accept: application/json" --max-time "$TIMEOUT" \
       "${CH}/check-tcp?host=${1}&max_nodes=${CH_NODES}" 2>/dev/null \
    | sed -n 's/.*"request_id": *"\([^"]*\)".*/\1/p' | head -1
}

ch_result() {
  # $1 = request_id. Devuelve "conectan|fallan", o "?|?" si no hubo resultado.
  # Cada resultado de nodo es un objeto JSON: partir por '{' pone uno por línea,
  # lo que evita depender de un parser de JSON. Éxito trae "time", fallo "error".
  local rid="$1" json ok bad i
  [ -n "$rid" ] || { printf '?|?'; return; }
  for i in 1 2 3 4 5; do
    json="$(curl -s -H "Accept: application/json" --max-time "$TIMEOUT" \
            "${CH}/check-result/${rid}" 2>/dev/null)"
    ok="$(printf '%s' "$json"  | tr '{' '\n' | grep -c '"time"')"
    bad="$(printf '%s' "$json" | tr '{' '\n' | grep -c '"error"')"
    [ $((ok + bad)) -gt 0 ] && { printf '%s|%s' "$ok" "$bad"; return; }
    sleep 5
  done
  printf '?|?'
}

fmt_ch() {
  # $1 = "ok|bad" -> "10/11 conectan" o "no evaluable"
  local ok="${1%%|*}" bad="${1##*|}"
  [ "$ok" = "?" ] && { printf 'no evaluable'; return; }
  printf '%s/%s conectan' "$ok" "$((ok + bad))"
}

CH_PJ="?|?"; CH_PJROOT="?|?"; CH_OEFA="?|?"; CH_VECINO="?|?"
if [ "$TERCEROS" -eq 1 ]; then
  echo "Sondeando desde nodos de terceros (~30 s)…" >&2
  # Se lanzan los cuatro sondeos y después se cobran: los nodos trabajan en
  # paralelo, así que la espera es una sola y no cuatro encoladas.
  RID_PJ="$(ch_submit "jurisprudencia.pj.gob.pe:443")"
  RID_PJROOT="$(ch_submit "www.pj.gob.pe:443")"
  RID_OEFA="$(ch_submit "publico.oefa.gob.pe:443")"
  RID_VECINO="$(ch_submit "${OEFA_VECINO}:443")"
  sleep 15
  CH_PJ="$(ch_result "$RID_PJ")"
  CH_PJROOT="$(ch_result "$RID_PJROOT")"
  CH_OEFA="$(ch_result "$RID_OEFA")"
  CH_VECINO="$(ch_result "$RID_VECINO")"
fi

# --- Lectura del resultado -------------------------------------------------
case "$PJ_CODE" in
  200|302) VEREDICTO="ACCESO OK — esta red alcanza el portal del Poder Judicial." ;;
  403)     VEREDICTO="BLOQUEADO — 403 desde ${PAIS} (${ORG})." ;;
  000)     VEREDICTO="SIN RESPUESTA — timeout o fallo de red; la prueba no concluye." ;;
  *)       VEREDICTO="INESPERADO — HTTP ${PJ_CODE}; revisar manualmente." ;;
esac

# Veredicto del sitio de desarrollo. Su modo de falla es distinto al del PJ y
# confundirlos cuesta caro: el 403 del PJ es una regla; un 000 puede ser una
# caída, y la vista de terceros es lo único que los separa sin cambiar de red.
OEFA_OK="${CH_OEFA%%|*}"; VEC_OK="${CH_VECINO%%|*}"
if [ "$OEFA_CODE" != "000" ]; then
  VEREDICTO_OEFA="OEFA responde HTTP ${OEFA_CODE} — el sitio de desarrollo está disponible."
elif [ "$OEFA_OK" = "?" ]; then
  VEREDICTO_OEFA="OEFA no responde y no hubo vista de terceros: NO CONCLUYE si está caído o filtrado."
elif [ "$OEFA_OK" -gt 0 ] 2>/dev/null; then
  VEREDICTO_OEFA="OEFA no responde acá pero SÍ a ${OEFA_OK} nodo(s) externo(s): el discriminante es la IP de origen."
elif [ "$VEC_OK" != "?" ] && [ "$VEC_OK" -gt 0 ] 2>/dev/null; then
  VEREDICTO_OEFA="OEFA está CAÍDO para todos: 0 nodos externos conectan, y el control del mismo /24 conecta desde ${VEC_OK}. No es tu IP."
else
  VEREDICTO_OEFA="OEFA no responde a nadie, pero el control tampoco: el sondeo no prueba nada. Reintentar."
fi

{
  echo "Diagnóstico de acceso — jurisprudencia.pj.gob.pe"
  echo "============================================================"
  echo "Fecha (UTC) : $(date -u +'%Y-%m-%d %H:%M:%S')"
  echo "IP origen   : ${IP}"
  echo "Ubicación   : ${CIUDAD:-?}, ${PAIS}"
  echo "ASN / ISP   : ${ORG}"
  echo
  echo "Resultados — desde esta red"
  echo "------------------------------------------------------------"
  printf '  %-46s %s\n' "jurisprudencia.pj.gob.pe (objetivo)" "${PJ_CODE}  server=${PJ_SRV}"
  printf '  %-46s %s\n' "www.pj.gob.pe (control, mismo /24 Radware)" "${ROOT_CODE}"
  printf '  %-46s %s\n' "publico.oefa.gob.pe (sitio de desarrollo)" "${OEFA_CODE}"
  echo
  echo "  ${VEREDICTO}"
  echo "  ${VEREDICTO_OEFA}"
  echo
  echo "Resultados — desde terceros (TCP :443, nodos de check-host.net)"
  echo "------------------------------------------------------------"
  if [ "$TERCEROS" -eq 0 ]; then
    echo "  omitido (--sin-terceros)"
  else
    printf '  %-46s %s\n' "jurisprudencia.pj.gob.pe (objetivo)"        "$(fmt_ch "$CH_PJ")"
    printf '  %-46s %s\n' "www.pj.gob.pe (control)"                    "$(fmt_ch "$CH_PJROOT")"
    printf '  %-46s %s\n' "publico.oefa.gob.pe (sitio de desarrollo)"  "$(fmt_ch "$CH_OEFA")"
    printf '  %-46s %s\n' "${OEFA_VECINO} (control, mismo /24)"        "$(fmt_ch "$CH_VECINO")"
  fi
  echo
  echo "Cómo interpretarlo"
  echo "------------------------------------------------------------"
  echo "  Correr este script desde tres redes y cruzar los resultados:"
  echo
  echo "    A = hotspot móvil chileno (otro ASN, mismo país)"
  echo "    B = datacenter EE.UU. (ni Chile ni Perú)"
  echo "    C = salida en Lima (VPN o VPS peruano)"
  echo
  echo "    A    B    C     Diagnóstico                     Solución"
  echo "    ---  ---  ---   ------------------------------  ----------------------"
  echo "    200  -    -     IP/ASN residencial puntual      Rotación simple"
  echo "    403  200  200   Denylist contra Chile/LATAM     Cualquier salida no-CL"
  echo "    403  403  200   Allowlist solo Perú             IP peruana obligatoria"
  echo "    403  403  403   Restricción más profunda        Reevaluar"
  echo
  echo "  El control www.pj.gob.pe importa: resuelve al mismo bloque /24 de"
  echo "  Radware que el objetivo. Si devuelve 302 mientras el objetivo devuelve"
  echo "  403, la restricción es una regla de la aplicación de jurisprudencia y"
  echo "  no una política del PoP ni un bloqueo de red contra el país."
  echo
  echo "  La vista de terceros responde otra pregunta: si el host está caído o si"
  echo "  el filtrado es contra vos. Se lee siempre CONTRA SU CONTROL, nunca sola:"
  echo
  echo "    objetivo  control   Lectura"
  echo "    --------  -------   ----------------------------------------------"
  echo "    0/n       0/n       el sondeo no prueba nada: falla el servicio de"
  echo "                        terceros o la ruta. No concluir de acá."
  echo "    0/n       conecta   el host está caído o filtrado para TODO EL"
  echo "                        MUNDO. No es tu IP: cambiar de salida no ayuda."
  echo "    conecta   conecta   el host vive y acepta a terceros. Si vos no"
  echo "                        llegás, el discriminante es tu IP de origen."
  echo
  echo "  Ojo con el nivel de la respuesta. Estos nodos prueban TCP, no HTTP: que"
  echo "  jurisprudencia.pj.gob.pe conecte desde todas partes no contradice el 403"
  echo "  — el handshake se completa y el rechazo llega después, en la capa de"
  echo "  aplicación. Un 403 es un bloqueo; un 000 con RST es otra cosa."
  echo
  echo "  Ya descartado, no hace falta volver a probarlo: headers completos de"
  echo "  Chrome, HTTP/1.1 vs HTTP/2, UA de Googlebot y la huella TLS/JA3 real de"
  echo "  Chrome vía curl-impersonate. Los cuatro dan 403. El discriminante no es"
  echo "  cómo se conecta el cliente sino desde dónde."
} | tee "$OUTFILE"

echo
echo "Guardado en: ${OUTFILE#"$ROOT"/}"
