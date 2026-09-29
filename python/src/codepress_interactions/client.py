"""Bounded process-local uploader; application threads never perform network I/O."""

from __future__ import annotations

import json
import math
import os
import queue
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

VERSION = "0.1.0"
_TYPES = {
    "request.started",
    "request.completed",
    "operation.started",
    "operation.phase",
    "operation.completed",
    "capture.interrupted",
    "capture.events_dropped",
}
_STRING_LIMITS = {
    "control_id": 128,
    "surface": 128,
    "action": 128,
    "route_template": 256,
    "feedback_type": 64,
    "trace_id": 128,
    "phase": 128,
    "sdk_version": 64,
}
_OUTCOMES = {
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "pending",
    "completed",
    "error",
    "abandoned",
}


@dataclass(frozen=True)
class Config:
    endpoint: str = ""
    server_key: str = field(default="", repr=False)
    enabled: bool = False
    queue_size: int = 512
    batch_size: int = 32
    max_event_bytes: int = 4096
    flush_interval: float = 1.0
    timeout: float = 3.0
    max_attempts: int = 3
    retry_interval: float = 0.5
    shutdown_timeout: float = 5.0

    def __post_init__(self) -> None:
        if min(self.queue_size, self.batch_size, self.max_event_bytes, self.max_attempts) < 1:
            raise ValueError("Queue, batch, event and attempt limits must be positive")
        for value in (
            self.flush_interval,
            self.timeout,
            self.retry_interval,
            self.shutdown_timeout,
        ):
            if not math.isfinite(value) or value <= 0:
                raise ValueError("Timing settings must be finite and positive")
        if self.enabled and (
            not self.endpoint.startswith(("http://", "https://")) or not self.server_key
        ):
            raise ValueError("Enabled telemetry needs an HTTP(S) endpoint and server key")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward the server credential to a redirected host.


