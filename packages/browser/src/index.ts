/** Capture evidence asynchronously. No raw DOM text, HTML, input values or URLs are emitted. */
export interface InteractionOptions {
  projectKey: string;
  /** Full service base URL (without /v1/batches). */
  endpoint: string;
  /** Local diagnostic label; tenant/environment authority comes from the key. */
  environment?: string;
  enabled?: boolean;
  allowedApiOrigins?: string[];
  flushIntervalMs?: number;
  retryBaseMs?: number;
  maxRetries?: number;
  maxQueueEvents?: number;
  maxBatchEvents?: number;
  maxBatchBytes?: number;
  maxMutationRecords?: number;
  requestTimeoutMs?: number;
  /** Explicitly scoped observation root; defaults to document.documentElement. */
  root?: Element;
}
export interface Diagnostics {
  enabled: boolean;
  queuedEvents: number;
  droppedEvents: number;
  acceptedBatches: number;
  failedBatches: number;
  lastError: string | null;
  adapters: string[];
  attribution: "explicit synchronous runAction only";
}
export interface ActionContext {
  interactionId: string;
  /** Carries this action through an async callback without global async context. */
  fetch: typeof fetch;
}
export interface InteractionHandle {
  flush(): Promise<void>;
  shutdown(): void;
  getDiagnostics(): Diagnostics;
  runAction<T>(name: string, callback: (context: ActionContext) => T): T;
}
type Data = Partial<{
  phase: string;
  action: string;
  control_id: string;
  feedback_type: string;
  outcome: "pending" | "completed" | "error" | "abandoned";
  duration_ms: number;
  count: number;
  sdk_version: string;
  trace_id: string;
}>;
type EventType =
  | "interaction.started"
  | "ui.state.changed"
  | "request.started"
  | "request.completed"
  | "capture.interrupted"
  | "capture.events_dropped";
interface EvidenceEvent {
  event_id: string;
  schema_version: 1;
  interaction_id: string | null;
  operation_id: null;
  source: "browser";
  source_instance_id: string;
  sequence: number;
  occurred_at: string;
  type: EventType;
  attribution: "explicit" | "unknown";
  data: Data;
}
interface Batch {
  batch_id: string;
  schema_version: 1;
  events: EvidenceEvent[];
}
const VERSION = "0.1.0";
const validInteractionId = (value: string | null): string | null =>
  value &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
const registryKey = Symbol.for("@codepress/interactions-browser/v1");
type RegistryWindow = Window & { [registryKey]?: Runtime };
const numberOption = (
  value: number | undefined,
  fallback: number,
  maximum = 1_000_000,
): number =>
  Number.isFinite(value) && value! >= 1
    ? Math.min(Math.floor(value!), maximum)
    : fallback;
const safeIdentifier = (value: string | null): string | undefined =>
  value && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/.test(value) ? value : undefined;
