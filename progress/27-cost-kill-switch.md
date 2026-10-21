# 27 — Cost kill switch, with configurable amounts (hearth-aws, before the first deploy)

Date: 2026-10-21. You asked: stop on its own if spend exceeds the free tier, and make the amount easy to change. Your choices: **$1** of actual monthly cost, **counting only Hearth's resources**.

## Checked against current AWS docs

- *Configuring budget actions*: actions can apply an IAM policy or an SCP, or stop EC2/RDS, automatically or after approval. There's nothing direct for Lambda or IoT, so the action is an **IAM deny policy on the stack's roles**.
- *AWS Budgets pricing*: monitoring and notifications are free; **the first two action-enabled budgets per month are free**, then $0.10/day.
- *AWS::Budgets::BudgetsAction*: `ActionType APPLY_IAM_POLICY`, `ApprovalModel AUTOMATIC`, `NotificationType ACTUAL`, `ActionThreshold`, `Definition.IamActionDefinition{PolicyArn, Roles}`, `ExecutionRoleArn`, `Subscribers`.
- There's **no hard spending cap** in AWS. Billing data lags by hours, so spend can pass the limit slightly before the action runs. This is stated in the README.

## What was built

- `KillSwitchBudget` `hearth-<hubId>-killswitch`: COST, MONTHLY, `killSwitchUsd` (default 1), `CostFilters.TagKeyValue = user:project$hearth`. `Tags.of(stack).add('project','hearth')` inside the stack, so every resource carries the tag even if `bin/` changes.
- `KillSwitchDeny`: a managed policy, `Deny * *`. **Not attached at deploy time** (tested); only Budgets attaches it.
- `KillSwitchExecutionRole`: trusted by `budgets.amazonaws.com`. It may **only** `iam:AttachRolePolicy`/`DetachRolePolicy` on **the skill role and the rule role**, **only** with `iam:PolicyARN` = the deny policy (tested).
- `KillSwitchAction`: APPLY_IAM_POLICY, AUTOMATIC, ACTUAL ≥ 100 % → deny on the two roles, plus an email to `budgetEmail`.
- After it trips: the Lambda can't publish or read and the rule can't write, so no IoT messages from the cloud and no DynamoDB writes. Left: Lambda invocations when you speak (inside the always-free 1 M/month), a few log lines, and the hub's idle IoT connection (fractions of a cent).
- **Configurable:**
  - `killSwitchUsd` (0–100) and `budgetAlertUsd` (the existing account-wide alert, previously hard-coded at 5) in `config/local.json` and `config/example.json`;
  - per-deploy override `-c killSwitchUsd=…` / `-c budgetAlertUsd=…`, validated like the config file;
  - `scripts/kill-switch.sh show|set <usd>|reset`; `set` validates the amount and edits `config/local.json` with jq.
- Docs: README "Cost guard" (including the **one-time activation of the `project` cost allocation tag** and Free Tier usage alerts), a runbook section "Kill switch tripped", and the Config line in hearth-aws/CLAUDE.md.

## Evidence

```text
$ pnpm --filter @hearth/aws test → Tests 41 passed (41)     (8 new in test/killswitch.test.ts)
  ✓ Hearth-only cost budget at $1 (TagKeyValue user:project$hearth)
  ✓ AUTOMATIC, ACTUAL, 100 %, APPLY_IAM_POLICY on exactly the skill + rule roles, email subscriber
  ✓ deny policy = Deny * *, attached to no role at deploy time
  ✓ execution role: only Attach/DetachRolePolicy on those 2 roles, conditioned on the deny policy ARN
  ✓ resources tagged project=hearth
  ✓ amounts flow from config (2.5 / 10) · context overrides validated (-1, 500 rejected)
  ✓ kill-switch.sh set 2.5 writes config; 0, -1, abc, 1000 rejected and config unchanged

$ HEARTH_CONFIG=config/example.json npx cdk synth -c killSwitchUsd=3
{"BudgetName":"hearth-laptop-monthly","Amount":5}
{"BudgetName":"hearth-laptop-killswitch","Amount":3}
$ … -c killSwitchUsd=-5 → Error: Invalid override
template: 2 AWS::Budgets::Budget · 1 AWS::Budgets::BudgetsAction · 1 AWS::IAM::ManagedPolicy
```

## Testing it for real (after the first deploy, with your go-ahead)

Spending real money to trip it isn't sensible. Instead: attach the deny policy by hand to the skill role, check that an ASK simulation gets the fallback, then detach it. That reproduces exactly what the action does. Watching the action fire for real would only happen in a month that actually exceeds the limit.

## Follow-up: a second, account-wide switch, and clearer names

You asked whether the switches are manual or automated Lambdas, and whether there's one for the whole account too.

- **Automated, with no Lambda of ours.** They're AWS Budgets actions with `ApprovalModel: AUTOMATIC`, run by AWS. They attach the deny policy; they don't delete or stop the stack.
- At first only the Hearth-only switch existed, and the account budget only sent email. **At your request, the account-wide budget now has the same automatic action**, still free (two action-enabled budgets).
- A standalone account has no safe automatic way to stop *other* services: SCPs need AWS Organizations, and denying your own admin identity risks locking you out. So both switches stop **Hearth only**. For the rest of the account, the email and Free Tier alerts are the signal.
- Renamed, since both amounts now stop Hearth (nothing deployed yet, so no migration): `killSwitchUsd` → **`hearthKillSwitchUsd`** (default 1), `budgetAlertUsd` → **`accountKillSwitchUsd`** (default 5). `scripts/kill-switch.sh show | set hearth|account <usd> | reset hearth|account`. The README "Cost guard" table, the runbook and the hearth-aws/CLAUDE.md Config line and resource rule are updated.

```text
$ pnpm --filter @hearth/aws test → Tests 42 passed (42)
  ✓ two automatic switches: Hearth-only and whole account, both on the same deny policy and roles; account budget has no tag filter
  ✓ kill-switch.sh set hearth 2.5 / set account 20 written; bad values, account 5000 and unknown switch rejected
$ cdk synth -c accountKillSwitchUsd=12
[{"BudgetName":"hearth-laptop-monthly","Amount":12},{"BudgetName":"hearth-laptop-killswitch","Amount":1}]
["hearth-laptop-killswitch","hearth-laptop-monthly"]     ← one automatic action each
```
