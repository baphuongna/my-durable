// R21 (index 400s): a device's git surface is bounded by its startDirs — the
// FE knows them from the network frame (info.startDirs + info.platform) and
// must NOT send doomed requests for project roots outside them (a leftover
// project from other start dirs 400s on the device and spams the console).
// Level: integration (vite SSR, real module graph; fetch mocked).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

globalThis.window = globalThis.window ?? {
  matchMedia: (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }),
};
if (!globalThis.navigator) Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node-test" }, configurable: true });
const origSetInterval = globalThis.setInterval;
globalThis.setInterval = function (fn: number | TimerHandler, ms: number, ...a: unknown[]) {
  const t = origSetInterval.call(this, fn as never, ms, ...(a as never[]));
  (t as { unref?: () => void }).unref?.();
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
  await vite.close();
});

interface FetchLog { url: string; body?: string }

async function setup() {
  const store = await vite.ssrLoadModule("/src/client/store.ts");
  const gitStore = await vite.ssrLoadModule("/src/client/git-store.ts");
  gitStore.clearGitCache();
  // The Windows laptop exactly as production reported it: startDirs =
  // C:\Users\phuongnb\dpi-work, a leftover project at D:\source\reconcile-backend-v2.
  store.network.model.apply({
    type: "network",
    devices: [
      {
        id: "dev1",
        name: "PhuongNB-Laptop",
        kind: "device",
        transport: "tunnel",
        url: null,
        source: "config",
        hasToken: true,
        status: "online",
        info: { startDirs: ["C:\\Users\\phuongnb\\dpi-work"], platform: "win32-x64 node v22.14.0" },
        tree: { sessions: [] },
      },
    ],
  } as never);
  const log: FetchLog[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    log.push({ url: String(input), body: typeof init?.body === "string" ? init.body : undefined });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { store, gitStore, log, done: () => { globalThis.fetch = realFetch; } };
}

test("ensureGit: a path outside the device's start dirs settles locally — no request, no console 400", async () => {
  const { gitStore, log, done } = await setup();
  try {
    await gitStore.ensureGit("dev1", "D:\\source\\reconcile-backend-v2", { force: true });
    assert.equal(log.length, 0, `no doomed request sent, got ${JSON.stringify(log)}`);
    const e = gitStore.gitEntry("dev1", "D:\\source\\reconcile-backend-v2");
    assert.match(e.error, /start dirs/);
    assert.equal(e.status, null);
    assert.ok(e.at > 0, "the verdict is cached, not retried every stale window");
  } finally {
    done();
  }
});

test("ensureGit: win32 containment is case- and slash-insensitive", async () => {
  const { gitStore, log, done } = await setup();
  try {
    await gitStore.ensureGit("dev1", "c:/users/PHUONGNB/dpi-work/proj", { force: true });
    assert.equal(log.length, 1, `the allowed path IS sent (device stays the enforcer), got ${JSON.stringify(log)}`);
  } finally {
    done();
  }
});

test("ensureGitBatch: foreign roots are filtered out of the batch; {error} entries settle the chip", async () => {
  const { gitStore, log, done } = await setup();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    log.push({ url: String(input), body: typeof init?.body === "string" ? init.body : undefined });
    return new Response(
      JSON.stringify({ "C:\\Users\\phuongnb\\dpi-work\\proj": { error: "not a git repository: C:\\Users\\phuongnb\\dpi-work\\proj" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    void realFetch;
    await gitStore.ensureGitBatch("dev1", ["C:\\Users\\phuongnb\\dpi-work\\proj", "D:\\source\\reconcile-backend-v2"]);
    assert.equal(log.length, 1, "exactly one batch request");
    const sent = JSON.parse(log[0].body ?? "{}").paths as string[];
    assert.deepEqual(sent, ["C:\\Users\\phuongnb\\dpi-work\\proj"], "the foreign root never rides the batch");
    const e = gitStore.gitEntry("dev1", "C:\\Users\\phuongnb\\dpi-work\\proj");
    assert.match(e.error, /not a git repository/);
    assert.equal(e.status, null);
    // and a second pass is a no-op: the error entry is fresh
    await gitStore.ensureGitBatch("dev1", ["C:\\Users\\phuongnb\\dpi-work\\proj", "D:\\source\\reconcile-backend-v2"]);
    assert.equal(log.length, 1, "cached verdicts are not re-sent");
  } finally {
    globalThis.fetch = realFetch;
    done();
  }
});

test("run-7 D2: only SENT keys are settled; >50 paths chunk to the device contract", async () => {
  const store = await vite.ssrLoadModule("/src/client/store.ts");
  const gitStore = await vite.ssrLoadModule("/src/client/git-store.ts");
  gitStore.clearGitCache();
  store.network.model.apply({
    type: "network",
    devices: [
      { id: "dev1", name: "Evil", kind: "device", transport: "tunnel", url: null, source: "config", hasToken: true, status: "online",
        info: { startDirs: ["/w"], platform: "linux x64" }, tree: { sessions: [] } },
    ],
  } as never);
  const bodies: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === "string") bodies.push(init.body);
    // hostile device: echoes the sent keys AND plants 500 fresh hostile keys
    const sent = JSON.parse(String(init?.body ?? "{}")).paths as string[];
    const map: Record<string, unknown> = {};
    for (const p of sent) map[p] = { repo: false };
    for (let i = 0; i < 500; i++) map[`/hostile/planted-${i}`] = { repo: true, branch: "x".repeat(100) };
    return new Response(JSON.stringify(map), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    // 60 paths: must chunk into 2 requests of ≤50 (device contract)
    const many = Array.from({ length: 60 }, (_, i) => `/w/p${i}`);
    await gitStore.ensureGitBatch("dev1", many);
    assert.equal(bodies.length, 2, `60 stale paths chunk to 2 batch requests, got ${bodies.length}`);
    for (const b of bodies) assert.ok((JSON.parse(b).paths as string[]).length <= 50, "each chunk respects the device's 50-path cap");
    // planted keys must NOT be settled
    const planted = gitStore.gitEntry("dev1", "/hostile/planted-0");
    assert.equal(planted.at, 0, "a hostile planted key never creates an entry");
    const legit = gitStore.gitEntry("dev1", "/w/p0");
    assert.ok(legit.at > 0, "sent keys still settle");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("run-8 (live console report): direct gitOp callers are gated too — a foreign path settles without a request", async () => {
  const { gitStore } = await setup();
  const outside = gitStore.gitAllowedFor("dev1", "D:\\source\\reconcile-backend-v2");
  assert.equal(outside.ok, false);
  assert.match(!outside.ok ? outside.reason : "", /outside the device's start dirs/);
  const inside = gitStore.gitAllowedFor("dev1", "C:\\Users\\phuongnb\\dpi-work\\proj");
  assert.equal(inside.ok, true, "a path under a start dir may ask");
});
