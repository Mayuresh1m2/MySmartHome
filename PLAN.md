# Hearth — Master Execution Plan

Monorepo for three projects whose specs were provided as CLAUDE.md files:

| Dir | Spec | What it is |
|---|---|---|
| `hearth-aws/` | `hearth-aws/CLAUDE.md` | CDK app, Alexa skill Lambda, skill package, handoff scripts |
| `hearth-hub/` | `hearth-hub/CLAUDE.md` | Long-running Node hub: MQTT relay → Ollama intent → policy → tools → reply |
| `hearth-devices/` | `hearth-devices/CLAUDE.md` | Local device platform: Mosquitto bus, adapter SDKs, registry, adapters |
| `contracts/` | (new) | Single source of truth for the cloud↔hub contract (v1) and local device contract (v0) as JSON Schema + fixtures, tested by every side |
| `local-stack/` | (new) | Everything needed to run the full system on this laptop without AWS |
| `progress/` | (new) | Journal of the whole journey, one md file per step |

Guiding principles (from the request): **local setup first, tests at every layer, observability built in from day one.** Nothing touches AWS, a real device, or system services until a local equivalent is green.

---

## 1. Environment (detected 2026-10-21)

- Machine: Intel i7-5500U (2C/4T), 15 GB RAM (~5.7 GB free at idle), Intel HD 5500 **plus a discrete AMD Radeon R9 M375 (4 GiB, GCN 1.0) usable by Ollama through Vulkan** (missed in the first survey, corrected 2026-10-21, see progress/20), Ubuntu 26.04.1 x86_64
- Present: Node 22.23, npm 10.9, corepack 0.34, uv 0.10, Python 3.14, git, gh, openssl, jq, tcpdump, Docker 29.3 (not usable without sudo; no compose plugin)
- Missing: pnpm, AWS CLI, ASK CLI, CDK (comes via pnpm), Ollama, Mosquitto, nmap, avahi-browse

Consequences:
- **LLM runs on the R9 M375 via Vulkan** (CPU-only is too slow for 3B: every eval case timed out). That GPU lost its device once under two pinned models, so its stability is an open question. Candidate list to benchmark: `qwen2.5:1.5b`, `qwen2.5:3b`, `llama3.2:3b`. Recorded under hearth-hub Environment once chosen.
- **Local stack must not depend on Docker** until docker group access is granted. Use pure-Node substitutes: `aedes` (MQTT broker, with TLS client-cert auth to mimic IoT Core) and `dynalite` (DynamoDB emulator).

## 2. Approval gates (I stop and ask)

| Gate | Why |
|---|---|
| G1 sudo: add user to `docker` group / install mosquitto, nmap, avahi | system change |
| G2 Install Ollama + `ollama pull` | system install; model size |
| G3 AWS: install AWS CLI, configure profile, `cdk bootstrap`, every `cdk deploy` (after tests + synth + `cdk diff` shown) | hearth-aws working rules |
| G4 Amazon developer account + ASK CLI init, skill creation | outward-facing |
| G5 Any delete/replace/deactivate in AWS | hearth-aws IMPORTANT rule |
| G6 systemd unit install | hearth-hub rule |
| G7 Any device probing beyond passive inventory, per device | hearth-devices rules |
| G8 Undocumented APIs / extracted vendor keys | hearth-devices rules |
| G9 Values only the user has: `budgetEmail`, device models, hubId confirmation | data |

Everything else (scaffolding, code, tests, local stack, docs) proceeds autonomously in the loop. This master plan stands in for the per-milestone "short plan for approval"; each milestone's progress file still records its plan before implementation.

## 3. Cross-cutting design

### 3.1 Contracts as code (`contracts/`)
- `contracts/cloud-hub/v1/command.schema.json`, `reply.schema.json`, plus `fixtures/valid/*.json` and `fixtures/invalid/*.json`.
- `contracts/local-devices/v0/{meta,state,set,result}.schema.json` + fixtures.
- hearth-aws and hearth-hub each run a contract test asserting their zod schemas accept every valid fixture and reject every invalid one. Drift between the two CLAUDE.md copies is checked by a test that diffs the "Contract with hearth-hub/aws" sections.

