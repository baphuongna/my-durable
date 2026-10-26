/**
 * Edge-case audit of the REST surface (B1–B6): every repro the sandbox audit
 * found — NaN limits bricking a session, uncontained /fs/dirs and /git paths,
 * registry validation answering 500, allowPrivateHosts ignored in the body,
 * and agent creation without a name — now answers a clean 4xx and leaves the
 * device usable.
 *
 * Same in-process pattern as session-failed.test.ts: a real Store (faux
 * provider, temp start dirs) behind the real router + error middleware.
 */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { bearerAuth } from "../src/auth.js";
import { errorMiddleware } from "../src/errors.js";
import { v1 } from "../src/routes.js";
import { faux, newToken, tempStore } from "./helpers.js";

async function backend(opts: { extraStartDirs?: string[] } = {}) {
  const t = await tempStore();
  // Extra start dirs (created by Store.open itself) keep the FIRST one as the
  // default git path while giving tests contained folders with other shapes.
  const startDirs = opts.extraStartDirs?.length
    ? [t.work, ...opts.extraStartDirs.map((d) => join(t.root, d))]
    : t.options.startDirs;
  const token = newToken();
  const store = await Store.open({ ...t.options, startDirs, name: "rest-edge-box" });
  const app = express();
  app.disable("x-powered-by");
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.use("/v1", bearerAuth(token), express.json({ limit: "256kb" }), v1(store));
  app.use((_req, res) => res.status(404).json({ error: { code: "not_found", message: "Route not found" } }));
  app.use(errorMiddleware);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await store.close().catch(() => {});
    await t.cleanup();
  };
  return { t, store, api, close };
}

const errorOf = async (res: Response) => {
  assert.equal(res.headers.get("content-type") ?? "", "application/json; charset=utf-8", "errors are JSON");
  return (await res.json()).error as { code: string; message: string };
};

