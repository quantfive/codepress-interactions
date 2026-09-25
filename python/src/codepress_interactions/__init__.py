"""Open Python interaction telemetry SDK."""

from __future__ import annotations

import atexit
import os
import threading
from typing import Any

from .client import Client, Config
from .context import interaction, interaction_id

__all__ = [
    "Client",
    "Config",
    "configure",
    "current_client",
    "diagnostics",
    "emit",
    "flush",
    "interaction",
    "shutdown",
]
_config = Config()
_client: Client | None = None
_pid = os.getpid()
_lock = threading.Lock()


def _after_fork() -> None:
    global _client, _pid, _lock
    _client = None
    interaction_id.set(None)
    _pid = os.getpid()
    _lock = threading.Lock()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_after_fork)


def configure(config: Config) -> None:
    global _config, _client
    if config == _config:
        return
    if _client:
        _client.shutdown()
    _config = config
    _client = None


def current_client() -> Client:
    global _client
    if os.getpid() != _pid:
        _after_fork()
    with _lock:
        if _client is None:
            _client = Client(_config)
    return _client


def emit(event_type: str, **data: Any) -> bool:
    try:
        return current_client().emit(event_type, interaction_id=interaction_id.get(), **data)
    except Exception:  # noqa: BLE001 - telemetry must not affect application work
        return False


def diagnostics() -> dict[str, Any]:
    return current_client().diagnostics()


def flush(timeout: float | None = None) -> bool:
    return current_client().flush(timeout)


def shutdown(timeout: float | None = None) -> bool:
    return _client.shutdown(timeout) if _client else True


atexit.register(shutdown)
