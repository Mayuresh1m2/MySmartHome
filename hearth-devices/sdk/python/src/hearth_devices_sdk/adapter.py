"""Adapter base class and runner. An adapter implements discovery, state and commands; the runner does the rest."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

import aiomqtt
import jsonschema
from pydantic import ValidationError

from .contract import (
    SET_FILTER,
    DeviceMeta,
    Result,
    SetCommand,
    adapter_status_topic,
    device_topic,
    state_payload,
    validate,
)
from .log import get_logger


class CommandError(Exception):
    """Raise from Adapter.execute with a short, user-safe reason (it is published in result.error)."""


class Adapter(ABC):
    #: Lowercase id; the MQTT username is adapter-<id>.
    adapter_id: str
    #: Seconds between state polls.
    poll_interval: float = 30.0
    #: High-risk capabilities are refused by the SDK unless an adapter explicitly opts in (defence in depth;
    #: hearth-devices policy also disables high risk by default).
    allow_high_risk: bool = False

    @abstractmethod
    async def discover(self) -> list[DeviceMeta]:
        """Return the devices this adapter controls."""

    @abstractmethod
    async def read_state(self, device_id: str) -> dict[str, Any]:
        """Return capability values for one device. Raise to mark it offline."""

    @abstractmethod
    async def execute(self, device_id: str, cmd: SetCommand) -> dict[str, Any] | None:
        """Carry out a validated command. Return new state values, or None to re-read state."""


@dataclass
class BusSettings:
    host: str = "127.0.0.1"
    port: int = 1883
    username: str | None = None
    password: str | None = None


@dataclass
class AdapterRunner:
    adapter: Adapter
    bus: BusSettings
    command_timeout: float = 10.0
    max_backoff: float = 30.0
    log: logging.Logger = field(default_factory=lambda: get_logger("hearth-adapter"))

    def __post_init__(self) -> None:
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", self.adapter.adapter_id):
            raise ValueError(f"bad adapter_id {self.adapter.adapter_id!r}")
        self.devices: dict[str, DeviceMeta] = {}
        self._client: aiomqtt.Client | None = None
        self.ready = asyncio.Event()

    @property
    def status_topic(self) -> str:
        return adapter_status_topic(self.adapter.adapter_id)

    async def run(self, stop: asyncio.Event) -> None:
        """Serves until stop is set, reconnecting with backoff when the bus drops; then goes offline cleanly."""
        delay = 1.0
        while not stop.is_set():
            try:
                await self._session(stop)
                return
            except aiomqtt.MqttError as exc:
                # The broker has published our last will ("offline"); the next session announces "online" again.
                self.ready.clear()
                self.log.warning("bus connection lost", extra={"err": str(exc), "retryInS": round(delay, 1)})
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(stop.wait(), delay)
                delay = min(delay * 2, self.max_backoff)

    async def _session(self, stop: asyncio.Event) -> None:
        will = aiomqtt.Will(self.status_topic, b"offline", qos=1, retain=True)
        async with aiomqtt.Client(
            self.bus.host,
            self.bus.port,
            username=self.bus.username or f"adapter-{self.adapter.adapter_id}",
            password=self.bus.password,
            identifier=f"adapter-{self.adapter.adapter_id}",
            will=will,
            keepalive=30,
        ) as client:
            self._client = client
            # Subscribe before announcing: once meta/state say "online", core may send a set immediately, and a
            # set that reaches the broker before this subscription exists is lost (seen on real Mosquitto).
            await client.subscribe(SET_FILTER, qos=1)
            await self._announce()
            self.ready.set()
            self.log.info("adapter online", extra={"adapter": self.adapter.adapter_id, "devices": list(self.devices)})
            serve = asyncio.create_task(self._serve())
            poll = asyncio.create_task(self._poll())
            stopping = asyncio.create_task(stop.wait())
            try:
                done, _ = await asyncio.wait({serve, poll, stopping}, return_when=asyncio.FIRST_COMPLETED)
                for t in done - {stopping}:
                    t.result()  # re-raises MqttError from a dropped connection
            finally:
                for t in (serve, poll, stopping):
                    t.cancel()
                    with contextlib.suppress(asyncio.CancelledError, aiomqtt.MqttError):
                        await t
            # Graceful shutdown publishes the same "offline" the last will would.
            await client.publish(self.status_topic, b"offline", qos=1, retain=True)
            self.log.info("adapter offline", extra={"adapter": self.adapter.adapter_id})

    async def _announce(self) -> None:
        assert self._client
        await self._client.publish(self.status_topic, b"online", qos=1, retain=True)
        for meta in await self.adapter.discover():
            if meta.adapter != self.adapter.adapter_id:
                expected = self.adapter.adapter_id
                raise ValueError(f"device {meta.id} declares adapter {meta.adapter!r}, expected {expected!r}")
            doc = meta.model_dump()
            validate("meta", doc)
            self.devices[meta.id] = meta
            await self._client.publish(device_topic(meta.id, "meta"), json.dumps(doc), qos=1, retain=True)
            await self._publish_state(meta.id)

    async def _publish_state(self, device_id: str, values: dict[str, Any] | None = None) -> dict[str, Any]:
        assert self._client
        if values is None:
            try:
                values = await asyncio.wait_for(self.adapter.read_state(device_id), self.command_timeout)
                online = True
            except Exception as exc:  # any read failure means "not reachable right now"
                self.log.warning("state read failed", extra={"deviceId": device_id, "err": str(exc)})
                values, online = {}, False
        else:
            online = True
        doc = state_payload(online, values)
        validate("state", doc)
        await self._client.publish(device_topic(device_id, "state"), json.dumps(doc), qos=1, retain=True)
        return doc

    async def _poll(self) -> None:
        while True:
            await asyncio.sleep(self.adapter.poll_interval)
            for device_id in list(self.devices):
                await self._publish_state(device_id)

    async def _serve(self) -> None:
        assert self._client
        async for message in self._client.messages:
            parts = message.topic.value.split("/")
            if len(parts) != 5 or parts[4] != "set" or parts[3] not in self.devices:
                continue  # another adapter's device
            await self.handle_set(parts[3], bytes(message.payload) if message.payload else b"")

    async def handle_set(self, device_id: str, payload: bytes) -> Result | None:
        """Validates and runs one command, then publishes result and fresh state. Public for tests."""
        assert self._client
        try:
            raw = json.loads(payload)
        except ValueError:
            self.log.warning("set dropped: not JSON", extra={"deviceId": device_id})
            return None
        request_id = raw.get("requestId") if isinstance(raw, dict) and isinstance(raw.get("requestId"), str) else None
        meta = self.devices[device_id]
        try:
            cmd = SetCommand.model_validate(raw)
        except ValidationError as exc:
            if request_id is None:
                self.log.warning("set dropped: invalid and no requestId", extra={"deviceId": device_id})
                return None
            return await self._result(device_id, request_id, False, f"invalid command: {exc.errors()[0]['msg']}")

        cap = meta.capability(cmd.capability)
        if cap is None:
            return await self._result(device_id, cmd.requestId, False, f"unknown capability {cmd.capability}")
        if cap.risk == "high" and not self.adapter.allow_high_risk:
            return await self._result(device_id, cmd.requestId, False, "high-risk capability is disabled")
        try:
            jsonschema.validate(cmd.params, cap.params or {"type": "object"})
        except jsonschema.ValidationError as exc:
            return await self._result(device_id, cmd.requestId, False, f"invalid params: {exc.message}")

        try:
            values = await asyncio.wait_for(self.adapter.execute(device_id, cmd), self.command_timeout)
        except CommandError as exc:
            return await self._result(device_id, cmd.requestId, False, str(exc))
        except TimeoutError:
            return await self._result(device_id, cmd.requestId, False, "device did not respond in time")
        except Exception:
            self.log.exception("execute failed", extra={"deviceId": device_id, "requestId": cmd.requestId})
            return await self._result(device_id, cmd.requestId, False, "adapter error")
        state = await self._publish_state(device_id, values)
        return await self._result(device_id, cmd.requestId, True, None, state, publish_state=False)

    async def _result(
        self,
        device_id: str,
        request_id: str,
        ok: bool,
        error: str | None,
        state: dict[str, Any] | None = None,
        publish_state: bool = True,
    ) -> Result:
        assert self._client
        if state is None:
            state = await self._publish_state(device_id) if publish_state else {}
        result = Result(requestId=request_id, ok=ok, error=error, state=state)
        doc = result.model_dump()
        validate("result", doc)
        await self._client.publish(device_topic(device_id, "result"), json.dumps(doc), qos=1)
        self.log.info(
            "command handled",
            extra={"deviceId": device_id, "requestId": request_id, "ok": ok, "error": error},
        )
        return result