test("B1: a non-integer limit/waitMs answers 400 invalid and never bricks the session", async () => {
  const b = await backend();
  try {
    const session = await b.store.create({ name: "Edge", cwd: "project", model: faux });
    const agent = session.agents[0]!.id;

    // The audit's repro: ?limit=abc used to 500 AND mark the session failed.
    for (const path of [
      `/v1/sessions/${session.id}/agents/${agent}/entries?limit=abc`,
      `/v1/sessions/${session.id}/agents/${agent}/entries?limit=1.5`,
      `/v1/sessions/${session.id}/agents/${agent}/entries?limit=0`,
      `/v1/sessions/${session.id}/tasks?status=terminal&limit=abc`,
      `/v1/sessions/${session.id}/submissions/1?waitMs=soon`,
    ]) {
      const res = await b.api(path);
      assert.equal(res.status, 400, `${path} answers 400`);
      const error = await errorOf(res);
      assert.equal(error.code, "invalid", `${path} code`);
      assert.match(error.message, /must be an integer/, `${path} message`);
    }
    // A body waitMs that is not a number is refused too, not silently queued.
    const msg = await b.api(`/v1/sessions/${session.id}/agents/${agent}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "hi", requestId: "rest-edge-1", waitMs: "soon" }),
    });
    assert.equal(msg.status, 400);
    assert.match((await errorOf(msg)).message, /must be an integer/);

    // The regression the audit cared about: the session is STILL USABLE.
    const agents = await b.api(`/v1/sessions/${session.id}/agents`);
    assert.equal(agents.status, 200, "the agents list still answers 200 after the bad limits");
    assert.equal(Array.isArray((await agents.json())), true);
    const entries = await b.api(`/v1/sessions/${session.id}/agents/${agent}/entries?limit=9999999`);
    assert.equal(entries.status, 200, "an above-cap limit clamps instead of failing");
    assert.equal(Array.isArray(((await entries.json()) as { items: unknown[] }).items), true, "the clamped page still reads");
  } finally {
    await b.close();
  }
});

test("B2: /fs/dirs only lists the start dirs and what lives under them", async () => {
  const b = await backend();
  try {
    // No path: the roots themselves — the TUI dir picker starts here.
    const roots = await b.api("/v1/fs/dirs");
    assert.equal(roots.status, 200);
    const rootListing = (await roots.json()) as { dirs: { name: string; path: string }[] };
    assert.deepEqual(rootListing.dirs.map((d) => d.path), [b.t.work]);

    // A start dir root is listable, and its parent navigation clamps there.
    const root = await b.api(`/v1/fs/dirs?path=${encodeURIComponent(b.t.work)}`);
    assert.equal(root.status, 200);
    const atRoot = (await root.json()) as { path: string; parent?: string; dirs: { name: string }[] };
    assert.equal(atRoot.path, b.t.work);
    assert.deepEqual(atRoot.dirs.map((d) => d.name), ["project"]);
    assert.equal(atRoot.parent, undefined, "a start dir root offers no parent outside itself");

    // Inside: parent points back at the root.
    const nested = await b.api(`/v1/fs/dirs?path=${encodeURIComponent(join(b.t.work, "project", "nested"))}`);
    assert.equal(nested.status, 200);
    assert.equal(((await nested.json()) as { parent?: string }).parent, join(b.t.work, "project"));

    // Outside — the audit's repros — all answer 400 invalid.
    for (const path of ["/etc", "~", join(b.t.work, "..", ".."), b.t.root]) {
      const res = await b.api(`/v1/fs/dirs?path=${encodeURIComponent(path)}`);
      assert.equal(res.status, 400, `path ${path} must be refused`);
      const error = await errorOf(res);
      assert.equal(error.code, "invalid");
      assert.match(error.message, /must live under a start dir/);
    }

    // A missing folder stays a 404, not a containment error.
    const missing = await b.api(`/v1/fs/dirs?path=${encodeURIComponent(join(b.t.work, "missing"))}`);
    assert.equal(missing.status, 404);
    assert.equal((await errorOf(missing)).code, "not_found");
  } finally {
    await b.close();
  }
});

test("B3: git routes are contained, default to the first start dir, and fail cleanly", async () => {
  // Two start dirs: the first becomes a repo (the omitted-path default), the
  // second stays plain (the contained non-repo case) — a subfolder of a repo
  // would still be inside it.
  const b = await backend({ extraStartDirs: ["plain"] });
  try {
    // Make the FIRST start dir a real repo, so the omitted-path default is observable.
    const sh = (args: string[]) => execFileSync("git", args, { cwd: b.t.work });
    sh(["init", "-b", "main"]);
    sh(["config", "user.email", "t@t"]);
    sh(["config", "user.name", "t"]);
    execFileSync("git", ["commit", "--allow-empty", "-m", "base"], { cwd: b.t.work });

    // Omitted path → the first start dir, never the daemon's own cwd.
    const status = await b.api("/v1/git/status");
    assert.equal(status.status, 200);
    const s = (await status.json()) as { repo: boolean; root?: string; branch?: string };
    assert.equal(s.repo, true);
    assert.equal(s.root, b.t.work, "no path means the first start dir");

    // POST /v1/git with no path: same default, and the op actually runs there.
    const log = await b.api("/v1/git", { method: "POST", body: JSON.stringify({ op: "log" }) });
    assert.equal(log.status, 200);
    assert.match(((await log.json()) as { text: string }).text, /base/, "the default path is the repo");

    // Outside paths are refused on every git route — read AND write ops.
    for (const init of [
      { method: "GET" as const, path: "/v1/git/status?path=%2Fetc" },
      { method: "POST" as const, path: "/v1/git", body: JSON.stringify({ op: "log", path: "/etc" }) },
      { method: "POST" as const, path: "/v1/git/status-batch", body: JSON.stringify({ paths: [b.t.work, "/etc"] }) },
      { method: "POST" as const, path: "/v1/git", body: JSON.stringify({ op: "push", path: "~" }) },
    ]) {
      const res = await b.api(init.path, { method: init.method, body: (init as { body?: string }).body });
      assert.equal(res.status, 400, `${init.method} ${init.path} must be refused`);
      const error = await errorOf(res);
      assert.equal(error.code, "invalid");
      assert.match(error.message, /must live under a start dir/);
    }

    // A contained non-repo answers a clean 400 — never git's usage text, never a 500.
    const plain = join(b.t.root, "plain");
    const op = await b.api("/v1/git", { method: "POST", body: JSON.stringify({ op: "log", path: plain }) });
    assert.equal(op.status, 400);
    const fault = await errorOf(op);
    assert.equal(fault.code, "invalid");
    assert.match(fault.message, /^not a git repository: /);
    assert.doesNotMatch(fault.message, /usage:/);

    // Status on a non-repo keeps its designed answer: repo:false, 200.
    const plainStatus = await b.api(`/v1/git/status?path=${encodeURIComponent(plain)}`);
    assert.equal(plainStatus.status, 200);
    assert.equal(((await plainStatus.json()) as { repo: boolean }).repo, false);
  } finally {
    await b.close();
  }
});

test("B4: registry validation answers 400 and unknown ids answer 404, not 500", async () => {
  const b = await backend();
  try {
    // Schedules: create with no body → 400; patch an unknown id → 404.
    const noSchedule = await b.api("/v1/schedules", { method: "POST", body: JSON.stringify({}) });
    assert.equal(noSchedule.status, 400);
    assert.equal((await errorOf(noSchedule)).code, "invalid");

    const schedule = await b.api("/v1/schedules", {
      method: "POST",
      body: JSON.stringify({ name: "Tidy", cwd: "project", model: { provider: "faux", modelId: "echo" }, prompt: "tidy up", everyMinutes: 60 }),
    });
    assert.equal(schedule.status, 201);
    const id = ((await schedule.json()) as { id: string }).id;
    const unknown = await b.api(`/v1/schedules/${id}x`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    assert.equal(unknown.status, 404);
    const unknownError = await errorOf(unknown);
    assert.equal(unknownError.code, "not_found");
    assert.match(unknownError.message, new RegExp(`no schedule ${id}x`));
    // DELETE keeps its idempotent shape.
    const gone = await b.api(`/v1/schedules/${id}x`, { method: "DELETE" });
    assert.equal(gone.status, 200);
    assert.deepEqual(await gone.json(), { removed: false });

    // Graphs: create with no body → 400; patch unknown → 404.
    const noGraph = await b.api("/v1/graphs", { method: "POST", body: JSON.stringify({}) });
    assert.equal(noGraph.status, 400);
    assert.equal((await errorOf(noGraph)).code, "invalid");
    const unknownGraph = await b.api("/v1/graphs/g_missing", { method: "PATCH", body: JSON.stringify({ name: "x" }) });
    assert.equal(unknownGraph.status, 404);
    assert.equal((await errorOf(unknownGraph)).code, "not_found");

    // Projects: patch an unknown id → 404.
    const unknownProject = await b.api("/v1/projects/prj_missing", { method: "PATCH", body: JSON.stringify({ labels: ["a"] }) });
    assert.equal(unknownProject.status, 404);
    assert.equal((await errorOf(unknownProject)).code, "not_found");

    // Device env: a managed key and an over-long value are 400s, not 500s.
    const managed = await b.api("/v1/device/env", { method: "POST", body: JSON.stringify({ key: "DPI_PORT", value: "9" }) });
    assert.equal(managed.status, 400);
    assert.match((await errorOf(managed)).message, /own setting/);
    const long = await b.api("/v1/device/env", { method: "POST", body: JSON.stringify({ key: "SOME_KEY", value: "x".repeat(2001) }) });
    assert.equal(long.status, 400);
    assert.equal((await errorOf(long)).code, "invalid");

    // pi-auth: a 10k key is a 400 with the bound in the message, not a 500.
    const key = await b.api("/v1/device/pi-auth/openrouter", { method: "PUT", body: JSON.stringify({ key: "k".repeat(10_000) }) });
    assert.equal(key.status, 400);
    const keyError = await errorOf(key);
    assert.equal(keyError.code, "invalid");
    assert.match(keyError.message, /1–4096/);
  } finally {
    await b.close();
  }
});

test("B5: allowPrivateHosts in the body reaches the sink registry per request", async () => {
  const b = await backend();
  const hadEnv = process.env.DPI_NOTIFY_ALLOW_PRIVATE;
  delete process.env.DPI_NOTIFY_ALLOW_PRIVATE;
  try {
    // A LAN host without the flag: refused, and the error names the flag.
    const refused = await b.api("/v1/notify/sinks", {
      method: "POST",
      body: JSON.stringify({ kind: "webhook", url: "http://192.168.1.10/hook" }),
    });
    assert.equal(refused.status, 400);
    const refusal = await errorOf(refused);
    assert.equal(refusal.code, "invalid");
    assert.match(refusal.message, /allowPrivateHosts/);

    // The same sink with the flag in the body: created (the audit found the flag ignored).
    const created = await b.api("/v1/notify/sinks", {
      method: "POST",
      body: JSON.stringify({ kind: "webhook", url: "http://192.168.1.10/hook", allowPrivateHosts: true }),
    });
    assert.equal(created.status, 201);
    const sink = (await created.json()) as { id: string; url: string };

    // The flag works on PATCH too, and its absence is enforced there.
    const patched = await b.api(`/v1/notify/sinks/${sink.id}`, {
      method: "PATCH",
      body: JSON.stringify({ url: "http://10.0.0.5/hook", allowPrivateHosts: true }),
    });
    assert.equal(patched.status, 200);
    assert.equal(((await patched.json()) as { url: string }).url, "http://10.0.0.5/hook");
    const relocked = await b.api(`/v1/notify/sinks/${sink.id}`, {
      method: "PATCH",
      body: JSON.stringify({ url: "http://10.0.0.6/hook" }),
    });
    assert.equal(relocked.status, 400, "a patch to another private host needs the flag again");

    // Wrong-typed flag is a 400, never silently coerced.
    const typed = await b.api("/v1/notify/sinks", {
      method: "POST",
      body: JSON.stringify({ kind: "webhook", url: "https://example.com/hook", allowPrivateHosts: "yes" }),
    });
    assert.equal(typed.status, 400);
    assert.match((await errorOf(typed)).message, /allowPrivateHosts must be a boolean/);

    const removed = await b.api(`/v1/notify/sinks/${sink.id}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { removed: true });
  } finally {
    if (hadEnv === undefined) delete process.env.DPI_NOTIFY_ALLOW_PRIVATE;
    else process.env.DPI_NOTIFY_ALLOW_PRIVATE = hadEnv;
    await b.close();
  }
});

test("B6: creating an agent requires a JSON body with a name", async () => {
  const b = await backend();
  try {
    const session = await b.store.create({ name: "Named", cwd: "project", model: faux });
    for (const [label, init] of [
      ["no body", { method: "POST" } as RequestInit],
      ["empty object", { method: "POST", body: JSON.stringify({}) }],
      ["wrong-typed name", { method: "POST", body: JSON.stringify({ name: 7 }) }],
      ["blank name", { method: "POST", body: JSON.stringify({ name: "   " }) }],
    ] as const) {
      const res = await b.api(`/v1/sessions/${session.id}/agents`, { ...init });
      assert.equal(res.status, 400, `${label} must be refused`);
      const error = await errorOf(res);
      assert.equal(error.code, "invalid");
      assert.match(error.message, /name is required/);
    }
    const created = await b.api(`/v1/sessions/${session.id}/agents`, {
      method: "POST",
      body: JSON.stringify({ name: "Helper" }),
    });
    assert.equal(created.status, 201);
    assert.equal(((await created.json()) as { name: string }).name, "Helper");
    assert.equal((await b.api(`/v1/sessions/${session.id}/agents`)).status, 200);
  } finally {
    await b.close();
  }
});
