# 21 — GPU soak test: stable GPU, but the laptop shut down from heat (PLAN D1)

Date: 2026-10-21. After the reboot that reset the GPU, I soak-tested qwen2.5:3b **alone** on the R9 M375: the 48-case eval ×10 (480 back-to-back requests).

## Before the run

```text
$ scripts/ollama.sh start      → listener pid = pidfile pid
ollama: msg="inference compute" library=Vulkan name=Vulkan1 description="AMD Radeon R9 M375 (RADV VERDE)"   (GPU back after the reboot)
$ ollama ps → qwen2.5:3b 2.1 GB 100% GPU Forever      (one model only)
warm-up 42005 ms (cold load from disk after the reboot)
```

## Readings during the run

These were taken live in the session. The run's log was in the session scratchpad under `/tmp`, which was cleared at shutdown, and the eval wrote results only at the end, so these readings are the only record.

| Time (IST) | Requests | Latency p50 / p95 / max | Generation | GPU temp | CPU temp | CPU clock | Notes |
|---|---|---|---|---|---|---|---|
| 10:55:06 | 85 | 2722 / 3527 / 3827 ms | — | — | — | — | 0 GPU errors |
| 11:01:10 | 171 | 2728 / 3619 ms | **8.8 tok/s** p50 (5.8–11.7); first 50: 9.5, last 50: 8.4 | **106 °C** | 92 °C | ~499 MHz on all 4 | load 10.8; IntelliJ at 131 % CPU |
| 11:05:23 | 249 | 2753 / 3558 ms | 8.8 tok/s (last 50) | **110 °C** | **98 °C** | ~498 MHz | 0 GPU errors |
| ~11:06 | — | — | — | — | — | — | **power off** |

Other measurements: prompt processing ~877 tok/s p50 (~522 prompt tokens, mostly served from Ollama's prefix cache, ~0.6 s), ~17 output tokens per tool call (~2.0 s). Limits from sysfs: amdgpu `temp1_crit` 120 °C (`crit_hyst` 90 °C); coretemp `max`/`crit` 105 °C; CPU `scaling_max_freq` 3000 MHz.

## The shutdown

```text
$ cat /sys/class/power_supply/{ACAD,BAT1}/…   → ACAD online=1, BAT1 Full 100 %           (not a power problem)
$ journalctl --list-boots
 -1 … Wed 2026-10-21 10:45:32 IST   Wed 2026-10-21 11:01:59 IST
  0 … Wed 2026-10-21 11:06:50 IST
$ journalctl -b -1 -n 8   → ends mid-run (perf interrupt messages), with no shutdown sequence
```

The previous boot's journal just stops: there's no orderly shutdown, and the last entries are from before my 11:05 reading because journald hadn't flushed. Together with the CPU at 98 °C and rising towards its 105 °C critical limit, and the GPU at 110 °C, **this is a hardware thermal trip.** The CPU and GPU share one cooler on this laptop. Sustained GPU inference heated the CPU too, and throttling all cores to ~500 MHz didn't stop the rise.

## What the soak did show

- **The GPU itself was stable:** 249 requests, zero Vulkan errors and no device loss. The earlier "device lost" happened with *two* pinned models.
- **Latency was steady despite the heat:** p50 ≈ 2.75 s and p95 ≈ 3.5–3.6 s throughout, inside the 4 s target, with generation easing from 9.5 to ~8.4 tok/s.
- **Sustained load isn't safe on this hardware:** it ended in a power cut after ~16 minutes of back-to-back inference.

The hub's real load is a handful of commands a day, each about 3 s of GPU work, so it's nowhere near this. But the hub must never be able to cook the machine: by repeated requests, a bug, or a stuck loop.

## Fixes made

- **The eval appends every row as it completes** to `hearth-hub/test/evals/results/<run>.partial.jsonl`, inside the repo (gitignored), not `/tmp`. An interrupted run now keeps its evidence. Verified: a 48-case keyword run wrote 48 lines.
- `scripts/ollama.sh start` waits for GPU discovery before reporting the compute device. (Made before the shutdown; committed now.)
- Root `CLAUDE.md` says the local device contract is v1. (Same.)

## Decision needed (see the summary given to the user)

Options: run qwen2.5:3b on the GPU behind a **thermal guard** in the hub; or use qwen2.5:1.5b on the CPU (cooler, 73–77 %); or stay on the keyword router. Separately: a cooling pad, and cleaning the vents and fans of this ~2015 laptop.
