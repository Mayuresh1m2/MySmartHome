# Minimal subset of Tasshack/dreame-vacuum `dreame/types.py` — only the one symbol
# `protocol.py` imports (`RestartableTimer`), copied verbatim to avoid vendoring the
# full 215 KB types module (device-model enums/dataclasses we don't use). Stdlib only.
# Source: github.com/Tasshack/dreame-vacuum @ f5b8472 — MIT, see LICENSE / NOTICE.md.
from threading import Thread, Event, Lock
import time


class RestartableTimer:
    def __init__(self) -> None:
        self._lock = Lock()
        self._event = Event()
        self._thread: Thread = None
        self._deadline: float = None
        self._function = None
        self._args: tuple = ()
        self._generation: int = 0
        self._stopped: bool = False

    def start(self, delay: float, function, args: tuple = None) -> None:
        with self._lock:
            if self._stopped:
                return
            self._deadline = time.monotonic() + delay
            self._function = function
            self._args = args or ()
            self._generation += 1
            if self._thread is None or not self._thread.is_alive():
                self._thread = Thread(target=self._run, daemon=True)
                self._thread.start()
        self._event.set()

    def cancel(self) -> None:
        with self._lock:
            self._deadline = None
            self._function = None
            self._args = ()
            self._generation += 1
        self._event.set()

    def stop(self) -> None:
        with self._lock:
            self._stopped = True
            self._deadline = None
            self._function = None
            self._args = ()
            self._generation += 1
        self._event.set()

    def _run(self) -> None:
        while True:
            with self._lock:
                if self._stopped:
                    return
                deadline = self._deadline
                generation = self._generation

            if deadline is None:
                self._event.wait()
                self._event.clear()
                continue

            remaining = deadline - time.monotonic()
            if remaining > 0:
                woken = self._event.wait(remaining)
                self._event.clear()
                if woken:
                    continue

            with self._lock:
                if self._stopped or self._generation != generation or self._deadline is None:
                    continue
                function = self._function
                args = self._args
                self._deadline = None
                self._function = None
                self._args = ()

            try:
                function(*args)
            except Exception:
                pass
