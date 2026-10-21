# 18 — Ollama installed, qwen2.5:3b evaluated (PLAN D1, gate G2 approved: one model)

Date: 2026-10-21. Your decisions: install Ollama with **one** model, the hub runs **on this laptop**, F2 goes **through the devices core**, other gates later.

## Hub environment recorded

`hearth-hub/CLAUDE.md` → Environment: this laptop, hubId `laptop`, i7-5500U (2C/4T), 15 GiB, Intel HD 5500 (CPU-only inference), Ubuntu 26.04.1.

## Ollama install: user-level, no sudo, no system service

The hub rules say to ask before installing system services, and the official install script creates one. So instead:

```text
gh api repos/ollama/ollama/releases/latest → v0.40.6, ollama-linux-amd64.tar.zst (1,438,364,593 B)
sha256 c164ab8b1b28e2a247c29719b8e404c423c5b83ae64c3ab4e59d50c7ff7fc5e0   matches sha256sum.txt
extracted to ~/.local/opt/ollama-0.40.6, skipping lib/ollama/cuda_v*  (no NVIDIA GPU) → 100 MB on disk
~/.local/bin/ollama → …/bin/ollama
OLLAMA_HOST=127.0.0.1:11434 setsid nohup ollama serve > ~/.ollama/serve.log   (pid in ~/.ollama/serve.pid)
$ curl 127.0.0.1:11434/api/version → {"version":"0.40.6"}      listening on 127.0.0.1 only
$ ollama pull qwen2.5:3b → verifying sha256 digest … success   (1.9 GB)
```

`ollama serve` runs as a plain user process. It won't survive a reboot until the service decision (G6/H2).

## Eval runs: every change measured before and after (spec rule)

| # | Change | Accuracy | Refused | p50 | p95 |
|---|---|---|---|---|---|
| — | keyword router (baseline) | 83.3 % | 20/20 | 0 ms | 1 ms |
| 1 | qwen2.5:3b, prompt v1 | 64.6 % | **8/20** | 2334 | 4000 (timeouts) |
| 2 | + `no_matching_tool`, `num_predict` 96→48, prompt v2 | 83.3 % | 20/20 | 3224 | 4006 |
| 3 | + streaming so a timeout really aborts | **91.7 %** (×2 runs) | 20/20 | 3242 / 3152 | 4006 / **4255** |
| 4 | + the timeout also covers prompt processing | 87.5 % | 20/20 | 3279 | 4001 |

What each finding was, and how I found it:

1. **Run 1 refused 8/20.** A small tool-calling model calls *some* tool for nearly everything: "unlock the front door" → `is_device_online(front door)`, "tell me a joke" → `last_result`. The pipeline kept all of these harmless (nothing unlock-like exists), but they weren't refusals. **Fix:** an explicit `no_matching_tool` (not a hub tool; calling it is a refusal), with the prompt pointing at it. Result: 20/20.
2. **Runs 1–2 had clusters of timeouts.** I measured `abort()` directly: **for a non-streamed request, ollama-js `abort()` does nothing.** The "aborted" call finished normally (`done_reason: stop`). A timed-out command therefore kept generating inside Ollama, and the next commands queued behind it. **Fix:** stream the response, so `abort()` really stops generation. Tested with a fake stream that counts aborts.
3. **Run 3 had p95 4255 ms against a 4000 ms timeout**, which should be impossible. The timer started only once `chat()` returned the stream, which happens *after* prompt processing. **Fix:** the budget covers the whole call, and a stream that arrives late is aborted immediately (tested).
4. **Where the time goes** (run 4, from the new per-call logs):

   ```text
   n=45  latency p50 3241 max 3965 | promptMs p50 596 max 760 (prefix cache hit) | genMs p50 2249 max 3495 | output tokens p50 17 max 37
   ```

   Generation is ~130 ms/token on 2 cores. In isolated runs it was ~90 ms/token (`num_thread` 2 vs 4: no difference: [1933, 2418, 1773] vs [1991, 2491, 1816] ms), so sustained load slows it down, probably thermal throttling. A tool call is ~17 tokens, so ~2.2 s is the floor for this model on this CPU, before any variance.

Remaining misses at 91.7 %: "is the hub alive" → refused; "how much storage is free on the laptop" → refused; "is the wifi working" → `router` (the gateway resolves both to the same device, but the eval is strict); "is the hub reachable on the network" → refused or timed out.

## Where M3 stands

- Accuracy ≥ 90 %: **met** in 2 of 3 runs with the final code (91.7, 91.7, 87.5).
- Every must-refuse refused: **met** (20/20 in every run since fix 1).
- p95 < 4 s: **not met.** p95 is at the 4 s budget, p50 is about 3.2 s.
- **A bigger problem than the M3 target:** the Lambda waits `REPLY_TIMEOUT_MS` = **3000 ms by default**. With a p50 of 3.2 s, *most* voice commands would get the "hub didn't answer" fallback. Using this model at all would need `replyTimeoutMs` raised towards the contract maximum of 5000, and `INTENT_TIMEOUT_MS` (new, default 4000, capped at 4800) set to match.

## Options (your decision)

1. **Pull qwen2.5:1.5b** (~1 GB) as well and eval it. Roughly 2× faster generation, so likely p95 ≈ 2 s. The open question is whether accuracy holds. You allowed one model, so this needs your OK.
2. **Keyword fast path + model fallback.** The keyword router answers its high-confidence matches instantly (it got 40 of 48 at 0 ms), and only the rest go to the model. Still at most one model call per command. But the spec says the model *replaces* the router, so this is a design change for you to approve.
3. **Keep qwen2.5:3b** with `replyTimeoutMs: 5000` and `INTENT_TIMEOUT_MS: 4500`. Simple, but slow to answer, and p95 stays at the edge.

My recommendation: **1 first.** If 1.5b holds ≥ 90 % with 20/20, it fixes latency without a design change. Option 2 is the fallback.

The hub's default stays `INTENT=keyword` until you choose.

```text
$ pnpm --filter @hearth/hub test → Tests 114 passed (114)
```
