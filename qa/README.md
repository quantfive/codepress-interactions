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
