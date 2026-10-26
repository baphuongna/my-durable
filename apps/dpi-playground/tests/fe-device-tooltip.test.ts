// Round 4 FE fix #1: the device row tooltip must never render a literal
// `· null` for tunnel devices — NetworkDevice.url is documented nullable
// (dpi-sdk/src/api.ts: "consumers must not build links or URLs from it").
// Caught live in production: tunnel rows read `<name> · null`.
// Level: integration (vite SSR, real module graph, no hub/browser).
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

function deviceFixture(over: Record<string, unknown> = {}) {
  return {
    id: "dev1",
    name: "Dev One",
    kind: "url",
    transport: "tunnel",
    url: null, // the documented tunnel shape
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
      models: [],
      storage: { dataDir: "/data", catalogPath: "/c", appStatePath: "/a" },
      capabilities: [],
    },
    tree: { uid: "u1", name: "Dev One", sessions: [], at: Date.now() },
    ...over,
  };
}

async function renderRow(device: Record<string, unknown>) {
  const row = (await vite.ssrLoadModule("/src/components/TreeRow.vue")).default;
  const node = {
    type: "device",
    key: "dev1",
    device,
    status: device.status,
    stale: false,
    children: [],
  };
  return renderToString(
    createSSRApp({
      render: () =>
        h(row, { node, depth: 0, open: true, selected: false, focused: false, online: true }),
    }),
  );
}

test("TreeRow: tunnel device (url null) tooltip shows the name alone, never `null`", async () => {
  const html = await renderRow(deviceFixture());
  assert.doesNotMatch(html, /title="[^"]*\bnull\b/, "tooltip must not contain the string null");
  assert.match(html, /title="Dev One"/, "tooltip is the device name when there is no url");
});

test("TreeRow: lan device (url set) tooltip still carries the url", async () => {
  const html = await renderRow(
    deviceFixture({ transport: "lan", url: "http://192.168.1.10:8787" }),
  );
  assert.match(
    html,
    /title="Dev One · http:\/\/192\.168\.1\.10:8787"/,
    "name · url survives when the url exists",
  );
});

test("TreeRow: error text still appends to the tooltip on either shape", async () => {
  const withUrl = await renderRow(
    deviceFixture({ transport: "lan", url: "http://d:1", error: "refused" }),
  );
  assert.match(withUrl, /title="Dev One · http:\/\/d:1\nrefused"/);
  const noUrl = await renderRow(deviceFixture({ error: "refused" }));
  assert.doesNotMatch(noUrl, /\bnull\b/, "no null even with an error and no url");
  assert.match(noUrl, /title="Dev One\nrefused"/);
});
