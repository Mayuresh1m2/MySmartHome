# 29 — Privacy audit, git history rewrite, and per-person settings in `.env`

Date: 2026-10-21. You asked whether anything in the code leaks your details, and to move per-person values into a `.env` so anyone can plug in their own.

## Audit (tracked files + git history)

| Found | Where | Done |
|---|---|---|
| Your Gmail as **author/committer** of all 31 commits | commit metadata | **History rewritten** to `4339598+Mayuresh1m2@users.noreply.github.com` (looked up with `gh api user`, read-only); also set as this repo's `user.email` for future commits |
| Your name + Gmail in `pyproject.toml` (added by `uv init`) | 22 commits' file contents | removed from every commit (`filter-branch --tree-filter`) |
| Linux username, `/home/<you>` paths, hostname | journal files in history | replaced with `$USER`, `~`, `<hostname>` in every commit |
| Router LAN address | `hearth-hub/config/devices.json` | file is now gitignored; committed `devices.example.json` uses `192.0.2.1` (a documentation-only address) |
| AWS account ID, IoT endpoint, skill ID | **never committed** (only in the gitignored `config/local.json`) | moved to `.env` |

Verification after the rewrite: Gmail in **0** files of any commit and **0** in metadata/messages; content identical to the backup except the removed `authors` block and the scrubbed journal lines; 297 tests passing. Nothing had been pushed (no remote). The old history is kept locally on `backup/pre-email-rewrite`. **Never push that branch**; delete it once you're satisfied (`git branch -D backup/pre-email-rewrite`).

## `.env` for every per-person value

- `.env.example` (committed) → `.env` (gitignored, mode 600) at the repo root: `HEARTH_ALERT_EMAIL`, `AWS_PROFILE`, `HEARTH_AWS_REGION`, `HEARTH_IOT_ENDPOINT`, `HEARTH_SKILL_ID`, `HEARTH_LOCALE`, `HEARTH_REPLY_TIMEOUT_MS`, `HEARTH_KILL_SWITCH_USD`, `HEARTH_ACCOUNT_KILL_SWITCH_USD`, `HEARTH_DEBUG_UTTERANCES`, `HEARTH_HUB_ID`, `HEARTH_OLLAMA_MODEL` (+ optional `HEARTH_CSR_PATH`, `HEARTH_CERTIFICATES`).
- `hearth-aws/lib/config.ts` reads the `.env` with `node:util` `parseEnv` (nothing executed); real environment variables win. Same validation as before, plus: a valid region code, the **IoT endpoint must belong to the configured region**, and errors name the variable (`HEARTH_SKILL_ID: not set`). `config/local.json` and `config/example.json` are gone; tests use `test/fixtures/test.env` (placeholders).
- `scripts/env.sh`: one shell loader for all scripts (only `KEY=value` lines, environment wins) plus `hearth_set_env`. `handoff.sh`, `kill-switch.sh` (`set` now edits `.env`), `services.sh` (model) and local-stack `prepare.sh` (hub id, region) use it.
- **`scripts/configure.sh`**: creates `.env` from the template if missing, fills `HEARTH_IOT_ENDPOINT` from your signed-in profile, validates, and lists what's missing. Read-only towards AWS.
- **The region is now per deployment** (you chose this): both CLAUDE.md contract sections say *"one AWS Region per deployment, set once in the repo-root `.env` as `HEARTH_AWS_REGION` (this deployment: `ap-southeast-2`) … the handoff's `hub.env` carries it to the hub"*. `contracts/cloud-hub/v1/constants.json` has `regionEnv` instead of a fixed region, and the drift test checks the new wording. The message format is unchanged, so `v` stays 1.
- Docs: README step 2 is now "configure your details", root and hearth-aws CLAUDE.md say per-person values live only in `.env`, the runbook covers `HEARTH_DEBUG_UTTERANCES` / `HEARTH_CERTIFICATES`, `make-csr.sh`'s message is updated, and `doctor.sh` checks for `.env`.

## Evidence

```text
$ AWS_PROFILE=hearth scripts/configure.sh
AWS profile hearth: account <account-id>, region ap-southeast-2
checking settings…
Invalid settings in <repo>/.env:
  HEARTH_SKILL_ID: not set                 ← expected until the skill exists
$ pnpm test → contracts 34 · skill 23 · hearth-aws 45 · local-stack 21 · devices-sdk/ts 12 · hearth-hub 131 (+5) · hearth-devices 55
$ git grep (staged) for the Gmail, account ID, endpoint, home paths → none
$ scripts/services.sh restart; pnpm local:say "is the router online" → 🗣 The router is online.  ok 2462 ms
```
