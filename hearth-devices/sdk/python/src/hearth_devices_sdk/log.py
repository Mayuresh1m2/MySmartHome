"""JSON-lines logging so adapter logs can be merged with hub and broker logs by requestId."""

from __future__ import annotations

import json
import logging
import sys
from datetime import UTC, datetime

_STD = set(vars(logging.makeLogRecord({})).keys()) | {"message", "asctime"}


class JsonFormatter(logging.Formatter):
    def __init__(self, svc: str) -> None:
        super().__init__()
        self.svc = svc

    def format(self, record: logging.LogRecord) -> str:
        doc = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "level": record.levelname.lower(),
            "svc": self.svc,
            "msg": record.getMessage(),
        }
        doc.update({k: v for k, v in vars(record).items() if k not in _STD})
        if record.exc_info:
            doc["exc"] = self.formatException(record.exc_info)
        return json.dumps(doc, default=str)


def get_logger(svc: str, level: str = "INFO") -> logging.Logger:
    log = logging.getLogger(svc)
    if not log.handlers:
        h = logging.StreamHandler(sys.stdout)
        h.setFormatter(JsonFormatter(svc))
        log.addHandler(h)
        log.propagate = False
    log.setLevel(level)
    return log
