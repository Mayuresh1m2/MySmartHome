"""Registry: the current picture of every device, built only from what adapters publish on the bus."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from hearth_devices_sdk.contract import DeviceMeta, validate
from jsonschema import ValidationError


@dataclass
class DeviceView:
    meta: DeviceMeta
    state: dict[str, Any] = field(default_factory=dict)
    adapter_online: bool = False

    @property
    def online(self) -> bool:
        """A device is online only if its adapter is online and its last state said so."""
        return self.adapter_online and bool(self.state.get("online"))

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.meta.id,
            "name": self.meta.name,
            "room": self.meta.room,
            "kind": self.meta.kind,
            "adapter": self.meta.adapter,
            "online": self.online,
            "capabilities": [{"name": c.name, "risk": c.risk} for c in self.meta.capabilities],
            "state": {k: v for k, v in self.state.items() if k not in ("v", "online")},
        }


class Registry:
    def __init__(self) -> None:
        self.devices: dict[str, DeviceView] = {}
        self.adapters: dict[str, str] = {}
        self.rejected = 0

    def apply(self, topic: str, payload: bytes, retained: bool = True) -> str | None:
        """Feeds one bus message. Returns what changed ("meta", "state", "status") or None if ignored.

        `retained` is False for messages delivered live. A live meta/state can only come from a connected adapter
        (its will is published only once the connection is gone), so it proves the adapter online even when the
        retained status we saw is stale; aedes, for one, can hand a new subscriber an outdated retained status.
        """
        parts = topic.split("/")
        if parts[:2] != ["hearth", "local"] or len(parts) != 5:
            return None
        if parts[2] == "adapters" and parts[4] == "status":
            status = payload.decode(errors="replace")
            if status not in ("online", "offline"):
                self.rejected += 1
                return None
            self.adapters[parts[3]] = status
            for d in self.devices.values():
                if d.meta.adapter == parts[3]:
                    d.adapter_online = status == "online"
            return "status"
        if parts[2] != "devices" or parts[4] not in ("meta", "state"):
            return None
        device_id, kind = parts[3], parts[4]
        if not payload:  # retained message cleared: device removed
            if kind == "meta":
                self.devices.pop(device_id, None)
            return kind
        try:
            doc = json.loads(payload)
            validate(kind, doc)
        except (ValueError, ValidationError):
            self.rejected += 1  # contract violations never enter the registry
            return None
        if kind == "meta":
            meta = DeviceMeta.model_validate(doc)
            if meta.id != device_id:
                self.rejected += 1
                return None
            view = self.devices.get(device_id) or DeviceView(meta=meta)
            view.meta = meta
            view.adapter_online = self.adapters.get(meta.adapter) == "online"
            self.devices[device_id] = view
        else:
            view = self.devices.get(device_id)
            if view is None:
                return None  # state before meta: wait for meta (both are retained)
            view.state = doc
        if not retained:
            adapter = self.devices[device_id].meta.adapter
            if self.adapters.get(adapter) != "online":
                self.adapters[adapter] = "online"
                for d in self.devices.values():
                    if d.meta.adapter == adapter:
                        d.adapter_online = True
        return kind

    def get(self, device_id: str) -> DeviceView | None:
        return self.devices.get(device_id)

    def list(self) -> list[dict[str, Any]]:
        return [d.summary() for d in sorted(self.devices.values(), key=lambda d: d.meta.id)]

    def snapshot(self, updated_at: int) -> dict[str, Any]:
        """The retained hearth/local/core/registry document (contract v1), capabilities with their params."""
        devices = []
        for d in sorted(self.devices.values(), key=lambda d: d.meta.id):
            s = d.summary()
            s["capabilities"] = [c.model_dump() for c in d.meta.capabilities]
            s["state"] = {k: v for k, v in d.state.items() if k not in ("v", "online", "updatedAt")}
            devices.append(s)
        return {"v": 1, "updatedAt": updated_at, "devices": devices}
