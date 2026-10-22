// FE smoke: App shell renders with an empty store (0 devices / 0 sessions).
// H05 evidence: no view assumes data exists; boot() is never called under SSR.
// Level: integration (vite SSR, real module graph, no hub/browser). No new deps.
// Design: P2-UI1 (probe validated by the test-engineer recon step); assertions pin
// the empty-state contract via stable data-testids added with the UI restyle.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";

// SSR shims — store.ts touches window.matchMedia / navigator.userAgent at module scope.
globalThis.window = globalThis.window ?? {
  matchMedia: (q) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }),
};
if (!globalThis.navigator) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "node-test" },
    configurable: true,
  });
}
// jobs.ts starts a 1s setInterval at module scope; unref intervals so the runner exits.
const origSetInterval = globalThis.setInterval;
globalThis.setInterval = function (fn, ms, ...a) {
  const t = origSetInterval.call(this, fn, ms, ...a);
  t.unref?.();
  return t;
};

const FE_ROOT = new URL("../apps/dpi-playground-fe/", import.meta.url);

let vite: Awaited<ReturnType<typeof createServer>>;
let html = "";

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

test("App shell renders with empty store (0 devices / 0 sessions)", async () => {
  const mod = await vite.ssrLoadModule("/src/App.vue");
  assert.ok(mod.default, "App.vue default export");
  html = await renderToString(createSSRApp(mod.default)); // no boot() → empty store
  assert.ok(html.length > 0, "non-empty render");
});

test("H05: empty states render, no assumptions of existing data", () => {
  assert.ok(html, "html from previous test");
  assert.match(html, /data-testid="app-shell"/, "app shell mounts");
  assert.match(html, /data-testid="welcome-empty"/, "welcome empty-state view");
  assert.match(html, /data-testid="tree-empty"/, "network tree empty hint");
  assert.match(html, /data-testid="topbar-stats"/, "topbar stats render");
  assert.match(html, /No devices yet/, "0-device copy");
  assert.match(html, /0 of 0 online/, "topbar stats show 0/0 devices");
  assert.match(html, /0<\/b> sessions/, "topbar stats show 0 sessions");
  assert.match(html, /0<\/b> agents/, "topbar stats show 0 agents");
});

test("style tokens: no self-referential custom property definitions", async () => {
  // Review MAJOR (P2-UI1): `--x: var(--x)` cycles collapse every dependent usage
  // to unset — the whole theme silently disappears. Guard the source.
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(
    new URL("../apps/dpi-playground-fe/src/style.css", import.meta.url),
    "utf8",
  );
  const cycles = [...css.matchAll(/--([\w-]+)\s*:\s*var\(--\1\b/g)].map((m) => `--${m[1]}`);
  assert.deepEqual(cycles, [], `cyclic token definitions: ${cycles.join(", ")}`);
  // And the core brand palette must resolve to real colors (not var() indirection).
  for (const token of ["--bg", "--fg", "--primary", "--ok", "--warn", "--err", "--offline"]) {
    assert.match(
      css,
      new RegExp(`${token}\\s*:\\s*#[0-9a-fA-F]{3,8}`),
      `${token} has a literal value`,
    );
  }
});

test("R03: an offline paired device with no sessions has an accessible credential manager", async () => {
  const store = await vite.ssrLoadModule("/src/client/store.ts");
  const mod = await vite.ssrLoadModule("/src/App.vue");
  const fingerprint = `sha256:${"c".repeat(64)}`;
  const device = {
    id: "offline-box",
    name: "Offline box",
    kind: "url",
    transport: "tunnel",
    url: null,
    source: "ui",
    hasToken: false,
    deviceUid: "fixture-uid",
    status: "offline",
    pairing: {
      status: "paired",
      keyFingerprint: fingerprint,
      pairedAt: Date.now(),
      credentialGeneration: 1,
      rotationPending: false,
    },
    tunnel: { state: "disconnected", readerCount: 0 },
  };
  try {
    store.network.model.apply({ type: "network", devices: [device] });
    let rendered = await renderToString(createSSRApp(mod.default));
    assert.match(rendered, /aria-label="Manage credentials for offline-box"/);
    store.ui.dialog = { kind: "credentials", deviceId: device.id };
    rendered = await renderToString(createSSRApp(mod.default));
    assert.match(rendered, /aria-label="Credential manager"/);
    assert.match(rendered, /Rotate credential/);
    assert.ok(/>\s*Revoke\s*</.test(rendered), "revoke remains accessible while offline");
    assert.match(rendered, new RegExp(fingerprint), "the detail shows the full fingerprint");
    assert.equal(store.selected.value, undefined, "managing a device needs no selected agent");
  } finally {
    store.network.model.apply({ type: "network", devices: [] });
    store.ui.dialog = undefined;
  }
});

test("R04: narrow-screen Network and Details are mutually exclusive", async () => {
  const store = await vite.ssrLoadModule("/src/client/store.ts");
  const wasNarrow = store.narrow.value;
  try {
    store.narrow.value = true;
    store.ui.drawer = true;
    store.showInspector();
    assert.equal(store.ui.drawer, false, "Details closes Network");
    assert.equal(store.ui.inspectorOverlay, true);
    store.toggleTree();
    assert.equal(store.ui.inspectorOverlay, false, "Network closes Details");
    assert.equal(store.ui.drawer, true);
    store.toggleTree();
    assert.equal(
      store.ui.drawer || store.ui.inspectorOverlay,
      false,
      "closing the active panel returns to Chat",
    );
  } finally {
    store.narrow.value = wasNarrow;
    store.ui.drawer = false;
    store.ui.inspectorOverlay = false;
  }
});
