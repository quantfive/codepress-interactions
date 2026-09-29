"""Call configure(settings=globals()) once at the end of Django settings."""

from __future__ import annotations

import os
import time
from collections.abc import MutableMapping
from importlib.util import find_spec
from typing import Any
from uuid import uuid4

from . import Config, emit
from . import configure as configure_client
from .context import interaction_id, valid_id


def configure(*, settings: MutableMapping[str, Any], **options: Any) -> Config:
    """Mutate only the supplied settings; never trigger django.conf initialization."""
    values: dict[str, Any] = {
        "endpoint": os.getenv("INTERACTIONS_ENDPOINT", ""),
        "server_key": os.getenv("INTERACTIONS_SERVER_KEY", ""),
        "enabled": os.getenv("INTERACTIONS_ENABLED", "false").lower() in {"true", "1", "yes"},
    }
    integer = {"queue_size", "batch_size", "max_event_bytes", "max_attempts"}
    for name in integer | {"flush_interval", "timeout", "retry_interval", "shutdown_timeout"}:
        raw = os.getenv("INTERACTIONS_" + name.upper())
        if raw is not None:
            values[name] = int(raw) if name in integer else float(raw)
    values.update(options)
    config = Config(**values)
    configure_client(config)
    if find_spec("celery") is not None:
        from .celery import install

        install()
    middleware = list(settings.get("MIDDLEWARE", []))
    path = "codepress_interactions.django.InteractionMiddleware"
    if path not in middleware:
        middleware.insert(0, path)
    settings["MIDDLEWARE"] = middleware
    return config


class InteractionMiddleware:
    sync_capable = True
    async_capable = True

    def __init__(self, get_response: Any):
        from asgiref.sync import iscoroutinefunction, markcoroutinefunction

        self.get_response = get_response
        self.is_async = iscoroutinefunction(get_response)
        if self.is_async:
            markcoroutinefunction(self)

    def __call__(self, request: Any) -> Any:
        if self.is_async:
            return self._async(request)
        token = interaction_id.set(valid_id(request.META.get("HTTP_X_INTERACTION_ID")))
        started = time.monotonic()
        trace_id = str(uuid4())
        emit("request.started", trace_id=trace_id)
        response = None
        try:
            response = self.get_response(request)
            return response
        finally:
            self._complete(request, response, started, trace_id)
            interaction_id.reset(token)

    async def _async(self, request: Any) -> Any:
        token = interaction_id.set(valid_id(request.META.get("HTTP_X_INTERACTION_ID")))
        started = time.monotonic()
        trace_id = str(uuid4())
        emit("request.started", trace_id=trace_id)
        response = None
        try:
            response = await self.get_response(request)
            return response
        finally:
            self._complete(request, response, started, trace_id)
            interaction_id.reset(token)

    @staticmethod
    def _complete(request: Any, response: Any, started: float, trace_id: str) -> None:
        data: dict[str, Any] = {
            "trace_id": trace_id,
            "outcome": "failed" if response is None or response.status_code >= 400 else "succeeded",
            "duration_ms": min(86400000, max(0, (time.monotonic() - started) * 1000)),
        }
        route = getattr(getattr(request, "resolver_match", None), "route", None)
        if isinstance(route, str) and len(route) <= 256:
            data["route_template"] = route
        emit("request.completed", **data)
