#!/usr/bin/env bash
#
# check-access.sh — Cierra el diagnóstico de acceso de §2.3.
#
# El portal del Poder Judicial responde 403 desde Chile. El diagnóstico de §2.2
# descartó fingerprinting TLS/JA3 con curl-impersonate y dejó una única hipótesis
# viva: el discriminante es un atributo de la IP de origen (país, ASN o
# reputación). Separar esas tres hipótesis exige correr esta misma prueba desde
# redes distintas.
#
# NO SE EJECUTARON esas pruebas en la entrega: requieren un hotspot móvil de otro
# ASN, una IP de datacenter estadounidense y una VPN con salida en Lima. Contratar
# esa infraestructura quedó fuera del alcance (ver §2.3 del documento). El script
# existe para que cualquiera con esas salidas de red cierre el diagnóstico en un
# comando — en particular quien evalúe esta entrega desde Perú.
#
# Uso:
#   bash scripts/check-access.sh
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

# --- Pruebas ---------------------------------------------------------------
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

# --- Lectura del resultado -------------------------------------------------
case "$PJ_CODE" in
  200|302) VEREDICTO="ACCESO OK — esta red alcanza el portal del Poder Judicial." ;;
  403)     VEREDICTO="BLOQUEADO — 403 desde ${PAIS} (${ORG})." ;;
  000)     VEREDICTO="SIN RESPUESTA — timeout o fallo de red; la prueba no concluye." ;;
  *)       VEREDICTO="INESPERADO — HTTP ${PJ_CODE}; revisar manualmente." ;;
esac

{
  echo "Diagnóstico de acceso — §2.3"
  echo "============================================================"
  echo "Fecha (UTC) : $(date -u +'%Y-%m-%d %H:%M:%S')"
  echo "IP origen   : ${IP}"
  echo "Ubicación   : ${CIUDAD:-?}, ${PAIS}"
  echo "ASN / ISP   : ${ORG}"
  echo
  echo "Resultados"
  echo "------------------------------------------------------------"
  printf '  %-46s %s\n' "jurisprudencia.pj.gob.pe (objetivo)" "${PJ_CODE}  server=${PJ_SRV}"
  printf '  %-46s %s\n' "www.pj.gob.pe (control, mismo /24 Radware)" "${ROOT_CODE}"
  printf '  %-46s %s\n' "publico.oefa.gob.pe (sitio de desarrollo)" "${OEFA_CODE}"
  echo
  echo "  ${VEREDICTO}"
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
  echo "  Ya descartado en §2.2, no hace falta volver a probarlo: headers de"
  echo "  Chrome, HTTP/1.1 vs HTTP/2, UA de Googlebot y la huella TLS/JA3 real de"
  echo "  Chrome vía curl-impersonate. Los cuatro dan 403. El discriminante no es"
  echo "  cómo se conecta el cliente sino desde dónde."
} | tee "$OUTFILE"

echo
echo "Guardado en: ${OUTFILE#"$ROOT"/}"
