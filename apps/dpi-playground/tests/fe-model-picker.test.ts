// Round 4 FE fixes #2/#3 on the model picker: the eyebrow names the device
// (id only as fallback), and the dialog carries the house a11y pattern —
// role="dialog" + aria-modal + accessible name (cf. ContextBar compaction
// modal, DeviceCredentialsDialog) — with the cursor landing in the search
// input on open (LoginCard/PromptDialog pattern).
// Level: integration (vite SSR for the markup) + source assertions for the
// client-only focus behavior (onMounted does not run under SSR).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

function deviceFixture() {
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
    tree: { uid: "u1", name: "Dev One", sessions: [], at: Date.now() },
  };
}

async function renderPicker() {
  const store = await vite.ssrLoadModule("/src/client/store.ts");
  store.network.model.apply({ type: "network", devices: [deviceFixture()] });
  store.selected.value = { deviceId: "dev1", sessionId: "s1", agentId: 1 };
  const picker = (await vite.ssrLoadModule("/src/components/ModelPicker.vue")).default;
  return renderToString(createSSRApp({ render: () => h(picker, {}) }));
}

test("model picker: dialog semantics match the house pattern", async () => {
  const html = await renderPicker();
  assert.match(
    html,
    /<section class="modal model-modal" role="dialog" aria-modal="true" aria-label="Model picker">/,
    "role=dialog + aria-modal + accessible name",
  );
});

test("model picker: eyebrow names the device, id only as fallback", async () => {
  const html = await renderPicker();
  assert.match(html, /PER AGENT ·(?:<!--.*?-->)?\s*Dev One/, "eyebrow shows the device name");
  assert.doesNotMatch(html, /PER AGENT · dev1/, "eyebrow must not show the raw id");
});

test("model picker: focus moves into the search input on open (house pattern)", async () => {
  const src = readFileSync(
    new URL("../apps/dpi-playground-fe/src/components/ModelPicker.vue", import.meta.url),
    "utf8",
  );
  assert.match(
    src.replace(/\s+/g, " "),
    /onMounted\(\(\) => void nextTick\(\(\) => searchInput\.value\?\.focus\(\)\)\)/,
    "autofocus matches the LoginCard/PromptDialog house pattern",
  );
  assert.match(src, /ref="searchInput"/, "the search input is the focus target");
  // Escape-to-close lives in App.vue's keydown and is untouched; the backdrop
  // click and the close button remain the other exits.
  assert.match(src, /@click\.self="emit\('close'\)"/);
  assert.match(src, /aria-label="Close model picker"/);
});
