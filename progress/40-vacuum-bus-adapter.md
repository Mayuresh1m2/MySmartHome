# 40 — Vacuum bus adapter (hearth-devices)

Goal: put the Dreame vacuum on the Hearth bus so the hub's `clean_house` tool (progress/39)
can reach it. This builds the adapter and unit-tests it behind an arm gate; the end-to-end dry
run and the first armed run follow.

## What was built
`adapters/vacuum/src/hearth_adapter_vacuum/__init__.py` — a `VacuumAdapter(Adapter)` on the SDK:

- Device `vacuum`, kind `robot-vacuum`, adapter `vacuum`. Capabilities:
  - `RvcRunMode` (medium): `{"mode": "idle" | "cleaning"}`
  - `RvcOperationalState` (read): `{}`
- `discover()` is static (no cloud call) so the adapter registers even when the vacuum is offline.
- `read_state()` → Dreamehome `get_properties` over the command relay (the proven progress/38
  path), mapped to `{runMode, operationalState, battery, error}`. No secrets in the state.
- `execute()` → one MIoT action via `send("action", …)`.
- The vendored client is synchronous and not re-entrant, so cloud calls run on a worker thread
  (`asyncio.to_thread`) under a lock, on one warm, logged-in client reused across calls.
- Token + did come from `secrets/vacuum_session.json` (minted in progress/38; no password). The
  vendored `dreamehome` logger is set to CRITICAL so it can never print the token.

## Action ids — verified, and an earlier guess corrected
progress/38 noted the start action as "likely siid 4 aiid 1". Checked against Tasshack's
`DreameVacuumActionMapping` (types.py, pinned commit `f5b8472…`):

- `START` = **siid 2, aiid 1** (full auto clean) ← what "clean the house" uses
- `START_CUSTOM` = siid 4, aiid 1 (needs map/zone params) ← the earlier guess; wrong for a plain start
- `CHARGE` (return to dock) = siid 3, aiid 1 ← used for `idle`
- `PAUSE` = 2/2, `STOP` = 4/2

So `cleaning` → START (2/1), `idle` → CHARGE (3/1), both with `in: []`.

## Arm gate — robot only moves when armed
`execute()` is a **dry run unless `VACUUM_ARMED` is set** (`1/true/yes/on`). Dry run logs the
action it would send and returns `None` (SDK re-reads the real, unchanged state) with ok=true,
so the full Alexa → hub → bus chain lights up without the vacuum firing. The first armed run is
done with the owner watching (medium risk; hearth-devices/CLAUDE.md).

## Tests (no bus, no cloud)
`adapters/vacuum/tests/test_vacuum.py` replaces the cloud client with a recorder:

- `discover()` shape + `validate("meta", …)` against the shared schema
- `_to_state` mapping (cleaning / sleeping / fault code)
- dry run sends nothing; armed sends START for `cleaning`, CHARGE for `idle`
- read capability and unknown capability send nothing / refuse

```
$ uv run pytest adapters/vacuum/tests -q
........                                                                 [100%]
8 passed in 0.32s
$ uv run ruff check adapters/vacuum/src adapters/vacuum/tests
All checks passed!
$ uv run pytest -q          # whole hearth-devices workspace
63 passed in 9.21s
```
(The `MqttCodeError: Unexpected disconnection` line in the full run is the SDK's existing
last-will subprocess test, not this adapter.)

Also added `[project.scripts] hearth-adapter-vacuum = "hearth_adapter_vacuum:main"`.

## End-to-end dry run — PASSED (2026-10-25)
Brought up Mosquitto (`scripts/bus.sh up`, after `bus-setup.sh fake vacuum` to add the
`adapter-vacuum` identity), the vacuum adapter (dry, `VACUUM_ARMED` unset), and a serving core;
then ran the hub against the bus:

```
DEVICES=mqtt DEVICES_BUS_USER=hub DEVICES_BUS_PASSWORD=… pnpm try "clean the house"
→ intent ollama+keyword (model_loading → keyword), tool clean_house, decision allowed, status ok
→ speech "Fine, fine. Calling in the cleaning crew."  (total 547 ms)
```

Evidence it travelled the whole chain and fired nothing:
- core: `command done … deviceId=vacuum capability=RvcRunMode via=voice ok=true` (policy allowed
  medium because the device was online + idle — "sleeping" on the dock).
- adapter: `dry-run (VACUUM_ARMED not set): would send START clean (siid=2 aiid=1); nothing sent`.
- A live read-only `hearth-devices list` beforehand showed the real vacuum `online=true`,
  `runMode=idle, operationalState=sleeping, battery=100` — a genuine cloud read over the relay.

Also cleared stale retained `fake-*` meta/state left by earlier fake-adapter runs, so the
registry showed only the real `vacuum`. Afterwards tore everything down (adapter, core, bus) —
back to services-stopped. The adapter log never contained the token.

## Next
- First **armed** run with the owner watching: same bring-up, adapter with `VACUUM_ARMED=1`,
  then one `clean the house` — the robot actually starts (medium risk; owner go-ahead required).
- Deploy the Alexa interaction-model change (progress/39) via ASK and test on the Echo.
- Owner: blank `DREAME_PASSWORD` out of `secrets/dreame.env` (not needed again).
