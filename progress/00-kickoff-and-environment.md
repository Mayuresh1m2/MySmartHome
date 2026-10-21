# 00 — Kickoff and environment survey

Date: 2026-10-21

## Starting point

The repo `MySmartHome` had no commits, only IntelliJ files and four specs:

- `aws-project-CLAUDE.md`: hearth-aws (CDK, Alexa skill Lambda, IoT Core, DynamoDB)
- `hub-project-CLAUDE.md`: hearth-hub (Node service: MQTT relay, Ollama intent, policy, tools)
- `devices-project-CLAUDE.md` + `devices-project-device-leads.md`: hearth-devices (local device platform)

Request: plan the execution with **local setup, testing and observability as critical**, then run it in a loop, documenting the journey here.

## Environment survey

Commands: `node --version` and the like for each tool, `lscpu`, `free -h`, `lspci`, `docker ps`.

| Item | Result |
|---|---|
| CPU | Intel Core i7-5500U @ 2.40GHz, 4 threads |
| RAM | 15 GiB total, ~5.7 GiB available |
| GPU | Intel HD 5500 (Broadwell GT2) **and an AMD Radeon R9 M375, 4 GiB (see correction below)** |
| OS | Ubuntu 26.04.1 LTS, x86_64 |
| Disk | 147 GB free |
| Node / npm / corepack | v22.23.1 / 10.9.8 / 0.34.6 (via fnm) |
| Python / uv | 3.14.4 / 0.10.11 |
| Docker | 29.3.0 installed, **not usable without sudo** (user not in `docker` group), no compose plugin |
| git / gh / openssl / jq / tcpdump | present |
| pnpm, AWS CLI, ASK CLI, Ollama, Mosquitto, nmap, avahi-browse | **missing** |

## Decisions

1. **Monorepo**: the three projects become `hearth-aws/`, `hearth-hub/` and `hearth-devices/` in this repo, each with its own CLAUDE.md. Shared contracts go in `contracts/`, so neither side can drift.
2. **Local-first**: a `local-stack/` emulates IoT Core (an `aedes` broker with mTLS and the same ACLs as the IoT policy) and DynamoDB (`dynalite`). Both are pure Node, so Docker isn't needed yet. The real skill handler and the real hub process run against it.
3. **Observability from day one**: `requestId` correlation everywhere, JSON logs, per-stage latency, `/health` + `/metrics` on 127.0.0.1, an audit JSONL log, and `trace.sh`/`doctor.sh` scripts. CloudWatch EMF + alarm + dashboard on the cloud side.
4. **CPU-only LLM**: the p95 < 4 s target means benchmarking small models (1.5–3B). This may be the hardest acceptance criterion on this machine.
5. **Gates**: anything needing sudo, AWS, the Amazon developer account, Ollama install, systemd or real device probing waits for explicit approval (see PLAN.md §2).
6. **Hub machine assumption**: the hub runs on this laptop (`hubId` = `laptop`, the spec default). To be confirmed by the user.

## Output

- `PLAN.md`: master plan with phases A–I, gates and loop protocol.
- This journal.

## Correction (later the same day)

The first survey ran `lspci | grep -iE 'vga|3d|nvidia'`, which misses AMD GPUs listed as `Display controller [0380]`. The machine also has a **discrete AMD Radeon R9 M375 (4 GiB, GCN 1.0 "Verde")**, and Ollama found it through Vulkan. Every "CPU-only" statement written before progress/20 is wrong. Details in [20-gpu-finding-and-model-comparison.md](20-gpu-finding-and-model-comparison.md).
