import asyncio
from types import SimpleNamespace
from uuid import uuid4

import pytest

import codepress_interactions as sdk
from codepress_interactions.context import interaction_id
from codepress_interactions.django import InteractionMiddleware, configure


@pytest.fixture(autouse=True)
def reset():
    sdk.configure(sdk.Config())
    interaction_id.set(None)
    yield
    sdk.shutdown()
    interaction_id.set(None)


def test_settings_configuration_is_idempotent_without_django_settings(monkeypatch):
    from django.conf import settings as django_settings

    # This SDK setup neither reads nor configures Django's LazySettings.
    before = django_settings.configured
    mapping = {"MIDDLEWARE": ("some.middleware",)}
    configure(settings=mapping, enabled=False)
    configure(settings=mapping, enabled=False)
    assert mapping["MIDDLEWARE"].count("codepress_interactions.django.InteractionMiddleware") == 1
    assert django_settings.configured == before
    assert sdk.current_client()._thread is None


def test_sync_request_exception_preserves_business_error_and_clears_context(monkeypatch):
    events = []
    monkeypatch.setattr(
        "codepress_interactions.django.emit",
        lambda kind, **data: events.append((kind, interaction_id.get(), data)),
    )
    identifier = str(uuid4())
    request = SimpleNamespace(
        META={"HTTP_X_INTERACTION_ID": identifier},
        resolver_match=SimpleNamespace(route="users/<int:id>/"),
    )

    def handler(request):
        assert interaction_id.get() == identifier
        raise RuntimeError("secret business exception")

    with pytest.raises(RuntimeError, match="secret business exception"):
        InteractionMiddleware(handler)(request)
    assert interaction_id.get() is None
    assert events[-1][2]["outcome"] == "failed"
    assert events[-1][2]["route_template"] == "users/<int:id>/"
    assert "secret" not in str(events)


@pytest.mark.asyncio
async def test_async_requests_have_isolated_context(monkeypatch):
    events = []
    entered, release = asyncio.Event(), asyncio.Event()
    first, second = str(uuid4()), str(uuid4())
    monkeypatch.setattr(
        "codepress_interactions.django.emit",
        lambda kind, **data: events.append((kind, interaction_id.get())),
    )

    async def handler(request):
        expected = request.META["HTTP_X_INTERACTION_ID"]
        if expected == first:
            entered.set()
            await release.wait()
        assert interaction_id.get() == expected
        return SimpleNamespace(status_code=200)

    middleware = InteractionMiddleware(handler)
    one = asyncio.create_task(middleware(SimpleNamespace(META={"HTTP_X_INTERACTION_ID": first})))
    await entered.wait()
    await middleware(SimpleNamespace(META={"HTTP_X_INTERACTION_ID": second}))
    release.set()
    await one
    assert interaction_id.get() is None
    assert [event[1] for event in events] == [first, second, second, first]


def test_invalid_correlation_is_unlinked(monkeypatch):
    seen = []
    monkeypatch.setattr(
        "codepress_interactions.django.emit",
        lambda *args, **kwargs: seen.append(interaction_id.get()),
    )
    middleware = InteractionMiddleware(lambda request: SimpleNamespace(status_code=200))
    middleware(SimpleNamespace(META={"HTTP_X_INTERACTION_ID": "malicious-text"}))
    assert seen == [None, None]


def test_celery_signals_propagate_context_and_clean_each_attempt(monkeypatch):
    from celery import signals

    from codepress_interactions import celery as adapter

    events = []
    monkeypatch.setattr(
        adapter, "emit", lambda kind, **data: events.append((kind, interaction_id.get(), data))
    )
    adapter.install()
    adapter.install()
    identifier = str(uuid4())
    headers = {}
    with sdk.interaction(identifier):
        signals.before_task_publish.send(
            sender="example", headers=headers, body={"secret": "not captured"}
        )
    assert headers == {"codepress_interaction_id": identifier}
    task = SimpleNamespace(request=SimpleNamespace(headers=headers))
    for state in ["RETRY", "SUCCESS"]:
        signals.task_prerun.send(
            sender="example.task", task_id="same-job", task=task, args=["private"]
        )
        assert interaction_id.get() == identifier
        signals.task_postrun.send(
            sender="example.task",
            task_id="same-job",
            task=task,
            state=state,
            retval="private-result",
        )
        assert interaction_id.get() is None
    assert len(events) == 4  # install idempotency; one event per signal.
    assert events[0][2]["operation_id"] != events[2][2]["operation_id"]
    assert [events[1][2]["outcome"], events[3][2]["outcome"]] == ["pending", "succeeded"]
    assert "private" not in str(events)


def test_real_django_dispatch_records_template_and_no_request_content(monkeypatch):
    from django.conf import settings
    from django.http import HttpResponse
    from django.test import Client
    from django.urls import path

    events = []
    monkeypatch.setattr(
        "codepress_interactions.django.emit",
        lambda kind, **data: events.append((kind, interaction_id.get(), data)),
    )
    global urlpatterns
    urlpatterns = [
        path("orders/<int:order_id>/", lambda request, order_id: HttpResponse("private response"))
    ]
    mapping = {
        "SECRET_KEY": "test",
        "ROOT_URLCONF": __name__,
        "ALLOWED_HOSTS": ["testserver"],
        "MIDDLEWARE": [],
    }
    configure(settings=mapping, enabled=False)
    if not settings.configured:
        settings.configure(**mapping)
    identifier = str(uuid4())
    response = Client().post(
        "/orders/123/?token=private", data={"password": "private"}, HTTP_X_INTERACTION_ID=identifier
    )
    assert response.status_code == 200
    assert [kind for kind, _, _ in events] == ["request.started", "request.completed"]
    assert events[-1][2]["route_template"] == "orders/<int:order_id>/"
    assert events[0][2]["trace_id"] == events[-1][2]["trace_id"]
    assert all(context == identifier for _, context, _ in events)
    assert "private" not in str(events) and "123" not in str(events)
