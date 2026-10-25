# 38 — Vacuum (Dreame L10 Prime): discovery, path decision, cloud adapter scaffold

Phase 0 for the robot vacuum. Device specifics (model, MAC, account) live in the gitignored
`hearth-devices/docs/private/devices/vacuum.md`; this entry keeps the method and evidence.

## Network discovery

Scanned the owner's HomE subnet from the hub (ping sweep + neighbor cache, miio UDP-54321
hello, mDNS). Asleep: nothing answered. After the owner woke the vacuum it appeared and
answered the **miio hello** reliably (device id + rising uptime stamp), MAC OUI → Xiaomi,
no TCP ports open (miio is UDP-only).

Pure-Python probes (`zeroconf` added to the venv; raw UDP for miio/SSDP) — no root, no
system packages, no nmap.

## Why cloud, not local

The miio hello is only the discovery ping; it does **not** prove local command control.
Confirmed by reading the Tasshack `dreame-vacuum` protocol: a Dreamehome-paired device is
driven **entirely over cloud MQTT** (TLS + ECDH + signing), and Dreamehome disables the
device's local command API. So for this unit there is no local path short of rooting
(Valetudo — model not confirmed supported, needs UART + disassembly) or a disruptive
hard-reset to Mi Home. Owner chose **class 3 (Dreamehome cloud)** now, Valetudo as a
possible future "make it fully local" project. This is the one device that leans on a
vendor cloud; recorded as a knowing exception to Hearth's local-first rule.

## Adapter scaffold (`hearth-devices/adapters/vacuum/`)

- Vendored the proven Dreamehome protocol **unmodified** (Tasshack, MIT, commit `f5b8472`):
  `vendor/dreamehome/{protocol.py,exceptions.py}` + a minimal `types.py` (just
  `RestartableTimer`) + attribution in `NOTICE.md`/`LICENSE`. Endpoints stay obfuscated in
  the upstream `DREAME_STRINGS` blob (verified it decodes to a 91-entry table) — no Dreame
  URLs in plaintext in this public repo.
- `vendor/miio` is a deliberate stub: the vendored import `from miio.miioprotocol import
  MiIOProtocol` is only used by the unused *local* class, so stubbing it drops the real
  `python-miio` and its `netifaces` C-extension. Result: **all deps are wheels, no native
  compilation** (would have needed Python.h / a compiler, i.e. sudo).
- Credentials handling per the owner's instruction — injected as env vars, **not viewed,
  not committed, not logged**: `scripts/run.sh` sources a gitignored `secrets/dreame.env`
  into the process env; `scripts/login_probe.py` disables the library's logging and prints
  only non-sensitive fields; the raw device list goes to `secrets/vacuum_devices.json`
  (mode 600), never stdout.
- **Secrets at rest (owner's choice): don't store the password.** The password is read from
  env once, used to mint a **revocable** Dreamehome auth token, and never written to disk.
  Only the token + non-secret metadata persist to `secrets/vacuum_session.json` (0600);
  later runs reuse the token with no password. No encryption layer was added: this box has
  **no TPM and no LUKS**, so a local-only key would mainly guard off-machine leaks, not a
  local-root compromise. Noted upgrade paths if wanted: `systemd-creds` host-binding
  (unattended, machine-bound) or a passphrase (max secrecy, not unattended); and enabling
  full-disk encryption is the real at-rest fix. Revoke the token by changing the password.

## Evidence

```
$ uv sync --all-packages        # after dropping python-miio, adding the miio stub
… no gcc / Python.h / native build …
$ .venv/bin/python -c "import paho.mqtt,Crypto,cryptography,requests; \
    import sys; sys.path.insert(0,'adapters/vacuum/vendor'); \
    from dreamehome.protocol import DreameVacuumDreameHomeCloudProtocol as P; P('x','y',account_type='dreame',country='sg')"
OK: deps + vendored Dreamehome protocol import & construct
$ .venv/bin/python adapters/vacuum/scripts/login_probe.py      # no creds
ERROR: set DREAME_USERNAME and DREAME_PASSWORD … Nothing was sent.   (exit 2)
$ adapters/vacuum/scripts/run.sh login_probe.py                 # no env file
missing …/secrets/dreame.env …                                       (exit 1)
$ uv run ruff check adapters/vacuum/        # vendor excluded in root ruff config
All checks passed!
```

## Probe result (2026-10-25)

Owner added `secrets/dreame.env`; ran `scripts/run.sh login_probe.py`.
- Region `in` failed; **`sg` succeeded** (Dreame serves India from Singapore).
- One device: name "Vaccum", **model `dreame.vacuum.r2471`**, MAC **70:C9:32:E4:EC:D9**,
  did `2034776152`, online.
- **Password worked once and was NOT stored**; the revocable token (+ username, region,
  did, model, mac) persisted to `secrets/vacuum_session.json` (0600, gitignored, no
  password field). A second run with the password blanked logged in **via the stored
  token** — password-less reuse confirmed.
- Correction: the cloud MAC (70:c9:32) differs from the LAN miio-responder at .167
  (`dc:ed:83`), so that LAN device is a different Xiaomi unit, not the vacuum. Corrected in
  `network.md` and `devices/vacuum.md`.

## Read-only status mapping (2026-10-25) — works

`scripts/status_probe.py` reads live status with the stored token (no password). Learned
that cloud reads go over the command relay via `send("get_properties", [{did,siid,piid}])`,
not the bare `get_properties()` endpoint (which returned empty); call `get_device_info()`
once after login to set the host shard. SIID/PIID confirmed for r2471 (STATE 2/1, ERROR
2/2, BATTERY 3/1, CHARGING 3/2, STATUS 4/1, CLEANING_TIME 4/2, CLEANED_AREA 4/3, SUCTION
4/4, WATER_VOLUME 4/5, WATER_TANK 4/6, TASK 4/7).

First reading: charging-completed / sleeping (on dock) / 100% / no error / task complete /
mop attached — i.e. online + idle, which satisfies the medium-risk gate.

## Next

Wire the actual commands (start = "clean my house", return-to-dock) behind the Hearth bus
+ policy (medium risk, require online + idle). Confirm the action aiids against the MIoT
spec, and **confirm with the owner before the first real command is sent.** Owner can blank
`DREAME_PASSWORD` out of `secrets/dreame.env` now.

---
(historical) Was blocked on the owner creating `secrets/dreame.env` (template in
`adapters/vacuum/secrets-template/`). Then run the read-only probe to confirm the model
code and that login/region work, record outbound endpoints + offline behaviour, map the
RVC properties, and only then build the adapter and the "clean my house" action behind the
bus and policy (start/stop = medium, online + idle).
