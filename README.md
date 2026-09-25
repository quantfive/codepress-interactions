# CodePress Interactions SDKs

Reusable browser and Python instrumentation for the hosted CodePress Interactions service.

This repository is being built for an initialization-only installation: automatic
browser interactions and backend requests, optional semantic operation annotations,
and correlated machine-readable evidence. The service remains separately hosted.

Initial targets: browser TypeScript, React/Next.js, Django and Celery. Packages are
not yet published. Install examples and compatibility guarantees will be added with
the tested SDK implementations; this scaffold is not a production-ready release.

## Privacy and failure behavior

SDKs must sanitize before transmission, exclude user inputs and credentials by
default, bound memory/network work, and keep telemetry outages from failing the
application. Unknown attribution remains unknown. Browser evidence never
establishes a trusted backend outcome.

## License

Apache-2.0. See [LICENSE](LICENSE).
