"""Local device contract v0 (contracts/local-devices/v0): topics, models and JSON Schema validation."""

from __future__ import annotations

import json
import os
import time
from functools import cache
from pathlib import Path
from typing import Any, Literal

import jsonschema
from pydantic import BaseModel, ConfigDict, Field

V = 0
ROOT = "hearth/local"
Risk = Literal["read", "low", "medium", "high"]
RISK_ORDER: dict[str, int] = {"read": 0, "low": 1, "medium": 2, "high": 3}
ID_PATTERN = r"^[a-z0-9][a-z0-9-]*$"


def device_topic(device_id: str, kind: Literal["meta", "state", "set", "result"]) -> str:
    return f"{ROOT}/devices/{device_id}/{kind}"


def adapter_status_topic(adapter_id: str) -> str:
    return f"{ROOT}/adapters/{adapter_id}/status"


SET_FILTER = f"{ROOT}/devices/+/set"


class Capability(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1)
    params: dict[str, Any] = Field(default_factory=dict, description="JSON Schema for the command params")
    risk: Risk


class DeviceMeta(BaseModel):
    model_config = ConfigDict(extra="forbid")
    v: Literal[0] = V
    id: str = Field(pattern=ID_PATTERN)
    name: str = Field(min_length=1)
    room: str = ""
    kind: str = Field(min_length=1)
    adapter: str = Field(pattern=ID_PATTERN)
    capabilities: list[Capability]

    def capability(self, name: str) -> Capability | None:
        return next((c for c in self.capabilities if c.name == name), None)


class SetCommand(BaseModel):
    v: Literal[0]
    requestId: str = Field(min_length=1)
    capability: str = Field(min_length=1)
    action: str = Field(min_length=1)
    params: dict[str, Any]


class Result(BaseModel):
    v: Literal[0] = V
    requestId: str
    ok: bool
    error: str | None
    state: dict[str, Any]


def now_ms() -> int:
    return int(time.time() * 1000)


def state_payload(online: bool, values: dict[str, Any] | None = None) -> dict[str, Any]:
    reserved = {"v", "online", "updatedAt"} & set(values or {})
    if reserved:
        raise ValueError(f"state values may not use reserved keys {sorted(reserved)}")
    return {"v": V, "online": online, "updatedAt": now_ms(), **(values or {})}


def contracts_dir() -> Path:
    env = os.environ.get("HEARTH_CONTRACTS_DIR")
    if env:
        return Path(env)
    # Monorepo layout: hearth-devices/sdk/python/src/hearth_devices_sdk/contract.py → <repo>/contracts
    return Path(__file__).resolve().parents[5] / "contracts" / "local-devices" / "v0"


@cache
def _validator(kind: str) -> jsonschema.Draft202012Validator:
    schema = json.loads((contracts_dir() / f"{kind}.schema.json").read_text())
    return jsonschema.Draft202012Validator(schema)


def validate(kind: Literal["meta", "state", "set", "result"], doc: Any) -> None:
    """Raises jsonschema.ValidationError if doc breaks the shared contract."""
    _validator(kind).validate(doc)
