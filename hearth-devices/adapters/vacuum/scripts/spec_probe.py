#!/usr/bin/env python3
"""One-off, READ-ONLY confirmation of the Dreame vacuum's cleaning-mode property.

Why this exists: the adapter's clean command only sends the plain full-auto START and never sets a
cleaning mode, so the robot runs whatever mode the Dreame app last had (its default). To add mode
selection (RvcCleanMode) we need to confirm, on this exact robot, the cleaning-mode property.

From Tasshack/dreame-vacuum @ f5b8472 (the source the vendored library is cut from), the mapping is:
  CLEANING_MODE = siid 4, piid 23   values: 0 sweeping, 1 mopping, 2 sweeping_and_mopping (one pass),
                                            3 mopping_after_sweeping (two passes: vacuum then mop)
  SUCTION_LEVEL = siid 4, piid 4    WATER_VOLUME = siid 4, piid 5
This probe READS those (plus state/status) in a single small batch and prints them in words. No action,
no set_property, no MQTT command is ever sent. Nothing on the robot moves or changes.

Run it ONCE with the robot idle, docked and online:
    uv run python scripts/spec_probe.py
It should print cleaning_mode. If it comes back as 'mopping_after_sweeping (3)' set in the app, that's
exactly the two-pass value we'll default to. Paste the output back.
"""
from __future__ import annotations

import json
import logging
import pathlib
import sys

logging.disable(logging.CRITICAL)

HERE = pathlib.Path(__file__).resolve().parent
ADAPTER = HERE.parent
sys.path.insert(0, str(ADAPTER / "vendor"))
SESSION = ADAPTER.parent.parent / "secrets" / "vacuum_session.json"

from dreamehome.protocol import DreameVacuumDreameHomeCloudProtocol  # noqa: E402

# A single small batch: exactly the properties we care about. One get_properties round-trip (the kind
# that worked), so no multi-chunk cloud fragility.
PROBE: dict[str, tuple[int, int]] = {
    "state": (2, 1),
    "error": (2, 2),
    "status": (4, 1),
    "suction_level": (4, 4),
    "water_volume": (4, 5),
    "water_tank_or_mop": (4, 6),
    "cleaning_mode": (4, 23),
}

CLEANING_MODE = {
    -1: "unknown", 0: "sweeping (vacuum only)", 1: "mopping (mop only)",
    2: "sweeping_and_mopping (one pass)", 3: "mopping_after_sweeping (two passes: vacuum then mop)",
}
SUCTION = {0: "quiet", 1: "standard", 2: "strong", 3: "turbo"}
WATER = {1: "low", 2: "medium", 3: "high"}
STATUS = {-1: "unknown", 0: "idle", 1: "paused", 2: "cleaning", 6: "charging", 14: "sleeping",
          17: "standby", 18: "segment-cleaning", 19: "zone-cleaning", 20: "spot-cleaning"}


def describe(name: str, value: object) -> str:
    if value is None:
        return "— (not reported by this model)"
    try:
        v = int(value)
    except (TypeError, ValueError):
        return str(value)
    if name == "cleaning_mode":
        return f"{CLEANING_MODE.get(v, '?')}  [{v}]"
    if name == "suction_level":
        return f"{SUCTION.get(v, '?')}  [{v}]"
    if name == "water_volume":
        return f"{WATER.get(v, '?')}  [{v}]"
    if name == "status":
        return f"{STATUS.get(v, v)}  [{v}]"
    if name == "error":
        return "none" if v == 0 else f"code {v}"
    return str(v)


def main() -> int:
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
        proto.get_device_info()  # set the cloud host/shard before reading (best effort)
    except Exception:
        pass

    batch = [{"did": str(did), "siid": s, "piid": p} for (s, p) in PROBE.values()]
    try:
        results = proto.send("get_properties", batch, retry_count=1, timeout=15)
    except Exception as ex:
        print(f"ERROR reading properties: {type(ex).__name__}", file=sys.stderr)
        return 1
    by_sp = {
        (it.get("siid"), it.get("piid")): it.get("value")
        for it in (results or []) if isinstance(it, dict) and it.get("code") == 0 and "value" in it
    }
    if not by_sp:
        print("No readable properties returned (robot offline/asleep, or token expired). "
              "Wake it on its dock and retry.", file=sys.stderr)
        return 1

    print(f"Dreame {sess.get('model', '?')} (did {did}, region {country}) — READ ONLY, nothing sent\n")
    for name, sp in PROBE.items():
        print(f"  {name:20s} {describe(name, by_sp.get(sp))}")
    print("\n  The line that matters is cleaning_mode. If it's mopping_after_sweeping [3], that's the")
    print("  two-pass value we'll default to. If cleaning_mode is '—', this model may expose it on a")
    print("  different piid — tell me and we'll confirm. (No command was sent.)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
