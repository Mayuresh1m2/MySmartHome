# 34: the $1 kill switch counts the whole account

## Why

Activating the `project` cost allocation tag (needed by the $1 "Hearth-only" budget's filter) is impossible here:

```text
$ aws ce list-cost-allocation-tags
AccessDeniedException: Failed to list Cost Allocation Tags: Linked account doesn't have access to cost allocation tags.
$ aws organizations describe-organization → this account is not the management account
```

New sign-up experience accounts are members of an AWS-managed organization, and AWS docs: "Only a management account in an
organization and single accounts that aren't members of an organization have access to the cost allocation tags manager."
So `TagKeyValue: user:project$hearth` would always see $0 and the switch would never fire.

Owner's choice (2026-10-21): an overall limit is fine for now, although more side projects may share the account later.
Their spend now counts towards the $1 limit; raise it with `scripts/kill-switch.sh set hearth <usd>`.

## Change

`lib/hearth-stack.ts`: no `costFilters` on `hearth-<hubId>-killswitch`. The `project=hearth` tag stays on every resource
(Tag Editor, Cost Explorer). Docs updated: README cost guard, runbook, kill-switch.sh, .env.example, config.ts, CLAUDE.md.

```text
pnpm test → 45 passed · cdk synth ok
cdk diff → [~] AWS::Budgets::Budget KillSwitchBudget may be replaced · [-] Removed: .CostFilters
  (CloudFormation reference: BudgetData.CostFilters "Update requires: No interruption"; only BudgetName replaces)
cdk deploy (approved) → ✅ Hearth-laptop, 20.7 s
stack events: KillSwitchBudget UPDATE_IN_PROGRESS → UPDATE_COMPLETE (no create/delete: updated in place)
```

## After

```text
hearth-laptop-killswitch  limit 1.0  actual 0.0  filters {}   lastUpdated 16:32:06
hearth-laptop-monthly     limit 5.0  actual 0.0  filters {}
action 9235ee83-… (killswitch)  STANDBY  AUTOMATIC  threshold 100 %  2 roles
action 20a65c48-… (monthly)     STANDBY  AUTOMATIC  threshold 100 %  2 roles
```

Also: SNS alert subscription confirmed by the owner (subscription has an ARN, no longer PendingConfirmation).
Note: hearth-aws/CLAUDE.md lists `pnpm lint`, but the project has no lint script.
