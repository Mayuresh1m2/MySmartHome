#!/usr/bin/env bash
# Starts the whole system locally: emulated cloud (broker, rule, DynamoDB, skill) + the real hub process.
# State, logs and the local audit log live in local-stack/.state/ (gitignored).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STACK="$ROOT/local-stack"
STATE="$STACK/.state"
HUB_ID="${HUB_ID:-laptop}"
BROKER_PORT="${BROKER_PORT:-8884}" DDB_PORT="${DDB_PORT:-8885}" CONTROL_PORT="${CONTROL_PORT:-8886}" HEALTH_PORT="${HEALTH_PORT:-8787}"
export HUB_ID BROKER_PORT DDB_PORT CONTROL_PORT
mkdir -p "$STATE/logs" "$STATE/pids" "$STATE/audit"

running() { [ -f "$STATE/pids/$1" ] && kill -0 "$(cat "$STATE/pids/$1")" 2>/dev/null; }
if running stack || running hub; then echo "already running (pnpm local:down first)"; exit 1; fi

CSR="$ROOT/hearth-hub/certs/hub.csr"
[ -e "$CSR" ] || { echo "No hub CSR. Run: hearth-hub/scripts/make-csr.sh"; exit 1; }
"$STACK/scripts/local-ca.sh" init >/dev/null
if [ ! -e "$STATE/hub-local.crt" ] || [ "$CSR" -nt "$STATE/hub-local.crt" ]; then
  "$STACK/scripts/local-ca.sh" sign "$CSR" "$STATE/hub-local.crt"
fi

cat > "$STATE/hub.local.env" <<ENV
IOT_ENDPOINT=localhost
MQTT_PORT=$BROKER_PORT
MQTT_PROTOCOL_VERSION=4
HUB_ID=$HUB_ID
AWS_REGION=eu-west-1
CERT_FILE=$STATE/hub-local.crt
CA_FILE=$STATE/ca/ca.crt
AUDIT_DIR=$STATE/audit
HEALTH_PORT=$HEALTH_PORT
INTENT=${INTENT:-keyword}
OLLAMA_MODEL=${OLLAMA_MODEL:-}
ENV

wait_for() { # url, seconds
  for _ in $(seq 1 $(( $2 * 5 ))); do curl -fsS -m 1 "$1" >/dev/null 2>&1 && return 0; sleep 0.2; done; return 1
}

setsid bash -c "cd '$STACK' && exec npx tsx src/cli/stack.ts" >>"$STATE/logs/stack.log" 2>&1 &
echo $! > "$STATE/pids/stack"
wait_for "http://127.0.0.1:$CONTROL_PORT/status" 20 || { echo "stack failed to start; see $STATE/logs/stack.log"; tail -5 "$STATE/logs/stack.log"; exit 1; }

setsid bash -c "cd '$ROOT/hearth-hub' && HUB_ENV_FILE='$STATE/hub.local.env' exec npx tsx src/index.ts" >>"$STATE/logs/hub.log" 2>&1 &
echo $! > "$STATE/pids/hub"
wait_for "http://127.0.0.1:$HEALTH_PORT/ready" 20 || { echo "hub not ready; see $STATE/logs/hub.log"; tail -5 "$STATE/logs/hub.log"; exit 1; }

cat > "$STATE/stack.json" <<JSON
{"hubId":"$HUB_ID","ports":{"broker":$BROKER_PORT,"ddb":$DDB_PORT,"control":$CONTROL_PORT,"hubHealth":$HEALTH_PORT},"startedAt":"$(date -Is)"}
JSON
echo "Hearth local stack is up (hubId=$HUB_ID)"
echo "  broker   mqtts://localhost:$BROKER_PORT   (IoT Core emulator, mTLS)"
echo "  dynamodb http://127.0.0.1:$DDB_PORT        (dynalite, table hearth-replies-local)"
echo "  control  http://127.0.0.1:$CONTROL_PORT   (pnpm local:say \"...\")"
echo "  hub      http://127.0.0.1:$HEALTH_PORT/health  /metrics"
echo "  logs     $STATE/logs/{stack,hub}.log   audit $STATE/audit/"
