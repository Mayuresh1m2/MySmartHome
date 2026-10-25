"""Unit tests for the Dreame vacuum adapter.

No bus and no cloud: the Dreamehome client is replaced with a fake that records calls, so the
tests cover discovery, the property->state mapping, and the arm gate (dry run vs real command)
without touching the network or moving a robot.
"""

from __future__ import annotations

from typing import Any

import hearth_adapter_vacuum as va
import pytest
from hearth_devices_sdk import CommandError, SetCommand, validate


class FakeCloud:
    def __init__(self, props: dict[str, Any] | None = None) -> None:
        self.props = props or {"status": 14, "battery": 100, "error": 0}
        self.calls: list[tuple[int, int]] = []

    def read_props(self) -> dict[str, Any]:
        return dict(self.props)

    def call(self, siid: int, aiid: int) -> None:
        self.calls.append((siid, aiid))


def make(props: dict[str, Any] | None = None) -> tuple[va.VacuumAdapter, FakeCloud]:
    adapter = va.VacuumAdapter()
    cloud = FakeCloud(props)
    adapter._cloud = cloud  # type: ignore[assignment]
    return adapter, cloud


def set_cmd(capability: str, params: dict[str, Any]) -> SetCommand:
    return SetCommand(v=1, requestId="r1", capability=capability, action="set", params=params)


async def test_discover_shape_is_valid_and_matches_the_contract() -> None:
    adapter, _ = make()
    metas = await adapter.discover()
    assert len(metas) == 1
    meta = metas[0]
    assert meta.kind == "robot-vacuum"
    assert meta.adapter == "vacuum"
    caps = {c.name: c.risk for c in meta.capabilities}
    assert caps == {"RvcRunMode": "medium", "RvcOperationalState": "read"}
    validate("meta", meta.model_dump())  # raises if it breaks the shared schema


def test_to_state_maps_cleaning_and_faults() -> None:
    cleaning = va._to_state({"status": 2, "battery": 73, "error": 0})
    assert cleaning == {"runMode": "cleaning", "operationalState": "cleaning", "battery": 73, "fault": None}

    sleeping = va._to_state({"status": 14, "battery": 100, "error": 0})
    assert sleeping["runMode"] == "idle"
    assert sleeping["operationalState"] == "sleeping"

    dry = va._to_state({"status": 1, "battery": 100, "error": 107})
    assert dry["fault"] == "the water tank is dry"  # the real low-water case

    unknown = va._to_state({"status": 12, "battery": 40, "error": 999})
    assert unknown["fault"] == "it reported a fault (code 999)"


async def test_read_state_goes_through_the_cloud() -> None:
    adapter, _ = make({"status": 2, "battery": 55, "error": 0})
    state = await adapter.read_state(va.DEVICE_ID)
    assert state["runMode"] == "cleaning"
    assert state["battery"] == 55


async def test_dry_run_does_not_touch_the_robot(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("VACUUM_ARMED", raising=False)
    adapter, cloud = make()
    out = await adapter.execute(va.DEVICE_ID, set_cmd("RvcRunMode", {"mode": "cleaning"}))
    assert out is None  # SDK re-reads
    assert cloud.calls == []  # nothing was sent


@pytest.mark.parametrize(
    ("mode", "expected"),
    [("cleaning", va.ACTION_START), ("idle", va.ACTION_CHARGE)],
)
async def test_armed_sends_the_right_action(
    monkeypatch: pytest.MonkeyPatch, mode: str, expected: tuple[int, int]
) -> None:
    monkeypatch.setenv("VACUUM_ARMED", "1")
    adapter, cloud = make()
    await adapter.execute(va.DEVICE_ID, set_cmd("RvcRunMode", {"mode": mode}))
    assert cloud.calls == [expected]


async def test_armed_clean_refuses_when_the_robot_has_a_standing_fault(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VACUUM_ARMED", "1")
    adapter, cloud = make({"status": 1, "battery": 100, "error": 107})  # dry water tank, standing
    with pytest.raises(CommandError, match="water tank is dry"):
        await adapter.execute(va.DEVICE_ID, set_cmd("RvcRunMode", {"mode": "cleaning"}))
    assert cloud.calls == []  # did not poke a robot that can't clean


async def test_read_capability_sends_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VACUUM_ARMED", "1")
    adapter, cloud = make()
    out = await adapter.execute(va.DEVICE_ID, set_cmd("RvcOperationalState", {}))
    assert out is None
    assert cloud.calls == []


async def test_unknown_capability_is_refused() -> None:
    adapter, _ = make()
    with pytest.raises(CommandError):
        await adapter.execute(va.DEVICE_ID, set_cmd("DoorLock", {"locked": False}))
