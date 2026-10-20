# 10 — hearth-devices adapter SDKs, Python and TypeScript (PLAN E1)

Date: 2026-10-21

## Goal

The two small base libraries from the devices spec. They handle the MQTT plumbing, meta/state/result publishing, the last-will offline status and schema validation, so that each adapter only implements `discover`, `read_state` and `execute`.

## Phase-order note

The devices spec lists Phase 0 (device inventory and research) first. That's blocked on gate G9: I can't assume device models. The SDKs control no device, so building them now doesn't break "write findings before writing code", which is about device control code. No network scanning or device probing happened in this step.

## A Mosquitto stand-in: `local-stack/src/bus.ts`

Mosquitto needs Docker or apt (gate G1). The tests and local runs use an aedes bus that mirrors what `mosquitto.conf` + `passwd` + `acl` will enforce:

- 127.0.0.1 only, password auth, no anonymous clients (constant-time password compare)
- `adapter-<id>`: may publish `devices/+/{meta,state,result}` and **only its own** `adapters/<id>/status`; may subscribe to `devices/+/set`
- `core`: may subscribe to `hearth/local/#` and publish only `devices/+/set`
- `pnpm --filter @hearth/local-stack bus` runs it standalone. Its first stdout line reports the port, so the Python tests can start it on port 0.

## Python SDK: `hearth-devices/sdk/python` (`hearth_devices_sdk`)

uv project. Runtime deps: aiomqtt 2.5.1 (paho-mqtt 2.1.0), pydantic 2.14.1, jsonschema 4.26.0. Dev deps: pytest 9.1.1, pytest-asyncio 1.4.0, ruff 0.17.1. The system's Python 3.14 is used, and `requires-python >= 3.12` per the spec. I checked aiomqtt's API with `inspect.signature` before using it.

- `contract.py`: topics, pydantic models (`DeviceMeta`, `Capability`, `SetCommand`, `Result`), `state_payload()` (rejects the reserved keys `v`/`online`/`updatedAt`), and `validate()` against the **shared JSON Schemas** in `contracts/local-devices/v0` (or `HEARTH_CONTRACTS_DIR`).
- `adapter.py`: the `Adapter` ABC and `AdapterRunner`:
  - Connects as `adapter-<id>` with a **last will** (`status=offline`, retained). Publishes `online`, then retained meta and state for each discovered device, then subscribes to `devices/+/set`.
  - `set` flow: parse → `SetCommand` → known capability → **high risk refused unless the adapter opts in** (defence in depth on top of core policy) → params validated against the capability's JSON Schema → `execute` with a timeout. Then it publishes `result` and retained `state`. `CommandError` messages are published. Any other exception becomes a generic "adapter error", so internals never leak.
  - Garbage, and `set` messages for other adapters' devices, are ignored. An invalid command that carries a requestId gets a failed result.
  - A failed state read publishes `online:false`.
  - **Reconnects with backoff** (1 s → 30 s) and re-announces `online` after the broker has fired the will.
  - Graceful stop publishes `offline`.
- `log.py`: JSON lines (`ts, level, svc, msg, deviceId, requestId, …`) in the same shape as the hub and stack logs, so `requestId` traces work across all of them.

## TypeScript SDK: `hearth-devices/sdk/ts` (`@hearth/devices-sdk`)

The same behaviour with mqtt.js 5 and ajv against the same schemas: the `Adapter` interface, `AdapterRunner.start/stop/handleSet`, and `CommandError`.

## Bugs found by the tests and fixed

1. **Adapters stayed "offline" forever after a connection blip** (both SDKs). When a session drops, the broker publishes the will, and nothing said "online" again. The Python runner also didn't reconnect at all (aiomqtt has none built in). Fix: Python `run()` is now a reconnect loop with backoff, and each session re-announces. In TS, `on('connect')` re-announces and refreshes state. The test takes over the adapter's client ID to make the broker drop the session, then asserts `online → offline → online`.
2. **Unhandled promise rejection in the TS runner.** The fire-and-forget re-announce, poll and set handlers could reject (for example "client disconnecting" during stop). That surfaced as a Vitest unhandled error, and in production it would crash the adapter process. Every background promise now has a `.catch` that logs. 5/5 clean runs afterwards.
3. Test-only issues: the first ACL test asserted at the wrong place (a denied QoS-1 publish never gets a PUBACK, so the first publish is what fails). And ruff's autofix reformatted a block, so one of my scripted edits silently didn't apply. I caught that and redid it with Edit.

Known noise: the ACL test makes aiomqtt print *"Future exception was never retrieved … Unexpected disconnection"*. It comes from aiomqtt's internals when a **test-only** raw client is kicked by the broker, and I confirmed it doesn't occur in the runner's reconnect or last-will tests (I ran each test separately to check).

## Evidence

```text
$ cd hearth-devices/sdk/python && uv run ruff check . && uv run pytest -q
All checks passed!
27 passed in 7.33s            (×3 earlier runs: 6.07 s, 6.35 s, 6.38 s)

covers: every contracts/local-devices/v0 fixture (valid → schema + models round-trip; invalid → rejected) ·
announce (status/meta/state, schema-valid) · set → result + state · 7 rejection cases (bad params, missing params,
unknown capability, high risk, CommandError, crash without leaking "secret internal detail", wrong v) ·
garbage/foreign devices ignored · failed read → online:false · graceful stop → offline ·
SIGKILL'd adapter subprocess → broker's last will → offline · ACL: spoofing another adapter's status is refused ·
session drop → reconnect → online again

$ pnpm --filter @hearth/devices-sdk test
      Tests  12 passed (12)   (×5 runs clean)

$ pnpm --filter @hearth/local-stack test      # bus ACL + auth + will
      Tests  19 passed (19)

$ pnpm test      # root: all JS packages, then ruff + pytest
contracts 27 · skill 23 · hearth-aws 14 · local-stack 19 · hearth-hub 87 · devices-sdk/ts 12 · devices-sdk/python 27  → 209 passing
```

The root `pnpm test` now runs `test:js` (all workspaces), then `test:py` (ruff + pytest).
