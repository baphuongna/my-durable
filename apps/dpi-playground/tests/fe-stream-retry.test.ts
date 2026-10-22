// HubStream resilience: a rejected subscription PUT (429 from the per-IP admin limiter, 5xx) must
// be retried with a capped backoff, and a reconnect timer must never outlive stop().
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as streamModule from "../apps/dpi-playground-fe/src/client/stream.js";

const { HubStream } = streamModule;

class Source {
  static CLOSED = 2;
  static all: Source[] = [];
  static latest: Source;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  readyState = 1;
  constructor(_url: string) {
    Source.latest = this;
    Source.all.push(this);
  }
  close() { this.readyState = Source.CLOSED; }
  emit(sub: string, frame: unknown) { this.onmessage?.({ data: JSON.stringify({ sub, frame }) }); }
  hello(streamId: string) { this.emit("hello", { type: "stream", streamId }); }
  die() { this.readyState = Source.CLOSED; this.onerror?.(); }
}

type Reply = { status: number; retryAfter?: string } | "throw";
interface Call { url: string; subs: string[] }

function setup(t: TestContext, replies: Reply[]) {
  const originalSource = globalThis.EventSource;
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  Source.all = [];
  globalThis.EventSource = Source as never;
  console.warn = () => {};
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    calls.push({ url, subs: JSON.parse(init.body).subs });
    const reply = replies.shift() ?? { status: 200 };
    if (reply === "throw") throw new TypeError("network down");
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? (reply.retryAfter ?? null) : null) },
      text: async () => "rejected",
    };
  }) as never;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stream = new HubStream();
  t.after(() => {
    stream.stop();
    globalThis.EventSource = originalSource;
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  });
  const settle = () => new Promise((done) => setImmediate(done));
  const tick = async (ms: number) => { t.mock.timers.tick(ms); await settle(); await settle(); };
  return { stream, calls, tick, settle };
}

test("FE-S1: backoff is 1 s doubling to a 30 s cap; Retry-After seconds are honoured within the cap", () => {
  const { retryDelay } = streamModule as unknown as { retryDelay(failures: number, retryAfter?: string | null): number };
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 20].map((n) => retryDelay(n)), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(retryDelay(0, "5"), 5000);
  assert.equal(retryDelay(3, "5"), 5000);
  assert.equal(retryDelay(0, "600"), 30000);
  assert.equal(retryDelay(0, "0"), 1000, "a zero Retry-After must not become a busy loop");
  for (const junk of ["", "soon", "-3", "1.5", "Wed, 21 Oct 2026 07:28:00 GMT", null, undefined])
    assert.equal(retryDelay(1, junk), 2000, String(junk));
});

