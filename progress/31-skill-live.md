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

## Real Echo, and a new invocation name

- **"Alexa, open home hearth" → "how much space is left" worked on your Echo:** Lambda log `15:48:12 {"outcome":"ok","latencyMs":2890,"textLength":22}`, hub `disk_space` via the model in 1967 ms. That's **hub M2's acceptance on real hardware.**
- The one-shot **"Alexa, ask home hearth how much space is left"** answered "I'm not sure how to help", and that request **never reached the Lambda** (only my 3 simulations appear in the invocations metric). The account was fine, since the skill showed in your Alexa app's Dev tab. English (India) speech recognition was missing the rare word "hearth" inside a sentence.
- Amazon's invocation-name rules (developer.amazon.com, "Choose the invocation name"): at least two words unless it's your own brand; a person's name needs another word; no Alexa/Echo/skill/app; must not infringe others' IP (enforced at certification). On "Jarvis": Marvel's character, so not for a published skill; it's also one word and has many published namesakes. You chose a Hindi name instead: **`chowkidar ji`** ("watchman"; spelled the common Indian-English way so the transcription matches).
- Changed: interaction model `invocationName`, manifest name "Chowkidar Ji (Hearth)" and example phrases, the hearth-aws/CLAUDE.md invocation rule (with the reason), README/runbook/spec text, the skill-package test (asserts two words), and the Lambda's help sentence (deploys with the next `cdk deploy`).

```text
set-interaction-model en-IN → SUCCEEDED (errors null) · update-skill-manifest → SUCCEEDED
simulate "ask chowkidar ji to ping"                 → IntentRequest slot "ping" → "Hub is online."
simulate "ask chowkidar ji how much space is left"  → "You have 141 gigabytes free out of 467, about 30 percent."
simulate "open chowkidar ji"                        → LaunchRequest → "Hearth is ready. What should I ask your home hub?"
```

## Second rename: `ramesh dude`

- "chowkidar ji" also failed on your Echo. CloudWatch showed **no Echo invocations** after the rename, only my 3 simulations at 15:56.
- **Your method:** dictate the phrase in the phone's voice mode and read the transcript. "chowkidar ji" and "bhai" weren't transcribed reliably; **"Ramesh dude" came out exactly, every time.** "Ramesh" alone isn't allowed (one word; a person's name needs another word), so the name is **`ramesh dude`**.
- The hearth-aws/CLAUDE.md invocation rule now records the history and the test method: check the whole phrase in voice mode before changing the name. (My scripted rename briefly garbled that history sentence; fixed.)

```text
set-interaction-model → SUCCEEDED · update-skill-manifest → SUCCEEDED (display name "Ramesh Dude (Hearth)")
simulate "ask ramesh dude how much space is left" → IntentRequest → "You have 141 gigabytes free out of 467, about 30 percent."
simulate "ask ramesh dude to ping"                → "Hub is online."
simulate "open ramesh dude"                       → LaunchRequest → "Hearth is ready. What should I ask your home hub?"
```

The deploy you stopped (help sentence only) is still pending; it now carries "ramesh dude".
