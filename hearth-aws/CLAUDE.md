# Hearth AWS

The cloud half of Hearth. An Alexa custom skill whose Lambda forwards spoken commands to my home hub through AWS IoT Core, waits briefly for the hub's reply, and has Alexa speak it. The hub is a separate project (hearth-hub) on my home network, and it only ever connects outbound.

This project owns the CDK app, the skill Lambda, the Alexa skill package (manifest and interaction model), and the scripts that hand the hub its certificate and endpoint.

Out of scope: anything that runs on my home network, device control, and the local LLM.

## How a request flows

1. "Alexa, ask ramesh dude to <command>" makes Alexa call the skill Lambda in the configured region (`HEARTH_AWS_REGION`).
2. The Lambda publishes the command to `hearth/<hubId>/commands` through the IoT Data Plane.
3. The hub, connected outbound over MQTT with its certificate, runs it and publishes to `hearth/<hubId>/replies`.
4. An IoT rule writes the reply into a DynamoDB table with a 5 minute TTL.
5. The Lambda polls the table by `requestId` for up to `REPLY_TIMEOUT_MS`, then speaks the reply or an honest fallback.

## Contract with hearth-hub

This section is identical in hearth-aws and hearth-hub. Never change one side alone: bump `v`, then update both CLAUDE.md files and both implementations together.

- Region: one AWS Region per deployment, set once in the repo-root `.env` as `HEARTH_AWS_REGION` (this deployment: `ap-southeast-2`). hearth-aws deploys there; the handoff's `hub.env` carries it to the hub as `AWS_REGION`.
- `hubId`: lowercase letters, digits and hyphens; default `laptop`
- MQTT client ID and IoT thing name: `hearth-<hubId>`
- Topics: `hearth/<hubId>/commands` (cloud to hub) and `hearth/<hubId>/replies` (hub to cloud), QoS 1
- Command payload: `{"v":1,"requestId":"<uuid>","text":"<utterance>","sentAt":<epoch ms>}`
- Reply payload: `{"v":1,"requestId":"<uuid>","speech":"<one or two sentences>","status":"ok|refused|error"}`
- Identity: an X.509 certificate issued from a CSR generated on the hub machine. The private key never leaves that machine.
- Timing: Alexa waits about 8 s. The Lambda waits `REPLY_TIMEOUT_MS` (default 3000, never above 5000). The hub drops commands older than 10 s and duplicate `requestId`s.
- Handoff from hearth-aws to hearth-hub: `hub.crt` plus `hub.env` with `IOT_ENDPOINT`, `HUB_ID` and `AWS_REGION`.

## Stack

- TypeScript (strict), pnpm, AWS CDK v2, Node.js 22 Lambda runtime
- Skill handler: `ask-sdk-core`, plus AWS SDK v3 (`@aws-sdk/client-iot-data-plane`, `@aws-sdk/client-dynamodb`)
- Tests: vitest, `aws-sdk-client-mock`, CDK assertions (`aws-cdk-lib/assertions`)
- Skill package managed with ASK CLI v2. Check `ask --help` before relying on remembered syntax.

## Layout

```text
bin/hearth.ts                     CDK app entry, reads the repo-root .env
lib/hearth-stack.ts               all AWS resources
lambda/skill/src/                 skill handler
lambda/skill/test/                handler unit tests
test/                             CDK assertion tests
skill-package/skill.json          skill manifest
skill-package/interactionModels/custom/en-IN.json
scripts/                          deploy and handoff helpers
../.env.example                   committed template with placeholders (repo root)
../.env                           my real values, gitignored (repo root)
out/                              handoff files for the hub, gitignored
docs/runbook.md                   operations, including certificate rotation
```

## Config

Per-person values live in the repo-root `.env` (gitignored; template `.env.example`), read by `lib/config.ts` and the scripts, with real environment variables taking precedence: `HEARTH_HUB_ID`, `HEARTH_AWS_REGION`, `HEARTH_SKILL_ID`, `HEARTH_IOT_ENDPOINT` (filled in by `scripts/configure.sh`), `HEARTH_CSR_PATH` (default `hearth-hub/certs/hub.csr`), `HEARTH_REPLY_TIMEOUT_MS`, `HEARTH_ALERT_EMAIL`, `HEARTH_LOCALE` (default `en-IN`), `HEARTH_KILL_SWITCH_USD` (default 1: Hearth's actual monthly cost) and `HEARTH_ACCOUNT_KILL_SWITCH_USD` (default 5: the whole account's), at which automatic AWS Budgets actions deny Hearth's roles and stop the cloud side, `HEARTH_DEBUG_UTTERANCES` and `HEARTH_CERTIFICATES` (JSON list for rotation; see `docs/runbook.md`). The two amounts can also be overridden per deploy with `-c hearthKillSwitchUsd=…`. Keep `.env.example` in step. Committed files contain no account IDs, skill IDs, endpoints or certificates.

## Resource rules

