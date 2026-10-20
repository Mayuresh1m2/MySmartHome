# 07 — Tools, policy, audit and the keyword router (PLAN B5, hub M2 locally)

Date: 2026-10-21

## Goal

The full hub flow without a model: receive → validate → staleness/duplicates → **intent → policy → tool.run → reply → audit**, with per-stage timings. The M2 "Alexa end to end" acceptance waits for the cloud (Phase G). The local equivalent comes in C4.

## What was built

| Module | Notes |
|---|---|
| `src/tools/*.ts` | `ping` (extra: answers "ask home hearth to ping" in aws M3), `disk_space` (`fs.statfs`), `list_folder`, `is_device_online`, `last_result`. Each declares a name, description, zod args, a risk and `run()`. All are `read` risk. The filesystem is injected (`ToolFs`) so tests never touch the disk. |
| `src/devices/` | `DeviceGateway` interface (`list`, `find`, `isOnline`) + `JsonDeviceGateway` (TCP connect probe, 1.5 s, injectable). The M5 seam is already in place. |
| `src/policy/policy.ts` | **Deny by default.** Strict zod schema for `policy.yaml` (a typo like `enable:` fails loudly). Per-tool `enabled`, `ratePerMinute`, arg constraints (`enum`, `maxLength`, `pattern`), `settings`; a global rate limit; `voiceRiskCeiling` limited to read/low/medium by the schema, and `high` refused in code regardless. |
| `src/audit/audit.ts` | Append-only JSONL `data/audit/YYYY-MM-DD.jsonl` (UTC day), dir 0700 and file 0600, with writes serialised so lines never interleave. `AUDIT_TEXT=false` stores only `textLength`. Dropped commands are audited as `dropped:<reason>`. |
| `src/intent/keywordRouter.ts` | Temporary router. Narrow on purpose, with destructive verbs ("delete", "free up", "remove") excluded. |
| `src/pipeline.ts` | Model output is treated as untrusted: unknown tool → `refused:unknown_tool`; args fail the tool's zod schema → `refused:bad_args`; then policy. Tool exceptions become a generic error reply (the message isn't spoken). Stage timings `intent/policy/tool/total` go to the log line, the audit line and the `hearth_hub_stage_duration_ms` histogram. |
| `src/app.ts`, `src/cli/try.ts` | Shared builder; `pnpm try "<text>"` runs without MQTT. |
| `config/policy.yaml`, `config/devices.json` | Voice ceiling `read`. Folders limited to `downloads` and `documents`. Devices: router (192.0.2.1:80) and the hub itself (127.0.0.1:8787). |

## Decision: file names are not spoken by default

The first `pnpm try "what's in my documents"` spoke real (personal) file names from ~/Documents. Replies leave the house through Amazon, and the spec says tools must never speak *"anything I wouldn't say on a phone call"*. So `list_folder` now speaks **only the count** unless `policy.yaml` sets `settings.maxItems > 0`. The opt-in path is tested. (The original output isn't reproduced here, for the same reason.)

## Evidence

`pnpm try` on this machine:

```text
how much space is left    disk_space        allowed                ok       "You have 147 gigabytes free out of 467, about 31 percent."  5 ms
list my downloads folder  list_folder       allowed                ok       "Your downloads folder has 99 items."
what's in my documents    list_folder       allowed                ok       "Your documents folder has 9 items."
show me the etc folder    list_folder       refused:arg_constraint refused  "Sorry, I'm not allowed to do that."
is the router online      is_device_online  allowed                ok       "The router is online."                                    18 ms
is the tv online          is_device_online  allowed                ok       "I don't know a device called tv."
what happened             last_result       allowed                ok       "I haven't handled any commands since I started."
ping                      ping              allowed                ok       "Hub is online."
delete all my files       -                 refused:intent         refused  "Sorry, I can't do that."
unlock the front door     -                 refused:intent         refused  "Sorry, I can't do that."
```

Audit line example (`data/audit/2026-10-20.jsonl`, mode 600):

```json
{"requestId":"4869155f-…","tool":null,"args":null,"decision":"refused:intent","outcome":"refused","latencyMs":7,"stages":{"intent":1,"total":7},"ts":"2026-10-20T19:06:30.542Z","text":"unlock the front door"}
```

Tests:

```text
$ pnpm --filter @hearth/hub test
 Test Files  12 passed
      Tests  87 passed (87)
```

New coverage: tool registry invariants (unique names, every schema exports to an object JSON Schema for M3, all read risk); each tool on a mocked fs or probe (path-like folder args rejected at the schema, unknown folders refused without touching the fs, IPs never spoken); policy (deny by default, disabled, risk ceiling, high always refused, arg constraints, per-tool and global rate limits, strict keys, the shipped policy.yaml); keyword router (13 phrasings, including 5 must-refuse); pipeline (allowed, intent refusal, invented tool, bad args, not in policy, risk, a tool exception not leaking its message, `AUDIT_TEXT=false`, 20 concurrent audit writes not interleaving).
