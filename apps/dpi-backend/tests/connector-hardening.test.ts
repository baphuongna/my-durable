/**
 * Connector hardening: a socket the connector gave up on is torn down, local fetches never follow
 * redirects or outlive the tunnel, only hub traffic counts as liveness, and tunnel subscriptions can
 * only name canonical SSE paths.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { DeviceConnector, type ConnectorStatus } from "../src/tunnel.js";
import { pairingPath, type PairingFile } from "../src/pairing-files.js";
import { HUB_ID, REQ_ID, SUB_ID, hubServer, pairedHome, pause, rig, until } from "./connector-rig.js";

const HELLO = (hubId = HUB_ID) => ({
  type: "hello", apiVersion: 1, tunnelProto: 1, hubId, connectionId: "00000000-1111-2222-3333-444444444444", serverTime: Date.now(),
});

/** A hub that answers the handshake with whatever `reply` says and records when each server-side socket closed. */
async function misbehavingHub(reply: (ws: WebSocket) => void) {
  const wss = new WebSocketServer({ noServer: true });
  const sockets: { openedAt: number; closedAt: number | null; code: number | null }[] = [];
  const server = createServer((_q, r) => r.writeHead(404).end());
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const entry = { openedAt: Date.now(), closedAt: null as number | null, code: null as number | null };
      sockets.push(entry);
      ws.on("error", () => {});
      ws.on("close", (code) => {
        entry.closedAt = Date.now();
        entry.code = code;
      });
      ws.on("message", (data) => {
        if (JSON.parse(data.toString()).type === "pair-handshake") reply(ws);
      });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/tunnel`,
    sockets,
    async close() {
      for (const c of wss.clients) c.terminate();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

/** A connector whose back-off never elapses: whatever socket is open after a verdict is the one the verdict left behind. */
async function parkedConnector(hubUrl: string, intervals: { helloMs: number }) {
  const home = await pairedHome(hubUrl);
  const statuses: ConnectorStatus[] = [];
  const connector = new DeviceConnector(home, undefined, {
    intervals: { pingMs: 60_000, idleMs: 60_000, ...intervals },
    sleep: () => new Promise<void>(() => {}),
    onStatus: (s) => statuses.push(s),
  });
  connector.start();
  return {
    connector,
    statuses,
    async cleanup() {
      connector.stop("test done");
      await rm(home, { recursive: true, force: true });
    },
  };
}

const VERDICTS: { name: string; reply: (ws: WebSocket) => void; state: string; detail: RegExp; helloMs: number }[] = [
  { name: "never sends hello", reply: () => {}, state: "connecting", detail: /no hello within deadline/, helloMs: 300 },
  { name: "malformed hello", reply: (ws) => ws.send("{ not json"), state: "connecting", detail: /hello: malformed JSON/, helloMs: 3000 },
  { name: "schema-violating hello", reply: (ws) => ws.send(JSON.stringify({ type: "hello", apiVersion: 1 })), state: "connecting", detail: /hello: schema violation/, helloMs: 3000 },
  {
    name: "valid frame that is not a hello",
    reply: (ws) => ws.send(JSON.stringify({ type: "control", action: "unsubscribe", subscriptionId: SUB_ID, sub: "/v1/events" })),
    state: "connecting",
    detail: /expected hello first/,
    helloMs: 3000,
  },
  {
    name: "hello from another hub",
    reply: (ws) => ws.send(JSON.stringify(HELLO("ffffffff-5e6f-4a5b-8c9d-0e1f2a3b4c5d"))),
    state: "hub-mismatch",
    detail: /different hubId/,
    helloMs: 3000,
  },
];

for (const v of VERDICTS) {
  test(`B1: ${v.name} - the connector hangs up on that hub promptly`, async () => {
    const hub = await misbehavingHub(v.reply);
    const c = await parkedConnector(hub.url, { helloMs: v.helloMs });
    try {
      await until(() => c.connector.status().detail.match(v.detail) !== null, 8000, `verdict ${v.detail}`);
      const verdictAt = Date.now();
      assert.equal(c.connector.status().state, v.state);
      await until(() => hub.sockets[0]?.closedAt != null, 1000, "server side sees the socket close");
      assert.ok(hub.sockets[0]!.closedAt! - verdictAt <= 1000);
      assert.equal(hub.sockets.length, 1, "no reconnect while parked");
      assert.equal(c.connector.status().state, v.state, "a late event after the hang-up changes nothing");
    } finally {
      await c.cleanup();
      await hub.close();
    }
  });
}

test("B1: a healthy hub keeps its socket (control)", async () => {
  const hub = await misbehavingHub((ws) => ws.send(JSON.stringify(HELLO())));
  const c = await parkedConnector(hub.url, { helloMs: 3000 });
  try {
    await until(() => c.connector.status().state === "connected", 5000, "connected");
    await pause(400);
    assert.equal(hub.sockets[0]!.closedAt, null);
  } finally {
    await c.cleanup();
    await hub.close();
  }
});

// -- B2: what the connector tells its owner ----------------------------------------

const EPOCH = "3c3c3c3c-1111-2222-3333-444444444444";
const NOTICE = { type: "pair.revoke", v: 1, deviceId: "dev-1", pairingEpoch: EPOCH, reason: "user", revokedAt: 1 };

async function observedConnector(hubUrl: string) {
  const home = await pairedHome(hubUrl);
  const revoked: { epoch: string; reason: string }[] = [];
  const rotated: PairingFile[] = [];
  const connector = new DeviceConnector(
    home,
    undefined,
    {
      intervals: { pingMs: 60_000, idleMs: 60_000, helloMs: 2000 },
      sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, Math.min(ms, 40))),
      onRevoked: (epoch, reason) => revoked.push({ epoch, reason }),
      onRotated: (file) => rotated.push(file),
    },
    { baseUrl: "http://127.0.0.1:9", token: "unused" },
  );
  return { home, connector, revoked, rotated, cleanup: async () => (connector.stop("test done"), rm(home, { recursive: true, force: true })) };
}

test("B2: a revoked control frame for the current epoch is reported once, after the pairing file is gone", async () => {
  const hub = await hubServer();
  const o = await observedConnector(hub.url);
  try {
    o.connector.start();
    await until(() => o.connector.status().state === "connected", 5000, "connected");
    hub.send({ type: "control", action: "revoked", notice: { ...NOTICE, pairingEpoch: "ffffffff-1111-2222-3333-444444444444" } });
    await pause(150);
    assert.equal(o.revoked.length, 0, "a notice for another epoch is nobody's business");
    hub.send({ type: "control", action: "revoked", notice: NOTICE });
    await until(() => o.revoked.length === 1, 3000, "revoke reported");
    assert.equal(o.revoked[0]!.epoch, EPOCH);
    assert.match(o.revoked[0]!.reason, /revoked/);
    assert.equal(existsSync(pairingPath(o.home)), false);
    assert.equal(o.connector.status().state, "revoked");
  } finally {
    await o.cleanup();
    await hub.close();
  }
});

test("B2: a 401 revoked verdict at the upgrade is reported with the epoch that was refused", async () => {
  const body = JSON.stringify({ type: "tunnel.auth-error", v: 1, code: "revoked", message: "revoked" });
  const server = createServer((_q, r) => r.writeHead(404).end());
  server.on("upgrade", (_req, socket: Duplex) => {
    socket.end(`HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const o = await observedConnector(`ws://127.0.0.1:${(server.address() as { port: number }).port}/api/tunnel`);
  try {
    o.connector.start();
    await until(() => o.revoked.length === 1, 5000, "revoke reported");
    assert.equal(o.revoked[0]!.epoch, EPOCH);
    assert.equal(o.connector.status().state, "revoked");
    assert.equal(existsSync(pairingPath(o.home)), false);
  } finally {
    await o.cleanup();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("B2: a persisted rotation is reported with the new credential; a stale one is not", async () => {
  const hub = await hubServer();
  const o = await observedConnector(hub.url);
  const rotation = (generation: number) => ({
    type: "control", action: "token-rotate", pairingEpoch: EPOCH, rotationId: "99999999-1111-2222-3333-444444444444",
    credentialId: `aaaaaaaa-0000-0000-0000-00000000000${generation}`, generation, tunnelToken: `dpt_${"R".repeat(43)}`,
  });
  try {
    o.connector.start();
    await until(() => o.connector.status().state === "connected", 5000, "connected");
    hub.send(rotation(2));
    await until(() => o.rotated.length === 1, 3000, "rotation reported");
    assert.equal(o.rotated[0]!.generation, 2);
    assert.equal(o.rotated[0]!.pairingEpoch, EPOCH);
    hub.send(rotation(2));
    await pause(150);
    assert.equal(o.rotated.length, 1, "a repeated generation is not a rotation");
  } finally {
    await o.cleanup();
    await hub.close();
  }
});

// -- B4 / B9 -----------------------------------------------------------------

const restRequest = (path: string) => ({ type: "rest-request", reqId: REQ_ID, method: "GET", path });
const subscribe = (sub: string, id = SUB_ID) => ({ type: "control", action: "subscribe", subscriptionId: id, sub });

test("B4a: a redirecting local API is never followed; the hub gets a gateway error", async () => {
  const hits: string[] = [];
  const r = await rig((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/v1/sessions") res.writeHead(302, { location: "/v1/elsewhere" }).end();
    else res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  try {
    assert.ok(r.hub.send(restRequest("/v1/sessions")));
    await until(() => r.hub.frames.some((f) => f.type === "rest-response"), 5000, "rest-response");
    const response = r.hub.frames.find((f) => f.type === "rest-response");
    assert.equal(response.status, 502);
    assert.deepEqual(hits, ["/v1/sessions"], "the Location target was never requested");
  } finally {
    await r.cleanup();
  }
});

test("B4c: a REST fetch is aborted on the device when the socket closes", async () => {
  let aborted = false;
  const r = await rig((_req, res) => {
    res.on("close", () => {
      if (!res.writableFinished) aborted = true;
    });
  });
  try {
    assert.ok(r.hub.send(restRequest("/v1/sessions")));
    await pause(150);
    assert.equal(aborted, false, "still in flight while the tunnel is up");
    r.connector.stop("socket gone");
    await until(() => aborted, 3000, "loopback request aborted after the tunnel ended");
  } finally {
    await r.cleanup();
  }
});

test("B4c: a REST fetch is aborted when the hub's socket drops (connector keeps running)", async () => {
  let aborted = false;
  const r = await rig((_req, res) => {
    res.on("close", () => {
      if (!res.writableFinished) aborted = true;
    });
  });
  try {
    assert.ok(r.hub.send(restRequest("/v1/sessions")));
    await pause(150);
    assert.equal(aborted, false);
    await r.hub.close();
    await until(() => aborted, 3000, "loopback request aborted after the hub dropped the socket");
  } finally {
    await r.cleanup().catch(() => {});
  }
});

test("B4b: re-subscribing under the same id aborts the old reader and the old reader's exit leaves the new one registered", async () => {
  const opened: { req: IncomingMessage; closed: boolean }[] = [];
  const r = await rig((req, res) => {
    const entry = { req, closed: false };
    opened.push(entry);
    res.on("close", () => {
      entry.closed = true;
    });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": ok\n\n");
  });
  try {
    const readers = () => (r.connector as unknown as { readers: Map<string, unknown> }).readers;
    assert.ok(r.hub.send(subscribe("/v1/events")));
    await until(() => opened.length === 1, 3000, "first reader");
    assert.equal(readers().size, 1);
    const first = readers().get(SUB_ID);
    // The first reader finishes while a second one has taken its id (what a hub resubscribe during teardown looks like).
    const second = new AbortController();
    readers().set(SUB_ID, second);
    (first as AbortController).abort();
    await until(() => opened[0]!.closed, 3000, "first loopback stream closed");
    await pause(50);
    assert.equal(readers().get(SUB_ID), second, "the newer reader is still registered");
    assert.equal(second.signal.aborted, false);
  } finally {
    await r.cleanup();
  }
});

test("B4b: a reader that ends without reading its stream (non-2xx answer) hangs up on the loopback connection", async () => {
  let closed = false;
  const r = await rig((_req, res) => {
    res.on("close", () => {
      closed = true;
    });
    res.writeHead(500, { "content-type": "text/plain" });
    res.write("partial");
  });
  try {
    assert.ok(r.hub.send(subscribe("/v1/events")));
    await until(() => closed, 3000, "loopback connection released by the finished reader");
  } finally {
    await r.cleanup();
  }
});

test("B4d: loopback SSE bytes do not refresh the hub liveness watchdog", async () => {
  const sseWrites: (() => void)[] = [];
  const r = await rig((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": ok\n\n");
    sseWrites.push(() => res.write(`data: ${JSON.stringify({ type: "x" })}\n\n`));
  });
  try {
    const internals = r.connector as unknown as { lastByte: number };
    assert.ok(r.hub.send(subscribe("/v1/events")));
    await until(() => sseWrites.length === 1, 3000, "reader open");
    await pause(100);
    const before = internals.lastByte;
    await pause(30);
    sseWrites[0]!();
    sseWrites[0]!();
    await pause(150);
    assert.equal(internals.lastByte, before, "only hub-to-device traffic may move lastByte");
  } finally {
    await r.cleanup();
  }
});

test("B4d: hub frames and pongs still refresh it (control)", async () => {
  const r = await rig(() => {});
  try {
    const internals = r.connector as unknown as { lastByte: number };
    const before = internals.lastByte;
    await pause(40);
    r.hub.send({ type: "control", action: "close", reason: "x" });
    await until(() => internals.lastByte > before, 2000, "hub frame refreshes lastByte");
  } finally {
    await r.cleanup();
  }
});

// -- B9 ------------------------------------------------------------------------

const BAD_SUBS = [
  "/v1/sessions/../events",
  "/v1/sessions/./events",
  "/v1/sessions/s1/agents/../events",
  "/v1/sessions//events",
  "/v1/sessions/s1/agents//events",
  "/v1/sessions/..\\events",
  "/v1/sessions/a\\b/events",
  "/v1/sessions/%2e%2e/events",
  "/v1/sessions/%2E/events",
  "/v1/sessions/a%2fb/events",
  "/v1/sessions/a%2Fb/events",
  "/v1/sessions/a%5cb/events",
  "/v1/sessions/%2e%2e%2f%2e%2e/events",
  "/v1/sessions/s1/events?x=a\\b",
  "/v1/sessions/%zz/events",
];

test("B9: subscribe paths with dot/empty/backslash/encoded-separator segments are refused; canonical ones are read", async () => {
  const seen: string[] = [];
  const r = await rig((req, res) => {
    seen.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": ok\n\n");
  });
  try {
    let n = 0;
    const id = () => `${(++n).toString(16).padStart(8, "0")}-1111-1111-1111-111111111111`;
    for (const bad of BAD_SUBS) assert.ok(r.hub.send(subscribe(bad, id())), bad);
    assert.ok(r.hub.send(subscribe("/v1/sessions/s%201/agents/a.b-c_d/events?docs=state", id())));
    await until(() => seen.length >= 1, 3000, "the canonical path is read");
    await pause(300);
    assert.deepEqual(seen, ["/v1/sessions/s%201/agents/a.b-c_d/events?docs=state"], "nothing but the canonical path was fetched");
  } finally {
    await r.cleanup();
  }
});