### 3.2 Local stack (`local-stack/`) — the whole system on one laptop
```
 fake Alexa request (JSON) ─▶ skill handler (real code, local transports)
                                 │ publish                      ▲ poll
                                 ▼                              │
                     aedes broker (mTLS, IoT-policy ACLs) ──▶ rule emulator ──▶ dynalite "replies" table (TTL attr)
                                 │ hearth/<hubId>/commands      ▲ hearth/<hubId>/replies
                                 ▼                              │
                               hearth-hub (real process, local CA cert)
```
- Local CA issues the hub cert **from the hub's own CSR** — same flow as IoT Core, so `make-csr.sh` and the relay are exercised exactly as in production.
- The broker enforces the same four permissions as the IoT policy (connect as `hearth-<hubId>`, subscribe/receive commands, publish replies) so ACL mistakes show up locally.
- The skill handler depends on two small ports (`CommandPublisher`, `ReplyStore`); prod adapters use IoT Data Plane + DynamoDB SDK, local adapters use the same SDK pointed at dynalite and an MQTT publish. Same handler code path either way.
- `pnpm local:up` / `local:down` / `local:say "how much space is left"` from the repo root.
- Once Docker is available, a `compose.yaml` adds Mosquitto (for hearth-devices) and the optional observability profile below.

### 3.3 Testing pyramid
1. Unit — vitest (TS) / pytest (Python), filesystem and network mocked.
2. Contract — shared fixtures (3.1).
3. Integration — in-process aedes + dynalite inside vitest: relay stale/duplicate/malformed/wrong-version, reconnect after broker restart, ACL denial.
4. Local end-to-end — `local-stack` driven by a test: fake Alexa request → spoken reply; plus hub-down → honest fallback within `REPLY_TIMEOUT_MS`.
5. CDK assertion tests — least-privilege policy, no function URL, table/TTL/rule, alarm, budget.
6. LLM evals — `pnpm eval`, ≥ 40 phrasings incl. must-refuse; accuracy, p50, p95.
7. Cloud acceptance — only after G3/G4: `aws iot-data publish` → table item; `ask dialog`/simulate "ask home hearth to ping".

### 3.4 Observability
- **One correlation key:** `requestId` appears in every log line, audit line, metric exemplar and DynamoDB item, from Lambda → hub → tool → device adapter.
- **Structured JSON logs:** pino in hub and devices SDK (TS), structlog-style JSON in Python SDK, JSON logs in Lambda. Fields: `ts, level, svc, requestId, stage, latencyMs, outcome`. Utterance text only when `DEBUG_UTTERANCES=true` (cloud) / `AUDIT_TEXT=true` (hub).
- **Stage timings:** hub logs per-stage latency (`validate, intent, policy, tool, publish`) so the 3 s budget can be attributed.
- **Hub health** on 127.0.0.1: `GET /health` (JSON: mqtt state, model loaded, last command time, uptime) and `GET /metrics` (Prometheus text: commands by status, stage latency histograms, reconnect count, ollama latency).
- **Audit:** append-only JSONL per spec (`data/audit/YYYY-MM-DD.jsonl`).
- **Cloud:** CloudWatch EMF metrics from the Lambda (latency, outcome = ok/refused/error/timeout), 14-day log retention, Lambda error alarm + budget email (M4), and a small CloudWatch dashboard.
- **Tooling:** `scripts/trace.sh <requestId>` collects every local log/audit line for one request; `scripts/doctor.sh` checks toolchain, certs present (not contents), broker reachability, Ollama status, health endpoint.
- **Optional (after G1):** compose profile with Prometheus + Grafana scraping hub/devices `/metrics`, with a provisioned dashboard.

## 4. Execution order

Status legend: `[ ]` todo, `[~]` in progress, `[x]` done, `[!]` blocked on a gate.

### Phase A — Foundation
- [x] A1 Monorepo layout: move specs into `hearth-aws/`, `hearth-hub/`, `hearth-devices/` (+ `docs/device-leads.md`); root `.gitignore`; pnpm workspace; `.claude/settings.json` guardrails (merged root + per project)
- [x] A2 Toolchain without sudo: pnpm via corepack into `~/.local/bin`; record versions
- [x] A3 `contracts/` schemas + fixtures + drift test
- [x] A4 `scripts/doctor.sh`; initial commit on a branch

### Phase B — Hub, fully local (hearth-hub M1/M2 locally)
- [x] B1 hearth-hub scaffold: TS strict ESM, pino, vitest, zod v4, config loading
- [x] B2 `scripts/make-csr.sh` (key never read by anything else) + local CA in `local-stack/` that signs the CSR
- [x] B3 relay: mqtt.js v5, mTLS, QoS1, clean session, backoff reconnect, zod validation, staleness (10 s) + duplicate rules; replies "Hub is online." — unit + integration tests vs aedes
- [x] B4 health `/health` + `/metrics`, stage timing logs
- [x] B5 tools (`list_folder`, `disk_space`, `is_device_online`, `last_result`), keyword router, `policy.yaml` deny-by-default, audit JSONL, `pnpm try`

