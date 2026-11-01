// Run-14 Unit B — hub-mux resilience UX, pinned the run-12/13 way: HubMux
// nextRetryInMs against the same local 127.0.0.1 SSE harness hub-mux.test.ts
// uses (a fake hub speaking the real wire contract — no production ports, no
// real server), renderHeader's optional retry chip as pure string tests, the
// toast-once / live-refresh behavior on a REAL App wired to that fake hub,
// and the r12 m2 setPending isolation fix.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HubMux, type MuxState } from "../src/hub-mux.ts";
import { renderHeader } from "../src/views.ts";
import { stripAnsi } from "./harness/strip.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `ok()` holds (50ms steps) or fail naming what never came. */
const waitUntil = async (ok: () => boolean, ms: number, what: string) => {
  for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await sleep(50);
  assert.ok(ok(), `timed out waiting for ${what}`);
};

/**
 * The hub-mux.test.ts fakeHub, plus the kill/revive switch its state test
 * builds inline: one SSE stream per GET, subscribe PUTs answered with per-key
 * hello frames. kill() destroys every live socket AND refuses new streams, so
 * the mux sees the exact failure mode of a dead hub.
 */
async function fakeHub() {
  let healthy = true;
  const sockets = new Set<Socket>();
  const streams = new Map<string, (line: string) => void>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (!healthy) return void res.destroy(); // hub process up, stream refused
    if (req.method === "GET" && url.pathname === "/api/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const id = `s${streams.size + 1}`;
      const send = (line: string) => res.write(line);
      streams.set(id, send);
      sockets.add(res.socket as Socket);
      send(`data: ${JSON.stringify({ sub: "hello", frame: { type: "stream", streamId: id } })}\n\n`);
      req.on("close", () => {
        streams.delete(id);
        sockets.delete(res.socket as Socket);
      });
      return;
    }
    if (req.method === "PUT" && url.pathname.startsWith("/api/stream/")) {
      const id = url.pathname.split("/").pop()!;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        const send = streams.get(id);
        for (const key of (JSON.parse(body || "{}").subs ?? []) as string[])
          send?.(`data: ${JSON.stringify({ sub: key, frame: { type: "hello", device: key.split("/")[0] } })}\n\n`);
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    kill: () => {
      healthy = false;
      for (const s of [...sockets]) s.destroy();
    },
    revive: () => {
      healthy = true;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

// -- HubMux.nextRetryInMs (run-14: pure observability, cadence untouched) ----

test("nextRetryInMs: null before any failure, null while live, null after stop", async () => {
  const hub = await fakeHub();
  const mux = new HubMux({ url: hub.url, token: "t" });
  const ctl = new AbortController();
  try {
    assert.equal(mux.nextRetryInMs(), null, "never failed → nothing is scheduled");
    // One subscriber drives the lazy loop; the first frame proves the hello
    // handshake (and therefore the live state) has been processed.
    const it = mux.events("dev/agent/s/1", ctl.signal)[Symbol.asyncIterator]();
    await it.next();
    await waitUntil(() => mux.live, 2000, "mux live");
    assert.equal(mux.nextRetryInMs(), null, "live → the wait was cleared on the hello");
  } finally {
    ctl.abort();
    mux.stop();
    await hub.close();
  }
  assert.equal(mux.nextRetryInMs(), null, "stopped → no retry will fire");
});

test("nextRetryInMs: 1s then 2s as the backoff doubles, derived from any now, clamped at 0", async () => {
  const hub = await fakeHub();
  const states: MuxState[] = [];
  const mux = new HubMux({ url: hub.url, token: "t" }, (s) => states.push(s));
  const ctl = new AbortController();
  try {
    const it = mux.events("dev/agent/s/1", ctl.signal)[Symbol.asyncIterator]();
    await it.next();
    await waitUntil(() => mux.live, 2000, "mux live");

    hub.kill();
    await waitUntil(() => states.includes("offline"), 5000, "first offline");
    // First outage: backoff.ms = 1000, recorded when the wait began. Sampling
    // costs a poll step, so anything in (500, 1000] proves a 1s schedule.
    const first = mux.nextRetryInMs();
    assert.ok(first !== null && first > 500 && first <= 1000, `first wait ≈1s, got ${first}`);
    // Pure derivation: the same deadline answers for ANY now — shifting now by
    // exactly 300ms shifts the answer by exactly 300ms.
    const at = Date.now();
    const d = mux.nextRetryInMs(at)!;
    assert.equal(mux.nextRetryInMs(at + 300), d - 300, "derived, never cached");
    // A now past the deadline clamps to 0 ("retry imminent"), never negative.
    assert.equal(mux.nextRetryInMs(at + 60_000), 0, "past deadline clamps to 0");

    // Second failure: advance() doubled the wait to 2s (cap 30s is Backoff's
    // own contract — the doubling is what this surface must mirror).
    await waitUntil(() => states.filter((s) => s === "offline").length >= 2, 8000, "second offline");
    const second = mux.nextRetryInMs();
    assert.ok(second !== null && second > 1500 && second <= 2000, `second wait ≈2s, got ${second}`);
    // The structural toast-once premise: setState never repeats a state, so a
    // retry cycle is always offline → connecting → offline, never offline².
    for (let i = 1; i < states.length; i++) assert.notEqual(states[i], states[i - 1]);
  } finally {
    ctl.abort();
    mux.stop();
    await hub.close();
  }
});

// -- renderHeader retry chip (run-14: optional field, existing bytes pinned) --

test("renderHeader: optional retry appends `· ↻Ns` after conn; absent retry changes nothing", () => {
  const base = { device: "box", sessions: 3, devicesOnline: 2, devicesTotal: 5, conn: "hub offline", connOk: false } as const;
  // Absent/undefined retry → the exact pre-run-14 render (r12/r13 pins hold:
  // no ↻, no stray `·`, still width-exact).
  const before = renderHeader(90, { ...base });
  assert.equal(visibleWidth(before), 90);
  assert.doesNotMatch(stripAnsi(before), /↻|·/, "no countdown chrome without the field");
  assert.equal(
    stripAnsi(renderHeader(90, { ...base, retry: undefined })),
    stripAnsi(before),
    "retry: undefined is byte-identical to the field being absent",
  );
  // With the field: the countdown rides right after the conn chip, one line.
  const after = renderHeader(90, { ...base, retry: "↻5s" });
  assert.equal(visibleWidth(after), 90, "width-exact with the chip");
  assert.ok(!after.includes("\n"), "single physical line");
  assert.match(stripAnsi(after), /hub offline · ↻5s/);
  // The pinned live/connecting states never carry the chip (app.ts only
  // passes retry while offline).
  const live = renderHeader(90, { device: "box", sessions: 1, conn: "live", connOk: true });
  assert.match(stripAnsi(live), /● live/);
  assert.equal(visibleWidth(live), 90);
  const connecting = renderHeader(90, { device: "box", sessions: 1, conn: "hub connecting", connOk: false });
  assert.match(stripAnsi(connecting), /hub connecting/);
  assert.doesNotMatch(stripAnsi(connecting), /↻/, "'hub connecting' renders unchanged");
  // Narrow terminals: the chip is truncated by fit(), never wrapped.
  const narrow = renderHeader(40, { ...base, retry: "↻30s" });
  assert.equal(visibleWidth(narrow), 40);
  assert.ok(!narrow.includes("\n"));
});

// -- App × HubMux: toast once per transition, live refresh, header countdown --

test("offline toasts exactly once across retry cycles; live toasts once, refreshes sessions, drops the countdown", async () => {
  const hub = await fakeHub();
  const treeCalls = { n: 0 };
  const client = {
    tree: async () => (treeCalls.n++, { uid: "u", name: "box", sessions: [], at: 0 }),
    device: async () => ({ models: [], defaultModel: "m", startDirs: [], name: "box" }),
    stream: () => ({ abort() {} }),
    on: () => () => {},
  };
  const { App } = await import("../src/app.ts");
  const app = new App(
    { id: "box", name: "box", url: "http://x", token: "t" },
    client as never,
    { models: [], startDirs: [] } as never,
    undefined,
    { url: hub.url, token: "t" },
  );
  // Count toasts at the notify chokepoint (each call overwrites app.toast).
  const toasts: string[] = [];
  const orig = app.notify.bind(app);
  (app as unknown as { notify: (m: string, e?: boolean) => void }).notify = (m, e) => {
    toasts.push(m);
    orig(m, e);
  };
  const appx = app as unknown as {
    mux?: HubMux;
    viaHub: boolean;
    muxState?: MuxState;
    onMuxState: (s: MuxState) => void;
    header(w: number): string;
  };
  const mux = new HubMux({ url: hub.url, token: "t" }, (s) => appx.onMuxState(s));
  try {
    // Wire the app the way switchDevice does: viaHub + one shared mux.
    appx.viaHub = true;
    appx.mux = mux;
    const ctl = new AbortController();
    const it = mux.events("box/agent/s/1", ctl.signal)[Symbol.asyncIterator]();
    await it.next();
    await waitUntil(() => mux.live, 2000, "mux live");

    hub.kill();
    await waitUntil(() => appx.muxState === "offline", 5000, "app saw offline");
    // While offline the header counts down to the next attempt.
    assert.match(stripAnsi(appx.header(120)), /hub offline · ↻\d+s/, "countdown rides the offline header");

    // Ride out two more full retry cycles (offline → connecting → offline at
    // 1s, then 2s): the offline toast must have fired exactly ONCE.
    await sleep(2600);
    assert.equal(
      toasts.filter((t) => t.includes("hub offline")).length,
      1,
      `one offline toast per outage, not per retry: ${JSON.stringify(toasts)}`,
    );
    assert.match(stripAnsi(appx.header(120)), /hub offline · ↻\d+s/, "still offline, still counting");

    const treesBeforeLive = treeCalls.n;
    hub.revive();
    await waitUntil(() => appx.muxState === "live", 10000, "hub back");
    assert.equal(
      toasts.filter((t) => t.includes("hub back online")).length,
      1,
      `one live toast: ${JSON.stringify(toasts)}`,
    );
    // run-14: the live transition refreshes the session list exactly once
    // (the herd froze with the connection; the in-flight guard collapses
    // concurrent hellos into a single /tree).
    await waitUntil(() => treeCalls.n > treesBeforeLive, 3000, "sessions refetched on live");
    assert.equal(treeCalls.n, treesBeforeLive + 1, "one /tree per live transition");
    // Back live: the countdown is gone and the conn chip no longer reports
    // the hub ("no agent" is honest here — no agent stream was ever attached;
    // what must NOT appear is any hub-offline/connecting/↻ residue).
    const liveHeader = stripAnsi(appx.header(120));
    assert.doesNotMatch(liveHeader, /hub offline|hub connecting|↻/, `live header must drop the hub chrome: ${liveHeader}`);
    ctl.abort();
    mux.stop();
  } finally {
    await app.exit();
    await hub.close();
  }
});

// -- r12 m2 (fixed run-14): refreshOps settle clears only its own pending note -

test("refreshOps settle keeps an unrelated picker flow's pending note (r12 m2)", async () => {
  const deferred = <T>() => {
    let resolve!: (v: T) => void;
    const p = new Promise<T>((r) => (resolve = r));
    return { p, resolve: resolve as (v: T) => void };
  };
  // Five never-settling ops reads; the test resolves them by hand.
  const vitals = deferred<Record<string, unknown>>();
  const usage = deferred<Record<string, unknown>>();
  const schedules = deferred<{ schedules: unknown[] }>();
  const env = deferred<Record<string, unknown>>();
  const sinks = deferred<{ sinks: unknown[] }>();
  const client = {
    vitals: () => vitals.p,
    deviceUsage: () => usage.p,
    schedules: () => schedules.p,
    envView: () => env.p,
    notifySinks: () => sinks.p,
    tree: async () => ({ uid: "u", name: "box", sessions: [], at: 0 }),
    device: async () => ({ models: [], startDirs: [] }),
  };
  const { App } = await import("../src/app.ts");
  const app = new App(
    { id: "box", name: "box", url: "http://x", token: "t" },
    client as never,
    { models: [], startDirs: [] } as never,
  );
  const appx = app as unknown as { refreshOps(): void; pendingNote: string | null };
  try {
    // First load (opsData empty): the ops flow TAKES the message line and must
    // give it back when the five reads settle.
    appx.refreshOps();
    assert.equal(appx.pendingNote, "loading device ops…");
    vitals.resolve({ at: 0 });
    usage.resolve({ at: 0 });
    schedules.resolve({ schedules: [] });
    env.resolve({ vars: [] });
    sinks.resolve({ sinks: [] });
    await sleep(50);
    assert.equal(appx.pendingNote, null, "the first load cleared its own note");

    // A later refresh no longer takes the line (opsData is populated) — so it
    // must not clear a note another flow set while it was in flight.
    appx.refreshOps(); // same already-resolved promises: settles on its own
    app.setPending("creating schedule…"); // a picker flow holds the line
    await sleep(50);
    assert.equal(
      appx.pendingNote,
      "creating schedule…",
      "r12 m2: ops settle cleared a pending note it never set",
    );
    app.setPending(null);
  } finally {
    await app.exit();
  }
});