test("FE-S2: reconnect delay is 2 s doubling to a 30 s cap", () => {
  const { reconnectDelay } = streamModule as unknown as { reconnectDelay(attempt: number): number };
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((n) => reconnectDelay(n)), [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test("FE-S3: a 429 on the subscription PUT is retried until it is applied", async (t) => {
  const { stream, calls, tick } = setup(t, [{ status: 429 }, { status: 429 }, { status: 200 }]);
  stream.set("agent", "k");
  stream.start();
  Source.latest.hello("s1");
  await tick(1);
  assert.equal(calls.length, 1);
  await tick(1000);
  assert.equal(calls.length, 2, "first retry after 1 s");
  await tick(1999);
  assert.equal(calls.length, 2, "second retry waits for the doubled delay");
  await tick(1);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.subs), [["k"], ["k"], ["k"]]);
  await tick(60_000);
  assert.equal(calls.length, 3, "applied: nothing more is sent");
});

test("FE-S4: a 5xx honours Retry-After", async (t) => {
  const { stream, calls, tick } = setup(t, [{ status: 503, retryAfter: "7" }, { status: 200 }]);
  stream.set("agent", "k");
  stream.start();
  Source.latest.hello("s1");
  await tick(1);
  await tick(6999);
  assert.equal(calls.length, 1);
  await tick(1);
  assert.equal(calls.length, 2);
});

test("FE-S5: stop() cancels a pending subscription retry", async (t) => {
  const { stream, calls, tick } = setup(t, [{ status: 429 }, { status: 200 }]);
  stream.set("agent", "k");
  stream.start();
  Source.latest.hello("s1");
  await tick(1);
  stream.stop();
  await tick(120_000);
  assert.equal(calls.length, 1);
});

test("FE-S6: a failure that lands after stop() does not schedule a retry", async (t) => {
  const { stream, tick, settle } = setup(t, []);
  let release!: () => void;
  const gate = new Promise<void>((done) => (release = done));
  let sent = 0;
  globalThis.fetch = (async () => {
    sent++;
    await gate;
    return { ok: false, status: 500, headers: { get: () => null }, text: async () => "" };
  }) as never;
  stream.set("agent", "k");
  stream.start();
  Source.latest.hello("s1");
  await tick(1);
  assert.equal(sent, 1);
  stream.stop();
  release();
  await settle();
  await tick(120_000);
  assert.equal(sent, 1);
});

test("FE-S7: a retry for a superseded stream is dropped and the new hello subscribes afresh", async (t) => {
  const { stream, calls, tick } = setup(t, [{ status: 429 }, { status: 200 }]);
  stream.set("agent", "k");
  stream.start();
  Source.latest.hello("old");
  await tick(1);
  assert.equal(calls[0].url, "/api/stream/old");
  Source.latest.hello("new");
  await tick(1);
  assert.equal(calls[1].url, "/api/stream/new");
  await tick(60_000);
  assert.deepEqual(calls.map((c) => c.url), ["/api/stream/old", "/api/stream/new"]);
});

test("FE-S8: a thrown fetch backs off instead of retrying every second", async (t) => {
  const { stream, calls, tick } = setup(t, ["throw", "throw", "throw", { status: 200 }]);
  stream.set("agent", "k");
  stream.start();
  Source.latest.hello("s1");
  await tick(1);
  await tick(1000);
  await tick(1000);
  assert.equal(calls.length, 2, "second retry is 2 s after the first");
  await tick(1000);
  assert.equal(calls.length, 3);
});

test("FE-S9: a re-selected key whose reopen request failed is reopened by the retry", async (t) => {
  const { stream, calls, tick } = setup(t, [{ status: 200 }, { status: 429 }, { status: 200 }, { status: 200 }]);
  stream.set("agent", "k");
  stream.start();
  Source.latest.hello("s1");
  await tick(1);
  assert.equal(calls.length, 1);
  stream.reopen("agent");
  await tick(1);
  assert.equal(calls.length, 2, "request without the key failed");
  assert.deepEqual(calls[1].subs, []);
  await tick(1000);
  assert.deepEqual(calls.slice(2).map((c) => c.subs), [[], ["k"]], "the key is dropped and re-added once more");
});

test("FE-S10: stop() cancels a pending reconnect; no EventSource is opened afterwards", async (t) => {
  const { stream, tick } = setup(t, []);
  stream.start();
  Source.latest.die();
  assert.equal(Source.all.length, 1);
  stream.stop();
  await tick(120_000);
  assert.equal(Source.all.length, 1);
});

test("FE-S11: start() replaces a pending reconnect instead of doubling it", async (t) => {
  const { stream, tick } = setup(t, []);
  stream.start();
  Source.latest.die();
  stream.start();
  assert.equal(Source.all.length, 2);
  await tick(120_000);
  assert.equal(Source.all.length, 2);
});

test("FE-S12: reconnects back off 2 s, 4 s, 8 s and start over after a hello", async (t) => {
  const { stream, tick } = setup(t, []);
  stream.start();
  Source.latest.die();
  await tick(1999);
  assert.equal(Source.all.length, 1);
  await tick(1);
  assert.equal(Source.all.length, 2);
  Source.latest.die();
  await tick(3999);
  assert.equal(Source.all.length, 2);
  await tick(1);
  assert.equal(Source.all.length, 3);
  Source.latest.hello("s1");
  Source.latest.die();
  await tick(2000);
  assert.equal(Source.all.length, 4, "the delay is 2 s again after a successful hello");
});

/** The first PUT stays in flight until `release()`, then settles with `outcome`. */
function gatedFirstPut(outcome: "ok" | "429" | "throw") {
  let release!: () => void;
  const gate = new Promise<void>((done) => (release = done));
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    if (urls.length > 1) return { ok: true, status: 200, headers: { get: () => null }, text: async () => "" };
    await gate;
    if (outcome === "throw") throw new TypeError("network down");
    return { ok: outcome === "ok", status: outcome === "ok" ? 200 : 429, headers: { get: () => null }, text: async () => "" };
  }) as never;
  return { urls, release };
}

for (const outcome of ["ok", "429", "throw"] as const)
  test(`FE-S13: a late ${outcome} for a replaced stream neither marks it applied nor delays the new hello`, async (t) => {
    const { stream, tick, settle } = setup(t, []);
    const { urls, release } = gatedFirstPut(outcome);
    stream.set("agent", "k");
    stream.start();
    Source.latest.hello("old");
    await tick(1);
    assert.deepEqual(urls, ["/api/stream/old"]);
    Source.latest.hello("new");
    release();
    await settle();
    await tick(1);
    assert.deepEqual(urls, ["/api/stream/old", "/api/stream/new"]);
  });

test("FE-S14: the retry delay starts over after a PUT succeeds", async (t) => {
  const { stream, calls, tick } = setup(t, [{ status: 429 }, { status: 429 }, { status: 200 }, { status: 429 }, { status: 200 }]);
  stream.set("agent", "k");
  stream.start();
  Source.latest.hello("s1");
  await tick(1);
  await tick(1000);
  await tick(2000);
  assert.equal(calls.length, 3);
  stream.set("session", "k2");
  await tick(30);
  assert.equal(calls.length, 4);
  await tick(1000);
  assert.equal(calls.length, 5, "1 s again, not 4 s");
});
