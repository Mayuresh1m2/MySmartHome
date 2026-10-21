# Hearth

Talk to your home through Alexa without opening your home to the internet.

| Project | What it is |
|---|---|
| [`hearth-aws/`](hearth-aws/README.md) | Alexa skill + Lambda + IoT Core identity (CDK). Deploy guide in its README |
| [`hearth-hub/`](hearth-hub/CLAUDE.md) | the home service: outbound mTLS to IoT Core, local model intent, allowlisted tools, policy, audit |
| [`hearth-devices/`](hearth-devices/CLAUDE.md) | local device platform: MQTT bus, adapter SDKs (Python/TS), registry, risk policy |
| `contracts/` | JSON Schemas + fixtures every side tests against |
| `local-stack/` | the whole system on one machine, no AWS needed |
| [`PLAN.md`](PLAN.md), [`progress/`](progress/README.md) | the plan, its approval gates, and a journal of every step with real output |

## Quick start (local, no AWS)

```bash
scripts/install-prereqs.sh              # what's present / missing (changes nothing)
scripts/install-prereqs.sh --system     # sudo part, in your own terminal (docker, compose, mosquitto-clients…)
scripts/install-prereqs.sh --user       # pnpm, uv, Ollama + model, workspace deps, hub key + CSR (no root)
pnpm local:up                           # IoT Core emulator + DynamoDB emulator + real skill + real hub
pnpm local:say "how much space is left"
pnpm hearth:trace <requestId>           # every log line for one request, across all services
pnpm local:down
pnpm test                               # all JS and Python tests
pnpm hearth:doctor                      # what's installed, configured and running
```

## Turning it off and on

The hub runs as systemd user services that start at boot (no login needed). When you don't need it:

```bash
scripts/services.sh stop     # hub, Ollama + model (frees ~2 GB VRAM, ~0.4 GB RAM), devices bus; stays off across reboots
scripts/services.sh start    # back on, and starting at boot again (model ready ~20 s later)
scripts/services.sh status
```

While it's off (or the laptop is asleep) Alexa says "Your home hub didn't answer in time. It might be offline." The
AWS side stays deployed. Closing the lid or idle sleep (on battery, after 15 min) suspends the laptop and the hub with it;
after resume the hub should notice the dead connection within about 30 s and reconnect by itself (as in the Wi-Fi
off/on test, progress/33). Suspend and resume itself is not tested yet.

## Wishlist

Ideas for where Hearth could go. None of them are started, and none need to be built the way they're described here. If one of them excites you, open an issue and say so. [CONTRIBUTING.md](CONTRIBUTING.md) explains how the project thinks about local testing, observability and safety.

- **More assistants.** Google Home, and whatever comes next. The hub shouldn't care which assistant is the front door.
- **Many more devices.** TVs, robot vacuums, kitchen appliances, plugs, lights, doorbells. Matter wherever possible, so one adapter covers many brands.
- **An adapter marketplace.** A catalog where anyone can publish an adapter for their device, and adding one to your hub is a single step, with what it can do and how risky it is shown up front.
- **Setup in minutes.** From a fresh machine to "Alexa, ask …" with one command and a guided walk through the AWS and Alexa steps.
- **See what your devices send out.** For each device on the network: who it talks to, how often, and how much.
- **Smaller hubs.** A Raspberry Pi or a mini PC instead of an old laptop, smaller models, and a good experience with no GPU at all.
- **More languages.** Hindi and other Alexa locales, and invocation names that are tested to be heard correctly.
- **The house talks back.** Announcements through the Echo when the doorbell rings or the dishwasher finishes.
- **A home dashboard.** Recent commands, device states and the hub's health on one local page.
- **Sleep-friendly.** A hub that survives the machine sleeping and waking without anyone noticing.
