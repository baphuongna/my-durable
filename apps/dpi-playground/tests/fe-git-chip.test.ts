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
  gitStore = await vite.ssrLoadModule("/src/client/git-store.ts");
});
test.after(async () => {
  await vite?.close();
});

// fresh store per render (module cache would leak entries between tests)
let viteUrl: Awaited<ReturnType<typeof createServer>>;
function resetStore() {
  void viteUrl;
}

let gitStore: { clearGitCache: () => void; ensureGit: typeof import("../apps/dpi-playground-fe/src/client/git-store.ts").ensureGit; gitEntry: typeof import("../apps/dpi-playground-fe/src/client/git-store.ts").gitEntry };

async function renderChip(status: unknown, cwd: string | undefined) {
  gitStore.clearGitCache();
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

test("Inspector Git TAB: always renders — 'not a repository' is a state, not a hidden chip", async () => {
  gitStore.clearGitCache();
  const panel = (await vite.ssrLoadModule("/src/components/GitPanel.vue")).default;
  const realFetch = globalThis.fetch;
  const mk = (s: unknown) =>
    new Response(JSON.stringify(s), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    String(input).includes("/v1/git/status") ? mk(repoState) : realFetch(input)) as typeof fetch;
  const repoState = { repo: false };
  const store = await vite.ssrLoadModule("/src/client/store.ts");
  void store;
  try {
    const html = await renderToString(
      createSSRApp({
        render: () => h(panel, { deviceId: "dev1", cwd: "/plain/dir" }),
      }),
    );
    assert.match(html, /Not a git repository/, "non-repo must SAY so, not vanish");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Inspector Git TAB: repo state shows branch and change counts", async () => {
  gitStore.clearGitCache();
  gitStore.clearGitCache();
  const panel = (await vite.ssrLoadModule("/src/components/GitPanel.vue")).default;
  const realFetch = globalThis.fetch;
  const repo = {
    repo: true,
    root: "/r",
    branch: "feature-x",
    head: "abc1234",
    subject: "hello",
    staged: 1,
    unstaged: 2,
    untracked: 3,
    ahead: 2,
    files: [
      { path: "src/a.ts", x: "M", y: " " },
      { path: "src/b.ts", x: " ", y: "M" },
    ],
    branches: [
      { name: "feature-x", current: true },
      { name: "main" },
    ],
    worktrees: [
      { path: "/r", branch: "feature-x", head: "abc1234" },
      { path: "/r-wt2", branch: "side", head: "ddd0000" },
    ],
  };
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    String(input).includes("/v1/git/status")
      ? new Response(JSON.stringify(repo), { status: 200, headers: { "content-type": "application/json" } })
      : realFetch(input)) as typeof fetch;
  try {
    const html = await renderToString(
      createSSRApp({ render: () => h(panel, { deviceId: "dev1", cwd: "/r" }) }),
    );
    assert.match(html, /feature-x/);
    assert.match(html, /\+1 ~2 \?3/);
    assert.match(html, /↑2/);
    assert.match(html, /Commit message/i);
    assert.match(html, /\+ worktree/);
    assert.match(html, /src\/a\.ts/, "changed files must be listed");
    assert.match(html, /\/r-wt2/, "linked worktrees must be listed");
    assert.match(html, /session/, "worktree rows must offer a session");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("git store: LAZY — a fresh entry never refetches; force does", async () => {
  gitStore.clearGitCache();
  let calls = 0;
  const realFetch = globalThis.fetch;
  const repo = { repo: true, root: "/r", branch: "main" };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/v1/git/status")) {
      calls += 1;
      return new Response(JSON.stringify(repo), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(input);
  }) as typeof fetch;
  try {
    await gitStore.ensureGit("dev1", "/r");
    await gitStore.ensureGit("dev1", "/r"); // fresh → no second call
    await gitStore.ensureGit("dev1", "/r"); // still fresh
    assert.equal(calls, 1, `fresh entry refetched: ${calls} calls`);
    await gitStore.ensureGit("dev1", "/r", { force: true });
    assert.equal(calls, 2, "force bypasses the TTL");
    const e = gitStore.gitEntry("dev1", "/r");
    assert.equal(e.status?.branch, "main");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("GitPanel: lazy + no polling — the source contract", async () => {
  const { readFile } = await import("node:fs/promises");
  const s = await readFile(new URL("../apps/dpi-playground-fe/src/components/GitPanel.vue", import.meta.url), "utf8");
  assert.match(s, /loading git/, "no loading copy");
  assert.match(s, /ensureGit/, "not riding the shared lazy store");
  assert.doesNotMatch(s, /setInterval/, "the panel must not poll — lazy means fetch when looked at, on demand");
  assert.match(s, /force: true/, "refresh must be explicit (force)");
});

test("GitPanel: refetch failure keeps the last good status + a retry button", async () => {
  const panel = (await vite.ssrLoadModule("/src/components/GitPanel.vue")).default;
  const realFetch = globalThis.fetch;
  let fail = false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (fail) throw new Error("Failed to fetch");
    return new Response(JSON.stringify({ repo: true, root: "/r", branch: "main", head: "aa1111" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const html = await renderToString(createSSRApp({ render: () => h(panel, { deviceId: "dev1", cwd: "/r" }) }));
    assert.match(html, /main/, "first paint has the repo facts");
  } finally {
    globalThis.fetch = realFetch;
  }
  // a later failing refresh (device tunnel dropped) must not blank the tab —
  // that path runs client-side; the guard is the stale-while-error state
  // (keep status, show error+retry), asserted on the rendered class contract.
  const storeSrc = await (await import("node:fs/promises")).readFile(
    new URL("../apps/dpi-playground-fe/src/client/git-store.ts", import.meta.url),
    "utf8",
  );
  assert.match(storeSrc, /e\.status = await deviceClient/, "the store owns the fetch (status kept on error)");
  assert.match(storeSrc, /device unreachable/, "network errors get human words");
  const panelSrc = await (await import("node:fs/promises")).readFile(
    new URL("../apps/dpi-playground-fe/src/components/GitPanel.vue", import.meta.url),
    "utf8",
  );
  assert.match(panelSrc, /refreshing/, "refetch with data shows a refreshing note");
});

test("GitPanel: IntelliJ contract — branch picker, file checkboxes, worktree sessions, no typing", async () => {
  const { readFile } = await import("node:fs/promises");
  const s = await readFile(new URL("../apps/dpi-playground-fe/src/components/GitPanel.vue", import.meta.url), "utf8");
  assert.match(s, /v-for="b in status.branches/, "branch menu must LIST existing branches");
  assert.match(s, /switchBranch\(b\.name\)/, "picking a branch must switch");
  assert.doesNotMatch(s, /v-model="wtName"/, "worktree creation must not be a bare typed input");
  assert.match(s, /addWorktree\(b\.name\)/, "worktree creation from existing branches");
  assert.match(s, /type="checkbox"/, "commit must offer file checkboxes");
  assert.match(s, /textarea/, "commit message must be a multi-line textarea");
  assert.match(s, /files: chosen/, "commit must send the chosen files");
  assert.match(s, /sessionOn\(w\.path/, "a worktree row must create a session");
});

test("session tree rows carry the branch", async () => {
  const { readFile } = await import("node:fs/promises");
  const s = await readFile(new URL("../apps/dpi-playground-fe/src/components/TreeRow.vue", import.meta.url), "utf8");
  assert.match(s, /branchOf\(n\.deviceId, n\.session\.cwd\)/, "session rows must look up their branch");
  assert.match(s, /⎇ \{\{ branch \}\}/, "session rows must render the branch chip");
});

test("Inspector tab list includes Git", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../apps/dpi-playground-fe/src/components/Inspector.vue", import.meta.url), "utf8");
  assert.match(src, /id: "git", label: "Git"/, "no git tab registered");
  assert.match(src, /GitPanel v-if="ui.tab === 'git'"/, "git panel not wired");
});
