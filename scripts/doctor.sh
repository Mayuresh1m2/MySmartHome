#!/usr/bin/env bash
# Hearth doctor: reports what is installed, configured and running.
# Read-only. Checks file *existence* only; never reads key material.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HEALTH_PORT="${HEALTH_PORT:-8787}"

ok=0 warn=0 bad=0
pass() { printf '  \033[32m✔\033[0m %s\n' "$*"; ok=$((ok+1)); }
note() { printf '  \033[33m!\033[0m %s\n' "$*"; warn=$((warn+1)); }
fail() { printf '  \033[31m✘\033[0m %s\n' "$*"; bad=$((bad+1)); }
have() { command -v "$1" >/dev/null 2>&1; }
ver()  { "$@" 2>&1 | head -1; }

echo "Toolchain"
if have node; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 22 ] && pass "node $(node --version)" || fail "node $(node --version) (need >= 22)"
else fail "node missing"; fi
have pnpm && pass "pnpm $(ver pnpm --version)" || fail "pnpm missing (corepack enable --install-directory ~/.local/bin pnpm)"
have uv && pass "$(ver uv --version)" || note "uv missing (needed for hearth-devices Python SDK)"
have openssl && pass "$(ver openssl version)" || fail "openssl missing (needed for make-csr.sh)"

echo "Optional / gated tools"
if have docker; then
  docker ps >/dev/null 2>&1 && pass "docker usable" || note "docker installed but not usable by $USER (gate G1: sudo usermod -aG docker $USER)"
else note "docker missing"; fi
have mosquitto && pass "$(ver mosquitto -h | head -1)" || note "mosquitto missing (gate G1; hearth-devices bus)"
have ollama && pass "ollama $(ver ollama --version)" || note "ollama missing (gate G2; hearth-hub M3)"
have aws && pass "$(ver aws --version)" || note "aws cli missing (gate G3)"
have ask && pass "ask cli $(ver ask --version)" || note "ask cli missing (gate G4)"

echo "Ollama runtime"
if curl -fsS -m 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
  pass "ollama API up: $(curl -fsS -m 2 http://127.0.0.1:11434/api/version)"
  loaded=$(curl -fsS -m 2 http://127.0.0.1:11434/api/ps | jq -r '[.models[].name] | join(", ")' 2>/dev/null)
  [ -n "$loaded" ] && pass "models loaded: $loaded" || note "no model loaded"
else note "ollama API not reachable on 127.0.0.1:11434"; fi

echo "hearth-hub identity (existence only)"
for f in hub.key hub.csr hub.crt AmazonRootCA1.pem; do
  [ -e "$ROOT/hearth-hub/certs/$f" ] && pass "certs/$f present" || note "certs/$f absent"
done
if [ -e "$ROOT/hearth-hub/certs/hub.key" ]; then
  perm=$(stat -c %a "$ROOT/hearth-hub/certs/hub.key")
  [ "$perm" = "600" ] && pass "hub.key mode 600" || fail "hub.key mode $perm (want 600)"
fi
[ -e "$ROOT/hearth-hub/config/hub.env" ] && pass "config/hub.env present" || note "config/hub.env absent"

echo "hearth-aws config"
[ -e "$ROOT/hearth-aws/config/local.json" ] && pass "config/local.json present" || note "config/local.json absent"
[ -e "$ROOT/hearth-aws/out/hub.crt" ] && pass "out/hub.crt present (handoff done)" || note "out/hub.crt absent (handoff not run)"

echo "Running services"
tmp=$(mktemp)
if curl -fsS -m 2 "http://127.0.0.1:$HEALTH_PORT/health" >"$tmp" 2>/dev/null; then
  pass "hub health: $(jq -c '{mqtt, modelLoaded, lastCommandAt}' "$tmp" 2>/dev/null || cat "$tmp")"
else note "hub health endpoint not answering on 127.0.0.1:$HEALTH_PORT"; fi
rm -f "$tmp"
if [ -e "$ROOT/local-stack/.state/stack.json" ]; then pass "local-stack state present"; else note "local-stack not initialised"; fi

echo
echo "Summary: $ok ok, $warn warnings, $bad failures"
[ "$bad" -eq 0 ]
