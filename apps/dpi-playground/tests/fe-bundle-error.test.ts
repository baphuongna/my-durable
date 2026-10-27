// R6 fe fix #5 (P4): an export-bundle failure used to surface only as a
// ≤120-char toast. It now stays inline in the Session heading with a Retry
// (Git tab's error-banner pattern) until a retry succeeds or the session
// changes. The retry loop lives in client/export-bundle.ts (unit-tested
// here); the browser-only download is injected.
// Level: unit + wiring.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ref } from "vue";
import { createServer } from "vite";

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

const BUNDLE = { filename: "s1.zip", mime: "application/zip", bytes: 2048, base64: "" };

test("export bundle: failure stays with a retry; a successful retry clears it", async () => {
  const { useExportBundle } = await vite.ssrLoadModule("/src/client/export-bundle.ts");
  const target = ref({ device: { id: "dev1" }, summary: { id: "s1" } });
  let calls = 0;
  const downloads: string[] = [];
  const notes: string[] = [];
  const s = useExportBundle(target, {
    fetchBundle: async () => {
      if (++calls === 1) throw Error("tunnel went away mid-export");
      return BUNDLE;
    },
    download: (r) => downloads.push(r.filename),
    notify: (t) => notes.push(t),
  });

  await s.run(); // mocked failure
  assert.match(s.error.value, /bundle export failed: tunnel went away/, "the error persists");
  assert.ok(!s.error.value.includes("slice"), "the inline error is not truncated to toast size");
  assert.equal(downloads.length, 0, "nothing downloaded on failure");

  await s.run(); // retry succeeds
  assert.equal(s.error.value, "", "a successful retry clears the inline error");
  assert.deepEqual(downloads, ["s1.zip"]);
  assert.match(notes.at(-1)!, /Bundle downloaded \(2 KiB\)/, "the success toast remains");
});

test("export bundle: the failure belongs to one session", async () => {
  const { useExportBundle } = await vite.ssrLoadModule("/src/client/export-bundle.ts");
  const target = ref({ device: { id: "dev1" }, summary: { id: "s1" } });
  const s = useExportBundle(target, {
    fetchBundle: async () => {
      throw Error("offline");
    },
    download: () => {},
    notify: () => {},
  });
  await s.run();
  assert.match(s.error.value, /offline/);
  target.value = { device: { id: "dev1" }, summary: { id: "s2" } }; // switch session
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(s.error.value, "", "switching sessions clears the stale failure");
});

test("Inspector: the Session heading carries the inline error with a retry", () => {
  const src = readFileSync(
    new URL("../apps/dpi-playground-fe/src/components/Inspector.vue", import.meta.url),
    "utf8",
  );
  const flat = src.replace(/\s+/g, " ");
  assert.match(flat, /useExportBundle\(/, "the export loop comes from the composable");
  assert.match(flat, /v-if="bundleError"[^>]*class="message-error"/, "a persistent error banner");
  assert.match(flat, /role="alert"/, "the banner is announced");
  assert.match(
    flat,
    /class="small" :disabled="exportingBundle" @click="downloadBundle"/,
    "a retry button re-runs the export",
  );
});
