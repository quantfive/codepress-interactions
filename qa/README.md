# Explicit SDK integration QA

`roundtrip.py` starts its own local Django application, opens Chrome, clicks a
control with progress/busy feedback, sends a bound browser request through the
Django SDK middleware, flushes both SDKs and reads the hosted timeline. The local
browser/server and SDK uploader are stopped in `finally` blocks. It logs no keys.

Build `pnpm build` first. Run from `python/` with Django and Playwright available:

```sh
uv run --with playwright python ../qa/roundtrip.py
```

Set environment variables `QA_TELEMETRY_ENDPOINT`, `QA_BROWSER_KEY`,
`QA_SERVER_KEY`, `QA_READ_TOKEN`, and optionally `QA_BROWSER_PORT` (8877) and
`QA_BROWSER_CHANNEL` (chrome). The project must already allow exactly the local
origin `http://127.0.0.1:<port>` and have an active admission lease. Use only a
test project. The test writes retained telemetry; its caller owns project/data
cleanup in the hosted service. Read-token provisioning is service administration,
not an SDK permission. No private CodePress imports are required.

The sample application is an SDK transport fixture, not a verification of any
customer business operation. Unit tests separately verify progress evidence and
privacy; this scenario proves the real browser→Django→ingestion→query link.

The browser fixture creates URL and Request objects in a same-origin iframe. It
asserts that native Request headers survive and a cross-realm URL to an unconfigured
origin receives no correlation header. Playwright intercepts that external host;
no actual third-party request leaves the browser. `QA_BROWSER_MODULE` may select
a separately built mutant module for regression validation. Expando properties and
stateful string conversions exercise target resolution for both fetch and XHR:
the target checked for header propagation must be the actual target sent.

## Mutation observer work bound

The browser unit suite delivers real mutation bursts: a large subtree, many
records with many subtrees, and thousands of excluded or text siblings. It counts record
lookups and inspected nodes during the SDK callback and requires the total to
remain within `maxMutationRecords`. The option is one shared callback work budget
(default 50, capped at 1,000), including ancestor privacy checks, excluded nodes,
and non-element nodes. Traversal is incremental and skips excluded descendants.
A truncated callback increments dropped diagnostics once; it does not estimate
the unknown number of unvisited nodes or potential events. Existing progress,
busy, removal, and privacy tests remain required. Run with `pnpm test`.

The click fallback test mounts 5,000 sibling buttons and verifies that an
unannotated control emits only an at-most-five-tag ancestry hint without reading
the sibling collection. Explicit safe control/test identifiers still take precedence.
The fallback is a non-unique structural hint, not a stable control identity.
