#!/usr/bin/env bash
# Local stand-in for AWS IoT Core's certificate authority.
#   init               create the local CA and the broker's server cert (localhost / 127.0.0.1)
#   sign <csr> <out>   issue a client cert from a hub CSR, the same way CreateCertificateFromCsr does
# Reads only the CSR, never the hub's private key. State lives in local-stack/.state/ (gitignored).
set -euo pipefail
STACK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${LOCAL_STACK_STATE:-$STACK_DIR/.state}"
CA="$STATE/ca"

init() {
  mkdir -p "$CA"; chmod 700 "$STATE" "$CA"
  if [ ! -e "$CA/ca.key" ]; then
    ( umask 077; openssl ecparam -name prime256v1 -genkey -noout -out "$CA/ca.key" 2>/dev/null )
    openssl req -x509 -new -key "$CA/ca.key" -sha256 -days 825 -subj "/CN=Hearth Local Test CA/O=Hearth" \
      -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -out "$CA/ca.crt"
    echo "created local CA: $CA/ca.crt"
  fi
  if [ ! -e "$CA/server.key" ]; then
    ( umask 077; openssl ecparam -name prime256v1 -genkey -noout -out "$CA/server.key" 2>/dev/null )
    openssl req -new -key "$CA/server.key" -subj "/CN=localhost" -out "$CA/server.csr"
    openssl x509 -req -in "$CA/server.csr" -CA "$CA/ca.crt" -CAkey "$CA/ca.key" -CAcreateserial -days 825 -sha256 \
      -extfile <(printf "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature") \
      -out "$CA/server.crt" 2>/dev/null
    rm -f "$CA/server.csr"
    echo "created broker server cert: $CA/server.crt"
  fi
}

sign() {
  local csr="$1" out="$2"
  [ -e "$CA/ca.key" ] || init
  openssl req -in "$csr" -noout -verify 2>/dev/null || { echo "CSR signature does not verify: $csr" >&2; exit 1; }
  local cn
  cn=$(openssl req -in "$csr" -noout -subject -nameopt multiline | awk -F' = ' '/commonName/ {print $2}')
  [[ "$cn" =~ ^hearth-[a-z0-9-]+$ ]] || { echo "unexpected CSR common name '$cn' (want hearth-<hubId>)" >&2; exit 1; }
  openssl x509 -req -in "$csr" -CA "$CA/ca.crt" -CAkey "$CA/ca.key" -CAcreateserial -days 365 -sha256 \
    -extfile <(printf "extendedKeyUsage=clientAuth\nkeyUsage=digitalSignature") -out "$out" 2>/dev/null
  echo "issued $out for $cn ($(openssl x509 -in "$out" -noout -fingerprint -sha256 | cut -d= -f2 | cut -c1-23)...)"
}

case "${1:-}" in
  init) init ;;
  sign) [ $# -eq 3 ] || { echo "usage: $0 sign <csr> <out.crt>" >&2; exit 2; }; sign "$2" "$3" ;;
  *) sed -n '2,5p' "$0"; exit 2 ;;
esac
