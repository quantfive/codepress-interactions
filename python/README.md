# Python SDK

Install `codepress-interactions[django,celery]` (release candidate source; publication is separate).
The core uses only Python's standard library and never imports private CodePress modules.

At the end of Django settings:

```python
from codepress_interactions.django import configure
configure(settings=globals())
```

Set `INTERACTIONS_ENABLED=true`, `INTERACTIONS_ENDPOINT=https://telemetry.example.com`
(service base URL), and `INTERACTIONS_SERVER_KEY` in the server environment. The SDK
posts to `/v1/batches`. Never put the server key in browser code. Setup is idempotent,
does not initialize Django settings, and starts no network work until a request emits
an event. Disabled is the default.

Django configuration automatically installs the Celery adapter when Celery is installed.
For a standalone Celery app without Django, call once beside app setup:

```python
from codepress_interactions.celery import install
install()
```

The adapter copies only a validated interaction UUID in publish headers. Each worker
attempt gets a fresh operation UUID, including retries. It captures no task arguments,
results, exception strings or task names. Worker context resets after every attempt.
Django captures request start/completion, route templates and coarse success/failure,
never request paths, URLs, query strings, bodies or raw text. Streaming response
completion means the handler returned, not that every response byte reached the client.
Missing/invalid `X-Interaction-Id` produces unlinked backend observations. An incoming
UUID is correlation supplied by a client, not proof of that client's identity.

Core use:

```python
from codepress_interactions import Config, configure, interaction, emit, flush, shutdown
configure(Config(endpoint="https://telemetry.example.com", server_key="...", enabled=True))
with interaction("52d89faa-2b4e-4c0f-9636-23b99f901534"):
    emit("request.completed", outcome="succeeded", duration_ms=12)
flush(timeout=2)
shutdown(timeout=2)
```

The background uploader bounds queued events (512 plus one in-flight batch of at most 32),
event bytes (4096), attempts (3) and network timeout (3s). Retry reuses identical serialized
batch bytes and IDs. `diagnostics()` reports accepted local events, acknowledged batches,
drops, retries and credential rejection; local acceptance is not a server acknowledgment.
Transient failures retry after 0.5s; permanent failures drop visibly. 401/403 stop admissions.
There is no disk spool: process death can lose pending telemetry. Forked processes lazily
create their own client, sequence and source instance. Server credentials are never logged.

All limits/timers are `Config` fields. Django environment overrides use `INTERACTIONS_`
plus uppercase field name, including `QUEUE_SIZE`, `BATCH_SIZE`, `MAX_EVENT_BYTES`,
`MAX_ATTEMPTS`, `FLUSH_INTERVAL`, `TIMEOUT`, `RETRY_INTERVAL`, `SHUTDOWN_TIMEOUT`.
`flush`/`shutdown` return false when their deadline expires; they never wait indefinitely.
Call shutdown explicitly during graceful application/worker shutdown for stronger delivery;
interpreter exit also makes a bounded best effort. A stalled transport may remain in its
bounded network call after a shorter caller shutdown deadline.

Development: `uv sync`, `uv run pytest`, `uv run ruff check src tests`, `uv build`.
