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
corepack enable pnpm && pnpm install
hearth-hub/scripts/make-csr.sh          # hub key + CSR (key stays on this machine)
pnpm local:up                           # IoT Core emulator + DynamoDB emulator + real skill + real hub
pnpm local:say "how much space is left"
pnpm hearth:trace <requestId>           # every log line for one request, across all services
pnpm local:down
pnpm test                               # all JS and Python tests
pnpm hearth:doctor                      # what's installed, configured and running
```
