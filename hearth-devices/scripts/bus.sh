#!/usr/bin/env bash
# Runs the Mosquitto bus with Docker Compose: up | down | logs | status
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
export HOST_UID=$(id -u) HOST_GID=$(id -g)
mkdir -p "$DIR/deploy/mosquitto/data"
[ -e "$DIR/secrets/mosquitto/passwd" ] || "$DIR/scripts/bus-setup.sh"
dc() { docker compose -f "$DIR/deploy/compose.yaml" "$@"; }
case "${1:-status}" in
  up) dc up -d --wait ;;
  down) dc down ;;
  logs) dc logs --tail "${2:-50}" ;;
  status) dc ps ;;
  *) echo "usage: $0 up|down|logs|status" >&2; exit 2 ;;
esac
