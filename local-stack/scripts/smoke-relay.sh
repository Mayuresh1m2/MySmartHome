#!/usr/bin/env bash
# Smoke test: real hub process against the local IoT Core emulator, including a broker outage.
# Uses the hub's real key path with the locally signed cert. Logs go to $OUT (default: a temp dir).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${OUT:-$(mktemp -d)}"
STATE="$ROOT/local-stack/.state"
HEALTH="http://127.0.0.1:${HEALTH_PORT:-8787}"
pids=()

start_broker() { setsid bash -c "cd '$ROOT/local-stack' && exec pnpm -s broker" >>"$OUT/broker.log" 2>&1 & BROKER=$!; pids+=("$BROKER"); }
stop_group()   { kill -- "-$1" 2>/dev/null; }
cleanup()      { for p in "${pids[@]}"; do stop_group "$p"; done; }
trap cleanup EXIT

[ -e "$STATE/hub-local.crt" ] || { echo "run local-stack/scripts/local-ca.sh sign first"; exit 1; }

start_broker; sleep 2
setsid bash -c "cd '$ROOT/hearth-hub' && HUB_ENV_FILE=/dev/null IOT_ENDPOINT=localhost MQTT_PORT=8884 MQTT_PROTOCOL_VERSION=4 \
  CERT_FILE='$STATE/hub-local.crt' CA_FILE='$STATE/ca/ca.crt' exec npx tsx src/index.ts" >"$OUT/hub.log" 2>&1 & HUB=$!; pids+=("$HUB")
sleep 3
echo "== 1. connected";            curl -s "$HEALTH/health"; echo
echo "== 2. broker stopped";       stop_group "$BROKER"; sleep 3
curl -s "$HEALTH/health"; echo;    curl -s -o /dev/null -w "ready=%{http_code}\n" "$HEALTH/ready"
echo "== 3. broker restarted";     start_broker; sleep 10
curl -s "$HEALTH/health"; echo;    curl -s -o /dev/null -w "ready=%{http_code}\n" "$HEALTH/ready"
echo "== metrics";                 curl -s "$HEALTH/metrics" | grep -E '^hearth_hub_mqtt'
echo "== logs in $OUT"