### Phase C — Cloud side, fully local (hearth-aws M1 + local stack)
- [x] C1 hearth-aws scaffold: CDK v2 app, config loading (`config/example.json`), skill handler with ports, unit tests (aws-sdk-client-mock)
- [x] C2 CDK stack: cert from CSR, thing, policy, table+TTL, rule, Lambda (Node 22, 7 s, 256 MB), invoke permission with skill ID, logs 14 d — assertion tests for least privilege + no function URL; `pnpm cdk synth` green
- [x] C3 `local-stack/`: aedes mTLS broker with IoT-equivalent ACLs, rule emulator, dynalite table, local skill runner, `local:up/down/say`
- [x] C4 Local e2e test: request → hub → spoken reply; hub off → fallback; trace by `requestId`

### Phase D — Local model (hearth-hub M3) — needs G2
- [~] D1 Install Ollama, benchmark models, pick one — 0.40.6 installed; R9 M375 GPU found (Vulkan). 3b/GPU 93.8 %, 20/20, p95 3.9 s; 1.5b fast but 73–77 %, 18/20. Next: reboot (GPU reset) + GPU soak test, then choose (progress/20)
- [x] D2 intent module (one call, tool calling, untrusted output), warm-up + keep-alive, latency metrics — code + mocked tests; real-model check waits for G2
- [x] D3 `pnpm eval` with ≥ 40 phrasings incl. must-refuse; target ≥ 90 %, all refusals, p95 < 4 s — harness + 48 cases done; keyword baseline 83.3 %, 20/20; model run waits for G2

### Phase E — Devices platform skeleton (hearth-devices Phase 1) — local; Mosquitto needs G1
- [x] E1 Python SDK (uv, aiomqtt, pydantic, ruff, pytest) + TS SDK (vitest): meta/state/result publishing, last will, schema validation against `contracts/local-devices/v0`
- [x] E2 fake adapter, registry, audit log, policy by risk class; tests on aedes/amqtt in-process
- [!] E3 Mosquitto with auth (docker or apt), acceptance: fake adapter appears, handles `set`, publishes `result`+`state`, goes offline via last will
- [!] E4 Phase 0 research: device table (needs G9 from user), one doc per device, classification and order — research subagents only when the user wants them

### Phase F — Hub gateway seam (hearth-hub M5)
- [x] F1 `DeviceGateway` interface, `devices.json` impl, fake gateway, device tools generated from capabilities and filtered by policy; test that swapping gateway needs no intent/tools change
- [x] F2 MQTT gateway via devices core (local contract v1: registry snapshot + request/response; hub = voice) — cross-language integration test green

### Phase G — Go to the cloud — needs G3/G4/G9
- [!] G1' AWS CLI + profile, `cdk bootstrap`; `config/local.json`
- [!] G2' aws M2: test → synth → diff → **ask** → deploy; `aws iot-data publish` fake reply → item in table; `scripts/handoff.sh` → `out/hub.crt`, `out/hub.env`
- [!] G3' hub M1 real: hub connects to IoT Core; fake command → reply item; Wi-Fi off/on → reconnect (user performs)
- [!] G4' aws M3: ASK CLI skill create → save ID → deploy → set endpoint → enable dev testing; simulate "ask home hearth to ping" with hub off (fallback) and on (reply)
- [!] G5' hub M2 acceptance: "Alexa, ask home hearth how much space is left" end to end

### Phase H — Hardening and operations
- [x] H1 aws M4: budget, alarm, log retention, `DEBUG_UTTERANCES`, CloudWatch dashboard, `docs/runbook.md` cert rotation — runbook awaits user review
- [!] H2 hub M4: systemd user/system unit, restart on failure, journald rotation, reboot test (G6)
- [x] C5 skill package (manifest + en-IN interaction model) with rule tests — privacy answers await user review
- [x] H3 aws M5: README for self-deployment incl. handoff — ASK commands to be confirmed at M3 (G4)

### Phase I — Real devices (hearth-devices Phases 2–5) — per-device gates G7/G8
- [!] I1 TV adapter (WoL, power, volume, mute, input/app, polling) with recorded fixtures
- [!] I2 remaining devices in Phase-0 order; I3 observe-only devices + outbound traffic summary

## 5. Loop protocol

Each loop iteration:
1. Read this file; pick the first `[ ]` item whose dependencies are met (skip `[!]`).
2. Write/extend its progress file (`progress/NN-<slug>.md`): goal, plan, commands run, output evidence, decisions, issues.
3. Implement; run the relevant tests/lint; paste real output into the progress file.
4. Mark the item `[x]` here, commit on the working branch.
5. If only gated items remain, stop the loop and ask the user for the gate decisions.
