import json
import threading
from uuid import uuid4

import codepress_interactions as sdk
from codepress_interactions import Client, Config


def config(**kwargs):
    return Config(
        endpoint="http://localhost",
        server_key="private-key",
        enabled=True,
        retry_interval=0.001,
        **kwargs,
    )


def test_retry_preserves_immutable_batch_and_acknowledges():
    bodies = []

    def transport(endpoint, key, body, timeout):
        bodies.append(body)
        return 503 if len(bodies) == 1 else 202

    client = Client(config(), transport=transport)
    assert client.emit("request.started", interaction_id=str(uuid4()))
    assert client.flush(2)
    assert client.shutdown(2)
    assert bodies[0] == bodies[1]
    body = json.loads(bodies[0])
    assert body["schema_version"] == 1
    assert body["events"][0]["source"] == "server"
    assert client.diagnostics()["retry_attempts"] == 1
    assert client.diagnostics()["acknowledged_batches"] == 1
    assert "private-key" not in repr(client.config)


def test_queue_is_bounded_without_blocking_application():
    entered, release = threading.Event(), threading.Event()

    def transport(*args):
        entered.set()
        assert release.wait(2)
        return 202

    client = Client(config(queue_size=1, batch_size=1), transport=transport)
    try:
        assert client.emit("request.started")
        assert entered.wait(2)
        assert client.emit("request.started")
        assert not client.emit("request.started")
        assert client.diagnostics()["dropped_events"] == 1
        assert not client.flush(0)
    finally:
        release.set()
        assert client.shutdown(2)


def test_invalid_fields_and_rejected_credential_have_safe_diagnostics():
    client = Client(config(), transport=lambda *args: 403)
    assert not client.emit("request.started", body="private input")
    assert not client.emit("request.started", duration_ms=float("nan"))
    assert not client.emit("operation.started")
    assert client.emit("request.started")
    assert client.flush(2)
    assert not client.emit("request.started")
    assert client.shutdown(2)
    diagnostics = client.diagnostics()
    assert diagnostics["invalid_events"] == 3
    assert diagnostics["credential_rejected"]
    assert diagnostics["dropped_events"] == 1
    assert "private" not in str(diagnostics)


def test_disabled_and_fork_reset_are_lazy(monkeypatch):
    sdk.configure(Config())
    assert not sdk.emit("request.started")
    parent = sdk.current_client()
    with sdk.interaction(str(uuid4())):
        sdk._after_fork()
        assert sdk.interaction_id.get() is None
        child = sdk.current_client()
    assert parent is not child
    assert child._thread is None
    assert sdk.shutdown()


def test_event_matches_published_schema_fixture():
    # Required envelope and strict data whitelist agree with the shared protocol fixture.
    from pathlib import Path

    fixture = json.loads((Path(__file__).parents[2] / "protocol/v1-batch.json").read_text())
    sent = []
    client = Client(
        config(),
        transport=lambda endpoint, key, body, timeout: sent.append(json.loads(body)) or 202,
    )
    assert client.emit(
        "request.completed", route_template="orders/<uuid:id>/", outcome="succeeded", duration_ms=2
    )
    assert client.shutdown(2)
    import jsonschema

    schema = json.loads((Path(__file__).parents[2] / "protocol/v1-batch.schema.json").read_text())
    jsonschema.validate(sent[0], schema, format_checker=jsonschema.FormatChecker())
    assert set(sent[0]) == set(fixture)
    event = sent[0]["events"][0]
    assert set(event) == set(fixture["events"][0])
    assert set(event["data"]) <= set(fixture["events"][0]["data"])


def test_transport_posts_base_url_and_never_follows_redirect(monkeypatch):
    from unittest.mock import MagicMock

    from codepress_interactions.client import _NoRedirect, _send

    opener = MagicMock()
    opener.open.return_value.__enter__.return_value.status = 202
    monkeypatch.setattr("urllib.request.build_opener", lambda handler: opener)
    assert _send("https://telemetry.example/", "secret", b"{}", 2) == 202
    request = opener.open.call_args.args[0]
    assert request.full_url == "https://telemetry.example/v1/batches"
    assert request.get_header("Authorization") == "Bearer secret"
    assert _NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.example") is None


def test_direct_client_reinitializes_after_pid_change(monkeypatch):
    client = Client(Config())
    instance = client._instance
    monkeypatch.setattr("codepress_interactions.client.os.getpid", lambda: client._pid + 1)
    assert client.diagnostics()["pending_events"] == 0
    assert client._instance != instance
    assert client._thread is None
