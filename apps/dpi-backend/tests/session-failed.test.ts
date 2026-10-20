// R-3 / P1-05 + P1-06: a Session that fails its own storage call is closed by pi-durable 1.3.0
// (Session.closed = {reason:"failed"}), with no next agent event needed. These tests drive the exact
// store/stream/error code paths that 1.3.0 triggers, in-process, against a real Store + Harness + HTTP app.
//
// Fault injection note: pi-durable's `SessionFailed` is raised inside the Harness when a Storage method
// throws; the Store observes it through `harness.closed`. Since Store does not take an injectable Storage
// (a fault-hook constructor is a P2-04 test-harness deliverable), these tests invoke the same
// `Store.failSession` the `harness.closed` handler calls, after asserting the wiring's observable contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { Store, lockFile } from "../src/store.js";
import { bearerAuth } from "../src/auth.js";
import { ApiFault, errorMiddleware } from "../src/errors.js";
import { onWatchEnd } from "../src/streams.js";
import { v1 } from "../src/routes.js";
import { BACKGROUND_CONTEXT as ctxOf } from "@earendil-works/chord/context";
import { ConversationBusy, SessionFailed } from "@earendil-works/pi-durable";
import { faux, newToken, tempStore } from "./helpers.js";

type FaultInjector = { failSession: (id: string, error: unknown) => void };
const inject = (store: Store) => store as unknown as FaultInjector;

async function inProcessBackend() {
  const t = await tempStore();
  const token = newToken();
  const store = await Store.open({
    dataDir: join(t.root, "data"),
    startDirs: [t.work],
    name: "session-failed-box",
    provider: "faux",
  });
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
    fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await store.close().catch(() => {});
    await t.cleanup();
  };
  return { t, store, token, base, api, close };
}

/** Incremental SSE reader: read frames as they arrive, and let a test act between frames. */
function sseReader(res: Response) {
  assert.equal(res.status, 200, "SSE opens with 200");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: { event: string; data: unknown }[] = [];
  let buffer = "";
  const pump = async (match: (frames: { event: string; data: unknown }[]) => boolean, timeout: number) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (match(frames)) return frames;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (event && data !== undefined) frames.push({ event, data: JSON.parse(data) });
      }
    }
    throw new Error(`SSE frames timed out; saw ${JSON.stringify(frames.map((f) => f.event))}`);
  };
  return {
    frames,
    until: (event: string, timeout = 10_000) => pump((f) => f.some((x) => x.event === event), timeout),
    untilAny: (events: string[], timeout = 10_000) => pump((f) => f.some((x) => events.includes(x.event)), timeout),
  };
}

// --------------------------------------------------------------- P1-05: error mapping

function callErrorMiddleware(err: unknown) {
  let status = 0;
  let body: { error?: { code?: string; message?: string } } | undefined;
  const res = {
    headersSent: false,
    status(s: number) {
      status = s;
      return this;
    },
    json(b: unknown) {
      body = b as typeof body;
      return this;
    },
    end() {},
  } as never;
  errorMiddleware(err, {} as never, res, (() => {}) as never);
  return { status, body };
}

test("P1-05: SessionFailed maps to unavailable 503, ConversationBusy stays busy 409", () => {
  const failed = callErrorMiddleware(new SessionFailed(new Error("disk I/O error")));
  assert.equal(failed.status, 503);
  assert.equal(failed.body?.error?.code, "unavailable");
  assert.doesNotMatch(String(failed.body?.error?.message), /disk I\/O error/, "cause must not be echoed verbatim");

  const busy = callErrorMiddleware(new ConversationBusy(1 as never));
  assert.equal(busy.status, 409);
  assert.equal(busy.body?.error?.code, "busy");
});

// --------------------------------------------------------------- P1-05: store marks the session unavailable

