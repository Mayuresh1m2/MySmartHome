# 23 — Docker Engine (gate G1) and a prerequisites script

Date: 2026-10-21. Your decision: Docker Engine from Ubuntu.

## Finding: there was no Docker Engine

My first survey (entry 00) said "Docker installed, not usable without sudo". That was incomplete:

```text
$ command -v docker → ~/bin/docker      (client binary only, 29.3.0, plus a buildx plugin)
$ ls /var/run/docker.sock → No such file or directory
$ systemctl is-active docker docker.socket → inactive inactive
$ getent group docker → (none)
$ dpkg -l | grep docker → (none)
```

## Installed by you (in a separate terminal)

`sudo` refused through Claude's `!` prefix (*"A terminal is required to authenticate"*), so you ran it in your own terminal:

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2
sudo usermod -aG docker $USER
```

Verified afterwards:

```text
docker:x:115:$USER          systemctl is-active docker → active
srw-rw---- 1 root docker /var/run/docker.sock          /usr/bin/docker --version → 29.1.3-0ubuntu4.1
```

**This session can't use Docker yet.** Group membership only applies at a new login, and this Ubuntu has neither `sg` nor `newgrp`, so there's no way to pick up the group mid-session. Next step: log out and back in, then `claude -c`.

Note: `~/bin/docker` (client 29.3) comes before `/usr/bin/docker` (29.1.3) on `PATH`. The client negotiates the API version with the daemon, and I'll check this after the re-login.

## `scripts/install-prereqs.sh`

| Flag | Root? | What |
|---|---|---|
| `--check` (default) | no | reports system packages, docker group and service, node/pnpm/uv/ollama, the model, workspace deps, hub CSR (existence only), optional tools |
| `--system` | **sudo, your terminal** | apt `docker.io docker-compose-v2 mosquitto-clients jq curl openssl zstd`; docker group. **Refuses without a TTY**, so it can't run from Claude |
| `--user` | no | pnpm (corepack), uv check, **Ollama v0.40.6 user install with sha256 verified and CUDA libs skipped**, `scripts/ollama.sh start`, `ollama pull qwen2.5:3b`, `pnpm install`, `uv sync --all-packages`, `make-csr.sh` only if there's no key |
| `--devices-tools` | sudo | nmap, avahi-utils, tcpdump (Phase 0) |
| `--aws` / `--ask` | no | AWS CLI v2 into `~/.local` / ASK CLI into `~/.local` (gates G3/G4) |

The root `CLAUDE.md` gained a Setup section: use the script, **Claude never runs sudo**, the docker group needs a fresh login, and Ollama is a user process. The README quick start begins with the script.

Evidence:

```text
$ scripts/install-prereqs.sh
System:   ✔ docker.io ✔ docker-compose-v2 ✘ mosquitto-clients ✔ jq ✔ curl ✔ openssl ✔ zstd
          ✘ in docker group, but not active yet: log out and back in   ✔ docker service active
User:     ✔ node v22.23.1 ✔ pnpm 12.14.0 ✔ uv 0.10.11 ✔ ollama 0.40.6 ✔ model qwen2.5:3b
          ✔ workspace node_modules ✔ hearth-devices .venv ✔ hub CSR (key never read)
Optional: · aws cli · ask cli · nmap · avahi-utils (not installed) ✔ tcpdump
2 missing.
$ scripts/install-prereqs.sh --system < /dev/null
--system needs a real terminal for sudo. Run it yourself, not through Claude.     exit=1
$ scripts/install-prereqs.sh --user      # rerun: everything skipped or already up to date, hub key untouched
```

## Next

1. You: `sudo apt-get install -y mosquitto-clients` (or rerun `scripts/install-prereqs.sh --system`), then log out and back in, then `claude -c`.
2. Me: E3, Mosquitto in Compose with password auth and ACLs mirroring the local bus, and the Phase 1 acceptance test against it.
