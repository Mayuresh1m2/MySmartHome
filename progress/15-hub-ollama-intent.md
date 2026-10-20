# 15 — Hub intent module on Ollama, code with a mocked model (PLAN D2, hub M3 part 1)

Date: 2026-10-21

## Goal

Replace the keyword router with one Ollama tool-calling call per command, with warm-up at startup, the model kept loaded, and latency logged. Ollama isn't installed (gate G2), so everything is built against an injected `ChatClient` and unit-tested. Running it against a real model waits for G2.

## Checked against the installed library

ollama-js 0.6.4's `dist/browser.d.ts`: `chat({model, messages, tools, stream, keep_alive, think, options})` → `message.tool_calls[].function.{name, arguments}` plus `prompt_eval_count`, `eval_count` and `load_duration` (ns), and `ps()` → resident models. The real `Ollama` class satisfies my `ChatClient` interface (the typecheck proves it).

## Design (`src/intent/ollamaIntent.ts`, `src/intent/prompt.ts`)

- **Exactly one call per command**, so no tool output ever goes back to the model (spec). The system prompt is separate, and the user text goes only in the user message.
- **Only policy-enabled tools are offered.** Their parameters come from `z.toJSONSchema(tool.args)`, with `$schema` stripped.
- Deterministic and small: `temperature 0`, `num_ctx 2048`, `num_predict 96`, `think: false`.
- **Kept loaded:** `keep_alive: -1` on every call. At startup `warmUp()` runs without blocking (the relay connects regardless). Every 60 s `ps()` re-checks residency and reloads if needed. `/health.modelLoaded` and the `hearth_hub_model_loaded` metric follow it.
- **Timeout of 4 s** (abort + error). The pipeline turns it into an honest error reply well inside Alexa's budget.
- **Untrusted output:**
  - no tool call → a *fixed* refusal: the model's free text is **never spoken**, since a prompt injection could shape it and it would leave the house through Amazon;
  - several tool calls → first one, logged;
  - the name and args then go through the pipeline's tool-exists, zod-args and policy checks as before.
- Each decision logs model, latency, tool calls, prompt and output token counts, and load time.
- `INTENT=ollama` plus `OLLAMA_MODEL` in `config/hub.env` switches it on. The default stays `keyword`.

## Evidence

```text
$ pnpm --filter @hearth/hub test
      Tests  107 passed (107)     (9 new in test/ollamaIntent.test.ts)
$ pnpm --filter @hearth/hub typecheck   (clean)
```

The tests cover:

- mapping the first tool call;
- a text-only reply ("Sure! Your password is hunter2.") becoming the fixed refusal;
- the exact request shape: one call, system + user message, only enabled tools, `keep_alive -1`, `think false`, `temperature 0`;
- every tool's parameters being an object schema without `$schema`;
- the timeout;
- warm-up and `ps()` driving `modelLoaded`;
- through the real pipeline: an invented `run_shell` → `refused:unknown_tool`; a real tool not in policy → `refused:not_in_policy`; `../../etc` → `refused:bad_args`; a non-allowed folder → `refused:arg_constraint`.

## Waiting on G2

Install Ollama, pull candidates of 10 GB or less (see PLAN §1; all are 1–2 GB), then run `pnpm eval` (D3) against each, pick one, and record it in hearth-hub/CLAUDE.md's Environment section.
