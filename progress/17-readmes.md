# 17 — Self-deployment README (PLAN H3 = aws M5) and repo README

Date: 2026-10-21

## Goal

aws M5: *a README that lets someone else deploy this into their own Amazon and AWS accounts from scratch, including the handoff to hearth-hub.*

## `hearth-aws/README.md`

Covers:

- what it is and the request path;
- cost (with the $5 budget);
- prerequisites;
- **eight ordered steps:**
  1. hub key and CSR on the hub machine;
  2. `config/local.json`, with the ATS endpoint lookup;
  3. `cdk bootstrap`;
  4. **create the skill first** (its ID is needed for the Lambda permission) and upload the interaction model;
  5. test → synth → diff → deploy, plus the SNS confirmation and an optional `iot-data publish` check of the replies path;
  6. set the endpoint from the stack output in a gitignored `.ask/skill.json` copy, so no ARN is committed, and enable development testing;
  7. `scripts/handoff.sh` and hub configuration;
  8. simulate "ask home hearth to ping" with the hub off and on.
- other locales;
- the local no-AWS stack;
- teardown (the table is retained on purpose).

**Honesty note:** ASK CLI isn't installed here, so the `ask smapi …` commands were written from knowledge of ASK CLI v2, not run. The README says so and points to `ask --help`. They get confirmed, and the README corrected, during aws M3 (gate G4). The AWS CLI commands use standard, stable subcommands, but are likewise unrun until G3.

## Root `README.md`

A map of the projects and the local quick start (`make-csr` → `local:up` → `local:say` → `hearth:trace` → `local:down`, then `pnpm test` and `pnpm hearth:doctor`).

## Acceptance status

aws M5 is done once someone follows the README. That first happens during G3/G4, with corrections recorded there.
