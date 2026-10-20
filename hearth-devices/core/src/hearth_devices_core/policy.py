"""Device-level policy by risk class (hearth-devices/CLAUDE.md "Risk classes")."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field

from .registry import DeviceView

Via = Literal["voice", "local"]
Rule = Literal["allow", "deny"]

#: State values that mean a device is busy, so medium-risk commands must wait.
BUSY_STATES = {"running", "cleaning", "washing", "drying", "seekingcharger", "active", "busy", "paused"}


class PolicyFile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[0]
    #: Default decision per risk class. High is deny by default; the schema forbids allowing it here.
    defaults: dict[Literal["read", "low", "medium"], Rule] = Field(
        default_factory=lambda: {"read": "allow", "low": "allow", "medium": "allow"}
    )
    #: Per device, per capability overrides. Allowing a high-risk capability makes it reachable locally only.
    devices: dict[str, dict[str, Rule]] = Field(default_factory=dict)


@dataclass
class Decision:
    allow: bool
    reason: str


def is_idle(state: dict) -> bool:
    """Idle unless the state says otherwise. Devices with no notion of busy (a TV, a lamp) count as idle."""
    if state.get("busy") is True:
        return False
    for key in ("operationalState", "OperationalState", "RvcOperationalState"):
        value = state.get(key)
        if isinstance(value, str) and value.lower().replace("_", "").replace(" ", "") in BUSY_STATES:
            return False
    return True


class Policy:
    def __init__(self, file: PolicyFile) -> None:
        self.file = file

    @classmethod
    def load(cls, path: str | Path) -> Policy:
        return cls(PolicyFile.model_validate(yaml.safe_load(Path(path).read_text())))

    def check(self, device: DeviceView | None, capability: str, via: Via) -> Decision:
        if device is None:
            return Decision(False, "unknown device")
        cap = device.meta.capability(capability)
        if cap is None:
            return Decision(False, "unknown capability")
        override = self.file.devices.get(device.meta.id, {}).get(capability)
        if cap.risk == "high":
            if via == "voice":
                return Decision(False, "high risk is never reachable by voice")
            if override != "allow":
                return Decision(False, "high risk is disabled")
        else:
            rule = override or self.file.defaults.get(cap.risk, "deny")
            if rule != "allow":
                return Decision(False, f"{cap.risk} risk denied by policy")
        if not device.online:
            if cap.risk == "read":
                return Decision(True, "allowed (device offline, read only)")
            return Decision(False, "device is offline")
        if cap.risk in ("medium", "high") and not is_idle(device.state):
            return Decision(False, "device is busy")
        return Decision(True, "allowed")
