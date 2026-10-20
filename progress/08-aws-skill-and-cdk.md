# 08 — hearth-aws: skill Lambda and the CDK stack (PLAN C1, C2 = aws M1, and M2's resources in code)

Date: 2026-10-21

## Goal

Everything on the cloud side that can be built and proven without an AWS account. The skill handler is tested against fakes and SDK mocks. The CDK stack's least-privilege claims are proven with assertion tests, and synth runs from a template config.

## Versions

aws-cdk-lib 2.274.0, aws-cdk CLI 2.1146.0, constructs 10.8.1, ask-sdk-core 2.14.0, ask-sdk-model 1.86.0, @aws-sdk/client-iot-data-plane and client-dynamodb 3.1153, aws-sdk-client-mock 4.1.0. None are deprecated (checked with `npm view … deprecated`).

## Skill Lambda (`lambda/skill`, `@hearth/skill`)

- `ports.ts`: `CommandPublisher` (prod: IoT Data Plane `Publish`, QoS 1) and `ReplyStore` (prod: DynamoDB `GetItem` with **ConsistentRead**). local-stack plugs in its own implementations, so the handler code is identical locally and in AWS.
- `relay.ts`: builds a contract v1 command (`randomUUID`, `sentAt`), publishes it, then polls every 150 ms until `REPLY_TIMEOUT_MS`, clamped to ≤ 5000 (default 3000). Outcomes: `ok | refused | error | timeout | publish_failed | bad_reply`. A reply that breaks the contract is `bad_reply` and is never spoken. Transient read errors while polling are tolerated.
- `skill.ts`: handlers for Launch, CommandIntent, Help, Stop/Cancel/NavigateHome, SessionEnded and errors. Uses `withSkillId`. The session ends after a command (one-shot "ask home hearth to …").
  - **Hub speech is SSML-escaped** (`& < >`). Otherwise a reply containing `&` or `<audio>` would break or inject SSML.
  - Honest fallbacks: timeout → "Your home hub didn't answer in time. It might be offline."
- `obs.ts`: JSON logs with `requestId`, `alexaRequestId`, `hubId`, `outcome`, `latencyMs`, and `textLength` (the text only when `DEBUG_UTTERANCES=true`). Plus one **CloudWatch EMF** record per command: namespace `Hearth`, dimensions `HubId[,Outcome]`, metrics `ReplyLatency` and `Requests`. Dashboards and alarms (M4) build on it without any extra SDK.

## CDK (`bin/hearth.ts`, `lib/hearth-stack.ts`, `lib/config.ts`)

- Config: zod-validated `config/local.json` (or `HEARTH_CONFIG`). It enforces the hubId format, an `amzn1.ask.skill.` prefix, the ATS endpoint format, `replyTimeoutMs ≤ 5000` and the email format. **It refuses a csrPath that contains a private key.** `config/example.json` is committed and points at `test/fixtures/example.csr`, a throwaway CSR whose key was piped away and never written.
- Stack `Hearth-<hubId>` in eu-west-1:
  - `AWS::IoT::Certificate` from the CSR (ACTIVE), thing `hearth-<hubId>`, a policy with exactly the four statements, and the policy and thing attachments.
  - Replies table: on-demand, PK `requestId`, TTL `expiresAt`, **RemovalPolicy RETAIN** (deleting or replacing it needs the user's decision).
  - Topic rule with the spec's SQL verbatim, a DynamoDBv2 action, and an **errorAction to a log group** (observability: failed rule writes don't vanish silently).
  - NodejsFunction: Node 22, arm64, 256 MB, 7 s, esbuild bundle of **99.7 kB** (AWS SDK v3 comes from the runtime). Its own role has three inline statements (`iot:Publish` on the commands topic, `dynamodb:GetItem` on the table, `logs:CreateLogStream/PutLogEvents` on its own log group) and **no managed policies**.
  - Invoke permission: principal `alexa-appkit.amazon.com` with `EventSourceToken` = skill ID.
  - Log groups at 14 days.
  - Outputs: function ARN, table name, certificate ID (for `handoff.sh`), thing name, rule name, endpoint.

## Issues hit

- `this.partition` renders as `{"Ref":"AWS::Partition"}` inside an `Fn::Join`, so the policy ARNs weren't plain strings and the exact-match test failed. The contract pins eu-west-1 (partition `aws`), so the ARNs use the literal `arn:aws:iot:…`.
- `CfnResource#addDependency` is deprecated → `addResourceDependency`.
- The CDK CLI printed "AI agent detected". That's informational only.

## Evidence

```text
$ pnpm --filter @hearth/aws synth:example
Bundling asset Hearth-laptop/SkillFunction/Code/Stage...
  .../index.js   99.7kb
⚡ Done in 34ms
(cdk.out/Hearth-laptop.template.json written)

$ pnpm -r test
contracts                 Tests  27 passed (27)
local-stack               Tests   7 passed (7)
hearth-aws/lambda/skill   Tests  23 passed (23)
hearth-aws                Tests  14 passed (14)
hearth-hub                Tests  87 passed (87)
$ pnpm -r typecheck       all Done
```

CDK assertions (`test/stack.test.ts`): cert from CSR, ACTIVE, no `PRIVATE KEY` anywhere in the template · thing and attachments · **hub policy deep-equals the four contract statements** · table billing, key, TTL, Retain · rule SQL verbatim plus error action · Lambda runtime, timeout, memory, env · a single invoke permission (Alexa + skill ID) · **Lambda role actions are exactly** `dynamodb:GetItem, iot:Publish, logs:CreateLogStream, logs:PutLogEvents`, with no managed policies, no `*` resources and no external IAM policies on the role · all logs 14 days · **no function URL, API Gateway, ALB or CloudFront**.

Mutation check: I temporarily added `fn.addFunctionUrl()` and `replies.grantReadWriteData(fn)`:

```text
 × role may only publish to the commands topic, read a reply and write its own logs
 × has no function URL, API Gateway or load balancer
      Tests  2 failed | 12 passed (14)
(restored → 14 passed)
```

## Acceptance status for aws M1

- `pnpm test` ✔. Assertion tests prove the hub policy and Lambda role allow only what the contract lists, and that no function URL exists ✔.
- `pnpm cdk synth` ✔ with `config/example.json`. Synth with `config/local.json` needs the real `skillId` and `iotEndpoint` (gates G3/G4) and `budgetEmail` (G9).
