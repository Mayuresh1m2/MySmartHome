# 13 — hearth-aws hardening, handoff script and runbook (PLAN H1 = aws M4, plus M2's handoff.sh)

Date: 2026-10-21

## Goal

aws M4: budget alert, log retention, a Lambda error alarm emailed to the owner, the `DEBUG_UTTERANCES` flag, and a certificate rotation runbook. *Done when synth shows the alarm and the budget, and the owner has reviewed the runbook.* Plus `scripts/handoff.sh` from M2, which can be written and tested without an account.

**Order note:** the spec says to do milestones in order. M2/M3 are fully coded, but their *deploys* are gated (G3/G4). This step is code-only and changes nothing in AWS. Its acceptance needs your runbook review regardless.

## Checked against current docs

The spec says to check docs rather than guess. I fetched the CloudFormation reference for `AWS::Budgets::Budget`: no region restriction is listed, so it can live in the eu-west-1 stack. A notification's `Threshold` with `ThresholdType: PERCENTAGE` is a percentage of the limit, so "above $5" is a $5 limit with ACTUAL > 100 %.

## What changed

- **Budget:** `hearth-<hubId>-monthly`, COST, MONTHLY, 5 USD; ACTUAL > 100 % emails `budgetEmail`.
- **Alarm:** `SkillErrors` on the Lambda `Errors` metric (Sum ≥ 1 over 5 min, missing data = not breaching). Action → SNS topic `Alerts` → email subscription to `budgetEmail`. Hub timeouts are deliberately *not* errors, because the skill answers them honestly. They show on the dashboard instead.
- **Dashboard** `hearth-<hubId>` (inside the free tier of 3 dashboards): commands by outcome (from the EMF metrics added in entry 08), reply latency p50/p95 with the timeout line, Lambda errors/invocations, and alarm status.
- **`debugUtterances`** config (default false) → `DEBUG_UTTERANCES` env.
- **Rotation-safe certificates:** config `certificates: [{name, csrPath, active}]`, with each certificate on a stable logical id (`primary` keeps the original ids). Rotation **adds** a certificate rather than changing the CSR on the existing resource, which would make CloudFormation replace the live certificate. Deactivation is a status change (ACTIVE → INACTIVE), not a replacement. Config validation: names unique, at least one active.
- **`scripts/handoff.sh [name]`:** stack output → `describe-certificate` → `out/hub.crt` (or `hub-<name>.crt`) plus `out/hub.env`. It cross-checks the config endpoint against `describe-endpoint --endpoint-type iot:Data-ATS`, refuses any response containing a private key, writes no credentials, and makes only read calls.
- **`docs/runbook.md`:** daily health (dashboard, alarm, rule error logs, tracing one requestId), deploy, debug-utterance toggling, **rotation in five steps** (new key/CSR in `certs/next` → add certificate, both active → switch the hub with instant rollback → ⚠ deactivate the old one → ⚠ remove it later), what to do if the key is exposed, hub-offline triage.
- `config/example.json` and the Config line in `hearth-aws/CLAUDE.md` now mention the two optional keys. The contract section is untouched, and the drift test still passes.

## Evidence

```text
$ pnpm --filter @hearth/aws test
      Tests  26 passed (26)      (12 new)
```

- `hardening.test.ts`: the budget (exact properties), SNS email subscription, alarm wired to the topic, dashboard references the `Hearth` namespace with `ReplyLatency`/`timeout`, and `DEBUG_UTTERANCES` false by default / true from config. **Rotation:** adding `next` leaves `HubCertificate` byte-identical and creates `HubCertificatenext` plus both attachments. Deactivating `primary` sets `Status: INACTIVE` with 2 certificates and still exactly 1 policy.
- `handoff.test.ts` (with a stub `aws` on PATH): writes hub.crt and hub.env with exact contents, calls only describe-* (asserts no create/update/delete), handles `hub-next.crt`, and refuses on endpoint mismatch, an undeployed certificate, or a private key in the response.
- `config.test.ts`: certificate name uniqueness and the at-least-one-active rule.

```text
$ pnpm --filter @hearth/aws synth:example   → resources in the template:
  1 AWS::Budgets::Budget          1 AWS::CloudWatch::Alarm      1 AWS::CloudWatch::Dashboard
  1 AWS::SNS::Topic               1 AWS::SNS::Subscription      1 AWS::DynamoDB::Table
  1 AWS::IoT::Certificate         1 AWS::IoT::Policy            1 AWS::IoT::Thing
  1 AWS::IoT::PolicyPrincipalAttachment  1 AWS::IoT::ThingPrincipalAttachment  1 AWS::IoT::TopicRule
  1 AWS::Lambda::Function         1 AWS::Lambda::Permission     2 AWS::Logs::LogGroup   2 AWS::IAM::Role
```

## Pending

- **Your review of `hearth-aws/docs/runbook.md`** (M4 acceptance).
- After the first deploy: confirm the SNS subscription email, or alarm emails won't arrive.
