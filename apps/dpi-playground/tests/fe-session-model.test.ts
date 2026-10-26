// F1-S2 session model visibility: the tree row carries a compact model chip
// (provider in the tooltip), and the Inspector SESSION tab names the current
// model with provenance — "model: <id> (<provider>)" plus "(default)" when it
// is the project's default model (device default when no project default).
// Level: integration (vite SSR, real module graph; deviceClient mocked).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";

globalThis.window = globalThis.window ?? {
  matchMedia: (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }),
};
if (!globalThis.navigator)
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node-test" }, configurable: true });
const origSetInterval = globalThis.setInterval;
globalThis.setInterval = function (fn, ms, ...a) {
  const t = origSetInterval.call(this, fn, ms, ...a);
  t.unref?.();
  return t;
};

const FE_ROOT = new URL("../apps/dpi-playground-fe/", import.meta.url);
let vite: Awaited<ReturnType<typeof createServer>>;

test.before(async () => {
  vite = await createServer({
    configFile: new URL("vite.config.ts", FE_ROOT).pathname,
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: "custom",
    logLevel: "error",
  });
});
test.after(async () => {
  await vite?.close();
});

// ------------------------------------------------------------ fixtures

function summary(over: Record<string, unknown> = {}) {
  return {
    id: "s1",
    name: "main session",
    cwd: "/w/repo",
    model: "claude-x",
    provider: "faux",
    createdAt: Date.now(),
    dbPath: "/data/s1/agent.sqlite",
    busy: false,
    agents: [{ id: 1, name: "main", named: false, kind: "root", busy: false, background: 0 }],
    ...over,
  };
}

function deviceFixture(s: ReturnType<typeof summary>, defaultModel = "faux/claude-x") {
  return {
    id: "dev1",
    name: "Dev One",
    kind: "url",
    transport: "tunnel",
    url: null,
    source: "ui",
    hasToken: true,
    status: "online",
    info: {
      uid: "u1",
      name: "Dev One",
      hostname: "dev-one",
      platform: "linux",
      apiVersion: 1,
      durableVersion: "0.0.1",
      startedAt: 0,
      startDirs: [],
      defaultModel,
      provider: "faux",
      models: [
        {
          id: "claude-x",
          provider: "faux",
          name: "Claude X",
          tier: "T0",
          icon: "lab.png",
          contextWindow: 0,
          reasoning: false,
          cost: { input: 0, output: 0 },
        },
      ],
      storage: { dataDir: "/data", catalogPath: "/c", appStatePath: "/a" },
      capabilities: [],
    },
    tree: { uid: "u1", name: "Dev One", sessions: [s], at: Date.now() },
  };
}

const project = (model?: { provider: string; modelId: string }) => ({
  id: "p1",
  rootPath: "/w/repo",
  name: "repo",
  labels: [],
  ...(model ? { model } : {}),
  kind: "code",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
});

// ------------------------------------------------------------ TreeRow model chip

async function renderRow(session: Record<string, unknown>) {
  const row = (await vite.ssrLoadModule("/src/components/TreeRow.vue")).default;
  const node = { type: "session", key: "dev1/s/s1", deviceId: "dev1", session, stale: false, children: [] };
  return renderToString(
    createSSRApp({
      render: () => h(row, { node, depth: 1, open: false, selected: false, focused: false, online: true }),
    }),
  );
}

test("TreeRow: session row shows a compact model chip with provider tooltip", async () => {
  const html = await renderRow(summary());
  assert.match(html, /class="tag"/, "model chip missing");
  assert.match(html, />claude-x<\/span>/, "chip must show the bare model id");
  assert.match(html, /title="faux \/ claude-x"/, "chip tooltip must carry provider + model");
});

test("TreeRow: no model chip when the session has no model", async () => {
  const html = await renderRow(summary({ model: "" }));
  assert.doesNotMatch(html, /class="tag"/, "empty model must not render a chip");
  const html2 = await renderRow(summary({ model: undefined, provider: undefined }));
  assert.doesNotMatch(html2, /class="tag"/, "older devices (no model field) must not render a chip");
});

// ------------------------------------------------------------ Inspector provenance line

/** Seed the store, render the Inspector SESSION tab, return the html. */
async function renderInspector(opts: { session: Record<string, unknown>; projects: unknown[] }) {
  const store = await vite.ssrLoadModule("/src/client/store.ts");
  const inspector = (await vite.ssrLoadModule("/src/components/Inspector.vue")).default;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/v1/projects"))
      return new Response(JSON.stringify({ projects: opts.projects }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    // The agent-detail fetch also lands under SSR — give it a well-shaped body.
    return new Response(JSON.stringify({ tools: [], agent: { id: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    store.network.model.apply({ type: "network", devices: [deviceFixture(opts.session as never)] });
    store.select({ deviceId: "dev1", sessionId: "s1", agentId: 1 });
    await new Promise((r) => setImmediate(r)); // let the projects fetch land
    return await renderToString(createSSRApp({ render: () => h(inspector) }));
  } finally {
    globalThis.fetch = realFetch;
    store.network.model.apply({ type: "network", devices: [] });
    store.select(undefined);
  }
}

test("Inspector SESSION: model line names id + provider, (default) when it matches the project default", async () => {
  const html = await renderInspector({
    session: summary(),
    projects: [project({ provider: "faux", modelId: "claude-x" })],
  });
  assert.match(html, /model: claude-x \(faux\) \(default\)/, "project default must be marked");
});

test("Inspector SESSION: no (default) marker when the model differs from the project default", async () => {
  const html = await renderInspector({
    session: summary({ model: "claude-y" }),
    projects: [project({ provider: "faux", modelId: "claude-x" })],
  });
  assert.match(html, /model: claude-y \(faux\)/, "provenance line must still name model + provider");
  assert.doesNotMatch(html, /\(default\)/, "a non-default model must not be marked");
});

test("Inspector SESSION: device default is the reference when no project default exists", async () => {
  const html = await renderInspector({ session: summary(), projects: [] });
  assert.match(html, /model: claude-x \(faux\) \(default\)/, "device default must be marked too");
});
