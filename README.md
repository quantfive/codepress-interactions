# CodePress Interactions

Apache-2.0 browser and Python SDKs for machine-readable interaction evidence.
The hosted service stores searchable summaries separately from compressed event
batches. This repository contains the SDKs and their versioned wire contract.

**Release candidate:** packages are not yet published to npm/PyPI, and the hosted
service is not publicly available. The snippets below show the intended installed
API. For development, build this workspace and install the local packages.

## Browser

Call once during browser application initialization:

```ts
import { initInteractions } from "@codepress/interactions-browser";

const interactions = initInteractions({
  projectKey: "PUBLIC_PROJECT_KEY",
  endpoint: "https://YOUR_TELEMETRY_HOST",
  allowedApiOrigins: ["https://YOUR_API_HOST"],
});
```

It captures semantic clicks/submits, navigation, structural UI changes, busy/progress
signals, and allowed-origin fetch/XHR observations. Dynamically mounted controls use
the same recorder. React applications can call this during browser bootstrap or use
the optional [React hook](packages/react/README.md).

Automatic observation does not guarantee causal attribution. For actions crossing
an asynchronous boundary, bind the request explicitly:

```ts
await interactions.runAction("transfer.confirm", async ({ fetch }) => {
  await fetch("/api/transfer", { method: "POST" });
});
```

The bound fetch propagates the interaction UUID only to configured API origins.
Ordinary unrelated requests stay unlinked. There is no time-window/last-click guess.
See [browser behavior and limits](packages/browser/README.md).

## Django and Celery

At the end of Django settings:

```python
from codepress_interactions.django import configure
configure(settings=globals())
```

Set `INTERACTIONS_ENABLED=true`, `INTERACTIONS_ENDPOINT` to the service base URL,
and `INTERACTIONS_SERVER_KEY` in the server environment. Never expose the server key
to a browser. Django request middleware is installed automatically; when Celery is
installed, its publish/worker hooks are installed by the same configuration call.
See [Python installation, standalone use and limits](python/README.md).

## Evidence contract

[JSON Schema](protocol/v1-batch.schema.json) and [sample batch](protocol/v1-batch.json)
define the v1 transport. An interaction identifies a user attempt; backend operations
and immutable event observations form its timeline. Backend success and visible UI
completion are distinct observations. Missing evidence means unknown, not failure.

Retries reuse identical batch bytes and IDs. Memory, batch sizes, retries and network
waits are bounded. Diagnostics distinguish queued/dropped events from server
acknowledgments. No disk/browser-storage spool is used; process/tab death can lose
pending observations. This is telemetry, not a durable business-event ledger.

Raw HTML, UI text, input values, request/response bodies and URL queries are not sent.
`data-interactions-exclude` excludes private DOM subtrees. Explicit action/control
identifiers should be static developer labels, never customer data. Evidence is data,
not executable HTML or agent instructions.

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
cd python
uv sync
uv run pytest
uv run ruff check src tests
uv build
```

Core Python transport uses the standard library; Django and Celery are optional extras.
The browser package is framework independent, with ESM, CommonJS and TypeScript outputs.

## License

[Apache-2.0](LICENSE).
