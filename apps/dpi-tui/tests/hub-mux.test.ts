// HubMux: the node client for the hub's /api/stream mux. Unit-tested against a
// real local SSE server that speaks the same protocol the hub does (hello →
// PUT subscribe → tagged frames), so the wire contract is pinned without a hub.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { HubMux } from "../src/hub-mux.ts";

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
