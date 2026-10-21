#!/usr/bin/env bash
# Hearth prerequisites, safe to rerun.
#
#   scripts/install-prereqs.sh            same as --check: report what is present/missing, change nothing
#   scripts/install-prereqs.sh --system   sudo part (run it YOURSELF in a real terminal; never from Claude):
#                                         apt: docker.io docker-compose-v2 mosquitto-clients jq curl openssl zstd
#                                         and adds you to the docker group (root-equivalent; re-login afterwards)
#   scripts/install-prereqs.sh --user     no root: pnpm (corepack), uv, Ollama (user install, checksum verified,
#                                         no CUDA libs), the hub model, workspace deps, hub key + CSR
#   scripts/install-prereqs.sh --devices-tools   sudo: nmap avahi-utils tcpdump (Phase 0 device research)
#   scripts/install-prereqs.sh --gpu-awake  sudo: udev rule that keeps the AMD dGPU from runtime-suspending, so a
#                                         voice command after idle isn't slowed by a ~3 s GPU resume (progress/26)
#   scripts/install-prereqs.sh --aws      no root: AWS CLI v2 into ~/.local (gate G3)
#   scripts/install-prereqs.sh --ask      no root: ASK CLI v2 into ~/.local (gate G4)
#
# Flags combine, e.g. --user --aws. Versions are pinned below; bump them deliberately.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OLLAMA_VERSION="${OLLAMA_VERSION:-v0.40.6}"
HUB_MODEL="${HUB_MODEL:-qwen2.5:3b}"
PNPM_VERSION="$(jq -r '.packageManager | sub("^pnpm@"; "")' "$ROOT/package.json" 2>/dev/null || echo 12.14.0)"
APT_SYSTEM=(docker.io docker-compose-v2 mosquitto-clients jq curl openssl zstd)
APT_DEVICES=(nmap avahi-utils tcpdump)
DL="$HOME/.cache/hearth-prereqs"
UDEV_RULE=/etc/udev/rules.d/90-hearth-dgpu-awake.rules

# The discrete AMD GPU Ollama uses: "<pci address> <vendor> <device>", or nothing.
amd_dgpu() { lspci -Dn 2>/dev/null | awk '$2 ~ /^03(00|02|80):$/ && $3 ~ /^1002:/ {split($3, id, ":"); print $1, id[1], id[2]; exit}'; }

