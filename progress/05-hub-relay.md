# 05 — Hub relay and the local IoT Core emulator (PLAN B3)

Date: 2026-10-21

## Goal

The relay: an MQTT client to IoT Core over mutual TLS, with clean session, QoS 1 and reconnect with backoff. It validates every payload and applies the staleness and duplicate rules. It's proven against a local broker that enforces the IoT policy.

## Finding: aedes has no MQTT 5

`aedes@1.2.0/README.md:81`: *"MQTT 5.0 (not support yet)"*. The spec asks for an MQTT 5 client.

**Decision:** add `MQTT_PROTOCOL_VERSION` (default **5** for IoT Core; local-stack sets **4**). The relay uses only behaviour common to both versions (clean start, QoS 1, plain publish/subscribe, no v5 properties), so emulator fidelity is preserved. Once Docker or apt access (G1) is granted, Mosquitto can replace aedes and run MQTT 5 with mTLS and ACLs.

## `local-stack/src/broker.ts`: IoT Core emulator

- A TLS server with `requestCert` + `rejectUnauthorized`. The client cert CN must equal the client ID, which must be `hearth-<hubId>` (emulating `iot:Connect client/hearth-<hubId>` on the attached cert).
- Subscribe is allowed only on `hearth/<hubId>/commands`; anything else gets **SUBACK 0x80**, as IoT Core does.
- A publish outside `hearth/<hubId>/replies` **disconnects** the client, as IoT Core does.
- The "cloud" publishes and subscribes in-process (`publish()`, `onMessage()`), the way the Lambda (IoT Data Plane) and the IoT rule do.
- Every connect, deny, publish (with `requestId` and size) and TLS error is logged as a JSON event.
- `testCerts.ts` builds a throwaway PKI per test run with the same `local-ca.sh`. Tests never touch the real `hub.key`.

Issues hit:

- `aedes.clients` isn't in the 1.x type definitions, so clients are tracked through the `client`/`clientDisconnect` events.
- mqtt.js 5 **rejects** `subscribeAsync` on SUBACK 0x80. That shaped the relay: a refused subscription is logged as a config/policy mismatch, the connection is closed, and the relay retries with backoff, staying visible in `/health` and metrics.

## `hearth-hub/src/relay/relay.ts`

- `reconnectPeriod: 0`. Reconnects are driven by the relay with exponential backoff and "equal jitter" (1 s → 60 s cap), and the attempt counter resets on connect.
- **Resubscribes on every connect**, because of the clean session.
- keepalive 30 s (the IoT Core minimum) to detect a dead Wi-Fi link quickly. connectTimeout 10 s.
- Pipeline entry: `parseCommand` → `CommandGuard.check` → `handlers.onCommand` → publish the reply (QoS 1). Drops are counted under `hearth_hub_commands_total{outcome=not_json|wrong_version|invalid|stale|future|duplicate}` and logged with `requestId`.
- Key, cert and CA are read from their paths straight into mqtt.js's TLS options. Nothing else references the key. Logger redaction is a second line of defence.
- `status` (state, lastConnectedAt, lastError, reconnectAttempt) is exposed for `/health` (B4).

`src/index.ts` wires config, logger, metrics and relay, with the M1 behaviour: reply "Hub is online." to every command.

## Evidence

```text
$ pnpm --filter @hearth/local-stack test     # emulator ACLs
 ✓ accepts the hub with matching cert CN and client id
 ✓ rejects a client id other than hearth-<hubId> (iot:Connect)
 ✓ rejects the right client id presented with another cert
 ✓ rejects a TLS client without a certificate
 ✓ allows subscribing only to the commands topic
 ✓ delivers cloud commands to the hub and hub replies to the cloud
 ✓ disconnects a hub that publishes outside its replies topic (iot:Publish)
      Tests  7 passed (7)

$ pnpm --filter @hearth/hub test
 ✓ relay: connects, subscribes and answers a command with a contract-valid reply
 ✓ relay: drops malformed, wrong-version, stale and duplicate commands without replying
 ✓ relay: reconnects and resubscribes after the connection drops
 ✓ relay: backs off while the broker is down and recovers when it returns
      Tests  37 passed (37)

$ for i in 1..5; vitest run test/relay.integration.test.ts     # flakiness check
      Tests  4 passed (4)  ×5   (1.9–2.2 s each)
```

The real-network acceptance (IoT Core, plus Wi-Fi off and on) is in Phase G, behind gates G3/G4. Locally, "Wi-Fi off/on" is covered by `dropClients()` and by a broker stop/start on the same port.
