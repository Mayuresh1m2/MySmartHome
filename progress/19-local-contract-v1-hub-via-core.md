# 19 — Local contract v1: the hub reaches devices only through core (PLAN F2 = devices Phase 4 seam)

Date: 2026-10-21. Your decision: route hub commands **through the devices core**.

## Why this needed a contract change

Under v0 any `core` identity could publish `set`, and the hub had no way to reach devices except by also publishing `set`, which would bypass device policy and audit. Routing through core needs new topics. The devices spec says *"to change the contract, bump `v` and update hearth-hub's `DeviceGateway` in the same change"*, so everything moved to **v1 in one commit**.

## Contract v1 (`contracts/local-devices/v1`, hearth-devices/CLAUDE.md "Local contract v1")

- Existing messages are unchanged apart from `"v": 1`. `set` is now published only by core.
- **New** `hearth/local/core/registry` (retained, from core): a snapshot of every device with capabilities (params included), online and state.
- **New** `hearth/local/core/request/<clientId>` → core applies policy and audit and sends `set` → **new** `hearth/local/core/response/<clientId>` (result-shaped).
- **The client's trust level comes from the topic, never the payload.** `request/hub` always runs as **voice**. The schema is closed (`additionalProperties: false`), so a request claiming `"via": "local"` is invalid (a fixture covers it).
- Bus ACL (local-stack bus now, Mosquitto `acl` later): the new `hub` user may publish **only** `core/request/hub` and read only `core/response/hub` and `core/registry`. It can't publish `set`, read device topics, or publish to another client's request topic.

## Changes

| Where | What |
|---|---|
| contracts | v0 → v1 (`git mv`), 3 new schemas, 3 valid + 4 invalid new fixtures, `localDevicesV1` export; contracts tests 27 → 34 |
| Python SDK | `V = 1`, the topics for core, `validate()` knows the new kinds |
| TS SDK | v1 types and validators |
| core | publishes a retained, contract-validated registry snapshot (coalesced to ≤ 1 per 100 ms); serves requests in **separate tasks** (handling one inline would deadlock, because the reply to a `set` arrives through the same message loop); `CLIENT_VIA = {hub: voice}`, unknown clients → voice; `hearth-devices serve` CLI |
| bus | `hub` identity; core may publish registry and responses |
| hub | `MqttDeviceGateway`: reads the registry snapshot, sends requests, waits ≤ 2.5 s for the response; `DEVICES=json|mqtt` and bus settings in config (password only in the gitignored `config/hub.env`); `@hearth/contracts` and ajv are now runtime deps |

## Bug found: stale retained status (aedes)

Running the new request tests together with the rest of the suite failed 2 of 3 times, while each test passed alone. Debug output:

```text
DEBUG adapters {'fake': 'offline'} {'fake-lamp': (False, True), 'fake-vacuum': (False, True), 'fake-lock': (False, True)}
```

The adapter's status was a **stale retained `offline`** (left by the previous test's adapter), while its devices were publishing fresh `online: true`. aedes stores retained messages asynchronously, so a subscriber arriving in the gap gets the old one and misses the live update.

**Fix in the registry (not the test):** a *live* (non-retained) meta/state from a device proves its adapter is connected. A will is published only after the connection is gone, and the broker preserves per-publisher order. A later real will still wins. Unit-tested. Afterwards: **5/5 runs at 55 passed**, and the suite time dropped from ~28 s back to 8.8 s (the 10 s fixture timeouts were gone).

A second, test-only issue: the snapshot test read the *previous* core's retained snapshot first. It now waits for a current one.

## Evidence

Cross-language integration (`hearth-hub/test/mqttGateway.integration.test.ts`: in-process bus, **the real Python `hearth-devices serve` and `hearth-adapter-fake` as processes**, the hub's gateway, tools and pipeline):

```text
 ✓ lists devices with capabilities from the registry snapshot
 ✓ generates voice tools from capabilities, never for the high-risk lock
     → device_level_control, device_on_off, device_rvc_operational_state, device_rvc_run_mode
 ✓ a voice command runs end to end, and one requestId appears in both audit logs
     hub reply "Done. The Fake lamp is on."; hub audit {tool: device_on_off, outcome: ok};
     devices audit {deviceId: fake-lamp, via: voice, decision: sent, ok: true}, same requestId
 ✓ even calling the gateway directly, core refuses the lock: hub requests are voice
     {"ok":false,"error":"policy: high risk is never reachable by voice"}
 ✓ the hub identity cannot send set to a device itself (broker drops it; lock still locked)
      Tests  5 passed (5)        ×3 more runs: 2.1–2.2 s each; no orphaned Python processes
```

Python (`core/tests/test_requests.py`): the retained snapshot is valid and includes params; a hub request runs with `via: voice` in the audit; **the lock is refused for the hub even though policy allows it locally** (and the same command succeeds locally, so it's policy and not luck that stops the hub); a payload claiming `via` gets "invalid request".

```text
$ pnpm test
contracts 34 · skill 23 · hearth-aws 33 · local-stack 21 · devices-sdk/ts 12 · hearth-hub 119 · hearth-devices (py) 55   → 297 passing
```

## Still open

- Generated device tools are built once at hub startup from the snapshot. Devices that appear later need a hub restart. Regenerating on registry change is a small follow-up.
- No device tools are enabled in the shipped `policy.yaml`, and the voice ceiling stays `read`, until real adapters exist and you decide.
