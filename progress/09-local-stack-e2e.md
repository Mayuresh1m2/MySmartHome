# 09 — The whole system on one laptop (PLAN C3, C4)

Date: 2026-10-21

## Goal

Run "Alexa, ask home hearth to …" end to end on this machine, with no AWS account, using the **real** skill handler code and the **real** hub process. Prove it with an automated test and make every request traceable by `requestId`.

## Architecture (`local-stack/src/stack.ts`)

```
pnpm local:say "…"  →  POST 127.0.0.1:8886/say  →  real hearth-aws skill handler (CommandIntent envelope)
   │ publish (in-process, like the IoT Data Plane)                    ▲ GetItem ConsistentRead (real DynamoReplyStore)
   ▼                                                                  │
 aedes broker :8884 (mTLS + IoT policy ACLs) ─ hearth/laptop/replies ─▶ rule emulator ─▶ dynalite :8885 (hearth-replies-local)
   │ hearth/laptop/commands                         ▲                    (adds expiresAt = floor(now/1000)+300)
   ▼                                                │
 real hearth-hub process (certs/hub.key + locally signed hub-local.crt, MQTT 3.1.1)
```

- **dynalite 4.0.0** runs in memory. Its dependency `classic-level` (a native LevelDB addon) wanted a build script. I **denied** it (`allowBuilds: classic-level: false`) because in-memory mode never loads it, so nothing is natively compiled. It does real DynamoDB validation: my first probe used a 1-character table name and got AWS's own `ValidationException`.
- The skill package now exports `./core` and `./ports`, so local-stack reuses `createSkill` and `DynamoReplyStore` unchanged. Only the publisher is local.

## Commands added (repo root)

| Command | What it does |
|---|---|
| `pnpm local:up` | inits the local CA, signs `hearth-hub/certs/hub.csr` if needed, writes `.state/hub.local.env`, starts the stack and hub (each in its own process group), waits for `/status` and the hub's `/ready` |
| `pnpm local:say "<text>"` | prints the spoken answer, outcome, latency and requestId |
| `pnpm local:down` | stops both by **process group** from pid files (no `pkill -f`; see entry 06) |
| `pnpm local:logs` | tails `stack.log` and `hub.log` |
| `pnpm hearth:trace <requestId>` | merges skill, broker, rule, hub log and hub audit lines for one request, in time order |

## Live run

```text
$ pnpm local:up
Hearth local stack is up (hubId=laptop)
  broker   mqtts://localhost:8884   (IoT Core emulator, mTLS)
  dynamodb http://127.0.0.1:8885    (dynalite, table hearth-replies-local)
  control  http://127.0.0.1:8886    (pnpm local:say "...")
  hub      http://127.0.0.1:8787/health  /metrics

> ping                      🗣 Hub is online.                                           ok       169ms
> how much space is left    🗣 You have 146 gigabytes free out of 467, about 31 percent. ok       169ms
> is the router online      🗣 The router is online.                                    ok       157ms
> list my downloads folder  🗣 Your downloads folder has 99 items.                      ok       165ms
> what happened             🗣 Just now, list folder: Your downloads folder has 99 items. ok      159ms
> unlock the front door     🗣 Sorry, I can't do that.                                  refused  153ms

hub killed:  🗣 Your home hub didn't answer in time. It might be offline.   timeout  3004ms   (budget 3000)
hub back:    🗣 Hub is online.                                              ok        153ms
```

End-to-end latency (~155–170 ms) is dominated by the skill's 150 ms poll interval. The hub's own work is 6–8 ms.

## Observability findings (found through the trace)

1. **Nagle's algorithm cost ~40 ms per reply.** The trace showed a steady 37–43 ms gap between the hub finishing and the broker receiving the reply, the classic delayed-ACK signature. The relay now calls `setNoDelay(true)` on the MQTT socket on every connect:

   ```text
   hub done → broker got reply   before: 09.068→09.109  09.896→09.937  10.745→10.786  11.580→11.623  12.436→12.473   (37–43 ms)
                                 after:  18.768→18.771  19.798→19.801  20.763→20.765  21.702→21.704  22.510→22.511   (1–3 ms)
   ```

   The same delay would apply against IoT Core.
2. **The audit write delayed the reply.** The pipeline awaited the audit append before returning the reply, but the spec's flow is "…tool.run, reply, audit". The audit write is now fire-and-forget (writes are still serialised), and `AuditLog.flush()` was added for `pnpm try` and the tests.
3. **Trace mislabelled hub log lines** as `hub-audit` (both carry `decision`). The label now comes from `svc` first.

Trace of one request after the fixes:

```text
$ pnpm hearth:trace ebcf2982-f3d6-4232-8ec4-267117a70f34
{"t":"19:17:56.380","src":"local-iot","what":"publish","topic":"hearth/laptop/commands"}
{"t":"19:17:56.389","src":"hearth-hub","what":"command handled","outcome":"ok","latencyMs":8,"stages":{"intent":1,"policy":0,"tool":2,"total":8},"tool":"disk_space"}
{"t":"19:17:56.391","src":"hub-audit","what":"allowed","outcome":"ok","latencyMs":8,"tool":"disk_space"}
{"t":"19:17:56.429","src":"local-iot","what":"publish","topic":"hearth/laptop/replies"}      ← before the Nagle fix
{"t":"19:17:56.444","src":"local-rule","what":"reply_stored"}
{"t":"19:17:56.536","src":"local-skill","what":"command relayed","outcome":"ok","latencyMs":158}
```

## C4: automated end-to-end test (`local-stack/test/e2e.test.ts`)

An in-process stack plus a **spawned real hub process** (throwaway PKI, temp audit dir, temp `devices.json` with a live and a dead local TCP endpoint, reply budget 1.5 s):

```text
 ✓ ping
 ✓ how much space is left
 ✓ device checks against real TCP endpoints
 ✓ refuses what no tool does
 ✓ every reply on the wire satisfies the shared contract       (ajv against contracts/cloud-hub/v1/reply.schema.json)
 ✓ one requestId correlates skill log, broker, rule and hub audit
 ✓ hub off: honest fallback within the reply budget; hub back: answers again
      Tests  7 passed (7)      ×3 repeat runs: 7.8 s, 9.1 s, 8.0 s; no orphaned processes
```

Whole repo:

```text
contracts 27 · hearth-aws 14 · skill 23 · local-stack 14 · hearth-hub 87  = 165 tests passing; 5/5 packages typecheck
```
