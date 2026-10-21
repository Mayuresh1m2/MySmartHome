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

Still in **older commits** (current files are clean): device brands (7e35049, f1719f4, 17f5872) and the partly
masked account ID (7b2a372). A public push needs either a history rewrite or a fresh single-commit history.

```text
pnpm test → contracts 34 · hearth-aws 45 · local-stack 21 · devices-sdk/ts 12 · hearth-hub 131 (+5 skipped) · hearth-devices 55
```
