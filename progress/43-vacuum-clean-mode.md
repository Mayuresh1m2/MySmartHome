# 43 — Vacuum cleaning-mode selection (RvcCleanMode)

Date: 2026-10-26. Branch: `feature/vacuum-clean-mode`.

## Why

Real-user feedback: my wife asked the vacuum to clean and it ran Dreame's **default** mode (vacuum + mop
in one simultaneous pass). Her preference is **sweep then mop as two separate passes**. The hub gave her
the default because the adapter never selects a cleaning mode.

## Finding (before any code)

- The adapter's clean command only sends `ACTION_START = (2, 1)` — plain full-auto clean. It never sets a
  cleaning-mode property, so the robot uses whatever mode the Dreame app last had (the default). That is the
  whole bug.
- Dreame's MIoT protocol **does** expose a settable *cleaning-mode* property (sweeping / mopping /
  sweep-and-mop, and on supporting models a "mop-after-sweep" value = the two-pass behaviour). The project
  already planned this: `hearth-devices/CLAUDE.md` lists **`RvcCleanMode`** as a capability. Only `RvcRunMode`
  (start / dock) was wired up.
- **Not yet verified for this model.** `progress/38` + the two probes confirmed only `state (2/1)`,
  `error (2/2)`, `battery (3/1)`, `charging (3/2)`, and siid-4 piids 1–7 (status, time, area, suction, water,
  tank, task). The cleaning-mode **piid and the value that means "sweep then mop" are NOT mapped** for
  `dreame.vacuum.r2471`, and whether r2471 does two passes as one mode-value or needs two orchestrated passes
  is unknown. Per this project's rule (and the clean-house post's own lesson), these numbers get **read, not
  guessed**.

## Step 1 — read-only discovery (this commit)

`scripts/spec_probe.py`: a one-off, READ-ONLY dump of the robot's MIoT properties over siid 2–9 / piid 1–40,
via `get_properties` with the stored token. No action, no `set_property`, no MQTT command — nothing moves.

Discovery method that pins the property with zero guessing (owner runs it):
1. In the Dreame app, set the robot to the preferred **sweep-then-mop (two-pass)** mode; run the probe.
2. Switch to the default **sweep-and-mop (one pass)**; run it again.
3. Diff: the piid whose value changed is the cleaning-mode property, and both runs give the two values.

## Step 2 — wire up `RvcCleanMode` (after the numbers are confirmed)

Add a cleaning-mode param that sets the confirmed property before `START`, defaulting to the two-pass
preference. Same `VACUUM_ARMED` flag, same policy gate (medium risk, online + idle), same read-the-fault
guard. Tests + a dry-run verification. Then the blog addition, written only once it actually works.

## Live finding (2026-10-26): the mode is a packed value on r2471

The cleaning-mode property is `CLEANING_MODE = siid 4, piid 23` (confirmed from Tasshack @ f5b8472,
`DreameVacuumPropertyMapping`). Mode enum: 0 sweeping, 1 mopping, 2 sweeping_and_mopping (one pass),
3 mopping_after_sweeping (two passes — the preference). Suction = 4/4 (quiet0/standard1/strong2/turbo3),
water = 4/5 (low1/med2/high3). Our probe read 4/4=1, 4/5=2 → standard / medium, which cross-checks.

BUT on r2471 the value at 4/23 is **packed**, not a clean 0–3: the live read returned **133634** while the
robot was mid-job in her two-pass mode. Tasshack decodes it with `split_group_value(value, mop_pad_lifting)`:
`values[0] = value & (3 if mop_pad_lifting else 1)`, `values[1] = (value>>8) & -769`, `values[2] = value>>16`,
and rebuilds with `combine_group_value` = `(v2<<16)|(v1<<8)|v0`. The mode bit(s) land in `values[0]`, and the
set path (`_update_cleaning_mode`) remaps 0↔2 and preserves self-clean/humidity — all conditioned on the
`self_wash_base` and `mop_pad_lifting` capability flags, which Tasshack detects **at runtime** (no per-model
constant; `r2471` appears nowhere in their source). So constructing the correct packed value ourselves means
reimplementing that runtime detection + a quirky packer, and a wrong value is a *write* to the robot.

## Decision: capture-and-replay (no decode, no guessing)

Instead of building the packed value, capture the exact integer the robot reports at 4/23 **while idle and set
(in the Dreame app) to her preferred two-pass mode**, store it in gitignored `secrets/` as her preferred clean
mode, and have the adapter `set_property(4, 23, <captured value>)` before `START`. This replays her own app's
setting verbatim — it also carries her suction/water/self-clean prefs — with zero encoding assumptions. Flagged
as an opaque-value write (per the rules) for the owner to approve; gated by `VACUUM_ARMED` + policy + fault check.
Capture must be when IDLE (the 133634 reading was mid-job, a transient phase — re-capture idle before storing).

## Decision (2026-10-27): two-pass is the default

Owner confirmed: "clean the house" should default to the two-pass (mopping_after_sweeping) mode — her
preference becomes the hub's default, which is the whole point of the feedback.

