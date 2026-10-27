"""Unit tests for the Dreame vacuum adapter.

No bus and no cloud: the Dreamehome client is replaced with a fake that records calls, so the
tests cover discovery, the property->state mapping, and the arm gate (dry run vs real command)
without touching the network or moving a robot.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import hearth_adapter_vacuum as va
import pytest
from hearth_devices_sdk import CommandError, SetCommand, validate


class FakeCloud:
    def __init__(self, props: dict[str, Any] | None = None) -> None:
        self.props = props or {"status": 14, "battery": 100, "error": 0}
        self.calls: list[tuple[int, int]] = []
        self.sets: list[tuple[int, int, int]] = []
        # One ordered timeline so a test can assert the mode is set *before* START.
        self.events: list[tuple] = []

    def read_props(self) -> dict[str, Any]:
        return dict(self.props)

    def call(self, siid: int, aiid: int) -> None:
        self.calls.append((siid, aiid))
        self.events.append(("call", siid, aiid))

    def set_property(self, siid: int, piid: int, value: int) -> None:
        self.sets.append((siid, piid, value))
        self.events.append(("set", siid, piid, value))


def make(props: dict[str, Any] | None = None) -> tuple[va.VacuumAdapter, FakeCloud]:
    adapter = va.VacuumAdapter()
    cloud = FakeCloud(props)
    adapter._cloud = cloud  # type: ignore[assignment]
    return adapter, cloud


@pytest.fixture(autouse=True)
def _isolate_clean_mode(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the clean-mode store at an empty temp path so tests never read the real secrets file."""
    store = tmp_path / "vacuum_clean_mode.json"
    monkeypatch.setattr(va, "CLEAN_MODE_PATH", store)
    return store


def write_clean_mode(store: Path, *, default: str | None = "mopping_after_sweeping",
                     value: int = 133634) -> None:
    doc: dict[str, Any] = {"modes": {"mopping_after_sweeping": {"value": value, "note": "two passes"}}}
    if default is not None:
        doc["default"] = default
    store.write_text(json.dumps(doc))


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


# --- capture-and-replay cleaning mode (default: two-pass) ---------------------------------------


def test_load_clean_modes_reads_default_and_values(_isolate_clean_mode: Path) -> None:
    write_clean_mode(_isolate_clean_mode, value=133634)
    default, modes = va._load_clean_modes()
    assert default == "mopping_after_sweeping"
    assert modes == {"mopping_after_sweeping": 133634}


def test_load_clean_modes_empty_when_no_file(_isolate_clean_mode: Path) -> None:
    assert va._load_clean_modes() == (None, {})


def test_load_clean_modes_ignores_unknown_default_and_bad_values(_isolate_clean_mode: Path) -> None:
    _isolate_clean_mode.write_text(json.dumps({
        "default": "not_captured",
        "modes": {"sweeping": {"value": "oops"}, "mopping": {"value": True}, "ok": {"value": 42}},
    }))
    default, modes = va._load_clean_modes()
    assert default is None  # the named default wasn't among the captured modes
    assert modes == {"ok": 42}  # string and bool values are dropped


async def test_armed_clean_sets_the_captured_mode_before_start(
    monkeypatch: pytest.MonkeyPatch, _isolate_clean_mode: Path
) -> None:
    monkeypatch.setenv("VACUUM_ARMED", "1")
    write_clean_mode(_isolate_clean_mode, value=133634)
    adapter, cloud = make()
    await adapter.execute(va.DEVICE_ID, set_cmd("RvcRunMode", {"mode": "cleaning"}))
    # The mode is written at 4/23, then START is sent — in that order.
    assert cloud.sets == [(va.CLEANING_MODE[0], va.CLEANING_MODE[1], 133634)]
    assert cloud.calls == [va.ACTION_START]
    assert cloud.events == [("set", 4, 23, 133634), ("call", *va.ACTION_START)]


async def test_armed_clean_without_a_capture_sends_plain_start(
    monkeypatch: pytest.MonkeyPatch, _isolate_clean_mode: Path
) -> None:
    monkeypatch.setenv("VACUUM_ARMED", "1")  # no capture file written
    adapter, cloud = make()
    await adapter.execute(va.DEVICE_ID, set_cmd("RvcRunMode", {"mode": "cleaning"}))
    assert cloud.sets == []  # nothing to replay -> robot keeps the app's last mode
    assert cloud.calls == [va.ACTION_START]


async def test_dry_run_with_a_capture_still_sends_nothing(
    monkeypatch: pytest.MonkeyPatch, _isolate_clean_mode: Path
) -> None:
    monkeypatch.delenv("VACUUM_ARMED", raising=False)
    write_clean_mode(_isolate_clean_mode)
    adapter, cloud = make()
    await adapter.execute(va.DEVICE_ID, set_cmd("RvcRunMode", {"mode": "cleaning"}))
    assert cloud.sets == [] and cloud.calls == []  # dry run: mode is not even set


async def test_docking_never_sets_the_clean_mode(
    monkeypatch: pytest.MonkeyPatch, _isolate_clean_mode: Path
) -> None:
    monkeypatch.setenv("VACUUM_ARMED", "1")
    write_clean_mode(_isolate_clean_mode)
    adapter, cloud = make()
    await adapter.execute(va.DEVICE_ID, set_cmd("RvcRunMode", {"mode": "idle"}))
    assert cloud.sets == []  # returning to the dock leaves the mode alone
    assert cloud.calls == [va.ACTION_CHARGE]


async def test_standing_fault_refuses_before_setting_the_mode(
    monkeypatch: pytest.MonkeyPatch, _isolate_clean_mode: Path
) -> None:
    monkeypatch.setenv("VACUUM_ARMED", "1")
    write_clean_mode(_isolate_clean_mode)
    adapter, cloud = make({"status": 1, "battery": 100, "error": 107})  # dry tank
    with pytest.raises(CommandError, match="water tank is dry"):
        await adapter.execute(va.DEVICE_ID, set_cmd("RvcRunMode", {"mode": "cleaning"}))
    assert cloud.sets == [] and cloud.calls == []  # neither mode nor start was sent
