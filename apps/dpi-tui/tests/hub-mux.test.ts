// HubMux: the node client for the hub's /api/stream mux. Unit-tested against a
// real local SSE server that speaks the same protocol the hub does (hello →
// PUT subscribe → tagged frames), so the wire contract is pinned without a hub.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { HubMux, type MuxState } from "../src/hub-mux.ts";
import type { Socket } from "node:net";

/** A minimal mux: one SSE stream, subscription keys echoed as tagged frames. */
async function fakeHub() {
  const subs = new Map<string, string[]>();
  const streams = new Map<string, (line: string) => void>();
  let opened = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/api/stream") {
      opened += 1;
      const id = `s${opened}`;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (line: string) => res.write(line);
      streams.set(id, send);
      send(`data: ${JSON.stringify({ sub: "hello", frame: { type: "stream", streamId: id } })}\n\n`);
      subs.set(id, []);
      req.on("close", () => streams.delete(id));
      return;
    }
    if (req.method === "PUT" && url.pathname.startsWith("/api/stream/")) {
      const id = url.pathname.split("/").pop()!;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const keys = (JSON.parse(body || "{}").subs ?? []) as string[];
        subs.set(id, keys);
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        // Every fresh subscription opens an upstream: its first frame is the hello.
        const send = streams.get(id);
        for (const key of keys)
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
    subs,
    push: (key: string, frame: unknown) => {
      for (const send of streams.values())
        send(`data: ${JSON.stringify({ sub: key, frame })}\n\n`);
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

test("HubMux delivers frames for a subscribed key and tags nothing else", async () => {
  const hub = await fakeHub();
  const mux = new HubMux({ url: hub.url, token: "t" });
  const ctl = new AbortController();
  try {
    const seen: unknown[] = [];
    const it = mux.events("dev/agent/s/1", ctl.signal)[Symbol.asyncIterator]();
    const first = await it.next();
    assert.equal(first.value.type, "hello");
    // A frame on another key must not reach this subscriber.
    hub.push("other/agent/s/1", { type: "disconnected", reason: "nope" });
    hub.push("dev/agent/s/1", { type: "snapshot", snapshot: {} });
    const second = await it.next();
    assert.equal(second.value.type, "snapshot");
    seen.push(first.value, second.value);
    assert.equal(seen.length, 2);
  } finally {
    ctl.abort();
    mux.stop();
    await hub.close();
  }
});

test("HubMux subscribes on the hub (PUT carries the key) and unsubscribes on abort", async () => {
  const hub = await fakeHub();
  const mux = new HubMux({ url: hub.url, token: "t" });
  const ctl = new AbortController();
  try {
    const it = mux.events("dev/session/s1", ctl.signal)[Symbol.asyncIterator]();
    await it.next();
    const live = [...hub.subs.values()].at(-1) ?? [];
    assert.deepEqual(live, ["dev/session/s1"]);
  } finally {
    ctl.abort();
    await new Promise((r) => setTimeout(r, 150));
    const after = [...hub.subs.values()].at(-1) ?? [];
    assert.deepEqual(after, [], "abort drops the key so the hub closes its upstream");
    mux.stop();
    await hub.close();
  }
});

// -- state transitions surfaced to the app (R4 finding 5) ---------------------
// The header/toast work rides HubMux's onState callback; pin the live →
// offline → live sequence against a hub that can be switched off and on.

test("HubMux reports live → offline → live through onState as the hub dies and returns", async () => {
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
        // Every fresh subscription opens an upstream whose first frame is the
        // hello — pushed onto the SSE stream, the way the real hub does it.
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
  const seen: MuxState[] = [];
  const mux = new HubMux({ url: `http://127.0.0.1:${port}`, token: "t" }, (state) => seen.push(state));
  const waitFor = async (state: MuxState, ms: number) => {
    for (let end = Date.now() + ms; !seen.includes(state) && Date.now() < end; )
      await new Promise((r) => setTimeout(r, 100));
    assert.ok(seen.includes(state), `mux never reached ${state} (seen: ${JSON.stringify(seen)})`);
  };
  try {
    // One subscriber drives the lazy mux loop.
    const ctl = new AbortController();
    const it = mux.events("dev/agent/s/1", ctl.signal)[Symbol.asyncIterator]();
    const first = await it.next();
    assert.equal(first.value.type, "hello");
    await waitFor("live", 2000);
    const liveAt = seen.indexOf("live");

    // Kill the stream sockets: the SSE ends → offline; the backoff loop then
    // reconnects once the hub serves again → live.
    healthy = false;
    for (const s of [...sockets]) s.destroy();
    await waitFor("offline", 6000);
    const offlineAt = seen.indexOf("offline");
    assert.ok(offlineAt > liveAt, "offline follows the first live");

    healthy = true;
    // Wait for a live state RECORDED AFTER the offline one — the pre-drop live
    // is still in `seen` and must not satisfy this.
    for (let end = Date.now() + 10000; seen.indexOf("live", offlineAt) <= offlineAt && Date.now() < end; )
      await new Promise((r) => setTimeout(r, 100));
    assert.ok(seen.indexOf("live", offlineAt) > offlineAt, `a fresh live follows the offline (seen: ${JSON.stringify(seen)})`);
    ctl.abort();
  } finally {
    mux.stop();
    for (const s of [...sockets]) s.destroy();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