test("P1-05: a failed session is unavailable, releases its lock, and leaves other sessions working", async () => {
  const { t, store, api, close } = await inProcessBackend();
  try {
    const a = await (await api("/v1/sessions", { method: "POST", body: JSON.stringify({ name: "A", cwd: t.work, model: faux }) })).json();
    const b = await (await api("/v1/sessions", { method: "POST", body: JSON.stringify({ name: "B", cwd: t.work, model: faux }) })).json();
    const rowA = store.resolveSession(a.id);
    const rowB = store.resolveSession(b.id);
    assert.ok(store.harness(rowA), "A is open before the failure");
    assert.ok((await api("/v1/sessions/A/agents")).ok, "A answers over REST before the failure");

    // The exact call the `harness.closed` (reason "failed") handler makes.
    const cause = new Error("SQLITE_IOERR: disk I/O error while committing");
    inject(store).failSession(rowA.id, cause);

    // A is now unavailable with a 503-shaped fault, and its handle/lock were cleaned up.
    assert.throws(() => store.harness(rowA), (e: unknown) => e instanceof ApiFault && e.code === "unavailable" && e.status === 503);
    assert.equal(store.opened.has(rowA.id), false, "A was dropped from opened sessions");
    const relock = lockFile(`${rowA.dbPath}.lock`);
    relock();
    inject(store).failSession(rowA.id, cause); // idempotent: a second failure is a no-op

    // B is untouched: the daemon is up and a real agent turn still works.
    assert.ok(store.harness(rowB));
    assert.equal((await api("/v1/sessions/B/agents")).status, 200);
    const main = (await (await api("/v1/sessions/B/agents")).json()) as { id: number; name: string }[];
    const bMain = main.find((x) => x.name === "main") ?? main[0];
    const settled = await (
      await api(`/v1/sessions/B/agents/${bMain.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: "still alive", whenBusy: "followUp", requestId: "p1-05-b", waitMs: 15_000 }),
      })
    ).json();
    assert.equal(settled.status, "done", "B answers a turn after A failed");
    assert.equal((await api("/v1/sessions/A/agents")).status, 503, "A answers unavailable over REST");
  } finally {
    await close();
  }
});

test("P1-05: the failure message is bounded and never stringifies the cause object", async () => {
  const { store, close } = await inProcessBackend();
  try {
    const row = await store.create({ name: "C", cwd: store.options.startDirs[0], model: faux });
    // A huge message is truncated; a non-Error cause is never serialized (no secret leak).
    inject(store).failSession(row.id, new Error("x".repeat(10_000)));
    let message = "";
    try {
      store.harness(store.resolveSession(row.id));
    } catch (e) {
      message = (e as ApiFault).message;
    }
    assert.ok(message.length > 0 && message.length <= 260, `bounded message (got ${message.length})`);
    assert.doesNotMatch(message, /xxxxx/, "a failed session must not echo the raw cause text");

    const d = await store.create({ name: "D", cwd: store.options.startDirs[0], model: faux });
    inject(store).failSession(d.id, { token: "SECRET_TOKEN_VALUE", nested: { transcript: "leak" } });
    try {
      store.harness(store.resolveSession(d.id));
      assert.fail("D should be unavailable");
    } catch (e) {
      assert.doesNotMatch((e as ApiFault).message, /SECRET_TOKEN_VALUE|transcript/, "object causes are not stringified");
    }
  } finally {
    await close();
  }
});

// --------------------------------------------------------------- P1-06: idle SSE learns at once

// The decision function the watch-closed wiring calls, exercised on every branch. In production the trigger is
// pi-durable closing the Session with reason "failed" after a Storage call throws (see P2-04 for an injectable
// fault hook that drives the whole path end to end).
test("P1-06: onWatchEnd faults an open viewer on session_failed, and only then", () => {
  const make = (closed = false) => {
    const sent: unknown[] = [];
    let ended = 0;
    return {
      sent,
      get ended() {
        return ended;
      },
      sse: { send: (f: unknown) => sent.push(f), closed, onClose: () => {}, sendIfChanged: () => {}, end: () => void ended++ } as never,
    };
  };

  const failed = make();
  onWatchEnd(failed.sse, { reason: "session_failed", error: new Error("disk I/O error") });
  assert.equal(failed.sent.length, 1, "one fault frame");
  assert.equal((failed.sent[0] as { type: string; error: { code: string } }).type, "fault");
  assert.equal((failed.sent[0] as { error: { code: string } }).error.code, "unavailable");
  assert.equal(failed.ended, 1, "response ended after the fault");

  // Every other end reason, and an already-closed viewer, must write nothing.
  for (const end of [{ reason: "stopped" } as const, { reason: "cancelled" } as const, { reason: "session_closed" } as const, { reason: "retired" } as const, { reason: "listener_error", error: new Error("x") } as const]) {
    const quiet = make();
    onWatchEnd(quiet.sse, end);
    assert.deepEqual(quiet.sent, [], `no write for ${end.reason}`);
    assert.equal(quiet.ended, 0, `no end for ${end.reason}`);
  }
  const gone = make(true);
  onWatchEnd(gone.sse, { reason: "session_failed", error: new Error("x") });
  assert.deepEqual(gone.sent, [], "never writes to an ended response");
  assert.equal(gone.ended, 0, "an already-ended response is left alone");
});

test("P1-06: a normally closed session ends its SSE stream without a fault frame or unhandled rejection", async () => {
  const { t, store, api, close } = await inProcessBackend();
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const a = await (await api("/v1/sessions", { method: "POST", body: JSON.stringify({ name: "E", cwd: t.work, model: faux }) })).json();
    const row = store.resolveSession(a.id);
    const controller = new AbortController();
    const res = await api(`/v1/sessions/E/agents/main/events`, { signal: controller.signal });
    const sse = sseReader(res);
    await sse.until("snapshot", 8_000);
    // A normal close must NOT produce a fault, and the wiring must not reject.
    await store.harness(row).close(ctxOf);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!sse.frames.some((f) => f.event === "fault"), "no fault frame for a normal close");
    controller.abort();
    process.off("unhandledRejection", onUnhandled);
    assert.deepEqual(unhandled, [], "no unhandled rejection");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await close();
  }
});

test("P1-06: a viewer that closed first is left alone — no write to an ended response, no unhandled rejection", async () => {
  const { t, store, api, close } = await inProcessBackend();
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const a = await (await api("/v1/sessions", { method: "POST", body: JSON.stringify({ name: "G", cwd: t.work, model: faux }) })).json();
    const row = store.resolveSession(a.id);
    const controller = new AbortController();
    const res = await api(`/v1/sessions/G/agents/main/events`, { signal: controller.signal });
    const sse = sseReader(res);
    await sse.until("snapshot", 8_000);
    controller.abort(); // the viewer goes away before the failure
    await new Promise((r) => setTimeout(r, 100));
    inject(store).failSession(row.id, new Error("storage read failed"));
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(unhandled, [], "no unhandled rejection from the closed viewer path");
    // The rest of the device still works.
    assert.equal((await api("/v1/device")).status, 200);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await close();
  }
});
