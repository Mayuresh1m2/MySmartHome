# Hearth hub

The home half of Hearth: a long-running service on a machine in my house. It keeps one outbound MQTT connection to AWS IoT Core, receives commands spoken to Alexa, picks an action with a local model through Ollama, runs only allowlisted tools, and replies with a sentence for Alexa to speak. It accepts no connections from the internet.

Out of scope: AWS resources (the hearth-aws project) and device protocols and adapters (the hearth-devices project, later). This project reaches devices only through the `DeviceGateway` interface.

## First session

Before choosing a model or a service manager, ask me which machine and OS the hub runs on and how much RAM and GPU it has. Record the answers under Environment.

## Environment

- Machine, OS, RAM, GPU: this laptop (confirmed 2026-10-21), hubId `laptop`. Intel Core i7-5500U (2 cores / 4 threads), 15 GiB RAM, Intel HD 5500 plus a discrete AMD Radeon R9 M375 (4 GiB VRAM, GCN 1.0) that Ollama uses through Vulkan, Ubuntu 26.04.1 LTS x86_64.
- Ollama version and chosen model: Ollama 0.40.6 (user install in ~/.local, `scripts/ollama.sh start`, 127.0.0.1:11434, not a system service). **Chosen 2026-10-21: qwen2.5:3b on the R9 M375 (Vulkan) behind the thermal guard**: 93.8 % accuracy, 20 of 20 refused, p50 ≈ 2.7 s, p95 ≈ 3.6 s, ~8.8 tok/s. Needs hearth-aws `replyTimeoutMs` 5000 and hub `INTENT_TIMEOUT_MS` 4300. Sustained load overheats this laptop (thermal power-off after ~16 min back to back), so the hub falls back to the keyword router at GPU ≥ 95 °C or CPU ≥ 90 °C, above 12 model calls a minute, while the model is loading, and on model errors (progress/21, 22).

## Contract with hearth-aws

This section is identical in hearth-aws and hearth-hub. Never change one side alone: bump `v`, then update both CLAUDE.md files and both implementations together.

- Region: one AWS Region per deployment, set once in the repo-root `.env` as `HEARTH_AWS_REGION` (this deployment: `ap-southeast-2`). hearth-aws deploys there; the handoff's `hub.env` carries it to the hub as `AWS_REGION`.
- `hubId`: lowercase letters, digits and hyphens; default `laptop`
- MQTT client ID and IoT thing name: `hearth-<hubId>`
- Topics: `hearth/<hubId>/commands` (cloud to hub) and `hearth/<hubId>/replies` (hub to cloud), QoS 1
- Command payload: `{"v":1,"requestId":"<uuid>","text":"<utterance>","sentAt":<epoch ms>}`
- Reply payload: `{"v":1,"requestId":"<uuid>","speech":"<one or two sentences>","status":"ok|refused|error"}`
- Identity: an X.509 certificate issued from a CSR generated on the hub machine. The private key never leaves that machine.
- Timing: Alexa waits about 8 s. The Lambda waits `REPLY_TIMEOUT_MS` (default 3000, never above 5000). The hub drops commands older than 10 s and duplicate `requestId`s.
- Handoff from hearth-aws to hearth-hub: `hub.crt` plus `hub.env` with `IOT_ENDPOINT`, `HUB_ID` and `AWS_REGION`.

## Architecture

One Node.js process with these modules:

- relay: MQTT 5 client to IoT Core over TLS with the hub certificate. Clean session, QoS 1, reconnect with backoff. Validates every payload with zod and applies the staleness and duplicate rules from the contract.
- intent: one Ollama call per command, with tool calling. Returns a tool and its arguments, or a short refusal. Treat model output as untrusted input.
- tools: one file per tool. Each declares a name, a description, a zod schema for its arguments, a risk level and `run()`.
- policy: loads `config/policy.yaml`. Deny by default, with a per-tool enable flag, argument constraints, a risk ceiling for voice and rate limits.
- audit: append-only JSONL in `data/audit/`, one line per command with time, `requestId`, text (or just its length when `AUDIT_TEXT=false`), tool, arguments, decision, outcome and latency.
- devices: the `DeviceGateway` interface. The first implementation reads `config/devices.json`; a later one talks to hearth-devices over local MQTT.
- state: the last result (for "what happened") and recent `requestId`s.
- health: an HTTP status endpoint on 127.0.0.1 only, reporting connection state, whether the model is loaded and the last command time.

Flow: receive, validate, check staleness and duplicates, intent, policy, `tool.run`, reply, audit.

## Stack

- Node.js 22, TypeScript (strict), ESM, pnpm, tsx for development
- `mqtt` (mqtt.js v5), `ollama` (ollama-js), zod v4 (`z.toJSONSchema` produces the tool schemas), pino, vitest
- Ollama installed natively on the host. Docker on macOS can't use the GPU.

## Layout

