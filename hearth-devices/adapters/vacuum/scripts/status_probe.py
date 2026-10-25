#!/usr/bin/env python3
"""Read-only status for the Dreame vacuum via the Dreamehome cloud.

Reads a handful of MIoT properties (battery, charging, state, status, task, tank) and
prints them in words. It only READS — no action, set_property, or MQTT command is sent.
Uses the stored token (secrets/vacuum_session.json); no password needed.

Property SIID/PIID map and value enums are from Tasshack/dreame-vacuum (MIT) — the stable
Dreame RVC schema that covers dreame.vacuum.r2471.
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

# name -> (siid, piid). The core read-only status set.
PROPS = {
    "state": (2, 1),
    "error": (2, 2),
    "battery_level": (3, 1),
    "charging_status": (3, 2),
    "status": (4, 1),
    "cleaning_time_min": (4, 2),
    "cleaned_area_m2": (4, 3),
    "suction_level": (4, 4),
    "water_volume": (4, 5),
    "water_tank_or_mop": (4, 6),
    "task_status": (4, 7),
}

STATE = {-1: "unknown", 1: "sweeping", 2: "idle", 3: "paused", 4: "error", 5: "returning",
         6: "charging", 7: "mopping", 8: "drying", 9: "washing", 10: "returning-to-wash",
         11: "building-map", 12: "sweeping+mopping", 13: "charging-completed", 14: "upgrading",
         18: "returning-remove-mop", 22: "auto-emptying"}
STATUS = {-1: "unknown", 0: "idle", 1: "paused", 2: "cleaning", 3: "back-home", 4: "partial",
          6: "charging", 10: "power-off", 12: "error", 13: "remote-control", 14: "sleeping",
          17: "standby", 18: "segment-cleaning", 19: "zone-cleaning", 20: "spot-cleaning"}
CHARGING = {-1: "unknown", 1: "charging", 2: "not-charging", 3: "charging-completed", 5: "return-to-charge"}
TASK = {-1: "unknown", 0: "completed/none", 1: "auto-cleaning", 2: "zone", 3: "segment",
        4: "spot", 5: "fast-mapping", 6: "auto-paused"}


def translate(name, value):
    if value is None:
        return "—"
    try:
        v = int(value)
    except (TypeError, ValueError):
        return value
    if name == "state":
        return f"{STATE.get(v, v)} ({v})"
    if name == "status":
        return f"{STATUS.get(v, v)} ({v})"
    if name == "charging_status":
        return f"{CHARGING.get(v, v)} ({v})"
    if name == "task_status":
        return f"{TASK.get(v, v)} ({v})"
    if name == "battery_level":
        return f"{v}%"
    if name == "error":
        return "none" if v == 0 else f"code {v}"
    return v


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

    # Initialise the device's cloud host/shard (best effort) before reading.
    try:
        proto.get_device_info()
    except Exception:
        pass

    # Cloud reads go over the command relay via send("get_properties", …); items key off did.
    batch = [{"did": str(did), "siid": s, "piid": p} for (s, p) in PROPS.values()]
    try:
        results = proto.send("get_properties", batch)
    except Exception as ex:
        print(f"ERROR reading properties: {type(ex).__name__}", file=sys.stderr)
        return 1
    if not results:
        print("ERROR: no property data returned (device offline?).", file=sys.stderr)
        return 1

    by_sp = {}
    for item in results:
        if isinstance(item, dict) and item.get("code") == 0 and "value" in item:
            by_sp[(item.get("siid"), item.get("piid"))] = item["value"]

    print(f"Dreame {sess.get('model','?')}  (did {did}, region {country}) — READ ONLY, nothing sent\n")
    for name, sp in PROPS.items():
        print(f"  {name:20s} {translate(name, by_sp.get(sp))}")

    st = by_sp.get((4, 1))
    docked = by_sp.get((3, 2)) in (1, 3)  # charging or charged = on dock
    print(f"\n  summary: {'on dock, ' if docked else ''}status={STATUS.get(int(st), st) if st is not None else '—'}, "
          f"battery={translate('battery_level', by_sp.get((3, 1)))}")
    print("  (no command was sent)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
