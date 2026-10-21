# 24 — Real Mosquitto for the devices bus (PLAN E3, devices Phase 1 complete)

Date: 2026-10-21, after the re-login that activated the docker group.

```text
$ scripts/install-prereqs.sh  → 1 missing: ollama server not running   (mosquitto-clients installed; docker group active)
$ docker version → client 29.3.0 / server 29.1.3 (api 1.52)      $ docker compose version → 2.40.3
```

## What was built (`hearth-devices/`)

- `deploy/compose.yaml`: `eclipse-mosquitto:2.0.22`, **pinned by digest** (`sha256:199ea8ef…a21`, pulled 2026-10-21). Host networking per the devices spec, but the listener is **127.0.0.1:1883 only**. Runs **as your UID**, so the secret files stay 0600. `restart: unless-stopped`, with a healthcheck through a read-only `healthcheck` identity.
- `deploy/mosquitto/mosquitto.conf`: `allow_anonymous false`, password file, ACL file, persistence, connection logging.
- `scripts/bus-setup.sh [adapter …]`: random 48-hex-character passwords into `secrets/bus.env` (kept on rerun), a `passwd` file hashed with the image's own `mosquitto_passwd -U`, and an ACL generated to **mirror `local-stack/src/bus.ts`** (core, hub, healthcheck, one block per adapter). Everything is under the gitignored `secrets/`, dir 0700 and files 0600.
- `scripts/bus.sh up|down|logs|status`, plus root `pnpm bus:up`, `pnpm bus:down`, `pnpm test:mosquitto`.
- The shared pytest fixture can run against a real broker: `HEARTH_TEST_BUS_PORT=1883` uses that port and the passwords from `secrets/bus.env`.

## Security probes (host `mosquitto_pub`/`mosquitto_sub`, MQTT 5)

```text
LISTEN 127.0.0.1:1883                                           (not reachable from the LAN)
anonymous                               → Connection error: Not authorized
core, wrong password                    → Connection error: Not authorized
hub publishes devices/fake-lock/set     → PUBACK RC:135  "Publish 1 failed: Not authorized"
hub publishes core/request/hub          → PUBACK RC:16   (allowed; no subscribers at the time)
adapter-fake publishes adapters/tv/status → "Publish 1 failed: Not authorized"
adapter-fake subscribes hearth/local/#  → SUBACK granted, but per-message ACL applies:
      core published core/registry        → NOT delivered to the adapter
      core published devices/fake-lamp/set → delivered (the adapter may read set)
```

**Difference from the stand-in bus:** aedes refuses a disallowed subscription (SUBACK 0x80) and disconnects a client on a denied publish. Mosquitto grants the subscription and filters each message, and answers a denied publish with PUBACK 0x87 without disconnecting. The effect is the same: nothing outside the ACL is delivered or accepted. The bus-specific "disconnects on denied publish" tests therefore run only against the stand-in bus.

## Bug found by the real broker: adapters announced before subscribing

The acceptance test passed on a fresh Mosquitto, then failed **3 out of 3** on reruns with `{"ok": false, "error": "no result from adapter"}`. A probe showed the device online in the registry, but the `set` was never answered. The cause: both SDKs published status, meta and state **before** subscribing to `set`. Core sees "online" and sends a command at once, the command reaches the broker before the adapter's subscription exists, and it's dropped (clean sessions keep nothing). The in-process aedes bus was fast enough to hide it. **Fix (both SDKs):** subscribe to `set` first, then announce.

## Evidence

```text
$ pnpm bus:up        → Container hearth-devices-mosquitto-1 Healthy
mosquitto version 2.0.22 running · Opening ipv4 listen socket on port 1883
$ pnpm test:mosquitto            (before the fix: 1 failed, 5 passed ×3)
6 passed in 1.64s                (×3 after the fix: 1.64 / 1.63 / 1.63 s)
$ cd hearth-devices && uv run pytest -q          → 55 passed (stand-in bus)
$ pnpm --filter @hearth/devices-sdk test         → 12 passed
```

The Phase 1 acceptance (*"the fake adapter shows up in the registry, handles a set, publishes result and state, and goes offline cleanly through its last will"*) now passes **on Mosquitto with authentication**, together with the v1 request path (hub = voice, lock refused, payload can't claim its trust level). **Devices Phase 1 is done.**

## Next

Move the local IoT Core emulator to Mosquitto too (mTLS, client id = certificate CN, ACL = the IoT policy), so the hub's relay is finally tested with **MQTT 5**, the protocol it uses against AWS.
