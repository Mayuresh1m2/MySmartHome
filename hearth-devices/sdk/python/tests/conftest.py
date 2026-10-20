"""Starts the local devices bus (local-stack/src/cli/bus.ts) for the test session and provides an observer."""

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

REPO = Path(__file__).resolve().parents[4]
USERS = {"core": "c0re", "adapter-testkit": "t3st", "adapter-other": "0ther"}


@pytest.fixture(scope="session")
def bus_port() -> Iterator[int]:
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
