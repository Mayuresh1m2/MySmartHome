"""Hearth adapter for the Dreame L10 Prime robot vacuum.

Control is class 3 (Dreamehome cloud) — see ../../docs/private/devices/vacuum.md. The cloud
protocol is vendored under ../vendor/dreamehome (Tasshack, MIT; see vendor/dreamehome/NOTICE.md).

What it exposes on the bus (contract v1):
  - RvcRunMode    (medium): {"mode": "idle" | "cleaning"}  -> start a full clean / return to dock
  - RvcOperationalState (read): current status, battery, error

Reads are always safe and go over the Dreamehome command relay (proven in progress/38). A
command that *moves the robot* is gated by VACUUM_ARMED: until the owner sets it, execute() is a
dry run — it logs what it would send and returns the current state, so the whole Alexa->hub->bus
chain can be exercised without the vacuum firing. The first real run is done with the owner
watching (medium risk, hearth-devices/CLAUDE.md).

Secrets: the revocable Dreamehome token + did live in ../../secrets/vacuum_session.json (minted
once by scripts/login_probe.py; no password stored). This adapter never prints the token, and the
vendored library's logger is silenced so it can't either.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import pathlib
import signal
import sys
import threading
from typing import Any

from hearth_devices_sdk import (
    Adapter,
    AdapterRunner,
    BusSettings,
    Capability,
    CommandError,
    DeviceMeta,
    SetCommand,
)

# The vendored Dreamehome cloud protocol lives under adapters/vacuum/vendor (not packaged).
_ADAPTER_ROOT = pathlib.Path(__file__).resolve().parents[2]  # .../adapters/vacuum
sys.path.insert(0, str(_ADAPTER_ROOT / "vendor"))
logging.getLogger("dreamehome").setLevel(logging.CRITICAL)  # never surface vendored debug/token logs

from dreamehome.protocol import DreameVacuumDreameHomeCloudProtocol  # noqa: E402

SESSION_PATH = _ADAPTER_ROOT.parent.parent / "secrets" / "vacuum_session.json"
# Captured cleaning-mode values for capture-and-replay (written by scripts/capture_clean_mode.py).
CLEAN_MODE_PATH = _ADAPTER_ROOT.parent.parent / "secrets" / "vacuum_clean_mode.json"
DEVICE_ID = "vacuum"

# --- capability schemas -------------------------------------------------------------------------
RUN_MODE = {
    "type": "object",
    "properties": {"mode": {"enum": ["idle", "cleaning"]}},
    "required": ["mode"],
    "additionalProperties": False,
}
READ_ONLY: dict[str, Any] = {"type": "object"}

# --- MIoT property map (did,siid,piid), confirmed for dreame.vacuum.r2471 in progress/38 --------
PROPS: dict[str, tuple[int, int]] = {
    "state": (2, 1),
    "error": (2, 2),
    "battery": (3, 1),
    "charging": (3, 2),
    "status": (4, 1),
    "cleaningTime": (4, 2),
    "cleanedArea": (4, 3),
    "taskStatus": (4, 7),
}

# --- MIoT actions (siid, aiid) from Tasshack DreameVacuumActionMapping (verified) ---------------
# START = full auto clean (NOT START_CUSTOM 4/1, which needs map/zone params); CHARGE = go home.
ACTION_START = (2, 1)
ACTION_CHARGE = (3, 1)

# Cleaning-mode property (siid, piid). On r2471 its value is a *packed* integer, not a 0-3 enum, whose
# layout depends on capabilities the vendor detects at runtime. Rather than reconstruct it (a wrong value
# is a risky write), we replay the exact integer the robot reports when the app is set to the wanted mode,
# captured idle by scripts/capture_clean_mode.py. Default is my wife's preference: vacuum then mop, two
# passes ("mopping_after_sweeping"). See progress/43 and hearth-devices/CLAUDE.md (RvcCleanMode).
CLEANING_MODE = (4, 23)


def _load_clean_modes() -> tuple[str | None, dict[str, int]]:
    """Read captured cleaning-mode values from the gitignored secrets store (capture-and-replay).

    Returns (default_mode_name, {mode_name: packed_value}). Empty when nothing has been captured yet, in
    which case the adapter sends a plain START and the robot keeps whatever mode the Dreame app last set.
    """
    try:
        store = json.loads(CLEAN_MODE_PATH.read_text())
    except Exception:
        return None, {}
    modes: dict[str, int] = {}
    for name, entry in (store.get("modes") or {}).items():
        value = entry.get("value") if isinstance(entry, dict) else None
        if isinstance(value, int) and not isinstance(value, bool):
            modes[name] = value
    default = store.get("default")
    if default not in modes:
        default = None
    return default, modes

STATUS_WORDS = {
    -1: "unknown", 0: "idle", 1: "paused", 2: "cleaning", 3: "returning", 4: "partial",
    6: "charging", 10: "power-off", 12: "error", 13: "remote-control", 14: "sleeping",
    17: "standby", 18: "segment-cleaning", 19: "zone-cleaning", 20: "spot-cleaning",
}
# Status codes where the robot is actively running a job (-> RvcRunMode "cleaning").
CLEANING_STATUS = {2, 18, 19, 20}

# Dreame fault codes (subset of Tasshack's DreameVacuumErrorCode) -> short, speakable reasons.
# Any other non-zero code falls back to a generic line that still names the number.
ERROR_WORDS = {
    8: "the dustbin needs attention",
    9: "the water tank isn't seated properly",
    10: "the clean-water tank is empty",
    11: "the dustbin is full",
    12: "the main brush is jammed",
    13: "the side brush is jammed",
    14: "the fan is blocked",
    20: "the battery is too low",
    21: "there's a charging fault",
    42: "the water pump has a fault",
    50: "the water pump has a fault",
    68: "the mop pad needs refitting",
    69: "the mop pad was removed",
    74: "the mop didn't fit properly",
    75: "the battery is too low",
    80: "it's stuck",
    81: "it's stuck",
    85: "the mop needs checking",
    105: "the water tank needs attention",
    107: "the water tank is dry",
    108: "the dirty-water tank needs emptying",
    116: "the clean-water tank is low",
    118: "the dirty-water tank is full",
    213: "the onboard water tank is empty",
    214: "the onboard dirty-water tank is full",
}


def _fault_reason(err: Any) -> str | None:
    """A short, user-safe reason for a non-zero Dreame fault code, or None when there is no fault."""
    code = _as_int(err)
    if code in (0, None):
        return None
    return ERROR_WORDS.get(code, f"it reported a fault (code {code})")


def _armed() -> bool:
    """A real command only fires when the owner has armed the adapter (default: dry run)."""
    return os.environ.get("VACUUM_ARMED", "").strip().lower() in {"1", "true", "yes", "on"}


class _Cloud:
    """Thin, thread-safe wrapper over the vendored Dreamehome cloud protocol.

    The vendored client is synchronous (requests-based) and not re-entrant, so every call is made
    under a lock on a worker thread. One logged-in client is kept warm and reused across reads and
    commands. Reading the session file is the only place the token is touched; it is never logged.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._proto: DreameVacuumDreameHomeCloudProtocol | None = None
        self._did: str | None = None

    def _ensure_login(self) -> DreameVacuumDreameHomeCloudProtocol:
        if self._proto is not None:
            return self._proto
        try:
            sess = json.loads(SESSION_PATH.read_text())
        except Exception as exc:  # missing/unreadable session -> device is simply not reachable
            raise CommandError("vacuum not linked (no cloud session)") from exc
        token, did, country, user = (
            sess.get("auth_key"), sess.get("did"), sess.get("country") or "sg", sess.get("username") or ""
        )
        if not (token and did):
            raise CommandError("vacuum not linked (session missing token)")
        proto = DreameVacuumDreameHomeCloudProtocol(
            user, "", account_type="dreame", country=country, auth_key=token, did=str(did)
        )
        if not proto.login() or getattr(proto, "auth_failed", False):
            raise CommandError("vacuum cloud token rejected (re-run login_probe)")
        # Set the device's cloud host/shard before any read or action (best effort).
        try:
            proto.get_device_info()
        except Exception:
            pass
        self._proto, self._did = proto, str(did)
        return proto

    def read_props(self) -> dict[str, Any]:
        with self._lock:
            proto = self._ensure_login()
            batch = [{"did": self._did, "siid": s, "piid": p} for (s, p) in PROPS.values()]
            results = proto.send("get_properties", batch)
            if not results:
                raise CommandError("vacuum offline")
            by_sp = {
                (it.get("siid"), it.get("piid")): it.get("value")
                for it in results
                if isinstance(it, dict) and it.get("code") == 0 and "value" in it
            }
            return {name: by_sp.get(sp) for name, sp in PROPS.items()}

    def call(self, siid: int, aiid: int) -> None:
        with self._lock:
            proto = self._ensure_login()
            resp = proto.send("action", {"did": self._did, "siid": siid, "aiid": aiid, "in": []})
            # MIoT success is code 0; None/other means the device refused or was unreachable.
            if isinstance(resp, dict) and resp.get("code") not in (0, None):
                raise CommandError(f"vacuum refused the command (code {resp.get('code')})")

    def set_property(self, siid: int, piid: int, value: int) -> None:
        """Write one MIoT property (used only to replay a captured clean-mode value before a clean).

        Uses the cloud protocol's generic `send`, symmetric to read_props' get_properties — the
        higher-level set_property helper lives on a different vendored class we don't instantiate.
        """
        with self._lock:
            proto = self._ensure_login()
            resp = proto.send(
                "set_properties",
                [{"did": self._did, "siid": siid, "piid": piid, "value": value}],
            )
            if not resp:  # None -> cloud unreachable / rejected
                raise CommandError("vacuum unreachable while setting clean mode")
            # MIoT set_properties returns [{siid,piid,code}]; code 0 (or absent) means applied.
            codes = [it.get("code") for it in resp if isinstance(it, dict)]
            if any(c not in (0, None) for c in codes):
                raise CommandError(f"vacuum refused the clean-mode set (code {codes})")


