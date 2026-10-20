"""Core service: keeps the registry current and is the one path that sends `set` (policy + audit)."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
import uuid
from dataclasses import dataclass
from typing import Any

import aiomqtt
from hearth_devices_sdk.contract import device_topic, validate
from hearth_devices_sdk.log import get_logger

from .audit import AuditLog
from .policy import Policy, Via
from .registry import Registry


@dataclass
class CoreSettings:
    host: str = "127.0.0.1"
    port: int = 1883
    username: str = "core"
    password: str | None = None
    result_timeout: float = 10.0


class Core:
    def __init__(self, settings: CoreSettings, policy: Policy, audit: AuditLog, log: logging.Logger | None = None):
        self.settings = settings
        self.policy = policy
        self.audit = audit
        self.registry = Registry()
        self.log = log or get_logger("hearth-devices-core")
        self.ready = asyncio.Event()
        self._client: aiomqtt.Client | None = None
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self.changes: asyncio.Queue[tuple[str, str]] = asyncio.Queue()

    async def run(self, stop: asyncio.Event) -> None:
        async with aiomqtt.Client(
            self.settings.host,
            self.settings.port,
            username=self.settings.username,
            password=self.settings.password,
            identifier=f"hearth-devices-core-{uuid.uuid4().hex[:6]}",
        ) as client:
            self._client = client
            await client.subscribe("hearth/local/#", qos=1)
            self.ready.set()
            pump = asyncio.create_task(self._pump())
            try:
                await stop.wait()
            finally:
                pump.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await pump

    async def _pump(self) -> None:
        assert self._client
        async for m in self._client.messages:
            topic = m.topic.value
            payload = bytes(m.payload) if m.payload else b""
            if topic.endswith("/result"):
                self._on_result(payload)
                continue
            changed = self.registry.apply(topic, payload)
            if changed:
                self.changes.put_nowait((topic.split("/")[3], changed))

    def _on_result(self, payload: bytes) -> None:
        try:
            doc = json.loads(payload)
            validate("result", doc)
        except Exception:
            return
        fut = self._pending.get(doc["requestId"])
        if fut and not fut.done():
            fut.set_result(doc)

    async def execute(
        self,
        device_id: str,
        capability: str,
        action: str,
        params: dict[str, Any],
        via: Via = "local",
        request_id: str | None = None,
    ) -> dict[str, Any]:
        """Policy → set → wait for result → audit. Always returns a result-shaped dict and never raises for refusals."""
        assert self._client, "core not running"
        request_id = request_id or str(uuid.uuid4())
        t0 = time.monotonic()
        device = self.registry.get(device_id)
        decision = self.policy.check(device, capability, via)
        base = {"requestId": request_id, "deviceId": device_id, "capability": capability, "action": action, "via": via}
        if not decision.allow:
            self.audit.write(**base, params=params, decision="refused", reason=decision.reason, ok=False, latencyMs=0)
            self.log.info("command refused", extra={**base, "reason": decision.reason})
            return {"v": 0, "requestId": request_id, "ok": False, "error": f"policy: {decision.reason}", "state": {}}

        cmd = {"v": 0, "requestId": request_id, "capability": capability, "action": action, "params": params}
        validate("set", cmd)
        fut: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = fut
        try:
            await self._client.publish(device_topic(device_id, "set"), json.dumps(cmd), qos=1)
            result = await asyncio.wait_for(fut, self.settings.result_timeout)
        except TimeoutError:
            result = {"v": 0, "requestId": request_id, "ok": False, "error": "no result from adapter", "state": {}}
        finally:
            self._pending.pop(request_id, None)
        latency = round((time.monotonic() - t0) * 1000)
        self.audit.write(
            **base, params=params, decision="sent", ok=result["ok"], error=result["error"], latencyMs=latency
        )
        self.log.info(
            "command done", extra={**base, "ok": result["ok"], "error": result["error"], "latencyMs": latency}
        )
        return result

    async def wait_for(self, predicate, within: float = 5.0) -> None:
        """Waits until predicate(registry) is true (for CLIs and tests)."""
        end = time.monotonic() + within
        while not predicate(self.registry):
            remaining = end - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("registry condition not met")
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self.changes.get(), remaining)
