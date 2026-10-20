import asyncio
import json
import os
import signal
import sys
from pathlib import Path

import pytest
from conftest import USERS
from testkit_adapter import TestkitAdapter

from hearth_devices_sdk import AdapterRunner, BusSettings, validate

LAMP = "hearth/local/devices/kit-lamp"


@pytest.fixture
async def running(bus_port):
    adapter = TestkitAdapter()
    runner = AdapterRunner(adapter, BusSettings(port=bus_port, password=USERS["adapter-testkit"]))
    stop = asyncio.Event()
    task = asyncio.create_task(runner.run(stop))
    await asyncio.wait_for(runner.ready.wait(), 5)
    yield adapter, runner, stop
    stop.set()
    await asyncio.wait_for(task, 5)


async def send(client, payload, device="kit-lamp"):
    body = payload if isinstance(payload, (bytes, str)) else json.dumps(payload)
    await client.publish(f"hearth/local/devices/{device}/set", body, qos=1)


def cmd(request_id, capability="OnOff", params=None, action="set"):
    return {"v": 0, "requestId": request_id, "capability": capability, "action": action, "params": params or {}}


async def test_announces_status_meta_and_state(observer, running):
    obs, _ = observer
    assert await obs.wait_for("hearth/local/adapters/testkit/status", lambda p: p == "online")
    meta = await obs.wait_for(f"{LAMP}/meta")
    validate("meta", meta)
    assert meta["adapter"] == "testkit" and {c["name"] for c in meta["capabilities"]} >= {"OnOff"}
    state = await obs.wait_for(f"{LAMP}/state")
    validate("state", state)
    assert state["online"] is True and state["on"] is False


async def test_set_publishes_result_and_state(observer, running):
    obs, client = observer
    await send(client, cmd("r-on", params={"on": True}))
    result = await obs.wait_for(f"{LAMP}/result", lambda p: p["requestId"] == "r-on")
    validate("result", result)
    assert result["ok"] is True and result["error"] is None and result["state"]["on"] is True
    assert await obs.wait_for(f"{LAMP}/state", lambda p: p["on"] is True)


@pytest.mark.parametrize(
    ("request_id", "command", "error"),
    [
        ("r-params", cmd("r-params", params={"on": "yes"}), "invalid params"),
        ("r-missing", cmd("r-missing", params={}), "invalid params"),
        ("r-unknown", cmd("r-unknown", capability="Teleport"), "unknown capability Teleport"),
        ("r-high", cmd("r-high", capability="DoorLock"), "high-risk capability is disabled"),
        ("r-cmderr", cmd("r-cmderr", capability="Explode"), "lamp refused"),
        ("r-crash", cmd("r-crash", capability="Crash"), "adapter error"),
        ("r-badv", {**cmd("r-badv"), "v": 1}, "invalid command"),
    ],
)
async def test_rejections_become_failed_results(observer, running, request_id, command, error):
    obs, client = observer
    await send(client, command)
    result = await obs.wait_for(f"{LAMP}/result", lambda p: p["requestId"] == request_id)
    validate("result", result)
    assert result["ok"] is False
    assert result["error"].startswith(error)
    assert "secret" not in result["error"]


async def test_garbage_and_foreign_devices_are_ignored(observer, running):
    obs, client = observer
    await send(client, b"not json")
    await send(client, {"no": "requestId"})
    await send(client, cmd("r-foreign"), device="someone-elses-tv")
    await send(client, cmd("r-after", params={"on": False}))
    await obs.wait_for(f"{LAMP}/result", lambda p: p["requestId"] == "r-after")
    ids = [p["requestId"] for p in obs.payloads(f"{LAMP}/result")]
    assert ids == ["r-after"]


async def test_failed_state_read_marks_device_offline(observer, running):
    obs, _ = observer
    adapter, runner, _ = running
    adapter.broken_reads = True
    await runner._publish_state("kit-lamp")
    state = await obs.wait_for(f"{LAMP}/state", lambda p: p["online"] is False)
    validate("state", state)


async def test_graceful_stop_publishes_offline(observer, bus_port):
    obs, _ = observer
    runner = AdapterRunner(TestkitAdapter(), BusSettings(port=bus_port, password=USERS["adapter-testkit"]))
    stop = asyncio.Event()
    task = asyncio.create_task(runner.run(stop))
    await asyncio.wait_for(runner.ready.wait(), 5)
    stop.set()
    await asyncio.wait_for(task, 5)
    statuses = obs.payloads("hearth/local/adapters/testkit/status")
    assert statuses[-1] == "offline"


async def test_last_will_marks_adapter_offline_when_killed(observer, bus_port):
    obs, _ = observer
    here = Path(__file__).parent
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        str(here / "testkit_adapter.py"),
        str(bus_port),
        env={**os.environ, "BUS_PASSWORD": USERS["adapter-testkit"], "PYTHONPATH": str(here)},
        stdout=asyncio.subprocess.DEVNULL,
    )
    status = "hearth/local/adapters/testkit/status"
    try:
        n = len(obs.payloads(status))
        await obs.wait_for(status, lambda _: len(obs.payloads(status)) > n, within=15)
        assert obs.payloads(status)[-1] == "online"
        proc.send_signal(signal.SIGKILL)  # no graceful shutdown: only the broker's last will can say offline
        await asyncio.wait_for(proc.wait(), 5)
        await obs.wait_for(status, lambda _: obs.payloads(status)[-1] == "offline", within=60)
    finally:
        if proc.returncode is None:
            proc.kill()


async def test_adapter_cannot_publish_outside_its_acl(bus_port):
    import aiomqtt

    # Spoofing another adapter's status is refused: the broker drops the connection, so no PUBACK ever arrives.
    with pytest.raises(aiomqtt.MqttError):
        async with aiomqtt.Client(
            "127.0.0.1", bus_port, username="adapter-other", password=USERS["adapter-other"], timeout=2
        ) as c:
            await c.publish("hearth/local/adapters/testkit/status", b"online", qos=1)


async def test_reconnects_and_reannounces_after_the_bus_drops_it(observer, bus_port):
    import aiomqtt

    obs, _ = observer
    runner = AdapterRunner(
        TestkitAdapter(), BusSettings(port=bus_port, password=USERS["adapter-testkit"]), max_backoff=0.5
    )
    stop = asyncio.Event()
    task = asyncio.create_task(runner.run(stop))
    await asyncio.wait_for(runner.ready.wait(), 5)
    status = "hearth/local/adapters/testkit/status"
    # Same client id connecting elsewhere makes the broker drop the adapter's session (like a network blip).
    async with aiomqtt.Client(
        "127.0.0.1",
        bus_port,
        username="adapter-testkit",
        password=USERS["adapter-testkit"],
        identifier="adapter-testkit",
    ):
        await obs.wait_for(status, lambda _: obs.payloads(status)[-1] == "offline", within=10)
    await obs.wait_for(status, lambda _: obs.payloads(status)[-1] == "online", within=10)
    await asyncio.wait_for(runner.ready.wait(), 5)
    stop.set()
    await asyncio.wait_for(task, 5)
    assert obs.payloads(status)[-1] == "offline"
