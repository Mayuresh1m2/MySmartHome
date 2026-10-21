# 36: preparing the repo to be public

Owner's request: mask the account ID, make the device list generic, and check nothing that shouldn't be is committed.

## Changes

- `progress/29`: the partly masked account ID (`<4 digits>…<4 digits>`) is now `<account-id>`.
- `hearth-devices/CLAUDE.md` and `docs/device-leads.md` name device types only (smart TV, robot vacuum, dishwasher,
  refrigerator, Echo and Echo Show, doorbell, car). The owner's brands, models and brand-specific leads moved to
  `hearth-devices/docs/private/` (`my-devices.md`, `device-leads.md`), now gitignored. Per-device findings go to
  `docs/private/devices/<device>.md`, because they name the actual model.

## Audit of every commit on hearth-setup (43 commits; the backup branch is excluded and must never be pushed)

```text
files ever committed with sensitive names: .env.example (template), hearth-aws/test/fixtures/example.csr,
  hearth-hub/config/devices.json (history: only 127.0.0.1 and 192.0.2.1)
example.csr: CN=hearth-laptop, O=Hearth-Example; public key ≠ the real hub CSR's (a test-only key; CSRs hold no secret)
private key blocks      3  → test strings with only the BEGIN header (tests that keys are rejected)
certificate blocks      1  → "MIIBfake" in handoff.test.ts
AWS access keys 0 · secret keys 0 · GitHub/Slack/OpenAI tokens 0 · account ID 0 · ARNs with an account 0
skill IDs / IoT endpoints → placeholders only (amzn1.ask.skill.0000…, xxxxxxxxxxxxxx-ats…)
emails                  → you@example.com, a@b.co, test decorators, the GitHub noreply address
private IPs 10.0.0.1/.20 → test fixtures · "MAC" C7:F8:… → fingerprint prefix of the throwaway local test CA
home paths, username, hostname 0 · passwords → code reading them from env/fixtures, none literal
```

At this point older commits still had the device brands and the partly masked account ID (current files were clean).

## History scrub (owner's choice: rewrite, after a backup)

```text
git branch backup/pre-publish-scrub hearth-setup           (c7306e3; local only, never push)
git filter-branch --tree-filter "python3 -I scrub.py …" -- hearth-setup
  scrub.py, in every commit: hearth-devices/docs/device-leads.md → the generic version; the brand rows of the
  hearth-devices/CLAUDE.md device table → device types; progress/29's partial account ID → <account-id>
final tree before d7da3b34… / after d7da3b34… → IDENTICAL
per-commit diff vs the backup: only those three files; messages, authors and dates identical; git fsck OK
rescan of every commit (content + messages): brands 0 · partial or full account ID 0 · skill ID 0 · IoT endpoint 0 ·
  alert email 0 · home path/hostname 0 · private key material 0 · AWS keys 0 · sensitive file names ever committed: none
```

## Everything still works

```text
pnpm test → contracts 34 · skill 23 · hearth-aws 45 · local-stack 21 · devices-sdk/ts 12 · hearth-hub 131 (+5 skipped) · hearth-devices 55
cdk synth OK · services.sh status → hub + ollama active, {"status":"ok","mqtt":"connected","modelLoaded":true}
ask smapi simulate-skill "ask ramesh dude how much space is left" (en-IN) → SUCCESSFUL, CommandIntent,
  "You have 141 gigabytes free out of 467, about 30 percent." · hub: disk_space allowed ok 1973 ms
```

Local-only refs that hold old history and must never be pushed: `backup/pre-email-rewrite`, `backup/pre-publish-scrub`,
`refs/original/refs/heads/hearth-setup` (filter-branch's own backup). Push only `hearth-setup` (or `main` made from it).

```text
pnpm test → contracts 34 · hearth-aws 45 · local-stack 21 · devices-sdk/ts 12 · hearth-hub 131 (+5 skipped) · hearth-devices 55
```
