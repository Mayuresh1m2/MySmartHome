# 03 — hearth-hub scaffold (PLAN B1)

Date: 2026-10-21

## Goal

A TypeScript strict ESM package with config, structured logging, metrics and contract-checked message schemas. The relay, tools and model come later and build on this.

## Environment (hub "First session" question)

The spec says to ask which machine the hub runs on. Detected values are recorded in `PLAN.md` §1. The working assumption is **this laptop** (i7-5500U, 15 GB, no GPU, Ubuntu 26.04), `hubId=laptop`. hearth-hub/CLAUDE.md's Environment section gets filled in once the user confirms and a model is chosen (D1).

## Dependencies

| Package | Version | Why |
|---|---|---|
| mqtt | 5.16.1 | relay (spec: mqtt.js v5) |
| ollama | 0.6.4 | intent (Phase D) |
| zod | 4.6.7 | validation, `z.toJSONSchema` for tool schemas |
| pino | 10.4.0 | JSON logs |
| yaml | 2.9.1 | `policy.yaml` |
| dev: tsx 4.23, vitest 5.0, typescript 7.0, aedes 1.2 (in-process broker for tests), pino-pretty, `@hearth/contracts` | | |

All are pure JS, with **no native compilation** (that would need approval). esbuild's postinstall only fetches a prebuilt binary. pnpm 12 blocks build scripts by default, so it was allowed with `pnpm approve-builds esbuild`, which wrote `allowBuilds: {esbuild: true}` to `pnpm-workspace.yaml`.

**Decision: no prom-client.** On install, `prom-client@15.1.3` reported *"deprecated: replaced by @prometheus-io/client"* (deprecated 2026-08-25). Rather than guess at a brand-new API, `src/obs/metrics.ts` implements the few Counter/Gauge/Histogram types the hub needs in Prometheus text format (~100 lines, tested).

## Modules written

- `src/config.ts`: zod-validated env. Loads `config/hub.env` (or `HUB_ENV_FILE`) without overriding real env vars. Derives `clientId=hearth-<hubId>`, the topics and the cert paths. Adds `CA_FILE` so local-stack can point at its own CA instead of Amazon Root CA 1.
- `src/obs/log.ts`: pino JSON with `svc`, ISO time, and redaction of any `key`/`cert`/`ca` field as defence in depth.
- `src/obs/metrics.ts`: `hearth_hub_commands_total{outcome}`, `hearth_hub_stage_duration_ms{stage}`, `hearth_hub_mqtt_connected`, `hearth_hub_mqtt_reconnects_total`, `hearth_hub_model_loaded`, `hearth_hub_last_command_timestamp_ms`.
- `src/relay/schema.ts`: `CommandV1`/`ReplyV1` as strict zod objects; `parseCommand()` never throws and classifies `not_json | wrong_version | invalid`; `makeReply()` clamps speech to 400 characters.
  - `z.guid()` rather than `z.uuid()`, so zod accepts exactly what the JSON Schema `format: uuid` accepts (any 8-4-4-4-12 hex). Strict RFC variant checks could reject IDs the other side considers valid.
- `src/relay/guard.ts`: staleness (> 10 s drops; exactly 10 s accepted), **future timestamps beyond 10 s also dropped** (clock skew), and duplicate detection with a 60 s memory.

## Evidence

```text
$ pnpm --filter @hearth/hub test
 Test Files  4 passed (4)
      Tests  33 passed (33)
$ pnpm --filter @hearth/hub typecheck
$ tsc --noEmit       (clean)
```

The tests cover: every `contracts/cloud-hub/v1` fixture against the zod schemas, parseCommand classes, reply clamping, guard boundaries (10 000 vs 10 001 ms, future, duplicate, forgetting), metric rendering and escaping, and config derivation and validation.
