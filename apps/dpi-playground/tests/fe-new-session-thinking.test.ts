// F2-S4 (FE half): the New session dialog offers the thinking level next to
// the model select — default "medium" (the backend's create default), all
// THINKING_LEVELS from @sdk/api, and the create call carries thinkingLevel.
// Level: integration (vite SSR, real module graph; deviceClient mocked) +
// source contract for the create payload (fe-git-chip pattern).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { readFile } from "node:fs/promises";

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

test("New session dialog: thinking select defaults to medium and offers every level", async () => {
  const store = await vite.ssrLoadModule("/src/client/store.ts");
  const dialog = (await vite.ssrLoadModule("/src/components/NewSessionDialog.vue")).default;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/v1/projects"))
      return new Response(JSON.stringify({ projects: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    // DirBrowser lists start dirs on mount — give it a well-shaped empty listing.
    return new Response(JSON.stringify({ path: "", dirs: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    store.network.model.apply({
      type: "network",
      devices: [
        {
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
            defaultModel: "faux/claude-x",
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
        },
      ],
    });
    const html = await renderToString(
      createSSRApp({ render: () => h(dialog, { deviceId: "dev1" }) }),
    );
    assert.match(html, /aria-label="New session thinking level"/, "thinking select missing");
    const select = html.match(/<select aria-label="New session thinking level"[\s\S]*?<\/select>/)?.[0] ?? "";
    // all 7 levels, in catalog order
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"])
      assert.match(select, new RegExp(`<option value="${level}"`), `level ${level} missing`);
    const options = [...select.matchAll(/<option value="(\w+)"/g)].map((m) => m[1]);
    assert.equal(options.length, 7, `exactly the 7 thinking levels, got ${options.join(",")}`);
    assert.match(select, /<option value="medium"[^>]*\sselected/, "medium must be the default");
  } finally {
    globalThis.fetch = realFetch;
    store.network.model.apply({ type: "network", devices: [] });
  }
});

test("New session dialog: the create call carries the chosen thinking level (source contract)", async () => {
  const src = await readFile(
    new URL("../apps/dpi-playground-fe/src/components/NewSessionDialog.vue", import.meta.url),
    "utf8",
  );
  assert.match(src, /THINKING_LEVELS/, "levels must come from @sdk/api");
  assert.match(src, /from "@sdk\/api"/, "THINKING_LEVELS import");
  assert.match(src, /v-model="draft\.thinking"/, "select rides the draft");
  assert.match(src, /thinkingLevel: draft\.value\.thinking/, "create body must carry thinkingLevel");
  assert.match(src, /thinking: "medium" as ThinkingLevel/, "default must be medium");
});
