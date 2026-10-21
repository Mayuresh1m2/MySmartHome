"""Local contract v1: core publishes a registry snapshot and serves requests from the hub (always as voice)."""

import asyncio
import json

import aiomqtt
import pytest
from hearth_adapter_fake import FakeAdapter
from hearth_devices_core import AuditLog, Core, CoreSettings, Policy, PolicyFile
from hearth_devices_sdk import AdapterRunner, BusSettings, validate

from conftest import USERS


@pytest.fixture
async def platform(bus_port, tmp_path):
    # The lock is allowed for *local* use here, to prove the hub's requests still count as voice.
    policy = Policy(PolicyFile(version=0, devices={"fake-lock": {"DoorLock": "allow"}}))
    core = Core(
        CoreSettings(port=bus_port, password=USERS["core"], result_timeout=5), policy, AuditLog(tmp_path / "audit")
    )
    adapter = AdapterRunner(FakeAdapter(poll_interval=3600), BusSettings(port=bus_port, password=USERS["adapter-fake"]))
    adapter.adapter.allow_high_risk = True  # only policy stands between voice and the lock in this test
    stop = asyncio.Event()
    tasks = [asyncio.create_task(core.run(stop)), asyncio.create_task(adapter.run(stop))]
    await asyncio.wait_for(core.ready.wait(), 5)
    try:
        await core.wait_for(
            lambda r: all(r.get(d) and r.get(d).online for d in ("fake-lamp", "fake-vacuum", "fake-lock")), 10
        )
    except TimeoutError:
        views = {d: (v.adapter_online, v.state.get("online")) for d, v in core.registry.devices.items()}
        print("DEBUG adapters", core.registry.adapters, views)
        raise
    yield core
    stop.set()
    await asyncio.gather(*tasks)


@pytest.fixture
async def hub(bus_port):
    """A client with the hub's bus identity: may only publish core/request/hub."""
    inbox: dict[str, list] = {"registry": [], "responses": []}
    async with aiomqtt.Client(
        "127.0.0.1", bus_port, username="hub", password=USERS["hub"], identifier="hearth-hub-test"
    ) as c:
        await c.subscribe("hearth/local/core/response/hub", qos=1)
        await c.subscribe("hearth/local/core/registry", qos=1)

        async def pump():
            async for m in c.messages:
                doc = json.loads(m.payload)
                inbox["registry" if m.topic.value.endswith("registry") else "responses"].append(doc)

        task = asyncio.create_task(pump())

        async def ask(body: dict) -> dict:
            await c.publish("hearth/local/core/request/hub", json.dumps(body), qos=1)
            for _ in range(250):
                for r in inbox["responses"]:
                    if r["requestId"] == body.get("requestId"):
                        return r
                await asyncio.sleep(0.02)
            raise TimeoutError(body)

        yield inbox, ask
        task.cancel()


def req(rid, device, capability, params, **extra):
    return {
        "v": 1,
        "requestId": rid,
        "deviceId": device,
        "capability": capability,
        "action": "set",
        "params": params,
        **extra,
    }


async def test_registry_snapshot_is_retained_and_valid(platform, hub):
    inbox, _ = hub
    for _ in range(100):
        # The first snapshot can be the previous core's retained one; wait for a current one.
        if (
            inbox["registry"]
            and all(d["online"] for d in inbox["registry"][-1]["devices"])
            and len(inbox["registry"][-1]["devices"]) == 3
        ):
            break
        await asyncio.sleep(0.05)
    snap = inbox["registry"][-1]
    validate("registry", snap)
    lamp = next(d for d in snap["devices"] if d["id"] == "fake-lamp")
    assert lamp["online"] is True
    assert {c["name"]: c["params"]["required"] for c in lamp["capabilities"]} == {
        "OnOff": ["on"],
        "LevelControl": ["level"],
    }


async def test_hub_request_runs_through_policy_and_audit_as_voice(platform, hub):
    _, ask = hub
    r = await ask(req("h-1", "fake-lamp", "OnOff", {"on": True}))
    validate("response", r)
    assert r["ok"] is True and r["state"]["on"] is True
    [line] = [a for a in platform.audit.read() if a["requestId"] == "h-1"]
    assert line["via"] == "voice" and line["decision"] == "sent"


async def test_high_risk_is_unreachable_from_the_hub_even_when_allowed_locally(platform, hub):
    _, ask = hub
    r = await ask(req("h-2", "fake-lock", "DoorLock", {"locked": False}))
    assert r == {
        "v": 1,
        "requestId": "h-2",
        "ok": False,
        "error": "policy: high risk is never reachable by voice",
        "state": {},
    }
    assert platform.registry.get("fake-lock").state["locked"] is True
    local = await platform.execute("fake-lock", "DoorLock", "set", {"locked": True}, via="local")
    assert local["ok"] is True  # the same command is allowed locally, so policy (not luck) stopped the hub


async def test_a_request_cannot_claim_its_own_trust_level(platform, hub):
    _, ask = hub
    r = await ask(req("h-3", "fake-lock", "DoorLock", {"locked": False}, via="local"))
    assert r["ok"] is False and r["error"] == "invalid request"
