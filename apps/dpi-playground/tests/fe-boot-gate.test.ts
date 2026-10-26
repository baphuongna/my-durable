// Round 4 FE fix #4: boot() must not fire the hub's guarded calls before the
// admin session exists. A fresh logged-out load used to collect 401s on all
// five (GET /api/network, EventSource /api/stream, three GET /api/ui-state/*).
// Now the network read goes first and alone as the auth probe: withAdminLogin
// (client/auth.ts) raises the login card on its 401 and retries the same call
// once after a successful login, so the stream and ui-state reads only ever
// fire on an accepted session.
// Level: integration (vite SSR, real store/auth module graph, stubbed fetch +
// EventSource, no hub). All modules come from the SAME vite server so the
// auth reactive state is the one boot() actually sees.
import test from "node:test";
import assert from "node:assert/strict";
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
const origSetInterval = globalThis.setInterval;
globalThis.setInterval = function (fn, ms, ...a) {
  const t = origSetInterval.call(this, fn, ms, ...a);
  t.unref?.();
  return t;
};
(globalThis as { location?: URL }).location = new URL("http://hub.test/") as never;

type Reply = { status: number; body?: string } | "throw";

/** Counting fetch stub; EventSource constructions are recorded into the same log. */
function stubTraffic(replies: Reply[]) {
  const calls: string[] = [];
  const record = (what: string) => calls.push(what);
  class FakeEventSource {
    constructor(url: string) {
      record(`ES ${url}`);
    }
    close() {}
    onmessage: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    readyState = 1;
  }
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  const native = (async (url: string | URL) => {
    const path = typeof url === "string" ? url : url.href;
    record(path);
    const reply = replies.shift() ?? { status: 200, body: "{}" };
    if (reply === "throw") throw new TypeError("network down");
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: async () => reply.body ?? "",
      json: async () => JSON.parse(reply.body ?? "{}"),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, record, native };
}

const FE_ROOT = new URL("../apps/dpi-playground-fe/", import.meta.url);
const makeVite = () =>
  createServer({
    configFile: new URL("vite.config.ts", FE_ROOT).pathname,
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: "custom",
    logLevel: "error",
  });

async function freshModules() {
  const vite = await makeVite();
  try {
    const auth = await vite.ssrLoadModule("/src/client/auth.ts");
    const store = await vite.ssrLoadModule("/src/client/store.ts");
    return { vite, auth, store };
  } catch (e) {
    await vite.close();
    throw e;
  }
}

const UNAUTHORIZED = {
  status: 401,
  body: '{"error":{"code":"unauthorized","message":"Missing or invalid admin token"}}',
};
const NULL_STATE = { status: 200, body: '{"value":null}' };

test("logged out, login dismissed: boot fires exactly one guarded request", async () => {
  const { calls, native } = stubTraffic([UNAUTHORIZED]);
  const { vite, auth, store } = await freshModules();
  const realFetch = globalThis.fetch;
  globalThis.fetch = auth.withAdminLogin(native);
  try {
    const pending = store.boot();
    await new Promise((done) => setImmediate(done));
    assert.equal(auth.auth.needed, true, "the login card is up while the probe waits");
    const pendingCalls = [...calls];
    assert.deepEqual(pendingCalls, ["/api/network"], "only the network probe has fired so far");

    auth.cancelLogin(); // the operator dismisses the card
    await pending;

    assert.deepEqual(calls, ["/api/network"], "no retry after dismissal, no stream, no ui-state");
    assert.equal(auth.auth.needed, false);
    assert.match(store.ui.error ?? "", /admin token/i, "the refusal surfaces in the app banner");
  } finally {
    globalThis.fetch = realFetch;
    await vite.close();
  }
});

test("logged in (valid cookie): boot loads everything in one pass", async () => {
  const { calls, native } = stubTraffic([
    { status: 200, body: '{"configFile":"/cfg/dpi-network.yaml","devices":[]}' },
    NULL_STATE,
    NULL_STATE,
    NULL_STATE,
    { status: 200, body: '{"version":"test-hub","node":"v24"}' },
  ]);
  const { vite, auth, store } = await freshModules();
  const realFetch = globalThis.fetch;
  globalThis.fetch = auth.withAdminLogin(native);
  try {
    await store.boot();
    // version() is fired without being awaited by boot; give it its tick.
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(
      calls,
      [
        "/api/network",
        "ES /api/stream",
        "/api/ui-state/tree.selected",
        "/api/ui-state/tree.width",
        "/api/ui-state/layout.panels",
        "/api/version",
      ],
      "stream + ui-state fire after the accepted network read, exactly as before",
    );
    assert.equal(store.ui.error, "");
    assert.equal(store.configFile.value, "/cfg/dpi-network.yaml", "network payload applied");
    assert.equal(store.hubVersion.value, "test-hub", "version badge loads");
  } finally {
    globalThis.fetch = realFetch;
    await vite.close();
  }
});

test("logged out then signed in: one 401, then the whole app loads", async () => {
  const { calls, native } = stubTraffic([
    UNAUTHORIZED, // the probe — the only guarded request pre-auth
    { status: 200, body: '{"ok":true,"exp":9999999999999}' }, // POST /api/session
    { status: 200, body: '{"devices":[]}' }, // the probe retried after login
    NULL_STATE,
    NULL_STATE,
    NULL_STATE,
    { status: 200, body: '{"version":"test-hub","node":"v24"}' },
  ]);
  const { vite, auth, store } = await freshModules();
  const realFetch = globalThis.fetch;
  globalThis.fetch = auth.withAdminLogin(native);
  try {
    const pending = store.boot();
    await new Promise((done) => setImmediate(done));
    assert.equal(auth.auth.needed, true, "login card up");
    assert.deepEqual(
      [...calls],
      ["/api/network"],
      "stream + ui-state still shut while the card waits",
    );

    assert.equal(await auth.login("adm_token"), true, "login succeeds through the same wrapper");
    await pending;

    assert.deepEqual(
      calls,
      [
        "/api/network",
        "/api/session",
        "/api/network",
        "ES /api/stream",
        "/api/ui-state/tree.selected",
        "/api/ui-state/tree.width",
        "/api/ui-state/layout.panels",
        "/api/version",
      ],
      "after login the boot continues: stream, then ui-state, then version — no further 401s",
    );
    assert.equal(auth.auth.needed, false);
    assert.equal(store.ui.error, "");
  } finally {
    globalThis.fetch = realFetch;
    await vite.close();
  }
});
