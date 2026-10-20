import json

import pytest
from hearth_devices_core import Policy, PolicyFile, Registry, is_idle

META = {
    "v": 0,
    "id": "vac",
    "name": "Vacuum",
    "room": "hall",
    "kind": "robot-vacuum",
    "adapter": "fake",
    "capabilities": [
        {"name": "RvcRunMode", "risk": "medium", "params": {}},
        {"name": "RvcOperationalState", "risk": "read", "params": {}},
        {"name": "OnOff", "risk": "low", "params": {}},
        {"name": "DoorLock", "risk": "high", "params": {}},
    ],
}


def feed(reg: Registry, state: dict | None = None, status: str = "online") -> Registry:
    reg.apply("hearth/local/adapters/fake/status", status.encode())
    reg.apply("hearth/local/devices/vac/meta", json.dumps(META).encode())
    reg.apply(
        "hearth/local/devices/vac/state",
        json.dumps({"v": 0, "online": True, "updatedAt": 1, **(state or {})}).encode(),
    )
    return reg


def test_registry_builds_devices_from_meta_and_state():
    reg = feed(Registry(), {"operationalState": "docked"})
    [d] = reg.list()
    assert d["id"] == "vac" and d["online"] is True and d["state"]["operationalState"] == "docked"


def test_adapter_offline_takes_its_devices_offline():
    reg = feed(Registry())
    reg.apply("hearth/local/adapters/fake/status", b"offline")
    assert reg.get("vac").online is False


def test_contract_violations_never_enter_the_registry():
    reg = Registry()
    assert reg.apply("hearth/local/devices/x/meta", b'{"v":0,"id":"x"}') is None
    assert reg.apply("hearth/local/devices/x/meta", b"garbage") is None
    other = {**META, "id": "someone-else"}
    assert reg.apply("hearth/local/devices/vac/meta", json.dumps(other).encode()) is None  # id/topic mismatch
    assert reg.apply("hearth/local/adapters/fake/status", b"maybe") is None
    assert reg.rejected == 4 and reg.list() == []


def test_cleared_retained_meta_removes_device():
    reg = feed(Registry())
    reg.apply("hearth/local/devices/vac/meta", b"")
    assert reg.get("vac") is None


@pytest.mark.parametrize(
    ("state", "idle"),
    [
        ({}, True),
        ({"operationalState": "docked"}, True),
        ({"operationalState": "Running"}, False),
        ({"RvcOperationalState": "seeking_charger"}, False),
        ({"busy": True}, False),
    ],
)
def test_is_idle(state, idle):
    assert is_idle(state) is idle


def policy(**over) -> Policy:
    return Policy(PolicyFile.model_validate({"version": 0, **over}))


def test_policy_risk_classes():
    reg = feed(Registry(), {"operationalState": "docked"})
    p = policy()
    d = reg.get("vac")
    assert p.check(d, "OnOff", "voice").allow
    assert p.check(d, "RvcRunMode", "voice").allow  # medium: online and idle
    assert p.check(d, "DoorLock", "local").reason == "high risk is disabled"
    assert p.check(d, "DoorLock", "voice").reason == "high risk is never reachable by voice"
    assert p.check(d, "Teleport", "local").reason == "unknown capability"
    assert p.check(None, "OnOff", "local").reason == "unknown device"


def test_medium_requires_idle_and_online():
    p = policy()
    busy = feed(Registry(), {"operationalState": "running"}).get("vac")
    assert p.check(busy, "RvcRunMode", "local").reason == "device is busy"
    off = feed(Registry(), status="offline").get("vac")
    assert p.check(off, "RvcRunMode", "local").reason == "device is offline"
    assert p.check(off, "RvcOperationalState", "local").allow  # reading is fine


def test_high_can_be_enabled_locally_but_never_by_voice():
    p = policy(devices={"vac": {"DoorLock": "allow"}})
    d = feed(Registry()).get("vac")
    assert p.check(d, "DoorLock", "local").allow
    assert not p.check(d, "DoorLock", "voice").allow


def test_policy_file_cannot_allow_high_by_default():
    with pytest.raises(ValueError):
        policy(defaults={"high": "allow"})


def test_shipped_policy_loads():
    from pathlib import Path

    p = Policy.load(Path(__file__).resolve().parents[2] / "config" / "policy.yaml")
    assert p.file.defaults["medium"] == "allow"
