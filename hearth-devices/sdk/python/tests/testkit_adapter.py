"""A minimal in-memory adapter used by the SDK tests (and runnable as a subprocess for the last-will test)."""

from __future__ import annotations

import asyncio
import os
import sys
from typing import Any

from hearth_devices_sdk import Adapter, AdapterRunner, BusSettings, Capability, CommandError, DeviceMeta, SetCommand


class TestkitAdapter(Adapter):
    __test__ = False  # not a pytest test class
    adapter_id = "testkit"
    poll_interval = 3600

    def __init__(self) -> None:
        self.on = False
        self.broken_reads = False

    async def discover(self) -> list[DeviceMeta]:
        return [
            DeviceMeta(
                id="kit-lamp",
                name="Kit lamp",
                room="lab",
                kind="light",
                adapter="testkit",
                capabilities=[
                    Capability(
                        name="OnOff",
                        risk="low",
                        params={"type": "object", "properties": {"on": {"type": "boolean"}}, "required": ["on"]},
                    ),
                    Capability(name="Explode", risk="medium", params={"type": "object"}),
                    Capability(name="Crash", risk="medium", params={"type": "object"}),
                    Capability(name="DoorLock", risk="high", params={"type": "object"}),
                ],
            )
        ]

    async def read_state(self, device_id: str) -> dict[str, Any]:
        if self.broken_reads:
            raise OSError("unreachable")
        return {"on": self.on}

    async def execute(self, device_id: str, cmd: SetCommand) -> dict[str, Any] | None:
        if cmd.capability == "OnOff":
            self.on = bool(cmd.params["on"])
            return {"on": self.on}
        if cmd.capability == "Explode":
            raise CommandError("lamp refused")
        raise RuntimeError("secret internal detail")


if __name__ == "__main__":
    runner = AdapterRunner(TestkitAdapter(), BusSettings(port=int(sys.argv[1]), password=os.environ["BUS_PASSWORD"]))

    async def main() -> None:
        await runner.run(asyncio.Event())  # runs until killed

    asyncio.run(main())
