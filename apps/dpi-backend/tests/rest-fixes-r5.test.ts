/**
 * Round-5 small-lane fixes: the session-name cap unified between create and
 * rename (the old create silently sliced to 100 where rename threw at 80),
 * the reserved "search" name (GET /v1/sessions/search is a literal route, and
 * resolveSession matches names case-insensitively — any casing of it is
 * unreachable via the name a client types), typed pi-auth errors (corrupt
 * auth.json / oauth conflicts were plain Errors → 500 with a stack), and
 * pi-durable's StorageRequestError mapped by class instead of by message
 * prefix (only "Invalid…" wordings used to score 400; anything else leaked a
 * 500 with raw internal text).
 *
 * Same in-process pattern as rest-fixes-r4.test.ts: a real Store (faux
 * provider, temp start dirs) behind the real router + error middleware.
 */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageRequestError } from "@earendil-works/pi-durable";
import { Store } from "../src/store.js";
import { bearerAuth } from "../src/auth.js";
import { errorMiddleware } from "../src/errors.js";
import { v1 } from "../src/routes.js";
import { faux, newToken, tempStore } from "./helpers.js";

async function backend() {
  const t = await tempStore();
  const token = newToken();
  const store = await Store.open(t.options);
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

const errorOf = async (res: Response | globalThis.Response) => {
  assert.equal(res.headers.get("content-type") ?? "", "application/json; charset=utf-8", "errors are JSON");
  return ((await res.json()) as { error: { code: string; message: string } }).error;
};

const createSession = (b: Awaited<ReturnType<typeof backend>>, name: string) =>
  b.api("/v1/sessions", { method: "POST", body: JSON.stringify({ name, cwd: b.t.work, model: faux }) });

// ------------------------------------------------------------------ name cap

test("session create and rename share one name cap: 81 is invalid, 80 is fine", async () => {
  const b = await backend();
  try {
    const tooLong = await createSession(b, "x".repeat(81));
    assert.equal(tooLong.status, 400, "create must no longer slice silently");
    const error = await errorOf(tooLong);
    assert.equal(error.code, "invalid");
    assert.match(error.message, /name is 81 characters; the limit is 80/);

    const atCap = await createSession(b, "y".repeat(80));
    assert.equal(atCap.status, 201);
    assert.equal(((await atCap.json()) as { name: string }).name, "y".repeat(80));

    // An empty name keeps its long-standing fallback (not a regression of this fix).
    const untitled = await createSession(b, "   ");
    assert.equal(untitled.status, 201);
    assert.equal(((await untitled.json()) as { name: string }).name, "Untitled session");

    // The store-level choke point (schedule runs and graph runs go through it too).
    await assert.rejects(() => b.store.create({ name: "z".repeat(81), cwd: b.t.work, model: faux }), /the limit is 80/);
  } finally {
    await b.close();
  }
});

// ------------------------------------------------------------- reserved name

test("the name 'search' is reserved in any casing, on create and rename", async () => {
  const b = await backend();
  try {
    for (const name of ["search", "Search", "SEARCH"]) {
      const created = await createSession(b, name);
      assert.equal(created.status, 400, `create(${name}) must be refused`);
      const error = await errorOf(created);
      assert.equal(error.code, "invalid");
      assert.match(error.message, /reserved/);
    }
    // The store-level choke point agrees.
    await assert.rejects(() => b.store.create({ name: "SeArCh", cwd: b.t.work, model: faux }), /reserved/);

    // Renaming an existing session into it is refused too.
    const created = await createSession(b, "Renamable");
    assert.equal(created.status, 201);
    const { id } = (await created.json()) as { id: string };
    for (const name of ["search", "Search"]) {
      const renamed = await b.api(`/v1/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      assert.equal(renamed.status, 400, `rename(${name}) must be refused`);
      assert.match((await errorOf(renamed)).message, /reserved/);
    }
    const after = await b.api(`/v1/sessions/${id}`);
    assert.equal(((await after.json()) as { name: string }).name, "Renamable", "the refusal changed nothing");

    // And the literal search route still answers with SEARCH RESULTS, not a session.
    const search = await b.api("/v1/sessions/search?q=Renamable");
    assert.equal(search.status, 200);
    const results = (await search.json()) as { matches: unknown[] };
    assert.ok(Array.isArray(results.matches), "the search route is untouched");
  } finally {
    await b.close();
  }
});

// -------------------------------------------------------- pi-auth typed errors

test("pi-auth answers 4xx for a corrupt auth.json and an oauth conflict — never a 500 with a stack", async () => {
  const b = await backend();
  const piDir = mkdtempSync(join(tmpdir(), "r5-pi-"));
  const previous = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = piDir;
  try {
    // Corrupt JSON: the strict read (write path) refuses, typed.
    writeFileSync(join(piDir, "auth.json"), "{ not json", { mode: 0o600 });
    const corrupt = await b.api("/v1/device/pi-auth/zai", { method: "PUT", body: JSON.stringify({ key: "sk-1234567890" }) });
    assert.equal(corrupt.status, 400, "corrupt auth.json is caller-visible refusal, not a 500");
    const corruptError = await errorOf(corrupt);
    assert.equal(corruptError.code, "invalid");
    assert.match(corruptError.message, /auth\.json is not valid JSON/);
    assert.ok(!JSON.stringify(corruptError).includes("stack"), "no stack in the response");
    const corruptDelete = await b.api("/v1/device/pi-auth/zai", { method: "DELETE" });
    assert.equal(corruptDelete.status, 400);
    assert.match((await errorOf(corruptDelete)).message, /not valid JSON/);

    // Wrong shape (valid JSON, not an object) is the same refusal family.
    writeFileSync(join(piDir, "auth.json"), "[1,2,3]", { mode: 0o600 });
    const shape = await b.api("/v1/device/pi-auth/zai", { method: "PUT", body: JSON.stringify({ key: "sk-1234567890" }) });
    assert.equal(shape.status, 400);
    assert.match((await errorOf(shape)).message, /unexpected shape/);

    // Conflicting oauth entry (pi's interactive login): typed refusal on write AND delete.
    writeFileSync(join(piDir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: "x", refresh: "y" } }), {
      mode: 0o600,
    });
    for (const method of ["PUT", "DELETE"] as const) {
      const conflict = await b.api("/v1/device/pi-auth/anthropic", {
        method,
        ...(method === "PUT" ? { body: JSON.stringify({ key: "sk-1234567890" }) } : {}),
      });
      assert.equal(conflict.status, 400, `${method} over an oauth entry must be a 400`);
      const conflictError = await errorOf(conflict);
      assert.equal(conflictError.code, "invalid");
      assert.match(conflictError.message, /interactive pi login/);
    }
    // And the file is untouched.
    assert.match(readFileSync(join(piDir, "auth.json"), "utf8"), /oauth/);

    // Happy paths unchanged: an api_key entry still writes (masked in the view) and removes.
    const ok = await b.api("/v1/device/pi-auth/zai", { method: "PUT", body: JSON.stringify({ key: "sk-tail-1234" }) });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { masked: string }).masked, "••••••••1234");
    const view = await b.api("/v1/device/pi-auth");
    assert.ok(JSON.stringify(await view.json()).includes("••••••••1234"));
    const removed = await b.api("/v1/device/pi-auth/zai", { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.equal(((await removed.json()) as { removed: boolean }).removed, true);
  } finally {
    if (previous === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previous;
    rmSync(piDir, { recursive: true, force: true });
    await b.close();
  }
});

// --------------------------------------------- StorageRequestError by class

/** Drive errorMiddleware directly: the mapping is the unit under test. */
const runMiddleware = (err: unknown) => {
  const captured = { statusCode: 0, body: undefined as { error?: { code: string; message: string } } | undefined };
  const res = {
    headersSent: false,
    status(code: number) {
      captured.statusCode = code;
      return res;
    },
    json(body: { error?: { code: string; message: string } }) {
      captured.body = body;
      return res;
    },
    end() {},
  };
  (errorMiddleware as unknown as RequestHandler)(err, {} as Request, res as unknown as Response, (() => {}) as NextFunction);
  return captured;
};

test("StorageRequestError maps by class to 400 invalid, whatever its message", () => {
  // The audit's repro shape: a well-formed-but-foreign cursor surfaces as
  // StorageRequestError with a message that starts with NEITHER "Invalid" nor
  // any other app-state prefix. The old mapping keyed on the prefix, so this
  // was a 500 echoing internal text.
  const foreign = runMiddleware(new StorageRequestError("ReadAfterWrite region mismatch"));
  assert.equal(foreign.statusCode, 400);
  assert.equal(foreign.body?.error?.code, "invalid");
  assert.equal(foreign.body?.error?.message, "ReadAfterWrite region mismatch");

  // A prefix-shaped message must NOT change behaviour class: still 400, still
  // the message (now via the instanceof branch, not the regex).
  const invalidShaped = runMiddleware(new StorageRequestError("Invalid storage cursor"));
  assert.equal(invalidShaped.statusCode, 400);
  assert.equal(invalidShaped.body?.error?.code, "invalid");

  // The prefix regex stays load-bearing for app-state's plain Errors.
  const appState = runMiddleware(new Error("Invalid array index"));
  assert.equal(appState.statusCode, 400);
  assert.equal(appState.body?.error?.code, "invalid");

  // And anything genuinely unknown still answers 500 internal.
  const internal = runMiddleware(new Error("kaboom"));
  assert.equal(internal.statusCode, 500);
  assert.equal(internal.body?.error?.code, "internal");
});
