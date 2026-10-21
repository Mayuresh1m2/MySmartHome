# hearth-aws

The cloud half of Hearth: an Alexa custom skill ("Alexa, ask **home hearth** to …") whose Lambda forwards what you said to your own home hub through AWS IoT Core, waits up to 3 s for the hub's reply, and speaks it. The hub ([`../hearth-hub`](../hearth-hub)) runs on a machine in your home and only ever connects **outbound**. Nothing here exposes a public endpoint.

```
Echo ─▶ Alexa ─▶ skill Lambda ──publish──▶ IoT Core ──▶ hearth/<hubId>/commands ──▶ hub (your home, mTLS)
                     ▲                                                              │
                     └── poll DynamoDB ◀── IoT rule ◀── hearth/<hubId>/replies ◀────┘
```

This README deploys it into **your own** Amazon developer and AWS accounts from scratch. Day-2 operations (dashboard, alarms, certificate rotation) are in [`docs/runbook.md`](docs/runbook.md).

## What it costs

Typically cents a month: on-demand DynamoDB, a few Lambda invocations, IoT messages, and one dashboard inside the free tier. The stack includes an AWS Budget that emails you if actual spend passes **$5/month**.

## Prerequisites

| | |
|---|---|
| AWS account | an IAM identity able to deploy CloudFormation, IoT, Lambda, DynamoDB, IAM roles, SNS, CloudWatch and Budgets |
| AWS CLI v2 | configured with a profile (`aws configure` or SSO). Credentials stay in the CLI; nothing here writes them to files |
| Amazon developer account | the same Amazon account your Echo uses, so the development skill shows up on your devices |
| ASK CLI v2 | `npm i -g ask-cli`, then `ask configure`. **Check `ask --help` for exact syntax.** The commands below were written before they could be run here, and are confirmed at milestone M3 |
| Node.js 22, pnpm | `corepack enable pnpm` |
| openssl, jq | for the hub's key/CSR and the handoff script |
| Your Echo's language | the skill locale must match it. This repo ships **en-IN** |

Everything runs in **eu-west-1** (fixed by the hub contract).

## Cost guard (kill switch)

Two budgets come with the stack:

| Budget | Counts | At | Does |
|---|---|---|---|
| `hearth-<hubId>-killswitch` | Hearth's costs only (tag `project=hearth`) | `killSwitchUsd` (default **$1**) actual | **automatically** attaches a deny-all policy to the skill and rule roles: the cloud side stops, Alexa answers "your home hub didn't answer", and you get an email |
| `hearth-<hubId>-monthly` | the whole account | `budgetAlertUsd` (default $5) actual | email only |

- Change the limit: `scripts/kill-switch.sh set 2`, then test → diff → deploy (an in-place budget update), or for one deploy only: `pnpm cdk deploy -c killSwitchUsd=2`.
- **One-time setup:** in the Billing console, activate the **`project` cost allocation tag** (Billing → Cost allocation tags). Until then the Hearth-only budget sees $0, and only the account-wide alert works. Activation can take up to 24 hours.
- Also turn on Billing preferences → **Free Tier usage alerts** (free): you're emailed at 85 % of any free-tier limit, before anything is switched off.
- It's not a hard cap: billing data lags by hours, so spend can pass the limit a little before the switch acts.
- After it trips: `scripts/kill-switch.sh reset` reverses it. It trips again if this month's cost is still over the limit; raise the limit first with `set`.

## 1. Create the hub's identity (on the hub machine)

The private key is created on the hub and never leaves it. AWS only ever sees the CSR.

```bash
cd hearth-hub
scripts/make-csr.sh --hub-id laptop       # pick your hubId: lowercase letters, digits, hyphens
# → certs/hub.key (mode 600), certs/hub.csr, certs/AmazonRootCA1.pem
# → prints the absolute CSR path for the next step
```

## 2. Configure this project

```bash
cd hearth-aws
pnpm install
cp config/example.json config/local.json      # gitignored
aws iot describe-endpoint --endpoint-type iot:Data-ATS --region eu-west-1 --query endpointAddress --output text
```

Edit `config/local.json`:

| key | value |
|---|---|
| `hubId` | the same id as step 1 |
| `iotEndpoint` | the output of the command above (`xxxx-ats.iot.eu-west-1.amazonaws.com`) |
| `csrPath` | the absolute path printed by `make-csr.sh` |
| `budgetEmail` | where budget, kill-switch and alarm emails go |
| `killSwitchUsd` / `budgetAlertUsd` | cost guard amounts, default 1 and 5 (see Cost guard) |
| `replyTimeoutMs` | 5000 when the hub uses a local model (it needs ~2.5–3.6 s); 3000 with the keyword router. Never above 5000 |
| `locale` | `en-IN`, or your Echo's locale (see "Other locales") |
| `skillId` | filled in at step 4; leave the placeholder for now |

