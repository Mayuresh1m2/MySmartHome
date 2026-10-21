# 22 — qwen2.5:3b on the GPU behind a thermal guard (PLAN D1 decided, hub M3)

Date: 2026-10-21. Your decision: "3b on GPU + thermal guard".

## Why a guard

Entry 21: the GPU itself was stable, but 16 minutes of back-to-back inference drove it to 110 °C and the CPU to 98 °C, and the laptop cut power. The CPU and GPU share one cooler. The hub's normal load is a few commands a day, but it must never be able to overheat the machine, whether through a flood of requests, a loop, or a bug.

## What was built

- `src/obs/thermal.ts`: `readTemps()` reads hwmon `amdgpu` and `coretemp` `temp1_input` with **no root**. `ThermalGuard`: GPU ≥ `THERMAL_GPU_MAX_C` (95) or CPU ≥ `THERMAL_CPU_MAX_C` (90) → hot, with **5 °C hysteresis** so it doesn't flap; `MODEL_CALLS_PER_MINUTE` (12) as a rolling limit; readings cached for 2 s; no sensors (another machine) → no thermal block.
- `src/intent/guardedIntent.ts`: uses the model only when the guard allows. Otherwise the **keyword router** answers (83.3 %, 20/20 refusals, ~0 ms), so a command never goes unanswered and there's still at most one model call per command. Fallback reasons: `model_loading`, `gpu_hot`, `cpu_hot`, `rate`, `model_error` (timeout or failure).
- Observability: `/health.thermal {state, gpuC, cpuC}`, `hearth_hub_temperature_celsius{device}` sampled every 15 s, `hearth_hub_intent_fallback_total{reason}`, and a warn log for every skip (with temps).
- Timeouts: `INTENT_TIMEOUT_MS` 4300 in `hub.example.env` (`INTENT=ollama`, `OLLAMA_MODEL=qwen2.5:3b`); hearth-aws `config/example.json` `replyTimeoutMs` 5000 (contract maximum), with the README updated and the two hearth-aws tests that pinned 3000 moved to 5000. `local:up` uses 5000 automatically when `INTENT=ollama` and passes `INTENT_TIMEOUT_MS` through.
- `pnpm eval` measures the **raw model** (not the guarded wrapper), so its numbers stay comparable.

## Findings during the live checks

1. **The GPU sensor reads `EBUSY` while the dGPU is runtime-suspended** (`/sys/class/drm/card0/device/power/runtime_status` = `suspended`). That reads as `null`, meaning "not hot", which is correct, since a suspended GPU isn't generating heat, and the read doesn't wake it. Under load it reads normally (55–64 °C for a short request).
2. **Commands sent while the model was loading timed out and held up the next one.** First live run: warm-up took 12.4 s; a command arriving during it queued and timed out (4.4 s, then fell back). The *next* command, arriving just after warm-up finished, *also* timed out, most likely because Ollama doesn't stop prompt processing at once when a request is aborted. **Fix:** the guard sends nothing to the model until warm-up completes (`model_loading`), and then those commands are answered instantly.
3. With the model pinned (`keep_alive -1`), the GPU stays awake (~55–75 °C at light use). A cold load takes 10–42 s, longer than Alexa's ~8 s window, so pinned is the right trade-off.

## Evidence

```text
$ pnpm --filter @hearth/hub test → Tests 130 passed (130)       (12 new: sensors, thresholds, hysteresis, rate, cache, all fallbacks)
$ pnpm --filter @hearth/aws test → Tests 33 passed (33)

# live: INTENT=ollama OLLAMA_MODEL=qwen2.5:3b pnpm local:up   (model cold, ollama stop beforehand)
Hearth local stack is up (hubId=laptop, intent=ollama qwen2.5:3b, reply timeout 5000 ms)
> (during warm-up) how much space is left   outcome=ok       latency=160ms    ← keyword fallback, model_loading
model loaded after ~11s                     ("model warmed up", warmUpMs 10478)
> is the hub alive                          outcome=refused  latency=4014ms   ← the model's own answer (known 3b miss)
> anything new in my downloads              outcome=ok       latency=2461ms   ← the model
hearth_hub_intent_fallback_total{reason="model_loading"} 1

# earlier run, after warm-up: model latencies 2718, 2026, 1945 ms
{"status":"ok","modelLoaded":true,"thermal":{"state":"ok","gpuC":73,"cpuC":72}}
hearth_hub_temperature_celsius{device="gpu"} 73 · {device="cpu"} 72

# forced hot: THERMAL_GPU_MAX_C=40
> how much space is left          outcome=ok       latency=170ms
> anything new in my downloads    outcome=refused  latency=161ms    ← keyword router (expected miss); model never called
{"modelLoaded":true,"thermal":{"state":"gpu_hot",…}}
hearth_hub_intent_fallback_total{reason="gpu_hot"} 2
```

## M3 status

| Target | Result |
|---|---|
| eval accuracy ≥ 90 % | ✔ 93.8 % (qwen2.5:3b, GPU) |
| every must-refuse refused | ✔ 20/20 |
| p95 < 4 s once loaded | ✔ 3.5–3.6 s across 249 soak requests (entry 21) |

hub M3 is **done**, with the conditions above: the reply timeout must be 5000 at the Lambda, and the guard is part of the design. The `hearth-hub/CLAUDE.md` Environment section records the choice.

## Suggested (hardware, yours)

A cooling pad, and cleaning the vents and fans. The laptop hit thermal limits under sustained load, which affects everything it runs, not only Hearth.
