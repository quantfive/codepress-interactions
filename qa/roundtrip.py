"""Explicit real-browser/Django SDK smoke test against an already provisioned service.

Run from python/: uv run --with playwright python ../qa/roundtrip.py
Inputs are environment variables; credentials never appear in command arguments/logs.
"""
from __future__ import annotations

import json
import os
import threading
import urllib.request
from pathlib import Path
from wsgiref.simple_server import WSGIRequestHandler, make_server

import django
from django.conf import settings
from django.core.handlers.wsgi import WSGIHandler
from django.http import HttpResponse, JsonResponse
from django.urls import path
from playwright.sync_api import sync_playwright

from codepress_interactions import flush, shutdown
from codepress_interactions.context import interaction_id
from codepress_interactions.django import configure

endpoint = os.environ['QA_TELEMETRY_ENDPOINT'].rstrip('/')
browser_key = os.environ['QA_BROWSER_KEY']
server_key = os.environ['QA_SERVER_KEY']
read_token = os.environ['QA_READ_TOKEN']
port = int(os.environ.get('QA_BROWSER_PORT', '8877'))
root = Path(__file__).resolve().parents[1]

config = dict(SECRET_KEY='local-smoke-only', ROOT_URLCONF=__name__,
              ALLOWED_HOSTS=['127.0.0.1'], MIDDLEWARE=[])
configure(settings=config, endpoint=endpoint, server_key=server_key, enabled=True,
          flush_interval=0.05, retry_interval=0.05, timeout=2)
settings.configure(**config)
django.setup()


def home(request):
    sdk_options = json.dumps(dict(projectKey=browser_key, endpoint=endpoint,
                                  allowedApiOrigins=[f'http://127.0.0.1:{port}'],
                                  flushIntervalMs=100000))
    return HttpResponse('''<!doctype html><button data-testid="transfer.confirm">Transfer</button>
<script type="module">
import {initInteractions} from '/sdk.js';
window.sdk=initInteractions(''' + sdk_options + ''');
document.querySelector('button').onclick=async()=>{
  const button=document.querySelector('button');
  button.disabled=true; button.setAttribute('aria-busy','true');
  const progress=document.createElement('progress'); document.body.append(progress);
  await window.sdk.runAction('transfer.confirm',async ({fetch})=>{
    window.result=await (await fetch('/work')).json();
  });
  progress.remove(); button.disabled=false; button.setAttribute('aria-busy','false');
  window.finished=true;
};
</script>''')


def sdk_file(request):
    return HttpResponse((root / 'packages/browser/dist/index.js').read_bytes(),
                        content_type='text/javascript')


def work(request):
    return JsonResponse({'interaction_id': interaction_id.get(), 'ok': True})


urlpatterns = [path('', home), path('sdk.js', sdk_file), path('work', work)]


class QuietHandler(WSGIRequestHandler):
    def log_message(self, format, *args):
        pass


def timeline(identifier):
    req = urllib.request.Request(
        f'{endpoint}/v1/interactions/{identifier}/timeline',
        headers={'Authorization': f'Bearer {read_token}'},
    )
    with urllib.request.urlopen(req, timeout=3) as response:
        return json.load(response)


server = make_server('127.0.0.1', port, WSGIHandler(), handler_class=QuietHandler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel=os.environ.get('QA_BROWSER_CHANNEL', 'chrome'))
        try:
            page = browser.new_page()
            page.goto(f'http://127.0.0.1:{port}')
            page.wait_for_function('window.sdk !== undefined')
            page.get_by_test_id('transfer.confirm').click()
            page.wait_for_function('window.finished === true')
            identifier = page.evaluate('window.result.interaction_id')
            assert identifier, 'Django did not receive the causal interaction UUID'
            page.evaluate('window.sdk.flush()')
            assert flush(timeout=5), 'Python SDK did not drain within its deadline'
            evidence = timeline(identifier)
            events = evidence['events']
            assert evidence['evidence_status'] == 'ready', evidence['evidence_status']
            assert any(e['source'] == 'browser' and e['type'] == 'request.completed' for e in events)
            assert any(e['source'] == 'server' and e['type'] == 'request.completed' for e in events)
            assert any(e['data'].get('route_template') == 'work' for e in events)
            assert not any(e['data'].get('outcome') == 'failed' for e in events)
            assert page.evaluate('window.sdk.getDiagnostics().acceptedBatches') >= 1
            page.evaluate('window.sdk.shutdown()')
            print(json.dumps({'result': 'PASS', 'interaction_id': identifier,
                              'checks': ['browser click', 'bound request header',
                                         'Django middleware', 'both SDK uploads',
                                         'service timeline correlation']}))
        finally:
            browser.close()
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)
    shutdown(timeout=5)
