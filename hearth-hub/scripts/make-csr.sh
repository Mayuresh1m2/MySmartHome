#!/usr/bin/env bash
# Creates the hub's private key and CSR on this machine and downloads Amazon Root CA 1.
# The private key is written with mode 600 and is never printed, copied or uploaded.
#
# Usage: scripts/make-csr.sh [--hub-id <id>] [--dir <certs dir>] [--skip-ca]
#   --dir lets certificate rotation create a new key/CSR alongside the live one (see hearth-aws docs/runbook.md).
set -euo pipefail
HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HUB_ID="${HUB_ID:-laptop}"
CERTS_DIR="$HUB_DIR/certs"
SKIP_CA=0

while [ $# -gt 0 ]; do
  case "$1" in
    --hub-id) HUB_ID="$2"; shift 2 ;;
    --dir) CERTS_DIR="$2"; shift 2 ;;
    --skip-ca) SKIP_CA=1; shift ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if ! [[ "$HUB_ID" =~ ^[a-z0-9-]+$ ]]; then
  echo "hubId must be lowercase letters, digits and hyphens: '$HUB_ID'" >&2; exit 2
fi

KEY="$CERTS_DIR/hub.key"
CSR="$CERTS_DIR/hub.csr"
mkdir -p "$CERTS_DIR"
chmod 700 "$CERTS_DIR"

if [ -e "$KEY" ]; then
  echo "Refusing to overwrite existing $KEY." >&2
  echo "For rotation, create the new key elsewhere: scripts/make-csr.sh --dir $HUB_DIR/certs/next" >&2
  exit 1
fi

# ECDSA P-256: supported by AWS IoT Core CreateCertificateFromCsr and cheap on a small CPU.
( umask 077; openssl ecparam -name prime256v1 -genkey -noout -out "$KEY" 2>/dev/null )
chmod 600 "$KEY"
openssl req -new -key "$KEY" -subj "/CN=hearth-$HUB_ID/O=Hearth" -sha256 -out "$CSR"
chmod 644 "$CSR"

if [ "$SKIP_CA" -eq 0 ] && [ ! -e "$CERTS_DIR/AmazonRootCA1.pem" ]; then
  if curl -fsSL -m 20 https://www.amazontrust.com/repository/AmazonRootCA1.pem -o "$CERTS_DIR/AmazonRootCA1.pem.tmp"; then
    mv "$CERTS_DIR/AmazonRootCA1.pem.tmp" "$CERTS_DIR/AmazonRootCA1.pem"
    echo "Downloaded Amazon Root CA 1."
  else
    rm -f "$CERTS_DIR/AmazonRootCA1.pem.tmp"
    echo "Warning: could not download Amazon Root CA 1; fetch it later into $CERTS_DIR/AmazonRootCA1.pem" >&2
  fi
fi

echo "Key:  $KEY (mode 600, stays on this machine)"
echo "CSR:  $CSR"
echo "CSR subject: $(openssl req -in "$CSR" -noout -subject)"
echo
echo "hearth-aws finds it here by default; set HEARTH_CSR_PATH in the repo-root .env only if it lives elsewhere:"
echo "  $CSR"
