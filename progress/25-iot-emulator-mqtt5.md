# 25 — Local IoT Core emulator on Mosquitto: the hub relay is now tested over MQTT 5

Date: 2026-10-21

## Why

Production uses MQTT 5 against AWS IoT Core, but aedes only speaks 3.1.1 (entry 05), so the relay had **never been tested with MQTT 5**. With Docker available, the local IoT emulator can run on Mosquitto.

## What was built (`local-stack/`)

- `deploy/compose.yaml` + `deploy/iot/mosquitto.conf`: the same digest-pinned `eclipse-mosquitto:2.0.22`, listener **127.0.0.1:8893**, TLS 1.2+, **`require_certificate true`**, **`use_identity_as_username`** (the certificate CN is the identity) and **`use_username_as_clientid`** (the client ID is forced to the CN, like `iot:Connect client/hearth-<hubId>`), no anonymous access.
- `scripts/iot-mosquitto.sh up|down|logs`: copies the local CA's broker cert, issues a `hearth-cloud` client cert (plays the Lambda's IoT Data Plane publish and the IoT rule), and writes the ACL **equal to the hearth-aws HubPolicy** (`hearth-laptop`: read commands, write replies; `hearth-cloud`: the reverse).
- `src/cloudClient.ts`: the stack's cloud side as an MQTT 5 mTLS client. `startLocalStack({externalIot})` uses it instead of in-process aedes. **`pnpm local:up` uses Mosquitto (MQTT 5) whenever Docker is usable**, and falls back to aedes (3.1.1) otherwise (`BROKER=aedes|mosquitto` overrides). `local:down` also stops the IoT container.
- `hearth-hub/test/relay.mqtt5.test.ts`: opt-in (`HEARTH_TEST_IOT_PORT=8893`, root `pnpm test:iot`), using throwaway certs signed by the local CA.

## Evidence

```text
$ HEARTH_TEST_IOT_PORT=8893 pnpm vitest run test/relay.mqtt5.test.ts
 ✓ connects with MQTT 5, subscribes, and answers a command with a contract-valid reply
 ✓ the IoT policy holds: the hub cannot publish to its commands topic (PUBACK 0x87)
 ✓ a certificate for another hub receives nothing and can publish nothing
 ✓ a client without a certificate is refused at the TLS layer
 ✓ reconnects and resubscribes after the broker restarts            (docker compose restart iot)
      Tests  5 passed (5)       ×3 runs, 2.8 s each
broker log: "OpenSSL Error … peer did not return a certificate" / "Client <unknown> disconnected"

$ pnpm --filter @hearth/hub test   → 130 passed | 5 skipped  (the MQTT 5 suite skips without the env var)

$ INTENT=ollama OLLAMA_MODEL=qwen2.5:3b pnpm local:up
hub log: {"mqtt":5,"port":8893,"intent":"ollama+keyword"}     control /status: {"iot":"mosquitto-mqtt5"}
> how much space is left     🗣 You have 142 gigabytes free out of 467, about 30 percent.   ok       2025 ms
> can you reach the router   🗣 The router is online.                                      ok       2460 ms
> unlock the front door      🗣 Sorry, I can't do that.                                    refused  2156 ms

$ pnpm hearth:trace a464d294-…
06:12:25.241 local-iot   publish hearth/laptop/commands
06:12:27.190 hearth-hub  command handled  stages {intent: 1943, policy: 0, tool: 3, total: 1949}  disk_space
06:12:27.193 local-iot   publish hearth/laptop/replies                  ← MQTT 5 reply leg: 2 ms
06:12:27.199 local-rule  reply_stored
06:12:27.264 local-skill command relayed ok 2025 ms

$ pnpm test → contracts 34 · skill 23 · hearth-aws 33 · local-stack 21 · devices-sdk/ts 12 · hearth-hub 130 (+5 opt-in) · hearth-devices 55
```

## Remaining differences from AWS IoT Core

- A disallowed **subscription** is granted but filtered per message (IoT Core fails the SUBACK). A denied **publish** gets PUBACK 0x87 without a disconnect (IoT Core disconnects). The hub only ever does allowed things, so this affects negative tests only.
- No IoT rule SQL engine. The stack's rule emulator applies the same `SELECT *, … AS expiresAt` logic in code.
