#!/usr/bin/env bash
# Stops the local stack and hub started by up.sh (by process group, never by name pattern).
STATE="$(cd "$(dirname "$0")/.." && pwd)/.state"
for p in hub stack; do
  f="$STATE/pids/$p"
  [ -f "$f" ] || continue
  pid=$(cat "$f")
  if kill -0 "$pid" 2>/dev/null; then kill -TERM -- "-$pid" 2>/dev/null && echo "stopped $p ($pid)"; fi
  rm -f "$f"
done
rm -f "$STATE/stack.json"
# The Mosquitto IoT emulator (if it was used) stays cheap to keep, but stop it with the stack for a clean slate.
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^hearth-local-iot-iot-1$'; then
  "$(dirname "$0")/iot-mosquitto.sh" down >/dev/null 2>&1 && echo "stopped local IoT (mosquitto)"
fi