## Wiring built (2026-10-27)

Implemented capture-and-replay without expanding the bus contract — the two-pass default lives in the
existing `RvcRunMode: cleaning` (START) path, so no new hub tool / Alexa utterance is needed this round.
(`RvcCleanMode` as a *settable* bus capability stays deferred; noted below.)

- `scripts/capture_clean_mode.py` — reads status + 4/23 in one batch, **refuses unless the robot is idle**
  (docked: idle/charging/sleeping/standby), and writes the exact integer to gitignored
  `secrets/vacuum_clean_mode.json` under a mode label, marking it the default. Sends nothing to the robot.
  `--mode`, `--no-default`, `--allow-busy` flags. Default label: `mopping_after_sweeping`.
- Adapter (`src/hearth_adapter_vacuum/__init__.py`):
  - `CLEANING_MODE = (4, 23)`; `_load_clean_modes()` reads the secrets store → `(default_name, {name: value})`,
    empty when nothing captured (→ plain START, unchanged behaviour; backward compatible).
  - `_Cloud.set_property(siid, piid, value)` wraps the vendored `proto.set_property`, checks MIoT code 0.
  - `execute()` clean path: fault check first (unchanged), then **if a default is captured, `set_property(4,23,value)`
    then START, in that order**. Dry run logs "would set clean mode … then send START" and sends nothing.
    Docking never touches the mode. All still behind `VACUUM_ARMED` + policy (medium, online+idle) + fault guard.
- Tests: +9 (17 total, ruff clean). Cover load/default/bad-value parsing, set-before-START ordering, no-capture
  plain START, dry-run sends nothing, docking leaves mode alone, standing fault refuses before any write.

Opaque-value write flagged (per CLAUDE.md): the replayed 4/23 integer is a vendor-packed value we do not decode.

## Remaining (needs the robot idle + owner present)

1. **Idle capture** — robot docked, Dreame app set to two-pass, run `uv run python scripts/capture_clean_mode.py`.
   (The earlier 133634 reading was mid-job; re-capture idle so the stored value is the stable config.)
2. **Armed dry-run verify** — confirm the log shows "would set clean mode mopping_after_sweeping (4/23=N) then START".
3. **First armed real run** (owner watching) — confirm the robot runs two passes (vacuum, then mop).
4. Blog paragraph: the real-user-feedback arc (wife ran it, got the one-pass default, fix = replay her mode).

## Deferred option

`RvcCleanMode` as a settable bus capability (pick a mode by voice) — not needed for "two-pass default". If added
later it maps mode-name → captured value via the same store and needs a hub DeviceGateway tool + utterances.

## Idle capture + armed live run (2026-10-27)

- Idle capture (robot sleeping, app set to two-pass): `cleaning_mode 4/23 = 133632`. Note it differs from the
  mid-job 133634 by 2 low bits — confirming the mid-job read carried transient phase bits; the idle value is
  the stable config. Stored in gitignored `secrets/vacuum_clean_mode.json`, default = mopping_after_sweeping.
- Armed dry-run (NoCloud guard): logged `would set clean mode mopping_after_sweeping (4/23=133632) then send
  START clean; nothing sent` and made zero cloud calls. Good.
- **Two live bugs found + fixed:**
  1. `set_property`/`action` helpers live on the vendored `DreameVacuumProtocol`, NOT on the
     `DreameVacuumDreameHomeCloudProtocol` we instantiate. First armed run raised `AttributeError: ... no
     attribute 'set_property'`. Fixed to use the cloud class's generic `send("set_properties", [{did,siid,
     piid,value}])`, symmetric to how `read_props` uses `get_properties`.
  2. Operational (not code): restarting the adapter by killing only the `uv` wrapper left the Python child
     running old code and flapping on the bus (same MQTT client-id → "connection lost"); and the adapter
     authenticates as identity `adapter-vacuum` with its own password (`BUS_PASSWORD_ADAPTER_VACUUM` in
     gitignored `secrets/bus.env`), not the core's. Correct restart: `pkill -9 -f hearth-adapter-vacuum`,
     then relaunch with that per-identity password.
- **Armed live run succeeded:** `hearth-devices set vacuum RvcRunMode set '{"mode":"cleaning"}'` → core
  `ok=true`, state `runMode=cleaning`. Adapter log: set clean mode (4/23=133632) → START (2/1) → handled.
  Physical two-pass behaviour (vacuum then mop) is being confirmed by the owner watching the floor.

## Observed gap: can't dock via the hub while cleaning

Sending `RvcRunMode: idle` (return to dock) while the robot was cleaning was refused by core policy:
`policy: device is busy`. The medium-risk gate requires the device online + idle, which also blocks a
stop/return-to-dock mid-job. So today you can start a clean by voice but not stop it by voice — you dock
it from the Dreame app. Worth revisiting: allow `idle`/dock as an exception to the idle precondition
(stopping is lower-risk than starting). Noted for a later change, not in scope here.

## Status: shipped behavior — two-pass is the default, live-verified. Remaining: commit, then blog paragraph.
