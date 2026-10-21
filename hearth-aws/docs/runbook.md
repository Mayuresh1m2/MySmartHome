# Hearth AWS runbook

Region `eu-west-1`, stack `Hearth-<hubId>`. Every command uses the AWS CLI's configured profile.
Anything that deletes, replaces or deactivates something in AWS needs the owner's explicit go-ahead. Those steps are marked **⚠ ask first**.

## Daily health

| Question | Where |
|---|---|
| Is the hub answering? | Dashboard `hearth-<hubId>` → *Commands by outcome*. A rising `timeout` means the hub is offline or slow. |
| How fast? | Dashboard → *Reply latency* p50/p95, with the `REPLY_TIMEOUT_MS` line. |
| Did the Lambda break? | Alarm `SkillErrors` (emails `budgetEmail`). Hub timeouts are *not* errors; they're answered honestly. |
| Did a reply fail to reach the table? | Log group `…RuleErrors…`, the IoT rule's error action. |
| One request in detail | Skill log group, filter `{ $.requestId = "<id>" }`. On the hub: `pnpm hearth:trace <id>` (local stack) or `grep <id> hearth-hub/data/audit/*.jsonl`. |
| Spend | Budget `hearth-<hubId>-monthly` emails when actual spend passes $5. |

The alarm emails go through an SNS email subscription. **AWS sends a confirmation email after the first deploy, and alerts arrive only after someone clicks it.**

## Kill switch tripped

The symptom: Alexa always answers "Your home hub didn't answer in time", the hub is healthy, and an email from AWS Budgets says the action ran. The `KillSwitchDeny` policy is attached to the skill and rule roles.

```bash
scripts/kill-switch.sh show                 # both limits + which action ran
# find out why first: Cost Explorer (tag project=hearth for the Hearth switch, whole account for the other)
scripts/kill-switch.sh set hearth 3         # or: set account 10, if a limit should simply be higher (then test → diff → deploy)
scripts/kill-switch.sh reset hearth         # ⚠ ask first: detaches the deny policy (reset account for the other)
```

It trips again within the same month if Hearth's cost is still above the limit.

## Deploy

```bash
pnpm install
pnpm test && pnpm cdk synth            # must pass
pnpm cdk diff                          # show the diff to the owner, wait for go-ahead
pnpm cdk deploy                        # guarded: asks for permission
scripts/handoff.sh                     # writes out/hub.crt and out/hub.env
```

## Debugging utterances

Utterance text isn't logged by default; only its length is. To log it temporarily, set `"debugUtterances": true` in `config/local.json`, then run diff and deploy. Afterwards, set it back to `false` and deploy again. Logs are kept 14 days.

## Certificate rotation

The hub's identity is an X.509 certificate issued from a CSR generated on the hub machine. The private key never leaves that machine, so rotating means **a new key and CSR on the hub, a new certificate in AWS, switching the hub over, and only then deactivating the old certificate.**

Certificates are a named list in `config/local.json`. Each name maps to its own CloudFormation resource, so **adding a certificate never replaces an existing one.** Keep the first one named `primary`: that name maps to the original resource ids.

Before (implicit single certificate):

```json
{ "csrPath": "/…/hearth-hub/certs/hub.csr" }
```

### 1. New key and CSR on the hub machine

```bash
cd hearth-hub
scripts/make-csr.sh --dir certs/next      # writes certs/next/hub.key (600) and certs/next/hub.csr
```

The live `certs/hub.key` is untouched, and the script refuses to overwrite a key.

### 2. Issue the new certificate (both active)

```json
{
  "csrPath": "/…/hearth-hub/certs/hub.csr",
  "certificates": [
    { "name": "primary", "csrPath": "/…/hearth-hub/certs/hub.csr", "active": true },
    { "name": "r2026b",  "csrPath": "/…/hearth-hub/certs/next/hub.csr", "active": true }
  ]
}
```

```bash
pnpm test && pnpm cdk diff     # expect: + HubCertificater2026b and its two attachments; nothing replaced
pnpm cdk deploy
scripts/handoff.sh r2026b      # writes out/hub-r2026b.crt
```

### 3. Switch the hub

On the hub machine:

```bash
cp out/hub-r2026b.crt hearth-hub/certs/next/hub.crt
cd hearth-hub/certs
mkdir -p old && mv hub.key hub.csr hub.crt old/      # keep until step 5
mv next/hub.key next/hub.csr next/hub.crt .
chmod 600 hub.key
# restart the hub (systemd: systemctl --user restart hearth-hub)
curl -s 127.0.0.1:8787/health                       # mqtt.state must be "connected"
```

Then check end to end: "Alexa, ask home hearth to ping" should answer "Hub is online."

If the hub doesn't connect, move `old/*` back and restart. The old certificate is still active, so rollback is instant.

### 4. Deactivate the old certificate ⚠ ask first

Set `"active": false` on `primary`, then:

```bash
pnpm cdk diff     # expect: HubCertificate Status ACTIVE → INACTIVE (modify, not replace)
pnpm cdk deploy
```

Any client still using the old key is now refused. Watch the dashboard for a few minutes.

### 5. Remove the old certificate ⚠ ask first (later, after a quiet period)

Remove the `primary` entry. CloudFormation detaches it and deletes it. Make the rotated certificate the first entry, but **keep its name** (`r2026b`): renaming it would replace it. Then on the hub, delete `certs/old/` (`shred -u certs/old/hub.key`).

### If the hub key is ever exposed

Run steps 1 to 3 immediately, then step 4 right away instead of after a quiet period. Deactivating the exposed certificate is the actual revocation: an INACTIVE certificate can't connect. Then review the hub audit log and the IoT CloudWatch logs for connections you don't recognise.

## Hub offline

1. `curl 127.0.0.1:8787/health` on the hub machine. Look at `mqtt.state` and `lastError`.
2. `lastError` containing `Not authorized` or a TLS error: the certificate is inactive or missing, or `hub.crt` doesn't match `hub.key`.
3. `subscribe failed`: the hubId in `config/hub.env` doesn't match the IoT policy (`hearth-<hubId>`).
4. `ECONNREFUSED` or `ENOTFOUND`: network or DNS. The relay retries with backoff (up to 60 s).

## Skill

The skill stays in development. Never submit it for certification or publishing. Deleting the skill is **⚠ ask first**.