- Hub certificate: `AWS::IoT::Certificate` created from the CSR. Never create keys in AWS, and the private key is never in this project.
- Hub policy allows exactly four things: `iot:Connect` on `client/hearth-<hubId>`, `iot:Subscribe` on `topicfilter/hearth/<hubId>/commands`, `iot:Receive` on `topic/hearth/<hubId>/commands`, and `iot:Publish` on `topic/hearth/<hubId>/replies`.
- Replies table: on-demand billing, partition key `requestId`, TTL attribute `expiresAt`. Rule SQL: `SELECT *, floor(timestamp() / 1000) + 300 AS expiresAt FROM 'hearth/<hubId>/replies'`.
- Lambda: Node.js 22, 7 s timeout, 256 MB. Its role may only publish to the commands topic and read the replies table. Invoke permission goes to `alexa-appkit.amazon.com` with `eventSourceToken` set to the skill ID, and the handler uses `withSkillId`.
- No API Gateway, no Lambda function URLs, no other public endpoints.
- Logs: 14 day retention. Log `requestId`, latency and outcome. Log utterance text only when `DEBUG_UTTERANCES=true`.
- An AWS Budget emails `budgetEmail` above $5 a month (`accountKillSwitchUsd`, whole account), and a second, Hearth-only budget (tag `project=hearth`) watches `hearthKillSwitchUsd` ($1). At either limit an automatic budget action attaches a deny-all policy to the skill and rule roles, which stops Hearth's cloud side without deleting anything.

## Skill rules

- Invocation name `ramesh dude`. It's two words because one-word names aren't allowed unless they're your own brand, and a person's name needs another word. Chosen 2026-10-21 by testing transcription in the phone's voice mode: Alexa's English (India) recognition missed `home hearth` ("hearth") and `chowkidar ji` in one-shot requests, while "Ramesh dude" was transcribed exactly every time. Before changing it, check the whole phrase ("ask <name> how much space is left") the same way.
- One `CommandIntent` with slot `command` of custom type `COMMAND_TEXT` and the single sample `{command}`. Give the type 15 to 20 varied sample values. Don't use `AMAZON.SearchQuery`, which requires a carrier phrase around the slot.
- Keep the required built-ins (Help, Stop, Cancel, NavigateHome). Leave out FallbackIntent, which competes with free-form phrases.
- The skill locale must match my Echo's language, English (India) by default.
- The skill stays in development. Never submit it for certification or publishing.

## Commands

- `pnpm install`, `pnpm test`, `pnpm lint`
- `pnpm cdk synth`, `pnpm cdk diff`, `pnpm cdk deploy`
- `scripts/handoff.sh`: fetch the certificate PEM and write `out/hub.crt` and `out/hub.env`

## Working rules

- For each milestone: explore, write a short plan for my approval, implement, then show evidence that the acceptance check passed (command output, not a summary).
- Before any deploy, run the tests and synth, show me `cdk diff`, and wait for my go-ahead.
- IMPORTANT: ask me before deleting, replacing or deactivating anything in AWS, including `cdk destroy`, certificate revocation or rotation, table replacement and skill deletion.
- Never commit `config/local.json`, `out/`, `.ask/` or `cdk.out/`.
- Use the AWS CLI's configured profile. Never write credentials to files.
- When unsure how an AWS or Alexa API behaves today, check the current docs instead of guessing.

## Guardrails

If `.claude/settings.json` doesn't exist, create it with these rules. They catch the usual command forms, not every possible one, so the working rules above still apply.

```json
{
  "permissions": {
    "ask": [
      "Bash(pnpm cdk deploy *)",
      "Bash(npx cdk deploy *)",
      "Bash(ask deploy *)"
    ],
    "deny": [
      "Bash(pnpm cdk destroy *)",
      "Bash(npx cdk destroy *)",
      "Bash(aws iot delete-*)",
      "Bash(aws iot update-certificate *)",
      "Bash(aws dynamodb delete-table *)",
      "Bash(ask smapi delete-skill *)",
      "Bash(ask smapi submit-skill-for-certification *)"
    ]
  }
}
```

## Milestones

Work one milestone at a time, in order.

### M1: Skeleton
- CDK app, config loading, skill handler (Launch, CommandIntent, Help, Stop and Cancel, SessionEnded, error handler) and unit tests.
- Done when `pnpm test` and `pnpm cdk synth` pass, and assertion tests prove that the hub policy and the Lambda role allow only what the contract lists and that no function URL exists.

### M2: Hub identity and the replies path
- Certificate from the CSR, thing, policy and attachments; replies table, rule and TTL; `scripts/handoff.sh`.
- Done when, after a deploy, publishing a fake reply to `hearth/<hubId>/replies` with `aws iot-data publish` creates an item in the table, and `out/hub.crt` and `out/hub.env` exist.

### M3: The skill
- Manifest and interaction model. Create the skill with ASK CLI, set its endpoint to the Lambda ARN, and enable it for testing in development.
- Order matters: the Lambda permission needs the skill ID and the skill endpoint needs the Lambda ARN. Create the skill first, save its ID in config, deploy, then set the endpoint.
- Done when an ASK CLI simulation of "ask ramesh dude to ping" returns the fallback while the hub is off, and the hub's reply while hearth-hub is running.

### M4: Hardening
- Budget alert, log retention, a Lambda error alarm emailed to me, the `DEBUG_UTTERANCES` flag, and a certificate rotation runbook in `docs/runbook.md` (new CSR, new certificate, switch the hub, then deactivate the old one).
- Done when synth shows the alarm and the budget, and I've reviewed the runbook.

### M5: Docs for self-deployment
- A README that lets someone else deploy this into their own Amazon and AWS accounts from scratch, including the handoff to hearth-hub.
