"""Optional Celery signal adapter. Call install() beside Celery app setup."""

from __future__ import annotations

import time
from contextvars import ContextVar
from typing import Any
from uuid import uuid4

from . import emit
from .context import interaction_id, valid_id

_HEADER = "codepress_interaction_id"
_state: ContextVar[tuple[Any, ...] | None] = ContextVar("interaction_task_state", default=None)


def _publish(headers: dict[str, Any] | None = None, **kwargs: Any) -> None:
    if headers is not None:
        value = interaction_id.get()
        if value:
            headers[_HEADER] = value
        else:
            headers.pop(_HEADER, None)


def _prerun(task_id: str | None = None, task: Any = None, **kwargs: Any) -> None:
    headers = getattr(getattr(task, "request", None), "headers", None) or {}
    token = interaction_id.set(valid_id(headers.get(_HEADER)))
    previous = _state.get()
    operation = str(uuid4())
    _state.set((task_id, token, operation, time.monotonic(), previous))
    emit("operation.started", operation_id=operation, source="worker", outcome="running")


def _postrun(task_id: str | None = None, state: str | None = None, **kwargs: Any) -> None:
    current = _state.get()
    if current is None or current[0] != task_id:
        return
    _, token, operation, started, previous = current
    try:
        outcome = {"SUCCESS": "succeeded", "RETRY": "pending", "REVOKED": "cancelled"}.get(
            state or "", "failed"
        )
        emit(
            "operation.completed",
            operation_id=operation,
            source="worker",
            outcome=outcome,
            duration_ms=min(86400000, max(0, (time.monotonic() - started) * 1000)),
        )
    finally:
        interaction_id.reset(token)
        _state.set(previous)


def _worker_init(**kwargs: Any) -> None:
    from . import _after_fork

    _after_fork()
    _state.set(None)


def _worker_shutdown(**kwargs: Any) -> None:
    from . import shutdown

    shutdown()


def install() -> None:
    from celery import signals

    signals.worker_process_init.connect(
        _worker_init, weak=False, dispatch_uid="interactions.worker-init.v1"
    )
    signals.worker_process_shutdown.connect(
        _worker_shutdown, weak=False, dispatch_uid="interactions.worker-shutdown.v1"
    )

    signals.before_task_publish.connect(
        _publish, weak=False, dispatch_uid="interactions.publish.v1"
    )
    signals.task_prerun.connect(_prerun, weak=False, dispatch_uid="interactions.prerun.v1")
    signals.task_postrun.connect(_postrun, weak=False, dispatch_uid="interactions.postrun.v1")
