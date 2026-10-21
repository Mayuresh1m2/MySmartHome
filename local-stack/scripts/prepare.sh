#!/usr/bin/env bash
# Prepares local-stack state without starting anything: local CA, the hub cert from the hub CSR, and
# .state/hub.local.env. Used by up.sh and by the hearth-local-stack systemd unit.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STACK="$ROOT/local-stack"; STATE="$STACK/.state"
HUB_ID="${HUB_ID:-laptop}"
mkdir -p "$STATE/logs" "$STATE/pids" "$STATE/audit"
CSR="$ROOT/hearth-hub/certs/hub.csr"
[ -e "$CSR" ] || { echo "No hub CSR. Run: hearth-hub/scripts/make-csr.sh" >&2; exit 1; }
"$STACK/scripts/local-ca.sh" init >/dev/null
if [ ! -e "$STATE/hub-local.crt" ] || [ "$CSR" -nt "$STATE/hub-local.crt" ]; then
  "$STACK/scripts/local-ca.sh" sign "$CSR" "$STATE/hub-local.crt"
fi
cat > "$STATE/hub.local.env" <<ENV
IOT_ENDPOINT=localhost
MQTT_PORT=${HUB_MQTT_PORT:-8893}
MQTT_PROTOCOL_VERSION=${HUB_MQTT_VERSION:-5}
HUB_ID=$HUB_ID
AWS_REGION=ap-southeast-2
CERT_FILE=$STATE/hub-local.crt
CA_FILE=$STATE/ca/ca.crt
AUDIT_DIR=$STATE/audit
HEALTH_PORT=${HEALTH_PORT:-8787}
INTENT=${INTENT:-keyword}
OLLAMA_MODEL=${OLLAMA_MODEL:-}
INTENT_TIMEOUT_MS=${INTENT_TIMEOUT_MS:-4300}
ENV
