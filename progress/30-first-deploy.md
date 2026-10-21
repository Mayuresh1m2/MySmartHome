# 30 — First AWS deploy: bootstrap, skill, stack, handoff, hub on real IoT Core (aws M2, hub M1)

Date: 2026-10-21. Each step that changed your AWS or Amazon developer account ran only after your go-ahead.

## ASK CLI

`ask configure` showed "Feature unavailable – activate advanced features". That was its **optional AWS-linking step**, which opens the AWS console to create an IAM user, and new-experience accounts can't do that. The Alexa login itself had worked: profile **`Hearth`** (token + vendor ID). Hearth doesn't need the link, because CDK deploys the Lambda with `AWS_PROFILE`. `.env` gets `ASK_DEFAULT_PROFILE=Hearth`, and `.env.example` documents the variable.

## Bootstrap (approved)

```text
$ cdk bootstrap aws://<account>/ap-southeast-2 --tags project=hearth      (run outside the app dir; CDK 2.1145.0)
✅ Environment bootstrapped.   CDKToolkit: CREATE_COMPLETE, tag project=hearth
   resources: S3 bucket + policy, ECR repository, 5 IAM roles, 2 IAM policies, SSM /cdk-bootstrap/hnb659fds/version = 32
```

## Skill (approved)

`ask smapi … --help` was checked first. The skill was created from a gitignored copy of the manifest **without** the placeholder endpoint (`.ask/skill.json`, `apis.custom = {}`):

```text
create-skill-for-vendor → amzn1.ask.skill.84758c3a-…   manifest: SUCCEEDED
set-interaction-model en-IN (development) → SUCCEEDED
  LANGUAGE_MODEL_QUICK_BUILD ✔ LANGUAGE_MODEL_FULL_BUILD ✔ DIALOG_MODEL_BUILD ✔ NAME_FREE_INTERACTION_BUILD ✔
.env HEARTH_SKILL_ID set → scripts/configure.sh: ✔ all set: hub laptop, region ap-southeast-2, locale en-IN, kill switches $1 / $5
```

## Deploy (approved after you saw `cdk diff`)

The diff was 23 additions, no modifications or replacements. IAM statements exactly as designed (hub cert: Connect/Subscribe/Receive/Publish on its own client and topics; skill role: Publish commands + GetItem + own logs; rule role: PutItem + rule-error logs; Lambda invoke only by alexa-appkit with your skill ID; Budgets execution role: attach/detach only the deny policy on the two roles).

```text
$ pnpm cdk deploy
✅ Hearth-laptop   Deployment time: 77.32s
Outputs: HubThingName = hearth-laptop · IotEndpoint = …-ats.iot.ap-southeast-2.amazonaws.com · SkillFunctionArn = arn:aws:lambda:ap-southeast-2:<account>:function:Hearth-laptop-SkillFunction… · two kill-switch action IDs
```

## aws M2 acceptance ✔

```text
$ aws iot-data publish --topic hearth/laptop/replies --payload '{"v":1,"requestId":"2464…","speech":"M2 acceptance test.","status":"ok"}'
$ aws dynamodb get-item … → {"expiresAt":"1792576963","v":"1","speech":"M2 acceptance test.","requestId":"2464…","status":"ok"}   TTL in 298 s
$ scripts/handoff.sh → out/hub.crt, out/hub.env
   subject=CN=hearth-laptop, O=Hearth · issuer=Amazon Web Services · notAfter=Dec 31 2049
   cert public key == hub CSR public key: yes   (the private key never left the laptop)
```

## Hub on real IoT Core (hub M1)

`hub.crt` installed, `config/hub.env` = handoff values + `INTENT=ollama`, `OLLAMA_MODEL=qwen2.5:3b`, `INTENT_TIMEOUT_MS=4300` (gitignored, 0600). `scripts/services.sh install --target aws` removed the local-stack units and points the hub at `config/hub.env`.

**Bug 1 (services.sh):** the aws branch called `render` with fewer arguments than `set -u` allows (`$3: unbound variable`). Fixed with `${3:-}` / `${4:-}`.

**Bug 2: the hub couldn't connect at all**, with an empty error message and silent closes, 9 attempts. I ruled out, without touching `hub.key`:

| Check | Result |
|---|---|
| TCP 8883 from bash; server cert vs Amazon Root CA 1 (`openssl s_client`, no client key) | reachable; `Verify return code: 0 (ok)` |
| cert status, attached policy and thing | ACTIVE; `hearth-laptop-policy`; `hearth-laptop` |
| `aws iot test-authorization` CONNECT / SUBSCRIBE | **ALLOWED** / **ALLOWED** |
| the hub's own relay over MQTT 3.1.1 and 5 | both fail the same way, so it isn't the protocol |
| the full error object | `AggregateError`: IPv4 `connect ETIMEDOUT 13.239.218.38:8883`, IPv6 `ENETUNREACH` |

The cause: **Node's "happy eyeballs" gives each address only 250 ms** (`net.getDefaultAutoSelectFamilyAttemptTimeout()` = 250), and the TCP connect from here to Sydney takes **0.37–0.40 s** (TLS done at 0.74–0.87 s; measured with curl). Node abandoned every IPv4 attempt that would have succeeded. The local stack on 127.0.0.1 could never show this. **Fix:** the relay passes `autoSelectFamilyAttemptTimeout: 3000`. Connected 4 s after restart: `"connected and subscribed","topic":"hearth/laptop/commands"`.

## hub M1 acceptance (first half) ✔

```text
publish hearth/laptop/commands {"text":"ping"}                     → DynamoDB reply {"speech":"Hub is online.","status":"ok"}
publish hearth/laptop/commands {"text":"how much space is left"}   → {"speech":"You have 141 gigabytes free out of 467, about 30 percent.","status":"ok"}
hub: ping 1489 ms (intent 1485) · disk_space 1953 ms (intent 1951)   ← the model on the GPU
```

The second half, "the relay reconnects on its own after I switch Wi-Fi off and on", is yours to do.

## Next

- Skill endpoint → Lambda ARN, enable testing in development, ASK simulation of "ask home hearth to ping" with the hub on and off (aws M3).
- Confirm the SNS subscription email; activate the `project` cost allocation tag in Billing.
