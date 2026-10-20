"""`uv run hearth-devices list|set|watch` against the bus, using the core identity (policy and audit apply)."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path

from .audit import AuditLog
from .core import Core, CoreSettings
from .policy import Policy

ROOT = Path(__file__).resolve().parents[3]  # hearth-devices/


def _core() -> Core:
    settings = CoreSettings(
        host=os.environ.get("BUS_HOST", "127.0.0.1"),
        port=int(os.environ.get("BUS_PORT", "1883")),
        password=os.environ.get("BUS_PASSWORD"),
    )
    policy = Policy.load(os.environ.get("DEVICES_POLICY", ROOT / "config" / "policy.yaml"))
    return Core(settings, policy, AuditLog(os.environ.get("DEVICES_AUDIT_DIR", ROOT / "data" / "audit")))


async def _main(args: argparse.Namespace) -> int:
    core = _core()
    stop = asyncio.Event()
    task = asyncio.create_task(core.run(stop))
    await asyncio.wait_for(core.ready.wait(), 5)
    await asyncio.sleep(0.5)  # let retained meta/state/status arrive
    code = 0
    try:
        if args.cmd == "list":
            print(json.dumps(core.registry.list(), indent=2))
        elif args.cmd == "set":
            r = await core.execute(args.device, args.capability, args.action, json.loads(args.params), via="local")
            print(json.dumps(r, indent=2))
            code = 0 if r["ok"] else 1
        elif args.cmd == "watch":
            while True:
                device_id, what = await core.changes.get()
                view = core.registry.get(device_id)
                print(json.dumps({"device": device_id, "changed": what, **(view.summary() if view else {})}))
    finally:
        stop.set()
        await task
    return code


def main() -> None:
    p = argparse.ArgumentParser(prog="hearth-devices")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="devices in the registry")
    s = sub.add_parser("set", help="send a command through policy and audit")
    s.add_argument("device")
    s.add_argument("capability")
    s.add_argument("action")
    s.add_argument("params", nargs="?", default="{}")
    sub.add_parser("watch", help="stream registry changes")
    raise SystemExit(asyncio.run(_main(p.parse_args())))
