# hearth-adapter-vacuum — Dreame L10 Prime

Controls the Dreame L10 Prime robot vacuum. It's paired to the **Dreamehome** app, which
disables the device's local command API, so control is **class 3 (Dreamehome cloud)** —
commands round-trip through Dreame's servers. (Private notes: `../../docs/private/devices/vacuum.md`.)

The reverse-engineered Dreamehome cloud protocol is vendored, unmodified, under
[`vendor/dreamehome`](vendor/dreamehome) (from [Tasshack/dreame-vacuum](https://github.com/Tasshack/dreame-vacuum),
MIT — see its `NOTICE.md`/`LICENSE`). `vendor/miio` is a tiny stub so the vendored import
resolves without the `netifaces` C-extension dependency we don't need.

## Credentials — password used once, never stored

The account **password is used exactly once** (from the env file below) to mint a
**revocable auth token**, and is **never written to disk**. Only that token — plus
non-secret metadata (username, region, did, model, mac) — is persisted, to
`secrets/vacuum_session.json` (mode 0600, gitignored). Change your Dreamehome password to
revoke the token. Later runs reuse the token and need no password.

```bash
cp adapters/vacuum/secrets-template/dreame.env.example secrets/dreame.env   # from hearth-devices/
$EDITOR secrets/dreame.env            # set DREAME_USERNAME + DREAME_PASSWORD (+ optional DREAME_COUNTRY)
chmod 600 secrets/dreame.env
adapters/vacuum/scripts/run.sh login_probe.py
# then blank DREAME_PASSWORD back out of secrets/dreame.env — it isn't needed again
```

`secrets/` is gitignored. `run.sh` sources the file into the process environment only; the
scripts disable the vendored library's logging and never print the password or the token.

Not encrypting the token at rest was a deliberate choice (vacuum account, and this box has
no TPM/LUKS, so a local-only key would mostly guard off-machine leaks). If that changes,
`systemd-creds` host-binding or a passphrase are the upgrade paths.

## Read-only probe (safe — moves nothing)

```bash
adapters/vacuum/scripts/run.sh login_probe.py
```

Logs in, lists the account's devices, finds the vacuum by MAC, and prints its **model
code** + battery/state. The full raw device list is saved to `secrets/vacuum_devices.json`
(mode 600, gitignored) for property-mapping, not to stdout.

## Read-only status

```bash
adapters/vacuum/scripts/status_probe.py        # uses the stored token; no password; nothing sent
```

Prints battery, charging, state, status, last-clean and mop/tank. Cloud reads go via
`send("get_properties", …)` over the command relay (confirmed for `dreame.vacuum.r2471`).

## Bus adapter

`hearth_adapter_vacuum` runs on the Hearth bus (contract v1) and exposes one device,
`vacuum` (kind `robot-vacuum`):

| Capability | Risk | Params | Does |
|---|---|---|---|
| `RvcRunMode` | medium | `{"mode": "idle" \| "cleaning"}` | `cleaning` → start a full auto clean (MIoT siid 2 / aiid 1); `idle` → return to dock (siid 3 / aiid 1) |
| `RvcOperationalState` | read | `{}` | current status, battery, error |

Reads go over the Dreamehome command relay (`get_properties`), the same path the status probe
uses. The action ids were taken from Tasshack's `DreameVacuumActionMapping` — note `START` is
**siid 2 / aiid 1**, not the `START_CUSTOM` (siid 4 / aiid 1) that needs map/zone params.

### Arming — the robot only moves when you say so

`execute()` is a **dry run by default**: it logs the action it *would* send and returns the
current state (so the whole Alexa → hub → bus chain can be exercised safely), but sends nothing
to the vacuum. Set `VACUUM_ARMED=1` in the adapter's environment to let real commands through.
The first armed run is done with the owner watching (medium risk; hearth-devices/CLAUDE.md).

```bash
BUS_PASSWORD=… uv run hearth-adapter-vacuum          # dry run (safe)
BUS_PASSWORD=… VACUUM_ARMED=1 uv run hearth-adapter-vacuum   # armed — real commands fire
```

Needs `secrets/vacuum_session.json` (minted by the login probe above). Tests:
`uv run pytest adapters/vacuum/tests` (no bus, no cloud).

## Status

Phase 2 (first real adapter): cloud path chosen; login/list + read-only status probes working;
the bus adapter (read + `RvcRunMode`) is built and unit-tested behind the arm gate. Next: an
end-to-end dry run (bus + core + hub, `DEVICES=mqtt`), then the first armed run with the owner
watching, then deploy the Alexa interaction-model change.
