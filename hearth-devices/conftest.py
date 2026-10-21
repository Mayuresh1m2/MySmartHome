"""Shared test fixtures for every hearth-devices package: the local devices bus and a core observer."""

from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import aiomqtt
import pytest

REPO = Path(__file__).resolve().parents[1]
USERS = {"core": "c0re", "adapter-testkit": "t3st", "adapter-other": "0ther", "adapter-fake": "f4ke", "hub": "hu8"}


def _external_users() -> dict[str, str]:
    """Passwords for a real broker (HEARTH_TEST_BUS_PORT), from secrets/bus.env written by scripts/bus-setup.sh."""
    users: dict[str, str] = {}
    for line in (REPO / "hearth-devices" / "secrets" / "bus.env").read_text().splitlines():
        if line.startswith("BUS_PASSWORD_") and "=" in line:
            key, value = line.split("=", 1)
            users[key.removeprefix("BUS_PASSWORD_").lower().replace("_", "-")] = value
    return users


if os.environ.get("HEARTH_TEST_BUS_PORT"):
    USERS.update(_external_users())


@pytest.fixture(scope="session")
def bus_port() -> Iterator[int]:
    # HEARTH_TEST_BUS_PORT=1883 runs the tests against a real broker (Mosquitto via scripts/bus.sh) instead.
    if os.environ.get("HEARTH_TEST_BUS_PORT"):
        yield int(os.environ["HEARTH_TEST_BUS_PORT"])
        return
    env = {**os.environ, "BUS_PORT": "0", "BUS_USERS": ",".join(f"{u}:{p}" for u, p in USERS.items())}
    proc = subprocess.Popen(
        ["npx", "tsx", "src/cli/bus.ts"],
        cwd=REPO / "local-stack",
        env=env,
        stdout=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    assert proc.stdout
    line = proc.stdout.readline()
    port = json.loads(line)["port"]
    yield port
    os.killpg(proc.pid, signal.SIGTERM)
    proc.wait(timeout=10)


class Observer:
    """A 'core' client that records everything under hearth/local/#."""

    def __init__(self) -> None:
        self.messages: list[tuple[str, bytes, bool]] = []

    def payloads(self, topic: str) -> list[dict | str]:
        out: list[dict | str] = []
        for t, p, _ in self.messages:
            if t == topic:
                try:
                    out.append(json.loads(p))
                except ValueError:
                    out.append(p.decode())
        return out

    async def wait_for(self, topic: str, pred=lambda _p: True, within: float = 5.0):
        async def _wait():
            while True:
                for p in self.payloads(topic):
                    if pred(p):
                        return p
                await asyncio.sleep(0.02)

        return await asyncio.wait_for(_wait(), within)


@pytest.fixture
async def observer(bus_port: int) -> AsyncIterator[tuple[Observer, aiomqtt.Client]]:
    obs = Observer()
    async with aiomqtt.Client("127.0.0.1", bus_port, username="core", password=USERS["core"]) as client:
        await client.subscribe("hearth/local/#", qos=1)

        async def pump():
            async for m in client.messages:
                obs.messages.append((m.topic.value, bytes(m.payload), m.retain))

        task = asyncio.create_task(pump())
        await asyncio.sleep(0.1)
        yield obs, client
        task.cancel()
