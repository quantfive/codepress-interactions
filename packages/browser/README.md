# Browser interaction SDK

Initialize once at the application client entry point. Importing the package during SSR is safe; disabled/SSR initialization returns an inert handle. These packages are release candidates, not published registry packages.

```ts
import { initInteractions } from "@codepress/interactions-browser";

const interactions = initInteractions({
  projectKey: "public-project-key",
  endpoint: "https://interactions.example.com",
  allowedApiOrigins: [window.location.origin],
});
```

The endpoint is the service base URL; the SDK appends `/v1/batches`. The public key resolves project/environment on the service. `environment` is a local diagnostic configuration label and never grants authority. Service origin admission and lease configuration must already permit this installation. API origins default to this page's origin. Add a separate API origin explicitly only if it is controlled by your application and permits `X-Interaction-Id` in its CORS configuration.

Initial setup captures clicks on semantic controls (including dynamically mounted controls), form submissions, navigation signals, bounded structural DOM changes, and allowed-origin fetch/XHR observations. It does not require per-control annotations. Control identifiers use safe `data-interaction-id`/`data-testid` values when present, otherwise a bounded tag/sibling-position path. These identifiers are structural hints and can change when layouts change. Mark private subtrees `data-interactions-exclude`. Do not put user data or secrets in explicit tracking identifiers.

No DOM text, HTML, input values, request/response bodies, URL paths, queries, cookies or user IDs are recorded. Mutation evidence reports changed-record counts, not a replay or an assertion that a spinner represents business completion. HTTP statuses are bounded `data.phase` labels such as `http_201`; browser request outcomes are `completed`/`error`, never server business outcomes. No durable browser storage is used.

## Correlation

Automatic clicks are separate interaction attempts. Automatic requests and mutation/navigation observations have unknown attribution: the SDK does not attach them to whichever click happened most recently. For known causal work use an optional explicit action:

```ts
await interactions.runAction("transfer.confirm", async (context) => {
  await context.fetch("/api/transfer", { method: "POST" });
  await someOtherWork();
  await context.fetch("/api/verify");
});
```

`runAction` sets context only during the callback's synchronous invocation. Ordinary fetch/XHR calls during that synchronous portion inherit the action. After `await`, a timer or another callback, use the supplied `context.fetch` to preserve the known link. Ordinary unbound fetch after an await and independent polling remain unlinked. This avoids global async context leaking between overlapping actions. Business callback return values, thrown errors, and rejected promises remain unchanged. Existing `X-Trace-Id` is preserved; raw headers are never recorded. Ingestion and unconfigured third-party origins are never instrumented or sent correlation headers.

## Lifecycle and bounds

`flush()` attempts one immutable batch, returning without throwing transport errors. Retryable failures preserve the exact batch/event IDs and payload. Defaults: 1,000 queued events, 100 events/batch, 60,000 bytes/batch, flush every 5s, request timeout 10s, 3 retries with 1s exponential base, 50 mutation records per callback. Override using `maxQueueEvents`, `maxBatchEvents`, `maxBatchBytes`, `flushIntervalMs`, `requestTimeoutMs`, `maxRetries`, `retryBaseMs`, `maxMutationRecords`. These are bounded locally. Overflow and exhausted retries increment dropped diagnostics; they never hold up business requests. Retry timers are driven by the flush interval. `getDiagnostics()` exposes local accepted/failed/dropped counts and errors; it does not claim end-to-end installation health.

Page exit attempts one small keepalive batch. Delivery is best effort and can fail, particularly when an upload is already active or the browser terminates. No secret is placed in a URL. HTTP 401/403 stops capture and clears pending evidence; reconnecting requires explicit reinitialization after fixing admission.

Repeated identical initialization shares one recorder through reference-counted leases. Each owner calls `shutdown()` on its handle; the last owner stops timers/observers, aborts SDK uploads, clears queues, and restores only patches still owned by the SDK. Later third-party patches are preserved. Different concurrent project configurations return an inert handle: shut down the old project before switching account/org so pending events are never relabeled. React Strict Mode may start a fresh recorder after a complete cleanup, which is safe.

Not covered: shadow-root traversal, cross-origin frames, general Promise/timer propagation, persistent offline replay, input recording, screenshots, sampled completeness inference, or global cross-batch re-batching. Browser telemetry is untrusted evidence. Service v1 requires immutable batch retries; event IDs are never reassigned to another batch.

Structural feedback includes progress/status indicators appearing or disappearing,
`aria-busy` transitions, and disabled controls. Values and status text are omitted;
CSS-only spinners without semantic markup may remain an unknown structural change.
Signed URLs are excluded from request instrumentation. Existing interaction headers
are preserved; a valid UUID is used for correlation, otherwise attribution is unknown.
