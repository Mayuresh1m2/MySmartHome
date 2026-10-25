# 39 — "clean the house": Alexa + hub wiring

Goal: "Alexa, ask ramesh dude to clean the house" starts the robot vacuum. This entry covers
the Alexa-side and hub-side wiring; the hearth-devices vacuum adapter and the live run follow.

Decisions (owner, 2026-10-25): raise the hub's `voiceRiskCeiling` read→medium (medium stays
gated per-tool + online/idle; high never voice-reachable); prepare the Alexa interaction-model
change but deploy it last, after an end-to-end dry run.

## hearth-aws (prepared, NOT deployed)
Added `clean the house` and `clean my house` to the `COMMAND_TEXT` sample values in
`skill-package/interactionModels/custom/en-IN.json` (now 20, within the 15–20 guide). The
transport already forwards any utterance; these improve en-IN recognition. `pnpm test` → 45 pass.
ASK deploy held until the dry run (owner's choice).

## hearth-hub
- New tool `src/tools/cleanHouse.ts` (`clean_house`, **medium** risk, no args): finds the vacuum
  via the DeviceGateway (kind `robot-vacuum` or an `RvcRunMode` capability), executes
  `RvcRunMode{mode:cleaning}`, and returns the fixed in-character reply **"Fine, fine. Calling in
  the cleaning crew."** Honest fallback on offline/busy. Dedicated tool (not the generic
  `device_rvc_run_mode`) for a reliable small-model hit and the fixed reply.
- Routing: keyword router gains a clean/vacuum route; model gets the tool from the registry.
- `config/policy.yaml`: `voiceRiskCeiling: medium`; `clean_house` enabled, ratePerMinute 4.
- Tests: new `test/cleanHouse.test.ts`; updated the three tests that encoded the old
  "read-only by voice / all tools read-risk" invariant to the new one (voice reaches medium,
  nothing high). `pnpm test` → 135 pass.

### Eval (pnpm eval, qwen2.5:3b) — before/after, as required before a tool/prompt change
- BEFORE (stashed, 48 cases): **accuracy 0.938, refused 20/20**, p95 3837 ms.
- Adding `clean_house` alone regressed it: 0.87, refused 19/20 — the model refused basic "ping"
  phrases and mapped "free up some disk space" → clean_house. Deterministic (not variance).
- Tuning the tool description helped (0.907) but the "free up space" miss persisted.
- Adding one system-prompt line ("disk space / freeing space is never a vacuum task") →
  **accuracy 0.944, all 6 clean_house phrasings pass**, ping recovered. The remaining
  must-refuse "miss" is now a model **timeout** on "free up some disk space", not a wrong action.
- Why that's safe in production: the eval runs the raw model; the hub runs `GuardedIntent`, so a
  model timeout (or heat) falls back to the keyword router, which refuses "free up some disk
  space" (disk route excludes "free up"; no clean/vacuum match). Confirmed via `pnpm try`.

Note: repeated eval runs heated the laptop (CPU ~89 °C, warm-up 2.7→9.3 s); the thermal guard
correctly fell back to keyword. Stopped Ollama to cool down.

## Next
- hearth-devices: real vacuum adapter on the bus (`RvcRunMode` medium + `RvcOperationalState`
  read); `execute(cleaning)` sends the Dreamehome start proven in progress/38; `state` from the
  cloud read.
- Dry run: `DEVICES=mqtt`, bus + core + adapter up, `pnpm try "clean the house"` reaches the
  vacuum **without firing** (adapter no-fire mode), then the first real command with the owner
  watching.
- Then deploy the Alexa interaction model (ASK) and try it on the Echo.
