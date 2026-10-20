"""Phase 1 acceptance: the fake adapter shows up in the registry, handles a set, publishes result and state,
and goes offline cleanly through its last will. Runs the real `hearth-adapter-fake` entry point as a process."""

import asyncio
import os
import shutil
import signal

import pytest
from hearth_devices_core import AuditLog, Core, CoreSettings, Policy, PolicyFile

from conftest import USERS


@pytest.fixture
async def core(bus_port, tmp_path):
    c = Core(
        CoreSettings(port=bus_port, password=USERS["core"], result_timeout=5),
        Policy(PolicyFile(version=0)),
        AuditLog(tmp_path / "audit"),
    )
    stop = asyncio.Event()
    task = asyncio.create_task(c.run(stop))
    await asyncio.wait_for(c.ready.wait(), 5)
    yield c
    stop.set()
    await task


@pytest.fixture
async def fake_adapter(bus_port):
    exe = shutil.which("hearth-adapter-fake")
    assert exe, "workspace not synced (uv sync --all-packages)"
    proc = await asyncio.create_subprocess_exec(
        exe,
        env={**os.environ, "BUS_PORT": str(bus_port), "BUS_PASSWORD": USERS["adapter-fake"], "POLL_INTERVAL_S": "3600"},
        stdout=asyncio.subprocess.DEVNULL,
    )
    yield proc
    if proc.returncode is None:
        proc.terminate()
        await proc.wait()


async def test_fake_adapter_end_to_end(core, fake_adapter):
    # 1. shows up in the registry
    await core.wait_for(
        lambda r: all(r.get(d) and r.get(d).online for d in ("fake-lamp", "fake-vacuum", "fake-lock")), 15
    )
    assert {d["id"] for d in core.registry.list()} == {"fake-lamp", "fake-vacuum", "fake-lock"}

    # 2. handles a set, publishes result and state
    r = await core.execute("fake-lamp", "OnOff", "set", {"on": True}, via="voice")
    assert r["ok"] is True and r["state"]["on"] is True
    await core.wait_for(lambda reg: reg.get("fake-lamp").state.get("on") is True)

    # medium: allowed while idle, refused while busy (state reported by the adapter)
    r = await core.execute("fake-vacuum", "RvcRunMode", "set", {"mode": "cleaning"}, via="voice")
    assert r["ok"] is True
    await core.wait_for(lambda reg: reg.get("fake-vacuum").state.get("operationalState") == "running")
    r = await core.execute("fake-vacuum", "RvcRunMode", "set", {"mode": "cleaning"}, via="voice")
    assert r == {"v": 0, "requestId": r["requestId"], "ok": False, "error": "policy: device is busy", "state": {}}

    # high: refused by policy; the adapter never sees it
    r = await core.execute("fake-lock", "DoorLock", "set", {"locked": False}, via="local")
    assert r["error"] == "policy: high risk is disabled"
    assert core.registry.get("fake-lock").state["locked"] is True

    # adapter-side validation still applies to what policy lets through
    r = await core.execute("fake-lamp", "LevelControl", "set", {"level": 500}, via="local")
    assert r["ok"] is False and r["error"].startswith("invalid params")

    # every decision is audited
    decisions = [(a["deviceId"], a["capability"], a["decision"], a["ok"]) for a in core.audit.read()]
    assert decisions == [
        ("fake-lamp", "OnOff", "sent", True),
        ("fake-vacuum", "RvcRunMode", "sent", True),
        ("fake-vacuum", "RvcRunMode", "refused", False),
        ("fake-lock", "DoorLock", "refused", False),
        ("fake-lamp", "LevelControl", "sent", False),
    ]

    # 3. goes offline through its last will (SIGKILL: no graceful goodbye)
    fake_adapter.send_signal(signal.SIGKILL)
    await fake_adapter.wait()
    await core.wait_for(lambda reg: reg.adapters.get("fake") == "offline", 60)
    assert not any(d["online"] for d in core.registry.list())
    r = await core.execute("fake-lamp", "OnOff", "set", {"on": False}, via="local")
    assert r["error"] == "policy: device is offline"


async def test_graceful_stop_also_goes_offline(core, fake_adapter):
    await core.wait_for(lambda r: r.adapters.get("fake") == "online", 15)
    fake_adapter.send_signal(signal.SIGTERM)
    await fake_adapter.wait()
    await core.wait_for(lambda r: r.adapters.get("fake") == "offline", 10)