Check it:

```bash
pnpm test && pnpm cdk synth
```

## 3. Bootstrap CDK (once per account and region)

```bash
pnpm cdk bootstrap aws://<account-id>/eu-west-1
```

## 4. Create the skill first, so its ID exists

There's a chicken-and-egg ordering. The Lambda's invoke permission needs the **skill ID**, and the skill's endpoint needs the **Lambda ARN**. So create the skill first, deploy, then point the skill at the Lambda.

```bash
# create the skill from the manifest (endpoint is still a placeholder)
ask smapi create-skill-for-vendor --manifest "file:skill-package/skill.json"
#   → prints the skillId (amzn1.ask.skill.…); creation is asynchronous, so check with:
ask smapi get-skill-status --skill-id <skillId>

# upload the interaction model
ask smapi set-interaction-model --skill-id <skillId> --stage development --locale en-IN \
  --interaction-model "file:skill-package/interactionModels/custom/en-IN.json"
```

Put the skillId into `config/local.json` as `skillId`.

## 5. Deploy

```bash
pnpm test && pnpm cdk synth
pnpm cdk diff          # read it: IoT certificate/thing/policy, table, rule, Lambda, alarm, budget, dashboard
pnpm cdk deploy
```

Afterwards:

- Confirm the **SNS subscription email** AWS sends to `budgetEmail`, or alarm emails won't arrive.
- Optional check of the replies path:

  ```bash
  aws iot-data publish --region eu-west-1 --topic "hearth/<hubId>/replies" --cli-binary-format raw-in-base64-out \
    --payload '{"v":1,"requestId":"00000000-0000-4000-8000-000000000000","speech":"test","status":"ok"}'
  aws dynamodb get-item --region eu-west-1 --table-name <RepliesTableName output> \
    --key '{"requestId":{"S":"00000000-0000-4000-8000-000000000000"}}'
  ```

## 6. Point the skill at the Lambda and enable testing

Take `SkillFunctionArn` from the stack outputs. Put it in a **local copy** of the manifest, so no ARN gets committed:

```bash
ARN=$(aws cloudformation describe-stacks --region eu-west-1 --stack-name Hearth-<hubId> \
  --query "Stacks[0].Outputs[?OutputKey=='SkillFunctionArn'].OutputValue" --output text)
mkdir -p .ask && jq --arg arn "$ARN" '.manifest.apis.custom.endpoint.uri = $arn' skill-package/skill.json > .ask/skill.json
ask smapi update-skill-manifest --skill-id <skillId> --stage development --manifest "file:.ask/skill.json"
ask smapi set-skill-enablement --skill-id <skillId> --stage development
```

The skill stays in **development**. Don't submit it for certification.

## 7. Hand the hub its certificate

```bash
scripts/handoff.sh
# → out/hub.crt and out/hub.env (IOT_ENDPOINT, HUB_ID, AWS_REGION)
```

On the hub machine:

```bash
cp out/hub.crt hearth-hub/certs/hub.crt
cp hearth-hub/config/hub.example.env hearth-hub/config/hub.env   # then paste in the three values from out/hub.env
cd hearth-hub && pnpm install && pnpm start
curl -s 127.0.0.1:8787/health      # "mqtt": {"state": "connected"}
```

## 8. Try it

```bash
ask smapi simulate-skill --skill-id <skillId> --stage development --device-locale en-IN \
  --input-content "ask home hearth to ping"
# poll: ask smapi get-skill-simulation --skill-id <skillId> --stage development --simulation-id <id>
```

With the hub running you'll hear "Hub is online." With it stopped, "Your home hub didn't answer in time. It might be offline." Then try it on your Echo: *"Alexa, ask home hearth how much space is left."*

## Other locales

The locale must match your Echo's language. To use, say, en-GB:

1. Rename `skill-package/interactionModels/custom/en-IN.json` to `en-GB.json`, and change the key under `publishingInformation.locales` in `skill.json`.
2. Set `"locale": "en-GB"` in `config/local.json`.
3. `pnpm test`. The skill-package tests check that all three agree.

## Running everything without AWS

From the repo root, `pnpm local:up` runs this project's real skill handler against a local IoT Core emulator (mTLS, the same policy) and an in-memory DynamoDB, plus the real hub process. Then `pnpm local:say "how much space is left"`. See [`../progress/09-local-stack-e2e.md`](../progress/09-local-stack-e2e.md).

## Tearing down

`cdk destroy` deletes the Lambda, IoT resources, alarm, dashboard and budget. The **replies table is retained** on purpose; delete it yourself if you want it gone. Deactivate the hub certificate first if the hub is still running. Delete the development skill in the developer console or with ASK CLI.
