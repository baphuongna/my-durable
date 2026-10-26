// F3-S1+S2: create a worktree session straight from the session list.
//   - TreeRow: a worktree icon button in the session hover actions, emitting
//     action("worktree") like rename does.
//   - client/worktree.ts: the extracted flow — sibling target, worktree-add
//     before createSession, errors propagate without leaving a session behind.
// Level: integration (vite SSR) + unit (stub deviceApi).
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

const summary = {
  id: "s1",
  name: "main session",
  cwd: "/w/repo",
  model: "claude-x",
  provider: "faux",
  createdAt: Date.now(),
  dbPath: "/data/s1/agent.sqlite",
  busy: false,
  agents: [{ id: 1, name: "main", named: false, kind: "root", busy: false, background: 0 }],
};

test("TreeRow: session hover actions carry a worktree button wired to action('worktree')", async () => {
  const row = (await vite.ssrLoadModule("/src/components/TreeRow.vue")).default;
  const node = { type: "session", key: "dev1/s/s1", deviceId: "dev1", session: summary, stale: false, children: [] };
  const html = await renderToString(
    createSSRApp({
      render: () => h(row, { node, depth: 1, open: false, selected: false, focused: false, online: true }),
    }),
  );
  assert.match(html, /aria-label="New worktree session from main session"/, "worktree button missing");
  const src = await readFile(
    new URL("../apps/dpi-playground-fe/src/components/TreeRow.vue", import.meta.url),
    "utf8",
  );
  assert.match(src, /emit\('action', 'worktree'\)/, "button must emit action('worktree'), rename's pattern");
});

// ------------------------------------------------------------ client/worktree.ts

function stubApi(opts: { status?: object; failOp?: boolean } = {}) {
  const calls: string[] = [];
  const gitOpCalls: Array<{ path: string; op: string; opts: unknown }> = [];
  let createBody: unknown;
  return {
    calls,
    gitOpCalls,
    get createBody() {
      return createBody;
    },
    api: {
      gitStatus: async (path: string) => {
        calls.push(`status:${path}`);
        return opts.status ?? { repo: true, root: "/w/repo" };
      },
      gitOp: async (path: string, op: string, o: unknown) => {
        calls.push(`op:${op}`);
        gitOpCalls.push({ path, op, opts: o });
        if (opts.failOp) throw Error("fatal: a branch named 'x' already exists");
        return { text: "Preparing worktree (checking out 'feat/x')\nHEAD is now at abc" };
      },
      createSession: async (body: unknown) => {
        // Wire CONTRACT, not call-count: CreateSessionBody.model is either
        // absent or exactly { provider, modelId } — a bare modelId string is
        // the 400 the live bug was caught with, so it fails the test here.
        const m = (body as { model?: unknown }).model;
        if (m !== undefined && (typeof m !== "object" || m === null || typeof (m as { provider?: unknown }).provider !== "string" || typeof (m as { modelId?: unknown }).modelId !== "string" || Object.keys(m).sort().join(",") !== "modelId,provider"))
          throw new TypeError(
            `createSession body.model must be absent or { provider, modelId }, got: ${JSON.stringify(m)}`,
          );
        calls.push("create");
        createBody = body;
        return { ...summary, id: "s9", cwd: (body as { cwd: string }).cwd, name: (body as { name: string }).name };
      },
    } as never,
  };
}

test("worktreeTarget: sibling <parent>/<base>-<branch>, path separators flattened", async () => {
  const wt = await vite.ssrLoadModule("/src/client/worktree.ts");
  assert.equal(wt.worktreeTarget("/w/repo", "feat/x"), "/w/repo-feat-x");
  assert.equal(wt.worktreeTarget("/w/repo", "a\\b/c"), "/w/repo-a-b-c");
  assert.equal(wt.worktreeTarget("/w/repo", "plain"), "/w/repo-plain");
});

test("createWorktreeSession: status → worktree-add on the computed target → createSession with cwd=target", async () => {
  const wt = await vite.ssrLoadModule("/src/client/worktree.ts");
  const s = stubApi();
  const created = await wt.createWorktreeSession({
    deviceApi: s.api,
    cwd: "/w/repo",
    sessionName: "fix",
    branch: "feat/x",
  });
  assert.deepEqual(s.calls, ["status:/w/repo", "op:worktree-add", "create"], "order: status, add, create");
  assert.deepEqual(s.gitOpCalls, [
    { path: "/w/repo", op: "worktree-add", opts: { branch: "feat/x", target: "/w/repo-feat-x" } },
  ]);
  assert.deepEqual(s.createBody, { name: "fix", cwd: "/w/repo-feat-x" }, "session lands in the new checkout");
  assert.equal(created.id, "s9");
  assert.equal(created.cwd, "/w/repo-feat-x");
});

test("createWorktreeSession: a caller-supplied root skips the status round-trip", async () => {
  const wt = await vite.ssrLoadModule("/src/client/worktree.ts");
  const s = stubApi();
  await wt.createWorktreeSession({
    deviceApi: s.api,
    cwd: "/w/repo/sub",
    sessionName: "fix",
    branch: "feat/x",
    root: "/w/repo",
  });
  assert.deepEqual(s.calls, ["op:worktree-add", "create"], "no status call when root is known");
  assert.deepEqual(s.createBody, { name: "fix", cwd: "/w/repo-feat-x" });
});

