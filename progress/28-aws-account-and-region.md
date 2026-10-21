# 28 — Your AWS account uses the new sign-up experience: Hearth moves to ap-southeast-2

Date: 2026-10-21

## What happened

You created a personal AWS account and added root MFA. My setup steps (classic console, IAM Identity Center, region eu-west-1) then didn't match what you saw: no region selector, and the account page redirected to `settings.aws.com/profile`. I checked the current AWS docs:

| Finding | Source |
|---|---|
| The account was made with **"Sign up for AWS (new)"**. Regional resources live in one region chosen by country; **India → `ap-southeast-2` (Sydney)**; there's no region selector | [AWS Regions for your projects](https://docs.aws.amazon.com/accounts/latest/reference/project-regions.html) |
| Everything Hearth uses is supported on the Free plan: AWS IoT, Lambda, DynamoDB, CloudFormation, CloudWatch (+Logs), SNS, S3, ECR, IAM, STS, Systems Manager, Budgets, Cost Explorer. **IAM Identity Center and AWS Organizations are not**, unless you activate advanced features | [Supported services](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html) |
| "Activate advanced features" requires the Paid plan first, **can't be reversed**, removes spend limits, and enables the region selector and other regions | [Activate advanced features](https://docs.aws.amazon.com/accounts/latest/reference/activate-advanced-features.html) |
| **Spend limits** pause a project at its cap (minimum = the greater of $20 or AWS's estimate), with warnings at 50/75/90 % | [Create a spend limit](https://docs.aws.amazon.com/accounts/latest/reference/create-spend-limit.html), [update](https://docs.aws.amazon.com/accounts/latest/reference/update-spend-limit.html) |
| The Free plan ends after 6 months or when the credits are used up, then the account is suspended until you upgrade to Paid, and erased after 90 more days | [Free Tier FAQs](https://aws.amazon.com/free/faqs/) |
| "IAM user and role access to Billing" only controls *console* billing pages; the Billing/Budgets **APIs** aren't affected, so it isn't needed for the deploy | [Cost Management: access permissions](https://docs.aws.amazon.com/cost-management/latest/userguide/control-access-billing.html) |
| CLI 2.38.3 has **`aws login`**: temporary credentials from the console session, refreshed automatically, no keys | `aws login help` on this machine |

**Your decision: option A.** Keep the new experience, move Hearth to **ap-southeast-2**, use the native spend limit as the hard stop with our $1/$5 kill switches as earlier tripwires, use `aws login` for the CLI, and upgrade to Paid within 6 months. The alternative was to upgrade and activate advanced features to keep eu-west-1, which is irreversible and loses spend limits.

## Region change, done in one commit

- `Region: ap-southeast-2` in the contract section of **both** CLAUDE.md files (they stay identical; the drift test passes), `contracts/cloud-hub/v1/constants.json`, CDK `bin/` env, `handoff.sh`, `kill-switch.sh`, hub config default and `hub.example.env`, local-stack `prepare.sh`, all test fixtures, the README and the runbook. The historical journal entries are left as written.
- **Not bumping `v`**: the contract's `v` versions the message format (command/reply payloads), which is unchanged, and nothing is deployed, so there's no running peer on the old value. Both sides changed together, which is the rule's purpose. A bump is a mechanical follow-up if you'd like it anyway.
- Latency: Alexa serves EU/IN from Ireland (Amazon recommends eu-west-1 for those skills), so a Sydney Lambda adds one Ireland↔Sydney round trip, roughly 0.25 s per command. That's ~3.3 s instead of ~3.0 s, inside the 5 s reply budget.
- README: a "why Sydney" note and `aws login` for new-experience accounts.

```text
$ pnpm test → contracts 34 · skill 23 · hearth-aws 42 · local-stack 21 · devices-sdk/ts 12 · hearth-hub 131 (+5 opt-in) · hearth-devices 55
$ synth → IoT policy resource "arn:aws:iot:ap-southeast-2:<account>:client/hearth-laptop"
```

## Your next steps (new experience)

1. settings.aws.com → **Project → Overview → Additional Info → Region**: confirm it says Asia Pacific (Sydney).
2. **Spend limit** for the project (minimum $20) as the hard stop.
3. CLI: `aws login --profile hearth --region ap-southeast-2`, then `aws sts get-caller-identity --profile hearth`.
4. Alexa: developer.amazon.com with the Echo's Amazon account, then `ask configure` (say No to linking AWS).
