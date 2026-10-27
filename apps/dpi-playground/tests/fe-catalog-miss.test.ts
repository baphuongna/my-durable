// R6 fe fix #2 (P3): a model that is set but missing from the device catalog
// must not render as "no model". ContextBar shows the raw provider/modelId
// with a "not in this device's catalog" note instead of the pick-a-model
// prompt; ModelPicker pins a disabled "current · not in this device's
// catalog" row so the active model is always visible.
// Level: integration (vite SSR, real module graph).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";

globalThis.window = globalThis.window ?? {
  matchMedia: (q) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }),
};
if (!globalThis.navigator)
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "node-test" },
    configurable: true,
  });
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
    model: "ghost-9",
    provider: "other",
    createdAt: Date.now(),
    dbPath: "/data/s1/agent.sqlite",
    busy: false,
    agents: [{ id: 1, name: "main", named: false, kind: "root", busy: false, background: 0 }],
    ...over,
  };
}

function deviceFixture(s: ReturnType<typeof summary>) {
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
      startedAt: 0,
      startDirs: [],
      defaultModel: "faux/claude-x",
      provider: "faux",
      models: [
        {
          id: "claude-x",
          provider: "faux",
          name: "Claude X",
          tier: "T0",
          icon: "lab.png",
          contextWindow: 200_000,
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

async function renderComponent(path: string, props: Record<string, unknown> = {}) {
  const store = await vite.ssrLoadModule("/src/client/store.ts");
  const component = (await vite.ssrLoadModule(path)).default;
  try {
    return await renderToString(createSSRApp({ render: () => h(component, props) }));
  } finally {
    store.network.model.apply({ type: "network", devices: [] });
    store.selected.value = undefined;
  }
}

/** Seed the store with a device whose catalog misses the session's model. */
async function selectSession(session: ReturnType<typeof summary>) {
  const store = await vite.ssrLoadModule("/src/client/store.ts");
  store.network.model.apply({ type: "network", devices: [deviceFixture(session)] });
  store.selected.value = { deviceId: "dev1", sessionId: "s1", agentId: 1 };
}

// ------------------------------------------------------------ ContextBar

test("ContextBar: an off-catalog model shows raw ids + catalog note, not the pick-a-model prompt", async () => {
  await selectSession(summary()); // model ghost-9/other, catalog has claude-x/faux only
  const html = await renderComponent("/src/components/ContextBar.vue");
  assert.match(html, /ghost-9/, "the raw model id is shown");
  assert.match(html, /other \/ ghost-9/, "provider and model are named");
  assert.match(
    html,
    /not in this device(?:&#39;|')s catalog/,
    "the catalog miss is distinguished from no model",
  );
  assert.doesNotMatch(html, /Pick a model/, "a set model must not render the pick-a-model prompt");
});

test("ContextBar: no model at all still asks for one", async () => {
  await selectSession(summary({ model: "", provider: undefined }));
  const html = await renderComponent("/src/components/ContextBar.vue");
  assert.match(html, /Pick a model to see its context window\./);
  assert.doesNotMatch(html, /catalog/);
});

test("ContextBar: an in-catalog model renders the context bar", async () => {
  await selectSession(summary({ model: "claude-x", provider: "faux" }));
  const html = await renderComponent("/src/components/ContextBar.vue");
  assert.match(html, /of 200\.0k tokens/, "the window comes from the catalog entry");
  assert.doesNotMatch(html, /Pick a model/);
});

// ------------------------------------------------------------ ModelPicker

test("ModelPicker: pins a disabled current row for an off-catalog model", async () => {
  await selectSession(summary()); // ghost-9 is set but not in the catalog
  const html = await renderComponent("/src/components/ModelPicker.vue");
  assert.match(html, /ghost-9/, "the pinned row names the current model");
  assert.match(
    html,
    /current · not in this device(?:&#39;|')s catalog/,
    "the row says why it is pinned and disabled",
  );
  assert.match(html, /aria-disabled="true"/, "the pinned row is marked disabled");
  assert.match(
    html,
    /<div[^>]*aria-disabled="true"/,
    "the pinned row is a non-interactive div, not a button",
  );
  assert.doesNotMatch(html, /<button[^>]*aria-disabled="true"/, "no clickable disabled row");
});

test("ModelPicker: no pinned row when the current model is in the catalog", async () => {
  await selectSession(summary({ model: "claude-x", provider: "faux" }));
  const html = await renderComponent("/src/components/ModelPicker.vue");
  assert.doesNotMatch(html, /not in this device's catalog/);
  assert.match(html, /Claude X/, "the catalog row still lists");
});