def _send(endpoint: str, key: str, payload: bytes, timeout: float) -> int:
    request = urllib.request.Request(
        endpoint.rstrip("/") + "/v1/batches",
        data=payload,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.build_opener(_NoRedirect).open(request, timeout=timeout) as response:
            return int(response.status)
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
        return status


class Client:
    def __init__(
        self, config: Config, *, transport: Callable[[str, str, bytes, float], int] = _send
    ):
        self._pid = os.getpid()
        self.config = config
        self._transport = transport
        self._queue: queue.Queue[dict[str, Any]] = queue.Queue(config.queue_size)
        self._lock = threading.Lock()
        self._condition = threading.Condition(self._lock)
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._instance = str(uuid4())
        self._sequence = 0
        self._submitted = 0
        self._finished = 0
        self._closed = False
        self._rejected = False
        self._counts = {
            "accepted_events": 0,
            "dropped_events": 0,
            "failed_batches": 0,
            "acknowledged_batches": 0,
            "retry_attempts": 0,
            "invalid_events": 0,
        }

    def _ensure_process(self) -> None:
        if self._pid != os.getpid():
            self.__init__(self.config, transport=self._transport)

    def emit(
        self,
        event_type: str,
        *,
        interaction_id: str | None = None,
        operation_id: str | None = None,
        source: str = "server",
        **data: Any,
    ) -> bool:
        self._ensure_process()
        if not self.config.enabled or self._closed or self._rejected:
            return False
        try:
            if event_type not in _TYPES or source not in {"server", "worker"}:
                raise ValueError("Unsupported event")
            if event_type.startswith("operation.") and operation_id is None:
                raise ValueError("Operation ID required")
            from .context import valid_id

            if interaction_id is not None and valid_id(interaction_id) is None:
                raise ValueError("Invalid interaction ID")
            if operation_id is not None and valid_id(operation_id) is None:
                raise ValueError("Invalid operation ID")
            for name, value in data.items():
                if name in _STRING_LIMITS:
                    if not isinstance(value, str) or len(value) > _STRING_LIMITS[name]:
                        raise ValueError("Invalid string field")
                elif name == "outcome":
                    if value not in _OUTCOMES:
                        raise ValueError("Invalid outcome")
                elif name in {"duration_ms", "count"}:
                    bound = 86400000 if name == "duration_ms" else 1000000
                    if (
                        isinstance(value, bool)
                        or not isinstance(value, (int, float))
                        or not math.isfinite(value)
                        or not 0 <= value <= bound
                    ):
                        raise ValueError("Invalid numeric field")
                    if name == "count" and not isinstance(value, int):
                        raise ValueError("Count must be integer")
                else:
                    raise ValueError("Unsupported data field")
            with self._condition:
                if self._closed or self._rejected:
                    return False
                self._sequence += 1
                event = {
                    "event_id": str(uuid4()),
                    "schema_version": 1,
                    "interaction_id": interaction_id,
                    "operation_id": operation_id,
                    "source": source,
                    "source_instance_id": self._instance,
                    "sequence": self._sequence,
                    "occurred_at": datetime.now(timezone.utc).isoformat(),
                    "elapsed_ms": None,
                    "type": event_type,
                    "attribution": "explicit" if interaction_id else "unknown",
                    "data": {"sdk_version": VERSION, **data},
                }
                if len(json.dumps(event).encode()) > self.config.max_event_bytes:
                    self._counts["dropped_events"] += 1
                    return False
                try:
                    self._queue.put_nowait(event)
                except queue.Full:
                    self._counts["dropped_events"] += 1
                    return False
                self._submitted += 1
                self._counts["accepted_events"] += 1
                if self._thread is None:
                    self._thread = threading.Thread(
                        target=self._run, name="interactions-uploader", daemon=True
                    )
                    self._thread.start()
            self._wake.set()
            return True
        except Exception:  # noqa: BLE001 - telemetry must not affect application work
            with self._condition:
                self._counts["invalid_events"] += 1
            return False

    def _run(self) -> None:
        while not self._stop.is_set():
            self._wake.wait(self.config.flush_interval)
            self._wake.clear()
            events = []
            while len(events) < self.config.batch_size:
                try:
                    events.append(self._queue.get_nowait())
                except queue.Empty:
                    break
            if not events:
                continue
            payload = json.dumps(
                {"batch_id": str(uuid4()), "schema_version": 1, "events": events},
                separators=(",", ":"),
            ).encode()
            delivered = False
            for attempt in range(self.config.max_attempts):
                if self._stop.is_set() or self._rejected:
                    break
                try:
                    status = self._transport(
                        self.config.endpoint, self.config.server_key, payload, self.config.timeout
                    )
                except Exception:  # noqa: BLE001 - telemetry must not affect application work
                    status = 503
                if status == 202:
                    delivered = True
                    break
                if status in {401, 403}:
                    self._rejected = True
                if status not in {408, 429} and status < 500:
                    break
                if attempt + 1 < self.config.max_attempts:
                    with self._condition:
                        self._counts["retry_attempts"] += 1
                    if self._stop.wait(self.config.retry_interval):
                        break
            with self._condition:
                self._finished += len(events)
                if delivered:
                    self._counts["acknowledged_batches"] += 1
                else:
                    self._counts["failed_batches"] += 1
                    self._counts["dropped_events"] += len(events)
                self._condition.notify_all()
            if not self._queue.empty():
                self._wake.set()

    def diagnostics(self) -> dict[str, Any]:
        self._ensure_process()
        with self._condition:
            return {
                **self._counts,
                "pending_events": self._submitted - self._finished,
                "enabled": self.config.enabled,
                "credential_rejected": self._rejected,
                "closed": self._closed,
            }

    def flush(self, timeout: float | None = None) -> bool:
        self._ensure_process()
        deadline = time.monotonic() + (self.config.shutdown_timeout if timeout is None else timeout)
        self._wake.set()
        with self._condition:
            target = self._submitted
            while self._finished < target:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._condition.wait(remaining)
        return True

    def shutdown(self, timeout: float | None = None) -> bool:
        self._ensure_process()
        with self._condition:
            self._closed = True
        budget = self.config.shutdown_timeout if timeout is None else timeout
        started = time.monotonic()
        drained = self.flush(budget)
        self._stop.set()
        self._wake.set()
        if self._thread:
            self._thread.join(max(0, budget - (time.monotonic() - started)))
        return drained and (self._thread is None or not self._thread.is_alive())
