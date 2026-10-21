#!/usr/bin/env bash
# Local IoT Core emulator on Mosquitto (MQTT 5, mTLS): up | down | logs
# Copies the local CA's broker cert into .state/iot, issues the "hearth-cloud" client cert (plays the Lambda's
# IoT Data Plane publish and the IoT rule), and writes an ACL equal to the hub's IoT policy.
set -euo pipefail
STACK="$(cd "$(dirname "$0")/.." && pwd)"; STATE="$STACK/.state"; IOT="$STATE/iot"
HUB_ID="${HUB_ID:-laptop}"
export HOST_UID=$(id -u) HOST_GID=$(id -g)
dc() { docker compose -f "$STACK/deploy/compose.yaml" "$@"; }

prepare() {
  "$STACK/scripts/local-ca.sh" init >/dev/null
  umask 077; mkdir -p "$IOT"
  cp "$STATE/ca/ca.crt" "$STATE/ca/server.crt" "$STATE/ca/server.key" "$IOT/"
  if [ ! -e "$IOT/cloud.crt" ]; then
    openssl ecparam -name prime256v1 -genkey -noout -out "$IOT/cloud.key" 2>/dev/null
    openssl req -new -key "$IOT/cloud.key" -subj "/CN=hearth-cloud" -out "$IOT/cloud.csr"
    "$STACK/scripts/local-ca.sh" sign "$IOT/cloud.csr" "$IOT/cloud.crt" >/dev/null
  fi
  cat > "$IOT/acl" <<ACL
# = hearth-aws HubPolicy for hubId=$HUB_ID (iot:Subscribe/Receive commands, iot:Publish replies)
user hearth-$HUB_ID
topic read hearth/$HUB_ID/commands
topic write hearth/$HUB_ID/replies

# The cloud side: Lambda publishes commands (IoT Data Plane), the IoT rule reads replies.
user hearth-cloud
topic write hearth/$HUB_ID/commands
topic read hearth/$HUB_ID/replies
ACL
  chmod 600 "$IOT"/*
}

case "${1:-up}" in
  up) prepare; dc up -d; for _ in $(seq 1 50); do ss -ltn | grep -q '127.0.0.1:8893 ' && break; sleep 0.2; done; echo "local IoT (Mosquitto, MQTT 5, mTLS) on 127.0.0.1:8893" ;;
  down) dc down ;;
  logs) dc logs --tail "${2:-50}" ;;
  *) echo "usage: $0 up|down|logs" >&2; exit 2 ;;
esac
