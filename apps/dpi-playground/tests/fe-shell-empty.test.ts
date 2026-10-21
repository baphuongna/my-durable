// FE smoke: App shell renders with an empty store (0 devices / 0 sessions).
// H05 evidence: no view assumes data exists; boot() is never called under SSR.
// Level: integration (vite SSR, real module graph, no hub/browser). No new deps.
// Design: P2-UI1 (probe validated by the test-engineer recon step); assertions pin
// the empty-state contract via stable data-testids added with the herdr restyle.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";

// SSR shims — store.ts touches window.matchMedia / navigator.userAgent at module scope.
globalThis.window = globalThis.window ?? {
  matchMedia: (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }),
};
if (!globalThis.navigator) {
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node-test" }, configurable: true });
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

await test("App shell renders with empty store (0 devices / 0 sessions)", async () => {
  const mod = await vite.ssrLoadModule("/src/App.vue");
  assert.ok(mod.default, "App.vue default export");
  html = await renderToString(createSSRApp(mod.default)); // no boot() → empty store
  assert.ok(html.length > 0, "non-empty render");
});

await test("H05: empty states render, no assumptions of existing data", () => {
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
