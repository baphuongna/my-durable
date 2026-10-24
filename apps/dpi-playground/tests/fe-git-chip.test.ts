// GitChip: the session breadcrumb's git surface. Rendered only for a repo;
// shows branch + dirty counts; the panel carries fetch/pull/log/commit and
// worktree add/remove through the device's whitelisted /v1/git API.
// Level: integration (vite SSR, real module graph; deviceClient mocked).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";

globalThis.window = globalThis.window ?? {
  matchMedia: (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }),
};
if (!globalThis.navigator) Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node-test" }, configurable: true });
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

async function renderChip(status: unknown, cwd: string | undefined) {
  const store = await vite.ssrLoadModule("/src/client/store.ts");
  const chip = (await vite.ssrLoadModule("/src/components/GitChip.vue")).default;

  // The real DpiClient rides fetch — mock THAT (module exports are getter-only).
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/v1/git/status")) {
      calls.push("status");
      return new Response(JSON.stringify(status), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/v1/git") && (init?.method ?? "GET") === "POST") {
      calls.push(JSON.parse(String(init?.body ?? "{}")).op);
      return new Response(JSON.stringify({ text: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  void store;
  try {
    const html = await renderToString(createSSRApp({ render: () => h(chip, { deviceId: "dev1", cwd: cwd ?? undefined }) }));
    return { html, calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("GitChip: no repo → nothing rendered (no phantom chip)", async () => {
  const { html } = await renderChip({ repo: false }, "/some/dir");
  assert.doesNotMatch(html, /git-chip/);
});

test("GitChip: repo → branch, dirty, ahead/behind in the chip", async () => {
  const { html } = await renderChip(
    { repo: true, root: "/r", branch: "main", head: "abc1234", subject: "s", staged: 1, unstaged: 2, untracked: 0, ahead: 3, behind: 4 },
    "/r",
  );
  assert.match(html, /main/);
  assert.match(html, /±3/);
  assert.match(html, /↑3/);
  assert.match(html, /↓4/);
});

test("GitChip: status is fetched for the session's cwd through deviceClient", async () => {
  const { calls } = await renderChip({ repo: true, root: "/r", branch: "main" }, "/r/sub");
  assert.ok(calls.includes("status"), `fetched status, got ${calls.join(",")}`);
});