function noop(): InteractionHandle {
  return {
    flush: async () => {},
    shutdown() {},
    getDiagnostics: () => ({
      enabled: false,
      queuedEvents: 0,
      droppedEvents: 0,
      acceptedBatches: 0,
      failedBatches: 0,
      lastError: null,
      adapters: [],
      attribution: "explicit synchronous runAction only",
    }),
    runAction: (_name, callback) =>
      callback({
        interactionId: "",
        fetch: (...args) => globalThis.fetch(...args),
      }),
  };
}
/** Repeated identical initialization shares instrumentation through independent leases. */
export function initInteractions(
  options: InteractionOptions,
): InteractionHandle {
  if (
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    options.enabled === false
  )
    return noop();
  try {
    const endpoint = new URL(options.endpoint, window.location.href);
    if (
      !["https:", "http:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !options.projectKey
    )
      return noop();
    const host = window as RegistryWindow;
    const signature = JSON.stringify({
      ...options,
      root: undefined,
      endpoint: endpoint.href,
    });
    if (host[registryKey]) {
      if (
        host[registryKey]!.signature !== signature ||
        host[registryKey]!.root !== (options.root ?? document.documentElement)
      )
        return noop();
      return host[registryKey]!.lease();
    }
    const runtime = new Runtime(options, endpoint, signature);
    host[registryKey] = runtime;
    try {
      runtime.start();
    } catch {
      runtime.stop();
      return noop();
    }
    return runtime.lease();
  } catch {
    return noop();
  }
}
class Runtime {
  readonly root: Element;
  private queue: EvidenceEvent[] = [];
  private pending: {
    batch: Batch;
    serialized: string;
    attempts: number;
    nextAt: number;
  } | null = null;
  private active = true;
  private references = 0;
  private sequence = 0;
  private sourceId = crypto.randomUUID();
  private context: string | null = null;
  private originalFetch = window.fetch;
  private requestTarget = Object.getOwnPropertyDescriptor(
    Request.prototype, "url",
  )!.get!;
  private requestHeaders = Object.getOwnPropertyDescriptor(
    Request.prototype, "headers",
  )!.get!;
  private wrappedFetch?: typeof fetch;
  private observer?: MutationObserver;
  private timer?: ReturnType<typeof setInterval>;
  private sending: Promise<void> | null = null;
  private abort?: AbortController;
  private removals: (() => void)[] = [];
  private allowed: Set<string>;
  private ingestUrl: string;
  private dropped = 0;
  private accepted = 0;
  private failed = 0;
  private lastError: string | null = null;
  private maxQueue: number;
  private maxBatch: number;
  private maxBytes: number;
  private retries: number;
  constructor(
    private options: InteractionOptions,
    endpoint: URL,
    readonly signature: string,
  ) {
    this.root = options.root ?? document.documentElement;
    this.ingestUrl = endpoint.href.replace(/\/$/, "") + "/v1/batches";
    this.allowed = new Set(
      (options.allowedApiOrigins ?? [location.origin]).map(
        (origin) => new URL(origin).origin,
      ),
    );
    this.maxQueue = numberOption(options.maxQueueEvents, 1000, 10000);
    this.maxBatch = numberOption(options.maxBatchEvents, 100, 200);
    this.maxBytes = numberOption(options.maxBatchBytes, 60000, 60000);
    this.retries =
      options.maxRetries === 0 ? 0 : numberOption(options.maxRetries, 3, 20);
  }
  lease(): InteractionHandle {
    this.references++;
    let released = false;
    return {
      flush: () => (released ? Promise.resolve() : this.flush()),
      shutdown: () => {
        if (!released) {
          released = true;
          if (--this.references === 0) this.stop();
        }
      },
      getDiagnostics: () => this.diagnostics(),
      runAction: (name, callback) => {
        if (released || !this.active)
          return callback({
            interactionId: "",
            fetch: (...args) => window.fetch(...args),
          });
        const id = crypto.randomUUID();
        this.record("interaction.started", id, {
          action: safeIdentifier(name) ?? "custom_action",
        });
        const previous = this.context;
        this.context = id;
        try {
          return callback({
            interactionId: id,
            fetch: (input, init) => this.instrumentFetch(input, init, id),
          });
        } finally {
          this.context = previous;
        }
      },
    };
  }
  private diagnostics(): Diagnostics {
    return {
      enabled: this.active,
      queuedEvents:
        this.queue.length + (this.pending?.batch.events.length ?? 0),
      droppedEvents: this.dropped,
      acceptedBatches: this.accepted,
      failedBatches: this.failed,
      lastError: this.lastError,
      adapters: this.active ? ["dom", "navigation", "fetch", "xhr"] : [],
      attribution: "explicit synchronous runAction only",
    };
  }
  private record(type: EventType, id: string | null, data: Data): void {
    if (!this.active) return;
    try {
      if (
        this.queue.length + (this.pending?.batch.events.length ?? 0) >=
        this.maxQueue
      ) {
        this.dropped++;
        return;
      }
      this.queue.push({
        event_id: crypto.randomUUID(),
        schema_version: 1,
        interaction_id: id,
        operation_id: null,
        source: "browser",
        source_instance_id: this.sourceId,
        sequence: ++this.sequence,
        occurred_at: new Date().toISOString(),
        type,
        attribution: id ? "explicit" : "unknown",
        data: { ...data, sdk_version: VERSION },
      });
    } catch {
      this.dropped++;
    }
  }
  start(): void {
    const listen = (
      target: EventTarget,
      type: string,
      listener: EventListener,
    ) => {
      target.addEventListener(type, listener, true);
      this.removals.push(() =>
        target.removeEventListener(type, listener, true),
      );
    };
    const control = (event: Event) => {
      try {
        const target =
          event.target instanceof Element
            ? event.target.closest(
                "button,a,form,input[type=submit],[role=button]",
              )
            : null;
        if (
          !target ||
          !this.root.contains(target) ||
          target.closest("[data-interactions-exclude]")
        )
          return;
        const explicit =
          safeIdentifier(target.getAttribute("data-interaction-id")) ??
          safeIdentifier(target.getAttribute("data-testid"));
        // Structural fallback contains tag/sibling position only, never text/IDs/classes.
        const path: string[] = [];
        for (
          let node: Element | null = target;
          node && node !== this.root && path.length < 5;
          node = node.parentElement
        )
          path.unshift(
            `${node.tagName.toLowerCase()}:${node.parentElement ? Array.from(node.parentElement.children).indexOf(node) : 0}`,
          );
        this.record("interaction.started", crypto.randomUUID(), {
          action: event.type,
          control_id: explicit ?? path.join("/"),
        });
      } catch {
        /* Host event dispatch must remain unaffected. */
      }
    };
    listen(document, "click", control);
    listen(document, "submit", control);
    listen(window, "popstate", () =>
      this.record("ui.state.changed", null, { feedback_type: "navigation" }),
    );
    listen(window, "pagehide", () => {
      void this.flush(true);
    });
    const observerLimit = numberOption(
      this.options.maxMutationRecords,
      50,
      1000,
    );
    this.observer = new MutationObserver((records) => {
      let count = 0;
      for (const record of records.slice(0, observerLimit)) {
        const target =
          record.target instanceof Element
            ? record.target
            : record.target.parentElement;
        if (target && !target.closest("[data-interactions-exclude]")) {
          count++;
          if (record.type === "attributes") {
            const name = record.attributeName;
            if (name === "aria-busy" || name === "disabled") {
              this.record("ui.state.changed", null, {
                feedback_type: name === "aria-busy" ? "busy" : "disabled",
                phase: (
                  name === "aria-busy"
                    ? target.getAttribute(name) === "true"
                    : target.hasAttribute(name)
                )
                  ? "active"
                  : "inactive",
                control_id:
                  safeIdentifier(target.getAttribute("data-interaction-id")) ??
                  safeIdentifier(target.getAttribute("data-testid")),
              });
            }
          }
          for (const [nodes, phase] of [
            [record.addedNodes, "appeared"],
            [record.removedNodes, "removed"],
          ] as const) {
            let inspected = 0;
            for (const node of nodes) {
              if (++inspected > observerLimit) break;
              if (
                !(node instanceof Element) ||
                node.closest("[data-interactions-exclude]")
              )
                continue;
              const selector =
                'progress,[role="progressbar"],[role="status"],[aria-busy="true"]';
              const indicators: Element[] = [];
              const walker = document.createTreeWalker(
                node,
                NodeFilter.SHOW_ELEMENT,
                {
                  acceptNode: (candidate) =>
                    (candidate as Element).hasAttribute(
                      "data-interactions-exclude",
                    )
                      ? NodeFilter.FILTER_REJECT
                      : NodeFilter.FILTER_ACCEPT,
                },
              );
              let candidate: Element | null = node;
              for (
                let visited = 0;
                candidate && visited < observerLimit;
                visited++
              ) {
                if (candidate.matches(selector)) indicators.push(candidate);
                candidate = walker.nextNode() as Element | null;
              }
              for (const indicator of indicators) {
                if (indicator.closest("[data-interactions-exclude]")) continue;
                this.record("ui.state.changed", null, {
                  feedback_type: indicator.matches(
                    'progress,[role="progressbar"]',
                  )
                    ? "progress_indicator"
                    : indicator.matches('[aria-busy="true"]')
                      ? "busy"
                      : "status_region",
                  phase,
                  control_id:
                    safeIdentifier(
                      indicator.getAttribute("data-interaction-id"),
                    ) ?? safeIdentifier(indicator.getAttribute("data-testid")),
                });
              }
            }
          }
        }
      }
      if (count)
        this.record("ui.state.changed", null, {
          feedback_type: "structural_change",
          count,
        });
      this.dropped += Math.max(0, records.length - observerLimit);
    });
    this.observer.observe(this.root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "disabled",
        "aria-busy",
        "aria-expanded",
        "hidden",
        "role",
      ],
    });
    this.wrappedFetch = (input, init) =>
      this.instrumentFetch(input, init, this.context);
    window.fetch = this.wrappedFetch;
    this.removals.push(() => {
      if (window.fetch === this.wrappedFetch) window.fetch = this.originalFetch;
    });
    for (const name of ["pushState", "replaceState"] as const) {
      const original = history[name];
      const runtime = this;
      const wrapped: History[typeof name] = function (this: History, ...args) {
        const result = original.apply(this, args);
        runtime.record("ui.state.changed", null, {
          feedback_type: "navigation",
        });
        return result;
      };
      history[name] = wrapped;
      this.removals.push(() => {
        if (history[name] === wrapped) history[name] = original;
      });
    }
    this.patchXHR();
    this.timer = setInterval(
      () => {
        void this.flush();
      },
      numberOption(this.options.flushIntervalMs, 5000, 3600000),
    );
  }
  private requestUrl(input: string): URL | null {
    try {
      const url = new URL(input, document.baseURI);
      const signed = Array.from(url.searchParams.keys()).some((key) =>
        /^(x-amz-|x-goog-|signature$|token$|sig$)/i.test(key),
      );
      return !signed &&
        this.allowed.has(url.origin) &&
        url.href !== this.ingestUrl
        ? url
        : null;
    } catch {
      return null;
    }
  }
  private instrumentFetch(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    id: string | null,
  ): Promise<Response> {
    if (!this.active) return this.originalFetch.call(window, input, init);
    // Brand-check via native Request slots, which work across realms and ignore
    // expando properties. Resolve other inputs once and send the same URL we
    // checked: inspecting one representation and sending another leaks headers.
    let target: string;
    let inheritedHeaders: Headers | undefined;
    try {
      target = this.requestTarget.call(input) as string;
      inheritedHeaders = this.requestHeaders.call(input) as Headers;
    } catch {
      try {
        target = new URL(String(input), document.baseURI).href;
        input = target;
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (!this.requestUrl(target))
      return this.originalFetch.call(window, input, init);
    let modified = init;
    try {
      const headers = new Headers(init?.headers ?? inheritedHeaders);
      if (headers.has("X-Interaction-Id"))
        id = validInteractionId(headers.get("X-Interaction-Id"));
      else if (id) headers.set("X-Interaction-Id", id);
      modified = { ...init, headers };
    } catch {
      return this.originalFetch.call(window, input, init);
    }
    const started = performance.now();
    this.record("request.started", id, {});
    let request: Promise<Response>;
    try {
      request = this.originalFetch.call(window, input, modified);
    } catch (error) {
      this.record("request.completed", id, { outcome: "error" });
      throw error;
    }
    return request.then(
      (response) => {
        this.record("request.completed", id, {
          outcome: response.ok ? "completed" : "error",
          phase: `http_${response.status}`,
          duration_ms: Math.min(
            86400000,
            Math.max(0, performance.now() - started),
          ),
        });
        return response;
      },
      (error) => {
        this.record("request.completed", id, {
          outcome: "error",
          duration_ms: Math.min(
            86400000,
            Math.max(0, performance.now() - started),
          ),
        });
        throw error;
      },
    );
  }
  private patchXHR(): void {
    const prototype = XMLHttpRequest.prototype;
    const originalOpen = prototype.open;
    const originalSend = prototype.send;
    const originalHeader = prototype.setRequestHeader;
    const requests = new WeakMap<
      XMLHttpRequest,
      { url: string; interactionHeader: string | null }
    >();
    const runtime = this;
    const open = function (
      this: XMLHttpRequest,
      ...args: Parameters<XMLHttpRequest["open"]>
    ) {
      let target = String(args[1]);
      try {
        target = new URL(target, document.baseURI).href;
      } catch {
        // Let native open report invalid URLs with its own exception behavior.
      }
      args[1] = target;
      const result = originalOpen.apply(this, args);
      requests.set(this, { url: target, interactionHeader: null });
      return result;
    } as XMLHttpRequest["open"];
    const header = function (
      this: XMLHttpRequest,
      name: string,
      value: string,
    ) {
      const result = originalHeader.call(this, name, value);
      if (name.toLowerCase() === "x-interaction-id") {
        const entry = requests.get(this);
        if (entry)
          entry.interactionHeader =
            entry.interactionHeader === null
              ? value
              : `${entry.interactionHeader}, ${value}`;
      }
      return result;
    };
    const send = function (
      this: XMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null,
    ) {
      const entry = requests.get(this);
      const id =
        entry?.interactionHeader !== null &&
        entry?.interactionHeader !== undefined
          ? validInteractionId(entry.interactionHeader)
          : runtime.context;
      if (runtime.active && entry && runtime.requestUrl(entry.url)) {
        const started = performance.now();
        try {
          if (id && entry.interactionHeader === null)
            originalHeader.call(this, "X-Interaction-Id", id);
        } catch {
          /* Keep host request usable. */
        }
        runtime.record("request.started", id, {});
        this.addEventListener(
          "loadend",
          () =>
            runtime.record("request.completed", id, {
              outcome:
                this.status >= 200 && this.status < 400 ? "completed" : "error",
              phase: `http_${this.status}`,
              duration_ms: Math.min(
                86400000,
                Math.max(0, performance.now() - started),
              ),
            }),
          { once: true },
        );
      }
      return originalSend.call(this, body);
    };
    prototype.open = open;
    prototype.send = send;
    prototype.setRequestHeader = header;
    this.removals.push(() => {
      if (prototype.open === open) prototype.open = originalOpen;
      if (prototype.send === send) prototype.send = originalSend;
      if (prototype.setRequestHeader === header)
        prototype.setRequestHeader = originalHeader;
    });
  }
  flush(keepalive = false): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (this.sending) return this.sending;
    this.sending = this.send(keepalive)
      .catch(() => {
        this.lastError = "transport_error";
      })
      .finally(() => {
        this.sending = null;
      });
    return this.sending;
  }
  private async send(keepalive: boolean): Promise<void> {
    if (!this.pending && this.queue.length) {
      const batch: Batch = {
        batch_id: crypto.randomUUID(),
        schema_version: 1,
        events: [],
      };
      while (this.queue.length && batch.events.length < this.maxBatch) {
        batch.events.push(this.queue[0]);
        if (
          new TextEncoder().encode(JSON.stringify(batch)).byteLength >
          this.maxBytes
        ) {
          batch.events.pop();
          if (!batch.events.length) {
            this.queue.shift();
            this.dropped++;
            continue;
          }
          break;
        }
        this.queue.shift();
      }
      if (batch.events.length)
        this.pending = {
          batch,
          serialized: JSON.stringify(batch),
          attempts: 0,
          nextAt: 0,
        };
    }
    const pending = this.pending;
    if (!pending || Date.now() < pending.nextAt) return;
    this.abort = new AbortController();
    const timer = setTimeout(
      () => this.abort?.abort(),
      numberOption(this.options.requestTimeoutMs, 10000, 120000),
    );
    try {
      const response = await this.originalFetch.call(window, this.ingestUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.projectKey}`,
        },
        body: pending.serialized,
        keepalive,
        signal: this.abort.signal,
        credentials: "omit",
      });
      if (response.status === 202) {
        this.accepted++;
        this.pending = null;
        this.lastError = null;
        return;
      }
      if (response.status === 401 || response.status === 403) {
        this.lastError = "admission_denied";
        this.stop();
        return;
      }
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 429
      ) {
        this.failed++;
        this.dropped += pending.batch.events.length;
        this.pending = null;
        this.lastError = "batch_rejected";
        return;
      }
      throw new Error("retryable");
    } catch {
      if (!this.active) return;
      this.lastError = "transport_error";
      if (pending.attempts++ >= this.retries) {
        this.failed++;
        this.dropped += pending.batch.events.length;
        this.pending = null;
      } else
        pending.nextAt =
          Date.now() +
          numberOption(this.options.retryBaseMs, 1000, 3600000) *
            2 ** (pending.attempts - 1);
    } finally {
      clearTimeout(timer);
      this.abort = undefined;
    }
  }
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.dropped +=
      this.queue.length + (this.pending?.batch.events.length ?? 0);
    this.queue = [];
    this.pending = null;
    this.abort?.abort();
    clearInterval(this.timer);
    this.observer?.disconnect();
    for (const remove of this.removals.reverse()) {
      try {
        remove();
      } catch {
        /* Other instrumentation may freeze prototypes. */
      }
    }
    const host = window as RegistryWindow;
    if (host[registryKey] === this) delete host[registryKey];
  }
}
