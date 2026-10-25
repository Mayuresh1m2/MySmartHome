# 41 — Reporting vacuum faults back to Alexa (e.g. "the water tank is dry")

Context: the live end-to-end run (progress/40 armed) worked — "Alexa, ask ramesh dude to clean
the house" started the robot — but the vacuum then aborted on **low water** and Alexa still said
the generic success line. The Dreame cloud *accepts* a start instantly (returns ok); the robot
only discovers a problem a few seconds later, after the spoken reply has gone. So the reason has
to come from reading the robot's state, not from the start command's result.

Owner's choice (2026-10-25): do **both** — a read-only status question and surface a standing
fault on the clean command.

## Finding (real device)
After the failed start the robot reported, over the Dreamehome cloud (read-only probe):
`state=paused(3), error=code 107, status=charging(6)`. **107 = `WATER_TANK_DRY`** in Tasshack's
`DreameVacuumErrorCode`. The fault is persistent in the standard MIoT error property (siid 2 / piid 2).

## hearth-devices (adapter)
- Added `ERROR_WORDS`: a subset of Dreame fault codes → short, speakable reasons (107 → "the
  water tank is dry", plus empty/full clean & dirty tanks, dustbin, brushes, fan, stuck, low
  battery, mop); any other non-zero code → "it reported a fault (code N)".
- `read_state` now exposes a `fault` field (friendly string or null) instead of a raw code, so a
  hub read can speak it.
- `execute(RvcRunMode cleaning)` does a pre-send error read: if the robot already sits on a fault,
  it refuses with that reason and **sends no start** (doesn't poke a robot that can't clean). A
  fault discovered only *after* starting surfaces via the status read below, not here.
- Tests: 9 pass (incl. the dry-tank standing-fault refusal and the code→reason map). ruff clean.

## hearth-hub
- New read-only tool `vacuum_status` ("what is the vacuum doing / why did it stop / is it stuck")
  → speaks the fault if any ("The vacuum isn't running — the water tank is dry."), else the
  current activity + battery. Routed by the keyword router *before* the clean route (both match
  "vacuum"); also offered to the model.
- `clean_house` now relays the device-side reason: "I can't start the vacuum — the water tank is dry."
- `policy.yaml`: `vacuum_status` enabled (read risk, rate 6/min).
- Tests: 147 pass; `pnpm typecheck` clean (also fixed a pre-existing FakeGateway index-type gap).

### Eval (pnpm eval, qwen2.5:3b) — before/after, same session/thermal
- BEFORE (without vacuum_status, 54 cases): accuracy **0.944**, refused 19/20, p50 2069, p95 3982 ms.
- AFTER (with vacuum_status, 59 cases): accuracy **0.949**, refused 19/20, p50 2061, p95 4018 ms.
- The 5 new `vacuum_status` phrasings all routed correctly; the two non-refusal misses
  ("how much storage is free on the laptop"→refuse, "is the hub reachable"→ping) appear in **both**
  runs — pre-existing 3B quirks, not caused by this change. No regression.
- Known, pre-existing fragility (unchanged by this work): "free up some disk space" is sometimes
  mapped to clean_house by the raw model (BEFORE it timed out; AFTER it mapped to clean_house).
  Production's keyword fallback refuses it, but the model path could misfire. Flagged for separate
  hardening (prompt tweak would need its own before/after eval). See [[progress/39]].

## Live proof (real robot, still dry-tank)
Brought the bus + core + armed adapter back up and ran the hub (`pnpm try`, DEVICES=mqtt):
```
"why did the vacuum stop" → vacuum_status → "The vacuum isn't running — the water tank is dry."
"clean the house"         → clean_house  → "I can't start the vacuum — the water tank is dry."
```
Adapter log for the clean: `command handled ok:false error:"the water tank is dry"` with **no
`ARMED: sending START`** line — the pre-check refused and nothing fired. Then tore the stack down
(adapter, core, bus) and stopped Ollama — back to services-stopped.

## Next / open
- Uncommitted (this + progress/38–40). Nothing committed yet this run.
- Voice use of `vacuum_status` needs the long-running hub on this new code in `mqtt` mode (the
  live run used `pnpm try`, which loads current code; the service hub would need a restart/persist).
- Optional: harden the "free up disk space" → clean_house model fragility.
- Owner: blank `DREAME_PASSWORD` out of `secrets/dreame.env`.
