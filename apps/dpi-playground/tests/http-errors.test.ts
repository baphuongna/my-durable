/**
 * `safe()` wraps the hub's async route handlers. A handler that rejects on purpose says so with a
 * 4xx `status`; anything else is a fault of ours, and its text (SQLite messages, file paths) stays in
 * the log instead of reaching a client labelled as the client's mistake.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import { AuditUnavailableError } from "../apps/dpi-playground-hub/src/audit.js";
import { errorMiddleware, safe } from "../apps/dpi-playground-hub/src/http-errors.js";

async function serve(): Promise<{ base: string; server: Server }> {
  const app = express();
  app.get("/fault", safe(() => { throw new Error("SQLITE_BUSY: database is locked (/home/ops/.dpi/network.sqlite)"); }));
  app.get("/rejects", safe(async () => { throw new Error("EACCES: permission denied, open '/home/ops/.dpi/secret'"); }));
  app.get("/deliberate", safe(() => { throw Object.assign(new Error("No device box"), { status: 404 }); }));
  app.get("/invalid", safe(() => { throw Object.assign(new Error("subs must be a list of up to 20 keys"), { status: 400 }); }));
  app.get("/audit", safe(() => { throw new AuditUnavailableError("audit: 3 bytes free on the registry volume (floor 33554432)"); }));
  app.get("/fine", safe((_req, res) => res.json({ ok: true })));
  app.use(errorMiddleware);
  const server = createServer(app);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server };
}

const get = async (base: string, path: string) => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as { error?: { code: string; message: string }; ok?: boolean } };
};

test("safe: an unexpected fault is a generic 500 and none of its text reaches the client", async () => {
  const { base, server } = await serve();
  try {
    for (const path of ["/fault", "/rejects"]) {
      const r = await get(base, path);
      assert.equal(r.status, 500, path);
      assert.deepEqual(r.body, { error: { code: "internal", message: "Internal error" } }, path);
    }
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("safe: a failure the handler raised on purpose keeps its status and its short message", async () => {
  const { base, server } = await serve();
  try {
    assert.deepEqual(await get(base, "/deliberate"), { status: 404, body: { error: { code: "not_found", message: "No device box" } } });
    assert.deepEqual(await get(base, "/invalid"), { status: 400, body: { error: { code: "invalid", message: "subs must be a list of up to 20 keys" } } });
    assert.equal((await get(base, "/fine")).status, 200);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("safe: a refusal of the audit volume is a 503 with fixed text, never its free-space figures", async () => {
  const { base, server } = await serve();
  try {
    const r = await get(base, "/audit");
    assert.equal(r.status, 503);
    assert.equal(r.body.error?.code, "audit_unavailable");
    assert.doesNotMatch(JSON.stringify(r.body), /bytes free|33554432/);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
