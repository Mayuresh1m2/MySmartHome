#!/usr/bin/env bash
# User-level Ollama server for the hub (no system service): start | stop | status
# Bound to 127.0.0.1 only. The pid file holds the server's own pid, so stop really stops it.
set -uo pipefail
PIDF="$HOME/.ollama/serve.pid"; LOG="$HOME/.ollama/serve.log"; ADDR=127.0.0.1:11434
listener() { ss -ltnp 2>/dev/null | awk -v a="$ADDR" '$4==a' | grep -oE 'pid=[0-9]+' | cut -d= -f2; }
case "${1:-status}" in
  start)
    if [ -n "$(listener)" ]; then echo "already running (pid $(listener))"; exit 0; fi
    mkdir -p "$HOME/.ollama"
    setsid bash -c "echo \$\$ > '$PIDF'; OLLAMA_HOST=$ADDR exec ollama serve" >"$LOG" 2>&1 </dev/null &
    for _ in $(seq 1 50); do [ -n "$(listener)" ] && break; sleep 0.2; done
    [ "$(listener)" = "$(cat "$PIDF")" ] || { echo "listener pid $(listener) != pidfile $(cat "$PIDF")" >&2; exit 1; }
    # GPU discovery finishes a couple of seconds after the port opens.
    for _ in $(seq 1 50); do grep -q 'msg="inference compute"' "$LOG" && break; sleep 0.2; done
    echo "started (pid $(cat "$PIDF")); compute: $(grep -oE 'msg="inference compute".*' "$LOG" | grep -oE 'library=[A-Za-z]+|description="[^"]*"' | paste -sd' ')"
    ;;
  stop)
    pid=$(listener)
    [ -n "$pid" ] || { echo "not running"; rm -f "$PIDF"; exit 0; }
    kill "$pid"; for _ in $(seq 1 50); do [ -z "$(listener)" ] && break; sleep 0.2; done
    [ -z "$(listener)" ] && { echo "stopped ($pid)"; rm -f "$PIDF"; } || { echo "still running ($pid)" >&2; exit 1; }
    ;;
  status)
    pid=$(listener)
    if [ -n "$pid" ]; then echo "running (pid $pid) $(curl -fsS -m 2 http://$ADDR/api/version)"; ollama ps; else echo "not running"; fi
    echo "compute: $(grep -oE 'msg="inference compute".*' "$LOG" 2>/dev/null | grep -oE 'library=[A-Za-z]+|description="[^"]*"' | paste -sd' ')"
    ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
