import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initInteractions, type InteractionHandle } from "../src/index";
let handles: InteractionHandle[] = [];
let sent: { input: RequestInfo | URL; init?: RequestInit }[];
let transport: ReturnType<typeof vi.fn>;
const options = {
  projectKey: "public-project-key",
  endpoint: "https://telemetry.test",
  flushIntervalMs: 100000,
  allowedApiOrigins: ["http://localhost:3000", "http://localhost"],
  retryBaseMs: 1,
};
const init = () => {
  const handle = initInteractions(options);
  handles.push(handle);
  return handle;
};
const batches = () =>
  sent
    .filter((call) => String(call.input).includes("telemetry.test"))
    .map((call) => JSON.parse(String(call.init?.body)));
const events = () => batches().flatMap((batch) => batch.events);
beforeEach(() => {
  sent = [];
  transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ input, init });
    return new Response(null, {
      status: String(input).includes("telemetry.test") ? 202 : 200,
    });
  });
  window.fetch = transport as typeof fetch;
  document.body.innerHTML = "";
});
afterEach(() => {
  handles.forEach((handle) => handle.shutdown());
  handles = [];
  vi.restoreAllMocks();
});
describe("initialization capture", () => {
  it("captures dynamically mounted semantic control without exposing private content", async () => {
    const handle = init();
    document.body.innerHTML =
      '<button data-testid="transfer.confirm"><span>Secret customer text</span></button><input value="password"><div data-interactions-exclude><button>Secret</button></div>';
    document
      .querySelector("span")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document
      .querySelector("[data-interactions-exclude] button")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await handle.flush();
    expect(
      events().filter((event) => event.type === "interaction.started"),
    ).toHaveLength(1);
    expect(
      events().find((event) => event.type === "interaction.started").data
        .control_id,
    ).toBe("transfer.confirm");
    expect(JSON.stringify(batches())).not.toMatch(/Secret|password|innerHTML/);
    expect(
      events().some(
        (event) => event.data.feedback_type === "structural_change",
      ),
    ).toBe(true);
  });
  it("shares instrumentation and restores only its own patches", async () => {
    const original = window.fetch;
    const first = init();
    const second = init();
    const patched = window.fetch;
    first.shutdown();
    expect(window.fetch).toBe(patched);
    second.shutdown();
    expect(window.fetch).toBe(original);
    const third = init();
    const otherPatch = vi.fn((...args: Parameters<typeof fetch>) =>
      patched(...args),
    );
    window.fetch = otherPatch;
    third.shutdown();
    expect(window.fetch).toBe(otherPatch);
  });
  it("does not capture URLs during navigation", async () => {
    const handle = init();
    history.pushState({}, "", "/customers/private-id?token=secret");
    await handle.flush();
    expect(events()[0].data.feedback_type).toBe("navigation");
    expect(JSON.stringify(batches())).not.toMatch(/private-id|token|secret/);
  });
});
describe("causal request attribution", () => {
  it("does not assign polling or another click to a suspended async action", async () => {
    const handle = init();
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let actionId = "";
    const work = handle.runAction("transfer.confirm", async (context) => {
      actionId = context.interactionId;
      await window.fetch("/api/sync", {
        headers: { "X-Trace-Id": "existing-trace" },
      });
      await gate;
      await context.fetch("/api/bound");
      await window.fetch("/api/unbound");
    });
    await window.fetch("/api/polling");
    handle.runAction("other.action", () => window.fetch("/api/other"));
    resume();
    await work;
    const headers = (url: string) =>
      new Headers(
        sent.find((call) => String(call.input) === url)!.init?.headers,
      );
    expect(headers("/api/sync").get("X-Interaction-Id")).toBe(actionId);
    expect(headers("/api/sync").get("X-Trace-Id")).toBe("existing-trace");
    expect(headers("/api/bound").get("X-Interaction-Id")).toBe(actionId);
    expect(headers("/api/unbound").has("X-Interaction-Id")).toBe(false);
    expect(headers("/api/polling").has("X-Interaction-Id")).toBe(false);
    expect(headers("/api/other").get("X-Interaction-Id")).not.toBe(actionId);
    await window.fetch("https://third-party.test/resource");
    expect(sent.at(-1)!.init).toBeUndefined();
  });
  it("preserves host errors and unknown automatic request attribution", async () => {
    const handle = init();
    document.body.innerHTML = "<button>Click</button>";
    document.querySelector("button")!.click();
    await window.fetch("/api/poll");
    await handle.flush();
    const request = events().find((event) => event.type === "request.started");
    expect(request.interaction_id).toBeNull();
    expect(request.attribution).toBe("unknown");
    expect(
      events().find((event) => event.type === "request.completed").data.phase,
    ).toBe("http_200");
    expect(() =>
      handle.runAction("error", () => {
        throw new Error("host error");
      }),
    ).toThrow("host error");
  });
});
describe("transport", () => {
  it("retries identical batch and event IDs without recursive capture", async () => {
    let attempts = 0;
    transport.mockImplementation(async (input, init) => {
      sent.push({ input, init });
      return new Response(null, { status: ++attempts === 1 ? 503 : 202 });
    });
    const handle = init();
    handle.runAction("test", () => {});
    await handle.flush();
    await new Promise((resolve) => setTimeout(resolve, 3));
    await handle.flush();
    expect(batches()).toHaveLength(2);
    expect(batches()[0]).toEqual(batches()[1]);
    expect(
      events().every((event) => event.type === "interaction.started"),
    ).toBe(true);
    expect(handle.getDiagnostics().acceptedBatches).toBe(1);
  });
  it("bounds queues and stops capture on denied admission", async () => {
    const handle = initInteractions({ ...options, maxQueueEvents: 2 });
    handles.push(handle);
    for (let i = 0; i < 10; i++) handle.runAction("bounded", () => {});
    expect(handle.getDiagnostics().queuedEvents).toBe(2);
    expect(handle.getDiagnostics().droppedEvents).toBe(8);
    transport.mockImplementation(
      async () => new Response(null, { status: 403 }),
    );
    await handle.flush();
    expect(handle.getDiagnostics().enabled).toBe(false);
    expect(handle.getDiagnostics().queuedEvents).toBe(0);
    expect(handle.getDiagnostics().lastError).toBe("admission_denied");
  });
});

