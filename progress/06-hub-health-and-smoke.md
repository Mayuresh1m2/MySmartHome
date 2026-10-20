# 06 — Hub health and metrics endpoint, first live smoke test (PLAN B4)

Date: 2026-10-21

## Goal

Observability for the running hub: a status endpoint that answers "is it connected, is the model loaded, when was the last command?", plus Prometheus metrics. Then the first run of the **real hub process** against the local IoT Core emulator.

## `src/health/server.ts`

- Listens on **127.0.0.1 only**. The host is hard-coded rather than configurable, and a test asserts the bound address.
- `GET /health`: always 200, so it's readable while degraded: `{status: ok|degraded, hubId, uptimeSec, mqtt:{state,lastConnectedAt,lastError,reconnectAttempt}, modelLoaded, lastCommandAt}`.
- `GET /ready`: 200 when connected, **503** otherwise (for a supervisor or systemd later).
- `GET /metrics`: Prometheus text.
- Other methods get 405 and unknown paths 404.
- `modelLoaded` is `null` until the intent module exists (M3).

## New tooling

- `local-stack/src/cli/broker.ts` (`pnpm --filter @hearth/local-stack broker`): standalone emulator on 127.0.0.1:8884 with a JSON event log.
- `local-stack/scripts/smoke-relay.sh`: starts the broker and the real hub (`certs/hub.key` path + `.state/hub-local.crt`), checks health, kills the broker, checks degraded/503, restarts it, checks recovery, then dumps metrics.

## Issues hit

1. **My first ad-hoc smoke run killed its own shell.** `pkill -f "src/cli/broker.ts"` matched the bash process whose command line contained that string (exit 144), which left the hub orphaned. I cleaned up by PID. Fix: the smoke test is now a script that starts each process with `setsid` and kills by **process group**, so no pattern matching is involved.
2. **Duplicate error lines.** mqtt.js emitted the same `ECONNREFUSED` error twice per attempt. The relay now logs each *distinct* error once (still recorded in `lastError`).

## Evidence: `local-stack/scripts/smoke-relay.sh`

```text
== 1. connected
{"status":"ok","hubId":"laptop","uptimeSec":2,"mqtt":{"state":"connected",...,"reconnectAttempt":0},"modelLoaded":null,"lastCommandAt":null}
== 2. broker stopped
{"status":"degraded",...,"mqtt":{"state":"reconnecting","lastError":"connect ECONNREFUSED 127.0.0.1:8884","reconnectAttempt":3},...}
ready=503
== 3. broker restarted
{"status":"ok",...,"mqtt":{"state":"connected",...,"reconnectAttempt":0},...}
ready=200
== metrics
hearth_hub_mqtt_connected 1
hearth_hub_mqtt_reconnects_total 3
```

Hub log during the outage (backoff with jitter: 627 ms → 1130 ms → 3226 ms):

```text
{"level":30,"svc":"hearth-hub","stage":"relay","topic":"hearth/laptop/commands","msg":"connected and subscribed"}
{"level":40,"svc":"hearth-hub","stage":"relay","msg":"mqtt connection closed"}
{"level":30,"svc":"hearth-hub","stage":"relay","attempt":1,"delayMs":627,"msg":"reconnect scheduled"}
{"level":30,"svc":"hearth-hub","stage":"relay","attempt":2,"delayMs":1130,"msg":"reconnect scheduled"}
{"level":30,"svc":"hearth-hub","stage":"relay","attempt":3,"delayMs":3226,"msg":"reconnect scheduled"}
{"level":30,"svc":"hearth-hub","stage":"relay","topic":"hearth/laptop/commands","msg":"connected and subscribed"}
{"level":30,"svc":"hearth-hub","sig":"SIGTERM","msg":"shutting down"}
```

Broker event log:

```text
{"svc":"local-iot","evt":"broker_listening","port":8884,"hubId":"laptop"}
{"svc":"local-iot","evt":"client_connected","clientId":"hearth-laptop"}
{"svc":"local-iot","evt":"client_disconnected","clientId":"hearth-laptop"}
{"svc":"local-iot","evt":"broker_listening","port":8884,"hubId":"laptop"}
{"svc":"local-iot","evt":"client_connected","clientId":"hearth-laptop"}
```

`pnpm hearth:doctor` now shows `✔ hub health: {"mqtt":{"state":"connected",...}}` while the hub runs.

Unit tests: 42 passed (5 new health tests: bind address, ok/ready, degraded/503, metrics, 405/404).

Note: pino timestamps are UTC (`Z`). The machine is in IST (+05:30).
