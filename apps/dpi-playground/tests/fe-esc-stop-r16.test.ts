// R16 Esc-Esc stop (Unit B): client/esc-stop.ts is the pure policy —
// dialog > Find overlay > quote strip > double-Esc-within-1s-while-busy.
// quoteOpen arrives as a boolean on purpose: this policy must not import
// client/quote.ts (Unit A's module), so the two units can never couple.
// AgentView's wiring is asserted from source: capture-phase document keydown
// that consumes what the policy owns, so App.vue's legacy single-Esc
// interrupt can never race the double-Esc gesture.
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

const policy = () => vite.ssrLoadModule("/src/client/esc-stop.ts");

const base = {
  dialogOpen: false,
  overlayOpen: false,
  quoteOpen: false,
  busy: false,
  now: 10_000,
  lastEscAt: null as number | null,
};

test("esc-stop: an open dialog defers to App.vue, even mid gesture", async () => {
  const { decideEscStop } = await policy();
  assert.equal(
    decideEscStop({ ...base, dialogOpen: true, overlayOpen: true, quoteOpen: true, busy: true, lastEscAt: 9_999 }),
    "none",
    "App.vue's keydown owns the dialog case",
  );
});

test("esc-stop: the overlay closes before the strip, the strip before the stop", async () => {
  const { decideEscStop } = await policy();
  const midGesture = { ...base, overlayOpen: true, quoteOpen: true, busy: true, lastEscAt: 9_999 };
  assert.equal(decideEscStop(midGesture), "close-overlay", "overlay first");
  assert.equal(
    decideEscStop({ ...midGesture, overlayOpen: false }),
    "clear-strip",
    "then the quote strip",
  );
});

test("esc-stop: two Escapes within 1000ms while busy stop the turn", async () => {
  const { decideEscStop } = await policy();
  assert.equal(decideEscStop({ ...base, busy: true, lastEscAt: 9_000 }), "stop", "1000ms is inside");
  assert.equal(decideEscStop({ ...base, busy: true, lastEscAt: 10_000 }), "stop", "same tick counts");
});

test("esc-stop: 1001ms apart is no longer a double", async () => {
  const { decideEscStop } = await policy();
  assert.equal(decideEscStop({ ...base, busy: true, lastEscAt: 8_999 }), "none");
});

test("esc-stop: a single Escape never stops a turn", async () => {
  const { decideEscStop } = await policy();
  assert.equal(decideEscStop({ ...base, busy: true, lastEscAt: null }), "none", "first press");
  assert.equal(
    decideEscStop({ ...base, busy: false, lastEscAt: 9_999 }),
    "none",
    "no turn running",
  );
});

test("esc-stop: the clock jumping backwards is not a double", async () => {
  const { decideEscStop } = await policy();
  assert.equal(decideEscStop({ ...base, busy: true, now: 9_000, lastEscAt: 9_500 }), "none");
});

test("AgentView wiring: policy first, capture phase, store interrupt", () => {
  const view = src("components/AgentView.vue");
  assert.match(view, /import \{ decideEscStop \} from "\.\.\/client\/esc-stop"/, "the policy module");
  assert.match(view, /decideEscStop\(\{/, "keydown consults the policy");
  assert.match(
    view,
    /addEventListener\("keydown", onKeydown, true\)/,
    "capture phase: the policy decides before App.vue's bubble listener",
  );
  assert.match(
    view,
    /stopImmediatePropagation/,
    "an owned Escape never reaches App.vue's legacy single-Esc interrupt",
  );
  assert.match(
    view,
    /if \(e\.key !== "Escape" \|\| e\.isComposing \|\| ui\.dialog\) return;/,
    "dialogs stay App.vue's",
  );
  assert.match(view, /void interrupt\(\)/, "stop reuses the store's interrupt, not a new one");
  assert.match(
    view,
    /if \(!e\.repeat\) lastEscAt = Date\.now\(\);/,
    "a held (repeating) Escape never advances the double-Esc gesture",
  );
  assert.match(view, /lastEscAt = null;\s*\n\s*void interrupt\(\);/, "the gesture resets on stop");
});
