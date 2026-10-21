# 20 — There's a GPU; GPU vs CPU and 3b vs 1.5b (PLAN D1, continued)

Date: 2026-10-21. Your decision: "Also try qwen2.5:1.5b".

## Correction: the machine has a discrete GPU

The first eval of qwen2.5:1.5b crashed. Ollama's log showed:

```text
radv/amdgpu: Failed to query the last GPUVM fault (-22).
ggml_vulkan: device lost on Vulkan0
srv  update_slots: decode() failed: vk::Queue::submit: ErrorDeviceLost
$ ollama ps   → qwen2.5:1.5b 100% GPU Forever · qwen2.5:3b 100% GPU Forever      (RAM available: 1.7 GiB)
```

So Ollama had been running on a **GPU all along**:

```text
$ lspci -nn | grep -i display
04:00.0 Display controller [0380]: AMD/ATI Venus XTX [Radeon HD 8890M / R9 M275X/M375X] [1002:6820]
ollama: msg="inference compute" library=Vulkan name=Vulkan1 description="AMD Radeon R9 M375 (RADV VERDE)" type=discrete total="4.0 GiB"
        msg="dropping integrated GPU; to enable, set OLLAMA_IGPU_ENABLE=1" … "Intel(R) HD Graphics 5500"
```

My first survey grepped `lspci` for `vga|3d|nvidia`, which misses a GPU listed as "Display controller". **Every "CPU-only" statement before this entry was wrong.** I've corrected PLAN.md §1, the Environment section of hearth-hub/CLAUDE.md, and progress 00 and 18 (marked as corrections). `doctor.sh` now matches "display", reports Ollama's compute device, and fails loudly if the log shows a lost GPU.

The crash came from having **both models pinned** (`keep_alive -1`, 2.1 + 1.1 GB on a 4 GiB GCN 1.0 card). After it, the GPU stayed wedged: the next warm-up hung for 180 s, and a fresh `ollama serve` now finds only the CPU. **A reboot should reset the GPU.**

## Process mistake: "restarts" that didn't restart

I restarted Ollama twice with `kill $(cat serve.pid)`, but the original server (pid 1157449) kept running. The new servers failed to bind the port and exited, so evals kept hitting the wedged original. `ss -ltnp` showed the real listener. Fix: `scripts/ollama.sh start|stop|status` keeps the server's own PID, stops the listener and checks it, and refuses to report success if the PID file and the listener disagree.

## Eval scoring made fairer (applies to every model)

"is the wifi working" → `is_device_online(router)` was counted wrong, but `wifi` is an alias of the router in `devices.json`, so the hub's answer is identical. `device` arguments now match when both resolve to the same device through the gateway. Everything else stays strict.

## Results (48 cases, temperature 0, prompt and tools unchanged)

| Model | Device | Accuracy | Refused | p50 | p95 | Notes |
|---|---|---|---|---|---|---|
| keyword router | — | 83.3 % | 20/20 | 0 ms | 1 ms | baseline |
| qwen2.5:3b | **R9 M375 (Vulkan)** | **93.8 %** | **20/20** | 2327 ms | 3912 ms | fair scoring; earlier runs 91.7 % |
| qwen2.5:1.5b | R9 M375 (Vulkan) | 77.1 % | 18/20 | 1122 ms | 1397 ms | identical in 2 runs, strict scoring; then the GPU was lost (both models pinned) |
| qwen2.5:1.5b | CPU (`OLLAMA_NUM_GPU=0`) | 72.9 % | 18/20 | 2089 ms | 2821 ms | warm-up 26 s |
| qwen2.5:3b | CPU | 2.1 % | 0/20 | 4008 ms | 4019 ms | **every case timed out**; warm-up 51 s |

What 1.5b gets wrong: it refuses a bare "ping" and "are you there"; it uses `ping` for device reachability; it misses "say that again" / "what happened"; and it sends "format the disk" and "free up some disk space" to `disk_space`. These are tool-description problems that a round of tuning might fix (with before/after evals, per the spec). The two refusal misses are harmless (read-only), but they still fail the "every must-refuse refused" target.

New: `OLLAMA_NUM_GPU` (hub config → Ollama `num_gpu`; 0 = CPU only).

## What this means

- **qwen2.5:3b on the GPU is the only setup that meets accuracy and refusals.** Its p95 (3.9 s) is just inside the 4 s target, but it **needs `replyTimeoutMs` raised to 5000**: with the Lambda's default 3000, many commands would fall back.
- **The GPU's stability is now the main risk** for a 24/7 hub: a 2013-era GCN 1.0 card on RADV Vulkan lost its device once. That happened under two pinned models, a configuration the hub never uses (it loads one model). It still has to be soak-tested before relying on it.
- **CPU-only is viable only with 1.5b**, at ~73 % unless tuned.

## Recommendation, and what's needed from you

1. **Reboot the machine** (resets the GPU), then `scripts/ollama.sh start`, and confirm `compute: library=Vulkan … R9 M375`.
2. **Soak test:** qwen2.5:3b alone on the GPU, ~500 eval requests (`pnpm eval --repeat 10`). It passes if there's no device loss and latency holds.
3. If it passes: choose **qwen2.5:3b on GPU**, with `replyTimeoutMs: 5000` and `INTENT_TIMEOUT_MS: 4500`. If it fails: tune 1.5b's tool descriptions (with evals), or fall back to the keyword fast path plus model.

Current state: Ollama is running on CPU (the GPU is gone until reboot), and no model is loaded. The hub's default stays `INTENT=keyword`.

```text
$ pnpm --filter @hearth/hub test → Tests 119 passed (119)
```
