// Round 4 FE fix #2: the offline wall headlines name the device by its
// friendly NAME (the sidebar shows `d.name`; the raw UUID only belongs inside
// the `just net …` command strings, where the CLI needs it). Caught live in
// production: `7dbaa669… is offline` while the sidebar showed a real name.
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
    kind: "ssh",
    transport: "lan",
    url: "http://192.168.1.10:8787",
    source: "config",
    hasToken: true,
    status: "offline",
    lastSeenAt: Date.now() - 60_000,
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

async function renderPanel(device: Record<string, unknown>) {
  const panel = (await vite.ssrLoadModule("/src/components/OfflinePanel.vue")).default;
  return renderToString(createSSRApp({ render: () => h(panel, { device }) }));
}

/** The headline <h2> carries the fix.title; the command sits in a <code>. */
const h2 = (html: string) => html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? "";
const code = (html: string) => html.match(/<code[^>]*>([\s\S]*?)<\/code>/)?.[1] ?? "";

test("offline wall: `is offline` headline names the device, command keeps the id", async () => {
  const html = await renderPanel(deviceFixture());
  assert.equal(h2(html), "Dev One is offline", "headline uses d.name");
  assert.doesNotMatch(h2(html), /dev1/, "headline never shows the raw id");
  assert.match(code(html), /just net restart dev1/, "the CLI command keeps the id");
});

test("offline wall: tunnel credentials headline names the device", async () => {
  const html = await renderPanel(
    deviceFixture({ status: "unauthorized", transport: "tunnel", url: null, hasToken: true }),
  );
  assert.equal(h2(html), "Dev One tunnel credentials are not valid");
  assert.doesNotMatch(h2(html), /dev1/);
  // Tunnel devices are pointed at pairing, not at a register command — no code block.
  assert.doesNotMatch(html, /offline-command/, "tunnel unauthorized offers pairing, no command");
});

test("offline wall: no-token headline names the device", async () => {
  const html = await renderPanel(deviceFixture({ status: "unauthorized", hasToken: false }));
  assert.equal(h2(html), "No token for Dev One");
  assert.doesNotMatch(h2(html), /dev1/);
  assert.match(code(html), /just net register dev1/, "register command keeps the id");
});

test("offline wall: mismatch and version headlines name the device", async () => {
  const mismatch = await renderPanel(deviceFixture({ status: "mismatch" }));
  assert.equal(h2(mismatch), "Dev One answers as a different device");
  assert.doesNotMatch(h2(mismatch), /dev1/);
  assert.match(code(mismatch), /just net register dev1/, "re-register command keeps the id");

  const incompatible = await renderPanel(deviceFixture({ status: "incompatible" }));
  assert.equal(h2(incompatible), "Dev One speaks another API version");
  assert.doesNotMatch(h2(incompatible), /dev1/);
  assert.match(code(incompatible), /just net deploy dev1/, "deploy command keeps the id");
});

test("offline wall: checking headline names the device", async () => {
  const html = await renderPanel(deviceFixture({ status: "checking" }));
  assert.equal(h2(html), "Checking Dev One…");
  assert.doesNotMatch(h2(html), /dev1/);
});