test("createWorktreeSession: worktree-add rejects → propagates, no session created", async () => {
  const wt = await vite.ssrLoadModule("/src/client/worktree.ts");
  const s = stubApi({ failOp: true });
  await assert.rejects(
    wt.createWorktreeSession({ deviceApi: s.api, cwd: "/w/repo", sessionName: "fix", branch: "x" }),
    /already exists/,
  );
  assert.deepEqual(s.calls, ["status:/w/repo", "op:worktree-add"], "createSession must never run");
  assert.equal(s.createBody, undefined);
});

test("createWorktreeSession: non-repo cwd fails fast — no git op, no session", async () => {
  const wt = await vite.ssrLoadModule("/src/client/worktree.ts");
  const s = stubApi({ status: { repo: false } });
  await assert.rejects(
    wt.createWorktreeSession({ deviceApi: s.api, cwd: "/plain/dir", sessionName: "fix", branch: "x" }),
    /not a git repository/,
  );
  assert.deepEqual(s.calls, ["status:/plain/dir"], "nothing may run after a non-repo status");
  assert.equal(s.createBody, undefined);
});

// ------------------------------------------------ model wire shape (live bug)
// Caught live: the create body carried SessionSummary.model — a bare modelId
// string — and the device answered 400 "model must be { provider, modelId }".
// The stub's createSession now enforces the shape at runtime; these pin the
// two legitimate shapes: rewrapped object when the source has both fields,
// absent when it doesn't.

test("createWorktreeSession: a source session's model+provider ride along as { provider, modelId }", async () => {
  const wt = await vite.ssrLoadModule("/src/client/worktree.ts");
  const s = stubApi();
  await wt.createWorktreeSession({
    deviceApi: s.api,
    cwd: "/w/repo",
    sessionName: "fix",
    branch: "feat/x",
    source: { model: "claude-x", provider: "faux" },
  });
  assert.deepEqual(
    s.createBody,
    { name: "fix", cwd: "/w/repo-feat-x", model: { provider: "faux", modelId: "claude-x" } },
    "model must be the object the create route validates",
  );
});

test("createWorktreeSession without a catalog: source missing provider (or model) omits model — never a string", async () => {
  const wt = await vite.ssrLoadModule("/src/client/worktree.ts");
  for (const source of [{ model: "claude-x" }, { provider: "faux" }, undefined]) {
    const s = stubApi();
    await wt.createWorktreeSession({ deviceApi: s.api, cwd: "/w/repo", sessionName: "fix", branch: "b", source });
    assert.deepEqual(
      s.createBody,
      { name: "fix", cwd: "/w/repo-b" },
      `model must be absent when the source lacks model or provider (source=${JSON.stringify(source)})`,
    );
  }
});

test("the stub rejects a string model: a regression to the wire bug fails createSession itself", async () => {
  const s = stubApi();
  // The live-bug body, verbatim: model forwarded as the bare modelId string
  // SessionSummary stores. The stub — like the device — must refuse it.
  await assert.rejects(
    s.api.createSession({ name: "regress", cwd: "/w/repo-b", model: "claude-x" } as never),
    /must be absent or \{ provider, modelId \}/,
  );
  assert.deepEqual(s.calls, [], "a rejected body never counts as a created session");
});

test("createWorktreeSession + catalog: a served source model is forwarded; a stale one falls to the catalog default", async () => {
  const wt = await vite.ssrLoadModule("/src/client/worktree.ts");
  const catalog = [
    { provider: "zai", id: "glm-4.7" },
    { provider: "faux", id: "faux-1" },
  ];
  // Served pair → forwarded in the object shape.
  const served = stubApi();
  await wt.createWorktreeSession({
    deviceApi: served.api,
    cwd: "/w/repo",
    sessionName: "fix",
    branch: "b",
    source: { model: "glm-4.7", provider: "zai" },
    catalog,
    defaultModel: "faux/faux-1",
  });
  assert.deepEqual(served.createBody, {
    name: "fix",
    cwd: "/w/repo-b",
    model: { provider: "zai", modelId: "glm-4.7" },
  });
  // Stale pair (session outlived a catalog change, seen live) → the catalog
  // default, NEVER omitted: the worktree's brand-new project has no default
  // and the create route 400s an absent model (both proven live).
  const stale = stubApi();
  await wt.createWorktreeSession({
    deviceApi: stale.api,
    cwd: "/w/repo",
    sessionName: "fix",
    branch: "b",
    source: { model: "claude-x", provider: "openrouter" },
    catalog,
    defaultModel: "faux/faux-1",
  });
  assert.deepEqual(stale.createBody, {
    name: "fix",
    cwd: "/w/repo-b",
    model: { provider: "faux", modelId: "faux-1" },
  });
  // Stale pair, defaultModel not in the catalog → catalog[0] (NewSessionDialog's rule).
  const first = stubApi();
  await wt.createWorktreeSession({
    deviceApi: first.api,
    cwd: "/w/repo",
    sessionName: "fix",
    branch: "b",
    source: { model: "claude-x", provider: "openrouter" },
    catalog,
  });
  assert.deepEqual(first.createBody, {
    name: "fix",
    cwd: "/w/repo-b",
    model: { provider: "zai", modelId: "glm-4.7" },
  });
  // No source at all → still a valid explicit model when a catalog exists.
  const none = stubApi();
  await wt.createWorktreeSession({
    deviceApi: none.api,
    cwd: "/w/repo",
    sessionName: "fix",
    branch: "b",
    catalog,
    defaultModel: "faux/faux-1",
  });
  assert.deepEqual(none.createBody, {
    name: "fix",
    cwd: "/w/repo-b",
    model: { provider: "faux", modelId: "faux-1" },
  });
});