def _as_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _to_state(props: dict[str, Any]) -> dict[str, Any]:
    """Map raw MIoT properties to the capability values published on the bus (no secrets)."""
    status = _as_int(props.get("status"))
    return {
        "runMode": "cleaning" if status in CLEANING_STATUS else "idle",
        "operationalState": STATUS_WORDS.get(status if status is not None else -1, "unknown"),
        "battery": _as_int(props.get("battery")),
        # A short, speakable reason when the robot has a fault (e.g. "the water tank is dry"), else null.
        "fault": _fault_reason(props.get("error")),
    }


class VacuumAdapter(Adapter):
    adapter_id = "vacuum"

    def __init__(self, poll_interval: float = 60.0) -> None:
        self.poll_interval = poll_interval
        self._cloud = _Cloud()

    async def discover(self) -> list[DeviceMeta]:
        # Static metadata — no cloud call, so the adapter still registers if the vacuum is offline.
        return [
            DeviceMeta(
                id=DEVICE_ID,
                name="Robot vacuum",
                room="",
                kind="robot-vacuum",
                adapter="vacuum",
                capabilities=[
                    Capability(name="RvcRunMode", risk="medium", params=RUN_MODE),
                    Capability(name="RvcOperationalState", risk="read", params=READ_ONLY),
                ],
            )
        ]

    async def read_state(self, device_id: str) -> dict[str, Any]:
        props = await asyncio.to_thread(self._cloud.read_props)
        return _to_state(props)

    async def execute(self, device_id: str, cmd: SetCommand) -> dict[str, Any] | None:
        if cmd.capability == "RvcOperationalState":
            return None  # read-only: SDK re-reads state
        if cmd.capability != "RvcRunMode":
            raise CommandError(f"{cmd.capability} not supported on {device_id}")

        mode = cmd.params["mode"]
        siid, aiid = ACTION_START if mode == "cleaning" else ACTION_CHARGE
        verb = "START clean" if mode == "cleaning" else "return to dock"

        # Before a clean, replay the captured cleaning-mode value (default: two-pass) so the robot runs
        # my wife's preferred mode instead of inheriting whatever the Dreame app was last set to. Only
        # applies to a clean; docking never touches the mode. No capture on file -> plain START.
        clean_name, clean_value = (None, None)
        if mode == "cleaning":
            default_name, modes = _load_clean_modes()
            if default_name is not None:
                clean_name, clean_value = default_name, modes[default_name]
        log_extra = {"deviceId": device_id, "requestId": cmd.requestId}

        if not _armed():
            # Dry run: exercise the whole chain without moving the robot. ok=true is intentional so
            # the hub plays its success reply and we can see the end-to-end path light up.
            if clean_value is not None:
                runner_log.info(
                    "dry-run (VACUUM_ARMED not set): would set clean mode %s (%d/%d=%d) then send %s; "
                    "nothing sent", clean_name, CLEANING_MODE[0], CLEANING_MODE[1], clean_value, verb,
                    extra=log_extra,
                )
            else:
                runner_log.info(
                    "dry-run (VACUUM_ARMED not set): would send %s (siid=%d aiid=%d); nothing sent",
                    verb, siid, aiid, extra=log_extra,
                )
            return None  # re-read: reflects real (unchanged) state

        if mode == "cleaning":
            # Don't poke a robot that already can't clean: if it's sitting on a fault (e.g. a dry
            # water tank), surface that reason instead of sending a start it will only abort.
            # A fault the robot only discovers *after* starting shows up later via RvcOperationalState
            # (the hub's vacuum-status read), not here.
            reason = _fault_reason((await asyncio.to_thread(self._cloud.read_props)).get("error"))
            if reason:
                raise CommandError(reason)
            if clean_value is not None:
                runner_log.info(
                    "ARMED: setting clean mode %s (%d/%d=%d)", clean_name, CLEANING_MODE[0],
                    CLEANING_MODE[1], clean_value, extra=log_extra,
                )
                await asyncio.to_thread(
                    self._cloud.set_property, CLEANING_MODE[0], CLEANING_MODE[1], clean_value
                )

        runner_log.info(
            "ARMED: sending %s (siid=%d aiid=%d)", verb, siid, aiid, extra=log_extra,
        )
        await asyncio.to_thread(self._cloud.call, siid, aiid)
        return None  # re-read fresh state from the cloud


# Module logger for execute()'s dry-run / armed lines (the runner owns the structured handler).
runner_log = logging.getLogger("hearth-adapter.vacuum")


def main() -> None:
    runner = AdapterRunner(
        VacuumAdapter(poll_interval=float(os.environ.get("POLL_INTERVAL_S", "60"))),
        BusSettings(
            host=os.environ.get("BUS_HOST", "127.0.0.1"),
            port=int(os.environ.get("BUS_PORT", "1883")),
            password=os.environ["BUS_PASSWORD"],
        ),
    )
    stop = asyncio.Event()

    async def run() -> None:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, stop.set)
        await runner.run(stop)

    asyncio.run(run())


__all__ = ["VacuumAdapter", "main"]
