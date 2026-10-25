# Vendored: Dreamehome cloud protocol (from Tasshack/dreame-vacuum)

Why: the Dreame L10 Prime is paired to the **Dreamehome** app, which disables the
device's local command API. The only non-rooting way to control it is Dreame's cloud
(MQTT over TLS, with request signing). Rather than re-implement that reverse-engineered
protocol — and rather than publish Dreame's endpoints in plaintext — Hearth vendors the
proven implementation **unmodified**. The endpoint/header table stays obfuscated inside
`protocol.py` (`DREAME_STRINGS`, a base64+gzip blob) exactly as upstream ships it.

Source
: https://github.com/Tasshack/dreame-vacuum
Commit
: `f5b8472b8e2e4bb3dff7bc2a81a5fd594eca9585`
License
: MIT (see `LICENSE`), Copyright (c) 2022 Tasshack
Path upstream
: `custom_components/dreame_vacuum/dreame/`

Files vendored
- `protocol.py` — verbatim. The Dreamehome + Mi Home cloud protocols and the local miio
  wrapper. Self-contained: endpoints decode from `DREAME_STRINGS` at runtime.
- `exceptions.py` — verbatim. `DeviceException` and friends, imported by `protocol.py`.
- `types.py` — **not** verbatim: a minimal stub exposing only `RestartableTimer` (the one
  symbol `protocol.py` imports from the upstream 215 KB `types.py`). Class body copied
  verbatim; see the file header.

Not vendored: `device.py`, `map.py`, `const.py`, `resources.py` (the Home-Assistant-facing
device model, map decoder and 27 MB of embedded images) — Hearth drives the cloud protocol
directly and maps capabilities itself.

Runtime deps (installed via this adapter's `pyproject.toml`): `paho-mqtt`, `pycryptodome`,
`cryptography`, `requests`, `python-miio`.

Updating: re-copy `protocol.py` and `exceptions.py` from a newer commit, re-check that
`protocol.py` still imports only `RestartableTimer` from `.types` and `DeviceException`
from `.exceptions`, bump the commit above, and re-run `scripts/login_probe.py`.
