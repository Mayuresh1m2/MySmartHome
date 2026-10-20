# 02 — Contracts as code and the doctor script (PLAN A3, A4)

Date: 2026-10-21

## Goal

- One source of truth for both wire contracts, so hearth-aws, hearth-hub and hearth-devices all test against the same fixtures.
- A read-only `doctor` that shows what's installed, configured and running, as the first observability tool.

## A3: `contracts/` (`@hearth/contracts`)

```text
contracts/
  cloud-hub/v1/command.schema.json   {"v":1,requestId(uuid),text(1..500),sentAt(int)}  additionalProperties:false
  cloud-hub/v1/reply.schema.json     {"v":1,requestId(uuid),speech(1..400),status ok|refused|error}
  cloud-hub/v1/constants.json        region, hubId pattern, topics, QoS, timeouts, TTL
  cloud-hub/v1/fixtures/{valid,invalid}/   5 valid, 10 invalid (wrong v, bad uuid, empty text,
                                           missing sentAt, extra "exec" field, string sentAt, not JSON, ...)
  local-devices/v0/{meta,state,set,result}.schema.json
  local-devices/v0/fixtures/{valid,invalid}/  5 valid, 5 invalid
  src/index.ts                       loads schemas/constants; fixtures(contract, validity)
  test/contracts.test.ts             ajv 2020 + formats; every fixture checked; spec-drift tests
```

Design choices:

- **The cloud↔hub contract is closed** (`additionalProperties: false`). An unexpected field means a version mismatch, and the contract says to bump `v` for any change. Device `state` stays open, because it carries capability values by design.
- `text` max 500 and `speech` max 400 are bounds I added. The spec gives none. Speech is "one or two sentences" and Alexa caps output, so this is defensive.
- **Spec-drift tests:** (1) the "Contract with …" sections of `hearth-aws/CLAUDE.md` and `hearth-hub/CLAUDE.md` must match byte for byte; (2) `constants.json` must agree with the spec text (region, default hubId, timeouts, staleness, QoS, `v`).

Toolchain picked up: TypeScript 7.0.2, vitest 5.0.5, ajv 8.20, `@types/node` pinned to 22 to match the runtime. A shared `tsconfig.base.json` (strict, NodeNext, `noUncheckedIndexedAccess`) is at the root.

Evidence:

```text
$ pnpm --filter @hearth/contracts test
 Test Files  1 passed (1)
      Tests  27 passed (27)
$ pnpm --filter @hearth/contracts typecheck
$ tsc --noEmit            (clean)
```

Mutation check, to prove the drift test can fail: I changed "never above 5000" to 6000 in hearth-hub/CLAUDE.md only:

```text
     × hearth-aws and hearth-hub contract sections are identical
      Tests  1 failed | 26 passed (27)
$ git checkout hearth-hub/CLAUDE.md    # restored
```

## A4: `scripts/doctor.sh` (`pnpm hearth:doctor`)

It checks the toolchain, gated tools (docker access, mosquitto, ollama, aws, ask), whether the Ollama API is up and which models are loaded, and that hub identity files *exist* (it also checks the `hub.key` mode is 600, using `stat` without reading the file). It also checks hub/aws config presence, the hub `/health` on 127.0.0.1:8787 and the local-stack state. It exits non-zero only on hard failures.

Issue hit: **pnpm 12 has a built-in `pnpm doctor`**, which shadowed the script name. I renamed the script to `hearth:doctor`. I also fixed a sed edit that dropped the `mktemp` line.

```text
$ pnpm hearth:doctor
Toolchain        ✔ node v22.23.1  ✔ pnpm 12.14.0  ✔ uv 0.10.11  ✔ OpenSSL 3.5.5
Optional / gated ! docker not usable (G1)  ! mosquitto (G1)  ! ollama (G2)  ! aws (G3)  ! ask (G4)
...
Summary: 4 ok, 15 warnings, 0 failures
```