it("instruments XHR once, preserves trace header, and restores native methods", async () => {
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  const nativeHeader = XMLHttpRequest.prototype.setRequestHeader;
  const headers: Record<string, string> = {};
  XMLHttpRequest.prototype.open = vi.fn();
  XMLHttpRequest.prototype.setRequestHeader = vi.fn((name, value) => {
    headers[name] = value;
  });
  XMLHttpRequest.prototype.send = function () {
    Object.defineProperty(this, "status", { value: 201, configurable: true });
    this.dispatchEvent(new Event("loadend"));
  };
  const stubSend = XMLHttpRequest.prototype.send;
  try {
    const handle = init();
    let interactionId = "";
    handle.runAction("xhr.submit", (context) => {
      interactionId = context.interactionId;
      const request = new XMLHttpRequest();
      request.open("POST", "/api/xhr");
      request.setRequestHeader("X-Trace-Id", "existing-trace");
      request.send("secret body");
    });
    await handle.flush();
    expect(headers["X-Trace-Id"]).toBe("existing-trace");
    expect(headers["X-Interaction-Id"]).toBe(interactionId);
    expect(
      events().find((event) => event.type === "request.completed").data.phase,
    ).toBe("http_201");
    expect(JSON.stringify(batches())).not.toContain("secret body");
    handle.shutdown();
    expect(XMLHttpRequest.prototype.send).toBe(stubSend);
  } finally {
    XMLHttpRequest.prototype.open = nativeOpen;
    XMLHttpRequest.prototype.send = nativeSend;
    XMLHttpRequest.prototype.setRequestHeader = nativeHeader;
  }
});

it("records progress and busy evidence without status text or numeric values", async () => {
  const handle = init();
  document.body.innerHTML =
    '<button data-testid="transfer">Transfer</button><div data-interactions-exclude></div>';
  await Promise.resolve();
  const button = document.querySelector("button")!;
  button.setAttribute("aria-busy", "true");
  button.disabled = true;
  const progress = document.createElement("progress");
  progress.value = 0.123456;
  document.body.append(progress);
  document.querySelector("[data-interactions-exclude]")!.innerHTML =
    '<div role="status">Secret status</div>';
  await Promise.resolve();
  progress.remove();
  button.setAttribute("aria-busy", "false");
  await Promise.resolve();
  await handle.flush();
  const states = events().filter((event) => event.type === "ui.state.changed");
  expect(
    states.some(
      (event) =>
        event.data.feedback_type === "busy" && event.data.phase === "active",
    ),
  ).toBe(true);
  expect(
    states.some(
      (event) =>
        event.data.feedback_type === "busy" && event.data.phase === "inactive",
    ),
  ).toBe(true);
  expect(
    states.some(
      (event) =>
        event.data.feedback_type === "progress_indicator" &&
        event.data.phase === "appeared",
    ),
  ).toBe(true);
  expect(
    states.some(
      (event) =>
        event.data.feedback_type === "progress_indicator" &&
        event.data.phase === "removed",
    ),
  ).toBe(true);
  expect(
    states.some((event) => event.data.feedback_type === "status_region"),
  ).toBe(false);
  expect(JSON.stringify(batches())).not.toMatch(/Secret|0\.123456/);
});

it("leaves signed requests and existing correlation headers intact", async () => {
  const handle = init();
  await handle.runAction("upload", () =>
    window.fetch("/upload?X-Amz-Signature=private"),
  );
  expect(sent[0].init).toBeUndefined();
  await handle.runAction("request", () =>
    window.fetch("/api/request", {
      headers: { "X-Interaction-Id": "existing" },
    }),
  );
  expect(new Headers(sent[1].init?.headers).get("X-Interaction-Id")).toBe(
    "existing",
  );
  await handle.flush();
  expect(
    events().filter((event) => event.type === "request.started"),
  ).toHaveLength(1);
  expect(
    events().find((event) => event.type === "request.started").interaction_id,
  ).toBeNull();
  expect(JSON.stringify(batches())).not.toContain("private");
});

it("bounds progress traversal for a large added subtree", async () => {
  const traversals: ReturnType<typeof vi.fn>[] = [];
  const createWalker = document.createTreeWalker.bind(document);
  vi.spyOn(document, "createTreeWalker").mockImplementation((...args) => {
    const walker = createWalker(...args);
    const next = walker.nextNode.bind(walker);
    const counted = vi.fn(next);
    walker.nextNode = counted;
    traversals.push(counted);
    return walker;
  });
  const handle = initInteractions({ ...options, maxMutationRecords: 3 });
  handles.push(handle);
  const tree = document.createElement("section");
  tree.innerHTML = "<progress></progress>".repeat(5000);
  document.body.append(tree);
  await Promise.resolve();
  await handle.flush();
  expect(traversals.length).toBe(1);
  expect(traversals[0].mock.calls.length).toBeLessThanOrEqual(3);
  expect(
    events().filter(
      (event) => event.data.feedback_type === "progress_indicator",
    ).length,
  ).toBeLessThanOrEqual(3);
});
