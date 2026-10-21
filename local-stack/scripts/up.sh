#!/usr/bin/env bash
# Starts the whole system locally: emulated cloud (broker, rule, DynamoDB, skill) + the real hub process.
# State, logs and the local audit log live in local-stack/.state/ (gitignored).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STACK="$ROOT/local-stack"
STATE="$STACK/.state"
HUB_ID="${HUB_ID:-laptop}"
BROKER_PORT="${BROKER_PORT:-8884}" DDB_PORT="${DDB_PORT:-8885}" CONTROL_PORT="${CONTROL_PORT:-8886}" HEALTH_PORT="${HEALTH_PORT:-8787}"
# A local model needs the longer reply budget (contract max 5000).
REPLY_TIMEOUT_MS="${REPLY_TIMEOUT_MS:-$([ "${INTENT:-keyword}" = ollama ] && echo 5000 || echo 3000)}"
export HUB_ID BROKER_PORT DDB_PORT CONTROL_PORT REPLY_TIMEOUT_MS
mkdir -p "$STATE/logs" "$STATE/pids" "$STATE/audit"

running() { [ -f "$STATE/pids/$1" ] && kill -0 "$(cat "$STATE/pids/$1")" 2>/dev/null; }
if running stack || running hub; then echo "already running (pnpm local:down first)"; exit 1; fi

# IoT Core emulator: Mosquitto (MQTT 5, like AWS) when Docker is usable, else the in-process aedes broker (3.1.1).
if [ -z "${BROKER:-}" ]; then docker info >/dev/null 2>&1 && BROKER=mosquitto || BROKER=aedes; fi
if [ "$BROKER" = mosquitto ]; then
  "$STACK/scripts/iot-mosquitto.sh" up >/dev/null
  IOT_PORT=8893; HUB_MQTT_PORT=8893; HUB_MQTT_VERSION=5; export IOT_PORT
else
  unset IOT_PORT; HUB_MQTT_PORT=$BROKER_PORT; HUB_MQTT_VERSION=4
fi

HUB_MQTT_PORT=$HUB_MQTT_PORT HUB_MQTT_VERSION=$HUB_MQTT_VERSION "$STACK/scripts/prepare.sh"

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
{"hubId":"$HUB_ID","iot":"$BROKER","ports":{"broker":$HUB_MQTT_PORT,"ddb":$DDB_PORT,"control":$CONTROL_PORT,"hubHealth":$HEALTH_PORT},"startedAt":"$(date -Is)"}
JSON
echo "Hearth local stack is up (hubId=$HUB_ID, intent=${INTENT:-keyword}${OLLAMA_MODEL:+ $OLLAMA_MODEL}, reply timeout ${REPLY_TIMEOUT_MS} ms)"
echo "  broker   mqtts://localhost:$HUB_MQTT_PORT   (IoT Core emulator: $BROKER, MQTT $HUB_MQTT_VERSION, mTLS)"
echo "  dynamodb http://127.0.0.1:$DDB_PORT        (dynalite, table hearth-replies-local)"
echo "  control  http://127.0.0.1:$CONTROL_PORT   (pnpm local:say \"...\")"
echo "  hub      http://127.0.0.1:$HEALTH_PORT/health  /metrics"
echo "  logs     $STATE/logs/{stack,hub}.log   audit $STATE/audit/"
