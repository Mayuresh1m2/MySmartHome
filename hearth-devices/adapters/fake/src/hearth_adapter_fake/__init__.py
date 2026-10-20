"""Fake adapter: an in-memory lamp (low), robot vacuum (medium) and door lock (high).

Exercises the platform end to end without touching a real device. Capability names follow Matter clusters.
"""

from __future__ import annotations

import asyncio
import os
import signal
from typing import Any

from hearth_devices_sdk import Adapter, AdapterRunner, BusSettings, Capability, CommandError, DeviceMeta, SetCommand

BOOL_ON = {
    "type": "object",
    "properties": {"on": {"type": "boolean"}},
    "required": ["on"],
    "additionalProperties": False,
}
LEVEL = {
    "type": "object",
    "properties": {"level": {"type": "integer", "minimum": 0, "maximum": 100}},
    "required": ["level"],
    "additionalProperties": False,
}
RUN_MODE = {
    "type": "object",
    "properties": {"mode": {"enum": ["idle", "cleaning"]}},
    "required": ["mode"],
    "additionalProperties": False,
}
LOCK = {"type": "object", "properties": {"locked": {"type": "boolean"}}, "required": ["locked"]}


class FakeAdapter(Adapter):
    adapter_id = "fake"

    def __init__(self, poll_interval: float = 30.0) -> None:
        self.poll_interval = poll_interval
        self.state: dict[str, dict[str, Any]] = {
            "fake-lamp": {"on": False, "level": 50},
            "fake-vacuum": {"runMode": "idle", "operationalState": "docked", "battery": 100},
            "fake-lock": {"locked": True},
        }

    async def discover(self) -> list[DeviceMeta]:
        return [
            DeviceMeta(
                id="fake-lamp",
                name="Fake lamp",
                room="lab",
                kind="light",
                adapter="fake",
                capabilities=[
                    Capability(name="OnOff", risk="low", params=BOOL_ON),
                    Capability(name="LevelControl", risk="low", params=LEVEL),
                ],
            ),
            DeviceMeta(
                id="fake-vacuum",
                name="Fake vacuum",
                room="hall",
                kind="robot-vacuum",
                adapter="fake",
                capabilities=[
                    Capability(name="RvcRunMode", risk="medium", params=RUN_MODE),
                    Capability(name="RvcOperationalState", risk="read", params={"type": "object"}),
                ],
            ),
            DeviceMeta(
                id="fake-lock",
                name="Fake front door lock",
                room="hall",
                kind="lock",
                adapter="fake",
                capabilities=[Capability(name="DoorLock", risk="high", params=LOCK)],
            ),
        ]

    async def read_state(self, device_id: str) -> dict[str, Any]:
        return dict(self.state[device_id])

    async def execute(self, device_id: str, cmd: SetCommand) -> dict[str, Any] | None:
        s = self.state[device_id]
        match (device_id, cmd.capability):
            case ("fake-lamp", "OnOff"):
                s["on"] = cmd.params["on"]
            case ("fake-lamp", "LevelControl"):
                s["level"] = cmd.params["level"]
                s["on"] = cmd.params["level"] > 0
            case ("fake-vacuum", "RvcRunMode"):
                if cmd.params["mode"] == "cleaning" and s["battery"] < 10:
                    raise CommandError("battery too low")
                s["runMode"] = cmd.params["mode"]
                s["operationalState"] = "running" if cmd.params["mode"] == "cleaning" else "docked"
            case ("fake-vacuum", "RvcOperationalState"):
                pass  # read-only: just return state
            case ("fake-lock", "DoorLock"):
                s["locked"] = cmd.params["locked"]  # only reachable if policy and the SDK both allowed high risk
            case _:
                raise CommandError(f"{cmd.capability} not supported on {device_id}")
        return dict(s)


def main() -> None:
    runner = AdapterRunner(
        FakeAdapter(poll_interval=float(os.environ.get("POLL_INTERVAL_S", "30"))),
        BusSettings(
            host=os.environ.get("BUS_HOST", "127.0.0.1"),
            port=int(os.environ.get("BUS_PORT", "1883")),
            password=os.environ["BUS_PASSWORD"],
        ),
    )
    stop = asyncio.Event()

    async def run() -> None:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, stop.set)
        await runner.run(stop)

    asyncio.run(run())
