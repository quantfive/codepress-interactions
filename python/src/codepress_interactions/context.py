"""Explicit context is process-local; unlinked work never inherits a global last click."""

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from uuid import UUID

interaction_id: ContextVar[str | None] = ContextVar("interaction_id", default=None)


def valid_id(value: object) -> str | None:
    if not isinstance(value, str) or len(value) != 36:
        return None
    try:
        return str(UUID(value))
    except (ValueError, TypeError):
        return None


@contextmanager
def interaction(value: str | None) -> Iterator[None]:
    token = interaction_id.set(valid_id(value))
    try:
        yield
    finally:
        interaction_id.reset(token)
