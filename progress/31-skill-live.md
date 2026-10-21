# 31 — The skill is live in development (aws M3 acceptance)

Date: 2026-10-21

## Steps

`ask smapi … --help` was checked for each command first. Profile `Hearth` came via `ASK_DEFAULT_PROFILE`.

```text
endpoint: jq sets .manifest.apis.custom.endpoint.uri = SkillFunctionArn (stack output) in the gitignored .ask/skill.json
ask smapi update-skill-manifest -s <skill> -g development --manifest file:.ask/skill.json → manifest SUCCEEDED (errors null, warnings null)
ask smapi set-skill-enablement -s <skill> -g development → Command executed successfully!
```

The committed `skill-package/skill.json` keeps its placeholder, so no account or Lambda ARN is committed.

## Acceptance: an ASK CLI simulation of "ask home hearth to ping" (device locale en-IN)

```text
== hub ON   {"mqtt":"connected","modelLoaded":true}
{"status":"SUCCESSFUL","invoked":"CommandIntent","slot":"ping","speech":"<speak>Hub is online.</speak>"}
{"status":"SUCCESSFUL","invoked":"CommandIntent","slot":"how much space is left","speech":"<speak>You have 141 gigabytes free out of 467, about 30 percent.</speak>"}
== hub OFF (systemctl --user stop hearth-hub)
{"status":"SUCCESSFUL","slot":"ping","speech":"<speak>Your home hub didn't answer in time. It might be offline.</speak>"}
== hub back ON after ~5s

Lambda log ("command relayed", CloudWatch, last 10 min):
{"outcome":"ok","latencyMs":2650,"textLength":4,"hubId":"laptop"}
{"outcome":"ok","latencyMs":2738,"textLength":22,"hubId":"laptop"}
{"outcome":"timeout","latencyMs":5003,"textLength":4,"hubId":"laptop"}
```

- **aws M3 is done:** the fallback while the hub is off, and the hub's reply while it runs.
- End-to-end in the cloud, ~2.7 s per command with the model (Alexa allows ~8 s). The timeout fires at exactly the 5 s reply budget.
- Logs carry `textLength`, not the utterance (`DEBUG_UTTERANCES=false`), as specified.

## What's left, and whose it is

| Item | Who |
|---|---|
| **Real Echo:** "Alexa, ask home hearth how much space is left" (hub M2 acceptance) | you |
| Wi-Fi off → on, then check the hub reconnects (`curl 127.0.0.1:8787/health`) (hub M1 second half) | you |
| Confirm the AWS SNS subscription email (alarm emails) | you |
| Billing → Cost allocation tags → activate `project` (the Hearth kill switch) | you |
| settings.aws.com → project **spend limit** (the hard stop, minimum $20) | you |
| Reboot test against real IoT Core (hub M4 with real Alexa) | you, then me to verify |
| Review `hearth-aws/docs/runbook.md` (aws M4) and the manifest's privacy answers | you |
| Delete `backup/pre-email-rewrite` once you're happy (old history, local only) | you |

`pnpm local:up` still works for development, but its hub would collide with the service on 127.0.0.1:8787. Stop the service first (`systemctl --user stop hearth-hub`) or use another `HEALTH_PORT`.