have() { command -v "$1" >/dev/null 2>&1; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
miss() { printf '  \033[33m✘\033[0m %s\n' "$*"; MISSING=$((MISSING+1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
MISSING=0

check() {
  step "System (needs --system, run by you with sudo)"
  for p in "${APT_SYSTEM[@]}"; do dpkg -s "$p" >/dev/null 2>&1 && ok "$p" || miss "$p"; done
  if getent group docker | grep -qw "$USER"; then
    id -nG | grep -qw docker && ok "in docker group (active in this login)" || miss "in docker group, but not active yet: log out and back in"
  else miss "not in docker group"; fi
  systemctl is-active --quiet docker 2>/dev/null && ok "docker service active" || miss "docker service not active"

  step "User (needs --user, no root)"
  have node && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] && ok "node $(node --version)" || miss "node >= 22 (install via fnm/nvm; not handled here)"
  have pnpm && ok "pnpm $(pnpm --version 2>/dev/null)" || miss "pnpm"
  have uv && ok "$(uv --version)" || miss "uv"
  have ollama && ok "ollama $(ollama --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)" || miss "ollama"
  if curl -fsS -m 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    curl -fsS http://127.0.0.1:11434/api/tags | jq -e --arg m "$HUB_MODEL" '.models[] | select(.name == $m)' >/dev/null && ok "model $HUB_MODEL" || miss "model $HUB_MODEL"
  else miss "ollama server not running (scripts/ollama.sh start), can't check model $HUB_MODEL"; fi
  [ -d "$ROOT/node_modules" ] && ok "workspace node_modules" || miss "workspace deps (pnpm install)"
  [ -d "$ROOT/hearth-devices/.venv" ] && ok "hearth-devices .venv" || miss "hearth-devices venv (uv sync --all-packages)"
  [ -e "$ROOT/hearth-hub/certs/hub.csr" ] && ok "hub CSR (key never read)" || miss "hub key + CSR (hearth-hub/scripts/make-csr.sh)"

  step "GPU"
  if read -r addr _ _ < <(amd_dgpu); then
    ctl=$(cat "/sys/bus/pci/devices/$addr/power/control" 2>/dev/null)
    [ "$ctl" = on ] && ok "AMD dGPU $addr kept awake (power/control=on)" || miss "AMD dGPU $addr may runtime-suspend (power/control=$ctl): --gpu-awake"
  else echo "  · no AMD dGPU found"; fi

  step "Optional (gated)"
  have aws && ok "$(aws --version 2>&1 | cut -d' ' -f1)" || echo "  · aws cli: not installed (--aws, gate G3)"
  have ask && ok "ask cli $(ask --version 2>/dev/null)" || echo "  · ask cli: not installed (--ask, gate G4)"
  for p in "${APT_DEVICES[@]}"; do dpkg -s "$p" >/dev/null 2>&1 && ok "$p" || echo "  · $p: not installed (--devices-tools)"; done

  echo; [ "$MISSING" -eq 0 ] && echo "All required prerequisites present." || echo "$MISSING missing. See the flags at the top of this script."
}

system_install() {
  [ -t 0 ] || { echo "--system needs a real terminal for sudo. Run it yourself, not through Claude." >&2; exit 1; }
  step "apt: ${APT_SYSTEM[*]}"
  sudo apt-get update
  sudo apt-get install -y "${APT_SYSTEM[@]}"
  step "docker group"
  if getent group docker | grep -qw "$USER"; then ok "already a member"; else sudo usermod -aG docker "$USER"; ok "added; log out and back in for it to apply"; fi
  echo "Note: the docker group is root-equivalent on this machine."
}

devices_tools_install() {
  [ -t 0 ] || { echo "--devices-tools needs a real terminal for sudo." >&2; exit 1; }
  sudo apt-get install -y "${APT_DEVICES[@]}"
}

gpu_awake_install() {
  [ -t 0 ] || { echo "--gpu-awake needs a real terminal for sudo." >&2; exit 1; }
  read -r addr vendor device < <(amd_dgpu) || { echo "no AMD dGPU found" >&2; exit 1; }
  step "keep AMD dGPU $addr ($vendor:$device) awake"
  echo "ACTION==\"add|bind\", SUBSYSTEM==\"pci\", ATTR{vendor}==\"0x$vendor\", ATTR{device}==\"0x$device\", ATTR{power/control}=\"on\"" | sudo tee "$UDEV_RULE" >/dev/null
  echo on | sudo tee "/sys/bus/pci/devices/$addr/power/control" >/dev/null
  ok "$UDEV_RULE written; applied now: $(cat "/sys/bus/pci/devices/$addr/power/control")"
}

install_ollama() {
  local want="${OLLAMA_VERSION#v}" have_v=""
  have ollama && have_v="$(ollama --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  if [ "$have_v" = "$want" ]; then ok "ollama $have_v already installed"; return; fi
  local dir="$DL/ollama-$OLLAMA_VERSION" asset=ollama-linux-amd64.tar.zst base="https://github.com/ollama/ollama/releases/download/$OLLAMA_VERSION"
  mkdir -p "$dir"
  curl -fsSL -o "$dir/sha256sum.txt" "$base/sha256sum.txt"
  curl -fSL -o "$dir/$asset" "$base/$asset"
  local expected actual
  expected=$(grep -E "[ /*]$asset\$" "$dir/sha256sum.txt" | awk '{print $1}' | head -1)
  actual=$(sha256sum "$dir/$asset" | awk '{print $1}')
  [ -n "$expected" ] && [ "$expected" = "$actual" ] || { echo "ollama checksum mismatch ($actual vs $expected)" >&2; exit 1; }
  ok "checksum verified"
  local dest="$HOME/.local/opt/ollama-$OLLAMA_VERSION"
  mkdir -p "$dest" "$HOME/.local/bin"
  # No NVIDIA GPU on the hub machine: skip the ~1 GB of CUDA libraries. Vulkan (AMD) and CPU stay.
  tar --zstd -xf "$dir/$asset" -C "$dest" --exclude='lib/ollama/cuda_v*'
  ln -sfn "$dest/bin/ollama" "$HOME/.local/bin/ollama"
  rm -f "$dir/$asset"
  ok "ollama ${OLLAMA_VERSION#v} → $dest (user install, no system service)"
}

user_install() {
  step "pnpm $PNPM_VERSION"
  if have pnpm; then ok "pnpm $(pnpm --version)"; else corepack enable --install-directory "$HOME/.local/bin" pnpm && ok "pnpm via corepack"; fi
  step "uv"
  if have uv; then ok "$(uv --version)"; else echo "uv missing: install it from https://docs.astral.sh/uv/ (user-level), then rerun." >&2; exit 1; fi
  step "ollama $OLLAMA_VERSION"
  install_ollama
  "$ROOT/scripts/ollama.sh" start
  step "model $HUB_MODEL"
  ollama pull "$HUB_MODEL"
  step "workspace dependencies"
  (cd "$ROOT" && pnpm install)
  (cd "$ROOT/hearth-devices" && uv sync --all-packages)
  step "hub identity"
  if [ -e "$ROOT/hearth-hub/certs/hub.key" ]; then ok "hub key already exists (left untouched)"; else "$ROOT/hearth-hub/scripts/make-csr.sh"; fi
}

aws_install() {
  if have aws; then ok "$(aws --version 2>&1 | cut -d' ' -f1)"; return; fi
  local dir="$DL/awscli"; mkdir -p "$dir"
  curl -fsSL -o "$dir/awscliv2.zip" https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip
  (cd "$dir" && rm -rf aws && unzip -q awscliv2.zip)
  "$dir/aws/install" --install-dir "$HOME/.local/aws-cli" --bin-dir "$HOME/.local/bin" --update
  ok "$(aws --version 2>&1 | cut -d' ' -f1). Next: aws configure (or aws configure sso)"
}

ask_install() {
  if have ask; then ok "ask cli $(ask --version)"; return; fi
  npm install --prefix "$HOME/.local" -g ask-cli
  ok "ask cli $(ask --version). Next: ask configure"
}

[ $# -eq 0 ] && set -- --check
for arg in "$@"; do
  case "$arg" in
    --check) check ;;
    --system) system_install ;;
    --devices-tools) devices_tools_install ;;
    --gpu-awake) gpu_awake_install ;;
    --user) user_install ;;
    --aws) aws_install ;;
    --ask) ask_install ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done