```text
src/index.ts             wiring and startup
src/relay/               IoT Core client
src/intent/              system prompt, Ollama call, tool selection
src/tools/               one file per tool
src/policy/              policy loading and checks
src/audit/               JSONL audit log
src/devices/             DeviceGateway interface and implementations
src/health/              localhost status endpoint
config/hub.env           IOT_ENDPOINT, HUB_ID, AWS_REGION, OLLAMA_MODEL (gitignored; hub.example.env committed)
config/policy.yaml       which tools are enabled, with limits
config/devices.json      static device list for the first gateway
certs/                   hub.key, hub.csr, hub.crt, AmazonRootCA1.pem (gitignored)
scripts/make-csr.sh      generates the key and CSR locally and downloads the Amazon root CA
test/evals/phrases.yaml  phrasings with the tool and arguments each should produce
data/                    audit logs (gitignored)
```

## Rules that matter most

- IMPORTANT: never read, print, copy or send `certs/hub.key`. Code passes its path to the MQTT client and nothing else touches it.
- No inbound listeners except the health endpoint on 127.0.0.1.
- No shell-execution tool, ever. Tools are typed functions with validated arguments.
- One model call per command, and tool output never goes back into the model. If a feature needs a second call, propose it to me first, because it opens the door to prompt injection.
- A tool missing from `policy.yaml` is refused even when the model picks it.
- Risk levels are read, low, medium and high. Voice can reach medium at most, and nothing high is enabled in this version.
- Replies leave the house through Amazon. Tools must never speak secrets, tokens or anything I wouldn't say on a phone call.
- Ask me before installing system services, changing firewall or network settings, pulling a model larger than 10 GB, or adding a dependency that needs native compilation.

## Commands

- `pnpm dev`: run with tsx and readable logs
- `pnpm test`: unit tests
- `pnpm eval`: run `test/evals/phrases.yaml` against the configured model and print accuracy plus p50 and p95 latency
- `pnpm try "<text>"`: run intent, policy and the tool without MQTT
- `scripts/make-csr.sh`: create `certs/hub.key` and `certs/hub.csr`

## Testing rules

- Unit tests cover relay handling (stale, duplicate, malformed and wrong-version payloads), policy, and every tool, with the filesystem and network mocked.
- Before changing the model, the system prompt or any tool description, run `pnpm eval` and show me the numbers before and after.
- Evals include phrasings that must be refused, such as deleting files, unlocking anything, or asking for something no tool does.

## Working rules

- For each milestone: explore, write a short plan for my approval, implement, then show evidence that the acceptance check passed.
- When unsure how mqtt.js, IoT Core or Ollama behaves today, check the current docs instead of guessing.

## Guardrails

If `.claude/settings.json` doesn't exist, create it with these rules. They catch the usual command forms, not every possible one, so the rules above still apply.

```json
{
  "permissions": {
    "ask": [
      "Bash(sudo *)",
      "Bash(systemctl *)",
      "Bash(launchctl *)",
      "Bash(ollama pull *)"
    ],
    "deny": [
      "Read(./certs/hub.key)"
    ]
  }
}
```

## Milestones

Work one milestone at a time, in order.

### M1: Identity and connection
- `scripts/make-csr.sh` creates the key and CSR, then tells me the CSR path to put in hearth-aws's config. Place `hub.crt` and `hub.env` from the hearth-aws handoff. The relay connects, subscribes, validates, and replies "Hub is online." to every command.
- Done when a fake command published from the hearth-aws side produces a reply item in DynamoDB, and the relay reconnects on its own after I switch Wi-Fi off and on.

### M2: Tools, policy and audit, without a model
- Tools: `list_folder`, `disk_space`, `is_device_online` (TCP check against `devices.json`) and `last_result`. A temporary keyword router stands in for the intent module. Add `policy.yaml`, the audit log and the health endpoint.
- Done when unit tests pass and "Alexa, ask ramesh dude how much space is left" works end to end.

### M3: Local model
- Ollama tool calling replaces the keyword router. Warm the model up at startup, keep it loaded, log latency, and build `pnpm eval` with at least 40 phrasings.
- Done when eval accuracy is at least 90%, every must-refuse phrasing is refused, and p95 latency is under 4 s on this machine once the model is loaded.

### M4: Run as a service
- A systemd or launchd unit (or Docker Compose with host networking for the hub, with Ollama still native), starting on boot, restarting on failure, with log rotation.
- Done when the hub answers Alexa after a reboot with no manual steps.

### M5: The device gateway seam
- `DeviceGateway` with capability-based methods: list devices, get state, execute a capability. Device tools are generated from gateway capabilities and filtered by policy. The `devices.json` implementation stays.
- Done when tests show that a fake gateway can replace the real one with no change to the intent or tools modules.

## Later: hearth-devices

The device platform publishes devices on a local MQTT broker under `hearth/local/devices/<deviceId>/meta|state|set|result`. Its CLAUDE.md defines the payloads. Don't build device adapters in this project.
