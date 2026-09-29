---
name: verify-local
description: Verify CodePress Interactions SDK behavior, package artifacts and optional browser-to-Django telemetry round trips.
---

# SDK verification

Read the root README, changed package README and `qa/README.md` before selecting
claims. Bind evidence to a clean full commit SHA and report later source changes.
For Factory delivery, get the current workflow with `codepress factory skill`,
`codepress factory skill falsify-diff`, and `codepress factory skill falsifier`;
pre-QA falsification belongs to the delivery owner. Do not copy CLI workflow code.

Use `.codepress/verify-local/recipe.json` for setup and required command checks.
This is a library repository: ordinary checks need no persistent application
server, database, or production credential. Run Python commands from `python/`.
Inspect packed npm tarballs and built Python wheel/sdist for public entry points,
license files, declared dependencies and absence of environment/credential files.

Choose the execution environment before starting services. On developer devices,
run commands directly and own/stop any servers started. In a CodePress cloud
session, use the coding workspace via `start_coding` and
`coding_workspace_operation` for self-contained checks; never run customer
servers on the control-plane runner. If coding execution is absent, use only
an already authorized backend-issued verification environment with manifest-owned
check IDs. Report unsupported execution honestly; do not silently switch planes
or invoke retired app-server tools. No application Dockerfile is required here.

Observable runtime contracts:

- Browser: dynamic controls, excluded subtrees, bounded progress/busy traversal,
  privacy, fetch/XHR request preservation, SSR, repeated init/shutdown, queue bounds,
  immutable retries and denied admission. Do not equate DOM emulation with real
  browser CORS/navigation behavior.
- Python: strict wire schema, immutable retries, explicit acknowledgment, bounded
  failure/flush/shutdown, sync/async Django context isolation, optional Celery
  propagation and fork reset. Local queue acceptance is not remote acceptance.
- Correlation: no last-click timing guess; explicit bound fetch can cross awaits.
  Unrelated requests remain unknown. Missing capture is never business failure.

For a real network/browser claim use the committed `qa/roundtrip.py` with an
explicitly provisioned test telemetry service and the bindings in `qa/README.md`.
The caller supplies service access; the SDK has no administrative provisioning
permission. Reuse healthy caller-owned services; clean up only owned browser,
Django process/thread and uploader. Record service implementation/version and
whether storage was emulated. A source-built local service can prove the protocol;
only genuinely infrastructure-dependent effects need separately supplied staging
capabilities. This repository does not deploy a hosted service. If a required
runtime binding is unavailable, declare that specific evidence gap and continue
independent supported checks. Never invent secrets or treat missing hosted access
as a reason to suppress locally provable library evidence.

Retain new reusable probes in `qa/` or package tests before the owner freezes a new
head. During exact-head QA return proposed source changes to the owner; do not
change the candidate. Keep reports/logs/traces/credentials outside the checkout.
Return concrete per-contract observations, limitations, cleanup, and unique
Markdown/JSON/JSONL artifacts. Do not publish reports, ready/merge PRs, or publish
registry packages from verification.
