// SchedulesPanel empty-state flash (Auto tab): the first paint must not claim
// "No schedules yet." while the device's list is still in flight — a tunnel
// first-hit can take seconds, so the panel said "empty" at ~11ms and replaced
// it with real data at ~4s. Same bug class as the 0.0.47 modelsLoading fix.
// The fix mirrors UsagePanel: one .hint paragraph that reads "Reading
// schedules…" while loading and the empty copy only once the list has landed.
// Level: integration (vite SSR, real module graph; deviceClient stubbed at the
// fetch layer — its DpiClient rides fetch, so the stub IS the device).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";

// SSR shims — store.ts touches window.matchMedia / navigator.userAgent at module scope.
globalThis.window = globalThis.window ?? {
  matchMedia: (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }),
};
if (!globalThis.navigator) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "node-test" },
    configurable: true,
  });
}
// jobs.ts starts a 1s setInterval at module scope; unref intervals so the runner exits.
const origSetInterval = globalThis.setInterval;
globalThis.setInterval = function (fn: (...a: unknown[]) => void, ms: number, ...a: unknown[]) {
  const t = origSetInterval.call(this, fn, ms, ...a);
  (t as { unref?: () => void }).unref?.();
  return t;
};

const FE_ROOT = new URL("../apps/dpi-playground-fe/", import.meta.url);

let vite: Awaited<ReturnType<typeof createServer>>;
let store: typeof import("../apps/dpi-playground-fe/src/client/store.ts");
let panel: (typeof import("../apps/dpi-playground-fe/src/components/SchedulesPanel.vue"))["default"];

test.before(async () => {
  vite = await createServer({
    configFile: new URL("vite.config.ts", FE_ROOT).pathname,
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: "custom",
    logLevel: "error",
  });
  store = await vite.ssrLoadModule("/src/client/store.ts");
  panel = (await vite.ssrLoadModule("/src/components/SchedulesPanel.vue")).default;
});

test.after(async () => {
  await vite?.close();
});

const SCHEDULE = {
  id: "sch-1",
  name: "Nightly smoke",
  cwd: "/home/me/project",
  model: { provider: "anthropic", modelId: "claude-3" },
  prompt: "Run the tests and summarise failures",
  everyMinutes: 60,
  enabled: true,
  nextRunAt: Date.now() + 3_600_000,
  running: false,
};

/** Mount the SchedulesPanel for a selected device with the device's schedules
 * call stubbed at the fetch layer. `mode` picks what the device answers:
 *   "pending"   — the call never resolves (the tunnel first-hit window),
 *   "empty"     — resolves [] after a beat,
 *   "one"       — resolves a single schedule after a beat,
 *   "error"     — the device answers 500 after a beat.
 * SSR renders each component synchronously right after its setup, so the
 * panel's own in-flight load() would never be visible post-resolve. A short
 * app-wide serverPrefetch (it runs after setup, before render) lets that load
 * settle first — which is exactly the distinction under test: "pending" stays
 * in the loading window, the others render the settled state. */
async function renderPanel(mode: "pending" | "empty" | "one" | "error") {
  const realFetch = globalThis.fetch;
  let hits = 0;
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/v1/schedules")) {
      hits += 1;
      if (mode === "pending") return new Promise<Response>(() => {}); // tunnel never answers
      const body = mode === "one" ? { schedules: [SCHEDULE] } : { schedules: [] };
      const status = mode === "error" ? 500 : 200;
      const payload = mode === "error" ? { error: { code: "internal", message: "device exploded" } } : body;
      return new Promise<Response>((r) => setTimeout(() => r(reply(status, payload)), 10));
    }
    return realFetch(input, init);
  }) as typeof fetch;

  const prev = store.selected.value;
  store.selected.value = { deviceId: "dev1", sessionId: "s1", agentId: 1 };
  const app = createSSRApp({ render: () => h(panel) });
  app.mixin({ serverPrefetch: () => new Promise((r) => setTimeout(r, 25)) });
  try {
    const html = await renderToString(app);
    return { html, hits };
  } finally {
    globalThis.fetch = realFetch;
    store.selected.value = prev;
  }
}

test("in-flight first paint says Reading schedules, never No schedules yet", async () => {
  const { html, hits } = await renderPanel("pending");
  assert.equal(hits, 1, "the panel must have asked the device for its schedules");
  assert.match(html, /Reading schedules/, "the in-flight window must say so instead of guessing empty");
  assert.doesNotMatch(html, /No schedules yet/, "the empty state must wait for the fetch to resolve");
});

test("resolve with [] → the empty state appears (and only then)", async () => {
  const { html, hits } = await renderPanel("empty");
  assert.equal(hits, 1, "the list was fetched");
  assert.match(html, /No schedules yet/, "an actually empty device earns the empty state");
  assert.doesNotMatch(html, /Reading schedules/, "loading copy must be gone once the fetch landed");
});

test("resolve with one schedule → the row appears, no hint at all", async () => {
  const { html, hits } = await renderPanel("one");
  assert.equal(hits, 1, "the list was fetched");
  assert.match(html, /Nightly smoke/, "the schedule row must render");
  assert.match(html, /every 60m/, "the trigger chip must render");
  assert.doesNotMatch(html, /No schedules yet/, "a device with schedules is not empty");
  assert.doesNotMatch(html, /Reading schedules/, "loading copy must be gone once the fetch landed");
});

test("a failing fetch keeps the error wall — loading does not mask or delay it", async () => {
  const { html } = await renderPanel("error");
  assert.match(html, /message-error/, "the panel's error surface must render");
  assert.match(html, /device exploded/, "the device's failure text reaches the human");
  assert.doesNotMatch(html, /Reading schedules/, "loading must not mask the error");
  assert.doesNotMatch(html, /No schedules yet/, "an error is not an empty device");
});
