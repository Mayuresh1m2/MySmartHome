# 11 — hearth-devices core and the fake adapter: Phase 1 acceptance (PLAN E2)

Date: 2026-10-21

## Goal

The devices platform skeleton from Phase 1: a fake adapter, a registry built from adapter meta, device-level policy by risk class, and an audit log. Acceptance: *"the fake adapter shows up in the registry, handles a `set`, publishes `result` and `state`, and goes offline cleanly through its last will."* Mosquitto itself is gated (E3/G1), so the bus is the local stand-in from entry 10, which enforces the same auth and ACLs.

## Layout: hearth-devices is now a uv workspace

```text
hearth-devices/
  pyproject.toml            workspace: sdk/python, core, adapters/*; shared ruff + pytest config
  conftest.py               shared fixtures: starts the local bus (port 0) + a "core" observer
  config/policy.yaml        risk-class policy
  sdk/python/               hearth_devices_sdk (entry 10)
  core/                     hearth_devices_core + `hearth-devices` CLI
  adapters/fake/            hearth_adapter_fake + `hearth-adapter-fake` entry point
```

There's one `uv.lock` at `hearth-devices/` (the SDK's own lock was removed). Run `uv sync --all-packages` to install the members. Root `pnpm test:py` now runs ruff + pytest over the whole workspace.

## Fake adapter (`adapters/fake`)

| Device | Capabilities (Matter names) | Risk |
|---|---|---|
| fake-lamp | OnOff `{on}`, LevelControl `{level 0..100}` | low |
| fake-vacuum | RvcRunMode `{mode: idle|cleaning}`, RvcOperationalState | medium, read |
| fake-lock | DoorLock `{locked}` | high |

State is in memory. The vacuum reports `operationalState: running` while cleaning, which is what policy uses for "idle".

## Core (`core/src/hearth_devices_core`)

- **Registry:** built *only* from bus messages. Meta and state are validated against `contracts/local-devices/v0` before entering. Rejected: violations, a topic/id mismatch, unknown status words. A device is online only if its adapter's status is `online` **and** its last state said `online:true`. An adapter going offline takes its devices offline. A cleared retained meta removes the device.
- **Policy** (`config/policy.yaml`, strict pydantic schema):
  - unknown device or capability → refused;
  - **high**: refused by default, can't be default-allowed (schema), can be allowed per device/capability **for local use only**, and is **never reachable by voice**;
  - read/low/medium: default allow, with per-device overrides;
  - **medium requires online and idle**; read is allowed even when the device is offline.
  - *Idle* has no definition in the spec. I chose: idle unless `busy: true` or an operational state such as running, cleaning, washing, drying, seeking charger, active, busy or paused. Devices with no such notion (TV, lamp) count as idle. **This is my interpretation and needs your review.**
- **Audit:** JSONL `hearth-devices/data/audit/YYYY-MM-DD.jsonl` (dir 0700, file 0600, gitignored with `data/`). One line per sent *or refused* command, with requestId, device, capability, action, params, via, decision, reason, ok, error and latencyMs.
- **Core.execute:** policy → `set` (contract-validated) → waits for the matching `result` by requestId (10 s timeout) → audit. Refusals return a result-shaped `{"ok": false, "error": "policy: …"}` and never reach the bus.
- **CLI:** `uv run hearth-devices list | set <device> <capability> <action> '<json>' | watch`.

## Issues hit

1. **Flaky test: 1 failure in 3 runs.** `test_graceful_stop_publishes_offline` asserted right after the runner exited. The broker had acked the QoS-1 "offline", but delivery to the observer can still be in flight. The test now waits for the message. The same pattern in the reconnect test was fixed before it could flake. Afterwards: **10/10** runs green.
2. The SDK logger wrote JSON log lines to stdout, which mixed with the CLI's JSON output. Logs now go to **stderr**.
3. A `cd ..` in one of my scripts ran ruff outside the workspace. Rerun from the right directory.

## Evidence

Automated Phase 1 acceptance (`core/tests/test_phase1_acceptance.py`, which runs the real `hearth-adapter-fake` executable as a subprocess):

```text
1. all three devices appear online in the registry
2. OnOff set via voice → ok, result.state.on = true, registry state updated
   RvcRunMode cleaning while docked → ok; again while running → "policy: device is busy"
   DoorLock (high) → "policy: high risk is disabled"; lock state unchanged (adapter never saw it)
   LevelControl {level: 500} → passes policy, adapter rejects "invalid params"
   audit = [lamp sent ok, vacuum sent ok, vacuum refused, lock refused, lamp sent failed]
3. SIGKILL the adapter → broker last will → registry: adapter offline, every device offline,
   and a following command is refused "policy: device is offline"
+ graceful SIGTERM → offline
```

```text
$ cd hearth-devices && uv run ruff check . && uv run pytest -q
All checks passed!
43 passed in 8.81s                 (10 consecutive runs: all 43 passed, 8.4–9.2 s)
```

Live run with real processes (bus on :18830, `hearth-adapter-fake`, `hearth-devices` CLI):

```text
$ hearth-devices list
{"id":"fake-lamp","online":true,"capabilities":["OnOff:low","LevelControl:low"],"state":{"on":false,"level":50}}
{"id":"fake-lock","online":true,"capabilities":["DoorLock:high"],"state":{"locked":true}}
{"id":"fake-vacuum","online":true,"capabilities":["RvcRunMode:medium","RvcOperationalState:read"],"state":{"runMode":"idle","operationalState":"docked","battery":100}}
$ hearth-devices set fake-lamp OnOff set '{"on":true}'
{"v":0,"requestId":"8440835f-…","ok":true,"error":null,"state":{"v":0,"online":true,"on":true,"level":50}}     latencyMs 47
$ hearth-devices set fake-lock DoorLock set '{"locked":false}'
{"v":0,"requestId":"c2a088d8-…","ok":false,"error":"policy: high risk is disabled","state":{}}
--- kill -9 fake adapter
{"id":"fake-lamp","online":false} {"id":"fake-lock","online":false} {"id":"fake-vacuum","online":false}
--- audit
{"deviceId":"fake-lamp","capability":"OnOff","decision":"sent","ok":true,"latencyMs":47}
{"deviceId":"fake-lock","capability":"DoorLock","decision":"refused","ok":false,"reason":"high risk is disabled","latencyMs":0}
--- bus
publish hearth/local/adapters/fake/status   from adapter-fake (retain)   ← online
publish hearth/local/devices/fake-lamp/set  from hearth-devices-core-f7b39f
publish hearth/local/devices/fake-lamp/result from adapter-fake
publish hearth/local/adapters/fake/status   from adapter-fake (retain)   ← last will: offline
```

Remaining for Phase 1: real Mosquitto with a password file and ACL (E3, gate G1). The aedes bus has the same rules, so the switch should be configuration only.
