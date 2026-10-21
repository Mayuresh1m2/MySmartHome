#!/usr/bin/env bash
# Hearth as systemd *user* services (no root): install | uninstall | start | stop | status | restart
#   scripts/services.sh install [--target local|aws]   local (default): hub + local IoT emulator + local cloud
#                                                       aws: hub against real IoT Core (config/hub.env, certs/hub.crt)
#   scripts/services.sh stop    stop everything Hearth runs on this machine (hub, Ollama and its loaded model, the
#                               hearth-devices bus) and keep it off across reboots, until `start`
#   scripts/services.sh start   start the installed units again and re-enable them at boot (the bus stays off:
#                               nothing uses it yet; hearth-devices/scripts/bus.sh up when device work needs it)
# Logs: journalctl --user -u 'hearth-*' (journald rotates them). Starts at boot via linger.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNITS="$HOME/.config/systemd/user"
. "$ROOT/scripts/env.sh"; hearth_load_env 2>/dev/null || true
MODEL="${OLLAMA_MODEL:-${HEARTH_OLLAMA_MODEL:-qwen2.5:3b}}"
ALL=(hearth-ollama hearth-local-iot hearth-local-stack hearth-hub)
sc() { systemctl --user "$@"; }

render() { # template target hub_env hub_wants
  sed -e "s#@REPO@#$ROOT#g" -e "s#@MODEL@#$MODEL#g" -e "s#@HUB_ENV@#${3:-}#g" -e "s#@HUB_WANTS@#${4:-}#g" "$ROOT/deploy/systemd/$1.service.in" > "$UNITS/$1.service"
}

install() {
  local target=local
  [ "${1:-}" = --target ] && target="${2:?local|aws}"
  mkdir -p "$UNITS"
  # Stop anything started by hand (pnpm local:up, scripts/ollama.sh) so the units can own the ports.
  # Only when hand-started (pid files): down.sh would also stop the IoT container a running unit owns.
  if ls "$ROOT/local-stack/.state/pids/"* >/dev/null 2>&1; then bash "$ROOT/local-stack/scripts/down.sh" >/dev/null 2>&1 || true; fi
  sc is-active --quiet hearth-ollama || "$ROOT/scripts/ollama.sh" stop >/dev/null 2>&1 || true
  if [ "$target" = aws ]; then
    [ -e "$ROOT/hearth-hub/config/hub.env" ] && [ -e "$ROOT/hearth-hub/certs/hub.crt" ] || { echo "aws target needs hearth-hub/config/hub.env and certs/hub.crt (hearth-aws scripts/handoff.sh)" >&2; exit 1; }
    sc disable --now hearth-local-stack hearth-local-iot 2>/dev/null || true
    rm -f "$UNITS/hearth-local-stack.service" "$UNITS/hearth-local-iot.service"
    render hearth-ollama; render hearth-hub "" "$ROOT/hearth-hub/config/hub.env" ""
    sc daemon-reload; sc enable hearth-ollama hearth-hub; sc restart hearth-ollama hearth-hub
  else
    for u in hearth-ollama hearth-local-iot hearth-local-stack; do render "$u" "" "" ""; done
    render hearth-hub "" "$ROOT/local-stack/.state/hub.local.env" "hearth-local-stack.service"
    sc daemon-reload; sc enable hearth-ollama hearth-local-iot hearth-local-stack hearth-hub
    # restart (not just start) so changed units take effect
    sc restart hearth-ollama hearth-local-iot hearth-local-stack hearth-hub
  fi
  if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != yes ]; then
    loginctl enable-linger "$USER" && echo "linger enabled (services start at boot without a login)" \
      || echo "could not enable linger; run in your own terminal: sudo loginctl enable-linger $USER" >&2
  fi
  status
}

uninstall() {
  sc disable --now "${ALL[@]}" 2>/dev/null || true
  for u in "${ALL[@]}"; do rm -f "$UNITS/$u.service"; done
  sc daemon-reload
  echo "units removed (linger left as is: loginctl disable-linger $USER to turn it off)"
}

installed() { for u in "${ALL[@]}"; do [ -e "$UNITS/$u.service" ] && echo "$u"; done; }

stop() {
  local units; units=$(installed)
  # disable --now: stopped now and not started at boot (linger stays on, so `start` brings boot-start back).
  [ -n "$units" ] && sc disable --now $units 2>/dev/null
  # Anything started by hand outside the units.
  if ls "$ROOT/local-stack/.state/pids/"* >/dev/null 2>&1; then bash "$ROOT/local-stack/scripts/down.sh" >/dev/null 2>&1 || true; fi
  "$ROOT/scripts/ollama.sh" stop >/dev/null 2>&1 || true
  # The devices bus container has restart: unless-stopped, so `down` is what keeps it off after a reboot.
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^hearth-devices-'; then bash "$ROOT/hearth-devices/scripts/bus.sh" down >/dev/null 2>&1 || true; fi
  echo "Hearth stopped and won't start at boot (scripts/services.sh start to turn it back on)."
  echo "Alexa now answers \"Your home hub didn't answer in time. It might be offline.\" The AWS side stays deployed (idle cost: next to nothing)."
  status
}

start() {
  local units; units=$(installed)
  [ -n "$units" ] || { echo "no Hearth units installed: scripts/services.sh install --target aws" >&2; exit 1; }
  sc enable --now $units
  # The hub reports ready once the model has warmed up (about 20 s); until then the keyword router answers.
  for _ in $(seq 1 30); do curl -fsS -m 2 http://127.0.0.1:8787/health >/dev/null 2>&1 && break; sleep 1; done
  status
}

status() {
  for u in "${ALL[@]}"; do
    [ -e "$UNITS/$u.service" ] || continue
    printf '  %-20s %-9s %s\n' "$u" "$(sc is-active "$u" 2>/dev/null || true)" "$(sc is-enabled "$u" 2>/dev/null || true)"
  done
  echo "  linger: $(loginctl show-user "$USER" -p Linger --value 2>/dev/null)"
  echo "  devices bus: $(docker ps --filter name=hearth-devices- --format '{{.Status}}' 2>/dev/null | head -1 | grep . || echo stopped)"
  echo "  model in memory: $(curl -fsS -m 2 http://127.0.0.1:11434/api/ps 2>/dev/null | jq -r '[.models[].name] | join(", ") | if .=="" then "none" else . end' || echo "none (Ollama stopped)")"
  curl -fsS -m 2 http://127.0.0.1:8787/health 2>/dev/null | jq -c '{status, mqtt: .mqtt.state, modelLoaded, thermal}' || echo "  hub health: not answering"
}

case "${1:-status}" in
  install) shift; install "$@" ;;
  uninstall) uninstall ;;
  start) start ;;
  stop) stop ;;
  status) status ;;
  restart) sc restart hearth-hub ;;
  *) echo "usage: $0 install [--target local|aws] | uninstall | start | stop | status | restart" >&2; exit 2 ;;
esac
