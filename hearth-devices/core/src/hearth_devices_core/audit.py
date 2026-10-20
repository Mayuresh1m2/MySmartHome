"""Append-only JSONL audit of every command the core sends or refuses: data/audit/YYYY-MM-DD.jsonl (UTC)."""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


class AuditLog:
    def __init__(self, directory: str | Path) -> None:
        self.dir = Path(directory)

    def write(self, **entry: Any) -> dict[str, Any]:
        now = datetime.now(UTC)
        doc = {"ts": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"), **entry}
        self.dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = self.dir / f"{now:%Y-%m-%d}.jsonl"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a") as f:
            f.write(json.dumps(doc, default=str) + "\n")
        return doc

    def read(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for p in sorted(self.dir.glob("*.jsonl")):
            out.extend(json.loads(line) for line in p.read_text().splitlines() if line)
        return out
