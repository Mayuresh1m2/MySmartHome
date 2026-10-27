#!/usr/bin/env python3
"""Capture the robot's cleaning-mode value for capture-and-replay (READ from robot, WRITE to secrets).

Why capture instead of decode: on dreame.vacuum.r2471 the cleaning-mode property (siid 4, piid 23) is
not a clean 0-3 enum but a *packed* integer whose layout depends on capability flags the vendor detects
at runtime (self_wash_base, mop_pad_lifting). Reconstructing it ourselves risks writing a wrong value to
the robot. Instead we record the exact integer the robot already reports when the Dreame app is set to the
mode we want, and replay that integer verbatim before a clean. See progress/43.

This script sends NO command and writes NOTHING to the robot. It does one get_properties read, checks the
robot is idle (a mid-job read can carry transient phase bits), and saves the value to the gitignored
secrets file. The adapter later replays it with set_property(4, 23, <value>).

Usage (robot docked/idle, and the Dreame app set to the mode you want to capture):
    uv run python scripts/capture_clean_mode.py                 # captures as mopping_after_sweeping, sets default
    uv run python scripts/capture_clean_mode.py --mode sweeping_and_mopping
    uv run python scripts/capture_clean_mode.py --mode mopping_after_sweeping --no-default
"""
from __future__ import annotations

import argparse
import json
import logging
import pathlib
import sys
import time

logging.disable(logging.CRITICAL)

HERE = pathlib.Path(__file__).resolve().parent
ADAPTER = HERE.parent
sys.path.insert(0, str(ADAPTER / "vendor"))
SECRETS = ADAPTER.parent.parent / "secrets"
SESSION = SECRETS / "vacuum_session.json"
STORE = SECRETS / "vacuum_clean_mode.json"

from dreamehome.protocol import DreameVacuumDreameHomeCloudProtocol  # noqa: E402

CLEANING_MODE = (4, 23)
STATUS = (4, 1)
# Statuses where the robot is parked and the mode value is the stable configured one (not mid-job).
IDLE_STATUS = {0: "idle", 6: "charging", 14: "sleeping", 17: "standby"}
# Friendly mode names, for the --mode choices and a human note in the stored file. The value we store is
# whatever the robot reports; the name is just a label for which app setting was active during capture.
KNOWN_MODES = {
    "sweeping": "vacuum only",
    "mopping": "mop only",
    "sweeping_and_mopping": "vacuum and mop in one pass (Dreame default)",
    "mopping_after_sweeping": "vacuum first, then mop — two separate passes",
}


def main() -> int:
    ap = argparse.ArgumentParser(description="Capture the robot's cleaning-mode value into secrets/.")
    ap.add_argument("--mode", default="mopping_after_sweeping", choices=sorted(KNOWN_MODES),
                    help="label for the app mode active right now (default: mopping_after_sweeping)")
    ap.add_argument("--no-default", action="store_true", help="capture this mode but don't make it the default")
    ap.add_argument("--allow-busy", action="store_true",
                    help="capture even if the robot isn't idle (NOT recommended: value may be transient)")
    args = ap.parse_args()

    try:
        sess = json.loads(SESSION.read_text())
    except Exception:
        print(f"ERROR: no session at {SESSION}; run login_probe.py first.", file=sys.stderr)
        return 2
    token, did, country, user = sess.get("auth_key"), sess.get("did"), sess.get("country"), sess.get("username")
    if not (token and did):
        print("ERROR: session missing token/did; re-run login_probe.py.", file=sys.stderr)
        return 2

    proto = DreameVacuumDreameHomeCloudProtocol(
        user or "", "", account_type="dreame", country=country or "sg", auth_key=token, did=str(did),
    )
    if not proto.login() or getattr(proto, "auth_failed", False):
        print("ERROR: token login failed. Re-run login_probe.py with DREAME_PASSWORD once.", file=sys.stderr)
        return 1
    try:
        proto.get_device_info()
    except Exception:
        pass

    batch = [{"did": str(did), "siid": s, "piid": p} for (s, p) in (STATUS, CLEANING_MODE)]
    try:
        results = proto.send("get_properties", batch, retry_count=1, timeout=15)
    except Exception as ex:
        print(f"ERROR reading properties: {type(ex).__name__}", file=sys.stderr)
        return 1
    by_sp = {
        (it.get("siid"), it.get("piid")): it.get("value")
        for it in (results or []) if isinstance(it, dict) and it.get("code") == 0 and "value" in it
    }
    status = by_sp.get(STATUS)
    value = by_sp.get(CLEANING_MODE)
    if value is None:
        print("No cleaning_mode returned (robot offline/asleep, or token expired). Wake it on its dock "
              "and retry.", file=sys.stderr)
        return 1
    try:
        status_int = int(status) if status is not None else -1
        value_int = int(value)
    except (TypeError, ValueError):
        print(f"ERROR: unexpected non-integer values status={status!r} cleaning_mode={value!r}", file=sys.stderr)
        return 1

    if status_int not in IDLE_STATUS and not args.allow_busy:
        print(f"Robot is not idle (status={status_int}); the cleaning_mode value can carry transient "
              f"mid-job bits. Dock it and let it settle, then retry (or pass --allow-busy to override).",
              file=sys.stderr)
        return 1

    store: dict = {}
    if STORE.exists():
        try:
            store = json.loads(STORE.read_text())
        except Exception:
            store = {}
    store.setdefault("device", sess.get("model", "dreame.vacuum.r2471"))
    store.setdefault("property", {"siid": CLEANING_MODE[0], "piid": CLEANING_MODE[1]})
    modes = store.setdefault("modes", {})
    modes[args.mode] = {
        "value": value_int,
        "note": KNOWN_MODES[args.mode],
        "captured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "status_at_capture": IDLE_STATUS.get(status_int, f"status {status_int}"),
    }
    if not args.no_default:
        store["default"] = args.mode

    SECRETS.mkdir(parents=True, exist_ok=True)
    STORE.write_text(json.dumps(store, indent=2) + "\n")
    print(f"Captured cleaning_mode for '{args.mode}' = {value_int} (robot {IDLE_STATUS.get(status_int, status_int)}).")
    print(f"Saved to {STORE} (gitignored).")
    if not args.no_default:
        print(f"Default clean mode is now '{args.mode}' ({KNOWN_MODES[args.mode]}).")
    print("Nothing was sent to the robot.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
