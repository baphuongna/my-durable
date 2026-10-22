/**
 * FE admin auth: the fetch wrapper raises the login card on a 401, retries the
 * failed call once after a successful login, and never touches the login call
 * itself. Plus an SSR render of the LoginCard (visible only when auth is needed).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  auth,
  cancelLogin,
  login,
  withAdminLogin,
} from "../apps/dpi-playground-fe/src/client/auth.js";
void login;

type Reply = { status: number; body?: string } | "throw";

const install = (replies: Reply[]) => {
  const calls: string[] = [];
  const native = (async (url: string) => {
    calls.push(url);
    const reply = replies.shift() ?? { status: 200, body: "{}" };
    if (reply === "throw") throw new TypeError("network down");
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: async () => reply.body ?? "",
      json: async () => JSON.parse(reply.body ?? "{}"),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetch: withAdminLogin(native), calls, native };
};

// The wrapper reads location for the /api/session check; node has none.
(globalThis as { location?: URL }).location = new URL("http://hub.test/") as never;

test("401 on an admin call waits for login and retries the same call once", async () => {
  auth.needed = false;
  const { fetch, calls } = install([
    { status: 401, body: '{"error":{"code":"unauthorized"}}' },
    { status: 200, body: '{"devices":[]}' },
  ]);
  const pending = fetch("/api/network");
  await new Promise((done) => setImmediate(done));
  assert.equal(auth.needed, true, "the login card is up while the call waits");
  // login() posts /api/session through the SAME wrapped fetch; its 200 must not loop.
  const ok = await withLoginFetch(fetch, "adm_test-token");
  assert.equal(ok, true);
  const response = (await pending) as unknown as { status: number };
  assert.equal(response.status, 200, "the original call was retried after login");
  assert.deepEqual(calls, ["/api/network", "/api/session", "/api/network"]);
  assert.equal(auth.needed, false);
});

test("a denied login keeps the card up and eventually surfaces the original 401", async () => {
  auth.needed = false;
  const { fetch } = install([
    { status: 401, body: '{"error":{"code":"unauthorized"}}' },
    { status: 200, body: "{}" },
  ]);
  const pending = fetch("/api/network");
  await new Promise((done) => setImmediate(done));
  assert.equal(auth.error, "");
  const denied = install([{ status: 401, body: '{"error":{"code":"unauthorized"}}' }]);
  const ok = await withLoginFetch(denied.fetch, "wrong");
  assert.equal(ok, false);
  assert.equal(auth.error, "That token was not accepted.");
  assert.equal(auth.needed, true, "still gated");
  cancelLogin();
  const response = (await pending) as unknown as { status: number };
  assert.equal(response.status, 401, "cancel hands the caller its original 401");
  assert.equal(auth.needed, false);
});

test("the login call itself and non-401 answers pass straight through", async () => {
  auth.needed = false;
  const { fetch, calls } = install([
    { status: 401, body: '{"error":{"code":"unauthorized"}}' },
    { status: 500, body: '{"error":{"code":"internal"}}' },
  ]);
  const loginReply = (await fetch("/api/session", { method: "POST" })) as unknown as {
    status: number;
  };
  assert.equal(loginReply.status, 401, "a failed login is NOT intercepted");
  assert.equal(auth.needed, false, "no login card for the login call itself");
  const other = (await fetch("/api/network")) as unknown as { status: number };
  assert.equal(other.status, 500);
  assert.deepEqual(calls, ["/api/session", "/api/network"]);
});

test("login state resets between attempts; a 429 explains itself", async () => {
  auth.needed = false;
  auth.error = "";
  const { fetch } = install([{ status: 429, body: '{"error":{"code":"rate_limited"}}' }]);
  const ok = await withLoginFetch(fetch, "again");
  assert.equal(ok, false);
  assert.match(auth.error, /Too many attempts/);
});

test("SSR: the LoginCard renders the password gate only when a login is needed", async () => {
  const { createServer } = await import("vite");
  const { createSSRApp } = await import("vue");
  const { renderToString } = await import("vue/server-renderer");
  const FE_ROOT = new URL("../apps/dpi-playground-fe/", import.meta.url);
  const vite = await createServer({
    configFile: new URL("vite.config.ts", FE_ROOT).pathname,
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: "custom",
    logLevel: "error",
  });
  try {
    const mod = await vite.ssrLoadModule("/src/components/LoginCard.vue");
    const wasNeeded = auth.needed;
    auth.needed = true;
    const html = await renderToString(createSSRApp(mod.default));
    auth.needed = wasNeeded;
    assert.match(html, /data-testid="login-card"/);
    assert.match(html, /Admin token/);
    assert.match(html, /type="password"/);
    assert.match(html, /Sign in/);
  } finally {
    await vite.close();
  }
});

/** login() uses the module-level fetch; point it at a wrapped native for the test. */
async function withLoginFetch(wrapped: typeof fetch, token: string): Promise<boolean> {
  const real = globalThis.fetch;
  globalThis.fetch = wrapped;
  try {
    return await login(token);
  } finally {
    globalThis.fetch = real;
  }
}
