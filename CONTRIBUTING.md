# Contributing to Hearth

Hearth started as one person's home hub, built in the open. If you want to add a device, an assistant, a tool or just fix something, you're welcome here. This page is less about process and more about how the project thinks, so that what you build fits.

## The philosophy

**Nothing at home is reachable from the internet.** The hub only ever dials out. No port forwarding, no inbound listeners except a health endpoint on 127.0.0.1. Any feature that needs an inbound connection needs a very good reason and a design discussion first.

**Local first.** Prefer the most local way to talk to a device: a documented LAN API or Matter, then an unofficial LAN protocol, and the vendor's cloud only when there's nothing else. Write down which one you found and why, before writing code.

**The model chooses, code acts.** The language model only picks a tool and its arguments, or refuses. Tools are typed functions with validated arguments. There is no shell tool, and tool output never goes back into the model.

**Deny by default.** A tool or device action that isn't explicitly enabled in policy is refused, even if the model picks it. Nothing that can cause harm (unlocking, heating, opening, anything on a car) is reachable by voice.

**Your data and your details stay yours.** Per-person values (emails, account IDs, endpoints, device addresses, models) live in gitignored files such as `.env` and `hearth-devices/docs/private/`. Committed files use placeholders. Keys are created on the machine that uses them and never leave it.

**Cheap to run.** A few questions a day should cost close to nothing. Prefer pay-per-use services, avoid always-on cloud infrastructure, and keep the kill switches working.

## Test it locally

You shouldn't need an AWS account, an Echo or the real device to work on Hearth.

- `pnpm local:up` runs the whole system on one machine: an emulated IoT Core broker with mTLS, an emulated DynamoDB, the real skill handler and the real hub. `pnpm local:say "how much space is left"` talks to it like Alexa would. (If the hub is installed as a service, `scripts/services.sh stop` first, since both use port 8787.)
- `contracts/` holds JSON Schemas and fixtures for both contracts (cloud to hub, and hub to devices). Change a contract there first, then both sides in the same change, and the drift tests keep them honest.
- New device work starts with recorded fixtures and the fake adapter, so it can be tested without the device on the network.
- `pnpm test` runs every JS and Python test. Changes come with tests, including the cases that must be refused.
- Changing the model, the system prompt or a tool description? Run `pnpm eval` in `hearth-hub/` before and after, and include both numbers.

## Make it observable

If something goes wrong at 11 pm, the logs should say what happened without anyone attaching a debugger.

- Every command carries one `requestId` from Alexa to the device and back. Log it at every stage, along with latency and outcome. `pnpm hearth:trace <requestId>` stitches one request together across all services.
- Log what happened, not what was said: utterance text is off by default.
- The hub exposes `/health`, `/ready` and `/metrics` on 127.0.0.1. New components should report their state the same way.
- `pnpm hearth:doctor` should be able to tell a newcomer what's installed, configured and running. If your change adds a moving part, teach the doctor about it.

## Show your evidence

The `progress/` journal records every step with the commands that were run and their real output. When you open a pull request, do the same in its description: what you changed, how you tested it, and the output that shows it works. "It works on my machine" is a fine start, as long as the output is attached.

## Safety around real homes

- Only scan or probe networks and devices you own.
- Never flash, root, factory-reset or change a device's network settings as part of a default flow. If an adapter needs that, it must be an explicit, documented, opt-in step.
- If a device only works through an undocumented API, say so clearly in its docs and in the pull request.
- Never commit secrets, tokens, certificates, `.env`, `out/`, `certs/` or `secrets/`.

## Where to start

The [wishlist in the README](README.md#wishlist) lists ideas nobody has picked up yet. Open an issue to say which one you're taking on, or to suggest something new.
