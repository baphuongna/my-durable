// R6 fe fix #3 (P3): Escape must not close a BUSY prompt dialog — the click
// guards on the backdrop/buttons already do, but App.vue's document-level
// keydown closed ui.dialog unconditionally, unmounting the dialog whose
// in-flight action was about to render its error. The policy lives in
// client/dialog-escape.ts (unit-tested here); App.vue consults it with the
// PromptDialog's exposed busy flag, and PromptDialog keeps exposing it.
// Level: unit + wiring (App.vue's keydown only runs in a real browser).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const src = (p: string) =>
  readFileSync(new URL(`../apps/dpi-playground-fe/src/${p}`, import.meta.url), "utf8");

test("escape policy: a busy prompt keeps its dialog; a settled one closes", async () => {
  const { escapeDialog } = await vite.ssrLoadModule("/src/client/dialog-escape.ts");
  const prompt = {
    kind: "prompt",
    title: "Share this transcript publicly?",
    submit: "Create share link",
    run: async () => {},
  } as const;
  // busy + Escape → the dialog stays (the action keeps its surface)
  assert.equal(escapeDialog(prompt, true), "keep", "busy prompt + Escape keeps the dialog");
  // after settle + Escape → the dialog closes
  assert.equal(escapeDialog(prompt, false), "close", "settled prompt + Escape closes it");
  assert.equal(escapeDialog({ kind: "models" }), "close");
  assert.equal(escapeDialog({ kind: "help" }), "close");
  assert.equal(escapeDialog({ kind: "pair" }), "pair", "the pair wizard closes its own way");
});

test("App.vue: Escape consults the policy with the live prompt's busy flag", () => {
  const app = src("App.vue");
  assert.match(app, /const promptDialog = ref/, "App keeps a ref to the live PromptDialog");
  assert.match(app, /ref="promptDialog"/, "the ref is bound in the template");
  assert.match(
    app,
    /escapeDialog\(ui\.dialog, promptDialog\.value\?\.busy \?\? false\)/,
    "keydown asks the policy before closing on Escape",
  );
});

test("PromptDialog: exposes its busy flag for the Escape policy", () => {
  const dialog = src("components/PromptDialog.vue");
  assert.match(dialog, /defineExpose\(\{ busy \}\)/, "busy is exposed to the parent");
});
