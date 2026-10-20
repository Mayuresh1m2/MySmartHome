# 12 — Hub device gateway seam (PLAN F1 = hub M5)

Date: 2026-10-21

## Goal

hub M5: *"`DeviceGateway` with capability-based methods: list devices, get state, execute a capability. Device tools are generated from gateway capabilities and filtered by policy. The `devices.json` implementation stays."* Done when tests show a fake gateway can replace the real one with no change to the intent or tools modules.

## Design

- `src/devices/gateway.ts`: `DeviceGateway { name; list(); find(nameOrAlias); getState(id) → {online, values}; execute(id, capability, params, {requestId}) → {ok, error, state} }`. `DeviceCapability` mirrors hearth-devices meta: `{name, risk, params: JSON Schema}`.
- `JsonDeviceGateway` stays. Each `devices.json` entry exposes a single read capability, `Reachability`, backed by the TCP probe. `is_device_online` now calls `getState()`.
- `src/tools/deviceTools.ts`: `generateDeviceTools(gateway)` creates **one tool per capability name** across devices (`OnOff` → `device_on_off`, `RvcRunMode` → `device_rvc_run_mode`):
  - args `{device, params}`, where **params comes from the capability's JSON Schema via `z.fromJSONSchema`** (zod 4.6, probed first). It round-trips through `z.toJSONSchema`, which is what M3 hands to the model.
  - **High-risk capabilities never become tools** (spec: never reachable by voice). `Reachability` is skipped because `is_device_online` covers it.
  - The tool's risk is the highest any device declares for that capability.
  - Spoken result: "Done. The desk lamp is on." or "The desk lamp couldn't do that: device is offline." Gateway errors are designed to be user-safe (the hearth-devices SDK never forwards internals).
- **Filtered by policy twice.** `app.ts` keeps only generated tools that `policy.yaml` enables, so the intent module never sees the rest. At call time the usual policy check (voice ceiling, rate limits, arg constraints) still applies.
- **requestId flows to the device.** `ToolContext.requestId` is set by the pipeline and passed to `gateway.execute`, so one id can be traced from Alexa → skill → hub → device adapter → device audit (F2 puts it on the bus as the `set` requestId).
- `buildApp` became async, because the gateway is asked for capabilities at startup.

The shipped `policy.yaml` enables no device tools, and its voice ceiling stays `read`. Device control by voice is a decision for you once real adapters exist.

## Evidence

```text
$ pnpm --filter @hearth/hub test
      Tests  98 passed (98)          (11 new)
$ pnpm --filter @hearth/hub typecheck   (clean)
$ pnpm --filter @hearth/local-stack test   # spawned-hub e2e still green after the async buildApp change
      Tests  19 passed (19)
$ pnpm try "is the router online"
{"tool":"is_device_online","decision":"allowed","speech":"The router is online."}
```

New tests (`test/gateway.test.ts`, `test/fakeGateway.ts`):

- **Gateway contract suite, run against both `JsonDeviceGateway` and `FakeGateway`:** ids, capabilities, find by name, upper case and "the …", unknown → undefined, boolean `online`.
- **Tool generation:** `device_on_off (low)`, `device_level_control (low)`, `device_rvc_run_mode (medium)`. The lock's high-risk `DoorLock` never becomes a tool, and devices.json yields no device tools. Param validation follows the JSON Schema (wrong type, extra key rejected), and the export back to JSON Schema works.
- **M5 acceptance:** the same pipeline, keyword router and `is_device_online` work unchanged against both gateways ("The router is online." / "The desk lamp is online." / "The front door lock is not responding."). A generated tool executes through the fake gateway with **the command's requestId**. A tool missing from policy is filtered out (`refused:unknown_tool`). Medium above a `low` ceiling → `refused:risk`, with no gateway call. Bad params → `refused:bad_args`, also with no gateway call. Offline → spoken plainly.

One test-data fix along the way: the first run used `requestId: 'r1'`, which `makeReply` (correctly) rejects because the contract requires a UUID.

## Open question for F2

The hearth-devices core enforces device policy and audit (entry 11), but the bus ACL lets any `core` user publish `set`. When the hub's MQTT gateway is built (F2), either the hub sends through the core service, which keeps one policy and audit path, or the hub gets its own bus identity and duplicates the checks. I recommend **through core**, and will propose it then.
