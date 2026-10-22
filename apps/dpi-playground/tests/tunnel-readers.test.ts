/**
 * P2-17 — consumer-owned readers: multi-tab isolation, snapshot-first late
 * join, idempotent desired-set, unsubscribe isolation, reader caps, and
 * tunnel reconnect keeping the browser streamId with a fresh subscriptionId.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import type { WebSocket as WsSocket } from "ws";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { Audit } from "../apps/dpi-playground-hub/src/audit.js";
import { TunnelServer } from "../apps/dpi-playground-hub/src/tunnel.js";
import {
  TunnelDispatcher,
  TunnelTransport,
} from "../apps/dpi-playground-hub/src/tunnel-transport.js";
import { DeviceMonitor } from "../apps/dpi-playground-hub/src/monitor.js";
import { StreamMux } from "../apps/dpi-playground-hub/src/mux.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const HUB_ID = "7a8b9c0d-1e2f-4a3b-8c7d-6e5f4a3b2c1d";
const FINGERPRINT = `sha256:${"f".repeat(64)}`;
const UID = randomUUID();
const DEVICE_ID = "reader-dev";

interface FakeDevice {
  ws: WsSocket;
  subs: Map<string, string>; // subscriptionId → sub path
  subscribes: { subscriptionId: string; sub: string }[];
  unsubscribes: string[];
  broadcast: (frame: unknown) => void;
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "dpi-p217-"));
  const registry = new NetworkRegistry(join(dir, "net.sqlite"));
  registry.clearTunnelState();
  const audit = new Audit(registry);
  const tunnel = new TunnelServer(registry, audit, HUB_ID);
  const dispatcher = new TunnelDispatcher(tunnel, { audit });
  const token =
    "dpt_" +
    Buffer.from(randomUUID() + randomUUID())
      .toString("base64url")
      .slice(0, 43);
  const epoch = randomUUID();
  const t0 = Date.now();
  registry.db
    .prepare(
      `INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,created_at,updated_at,transport)
       VALUES(?, 'R Dev', 'url', NULL, NULL, 'ui', 0, ?, 'checking', ?, ?, 'tunnel')`,
    )
    .run(DEVICE_ID, UID, t0, t0);
  registry.db
    .prepare(
      `INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at)
       VALUES(?,?,?,?,'paired',1,?,?,?)`,
    )
    .run(DEVICE_ID, epoch, "pub", FINGERPRINT, t0, t0, t0);
  registry.db
    .prepare(
      `INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at,confirmed_at)
       VALUES(?,?,?,?,?,'current',?,?)`,
    )
    .run(randomUUID(), DEVICE_ID, epoch, 1, sha(token), t0, t0);

  const server = createServer();
  server.on("upgrade", (req, socket, head) => tunnel.handleUpgrade(req, socket, head));
  await new Promise<void>((d) => server.listen(0, "127.0.0.1", d));
  const hubPort = (server.address() as { port: number }).port;

  // Fake device with scriptable subscription bookkeeping.
  const device: FakeDevice = {
    ws: undefined as unknown as WsSocket,
    subs: new Map(),
    subscribes: [],
    unsubscribes: [],
    broadcast: () => {},
  };
  const connectDevice = async (): Promise<void> => {
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/api/tunnel`, {
      headers: { authorization: `Bearer ${token}` },
    }) as WsSocket;
    device.ws = ws;
    // A device's subscriptions belong to one connection: a reconnect starts with none (T-7 cuts a sender that names the old ones).
    device.subs.clear();
    await new Promise<void>((d) => ws.once("open", d));
    ws.on("message", (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.type === "rest-request" && msg.path === "/v1/device") {
        ws.send(
          JSON.stringify({
            type: "rest-response",
            reqId: msg.reqId,
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ apiVersion: 1, uid: UID, name: "R Dev" }),
          }),
        );
        return;
      }
      if (msg.type === "control" && msg.action === "subscribe") {
        device.subs.set(msg.subscriptionId, msg.sub);
        device.subscribes.push({ subscriptionId: msg.subscriptionId, sub: msg.sub });
        return;
      }
      if (msg.type === "control" && msg.action === "unsubscribe") {
        device.subs.delete(msg.subscriptionId);
        device.unsubscribes.push(msg.subscriptionId);
      }
    });
    device.broadcast = (frame) => {
      for (const id of device.subs.keys())
        ws.send(
          JSON.stringify({
            type: "tunnel-data",
            frame: frame as Record<string, unknown>,
            subscriptionId: id,
            sub: device.subs.get(id),
          }),
        );
    };
    ws.send(
      JSON.stringify({
        type: "pair-handshake",
        v: 1,
        deviceUid: UID,
        deviceId: DEVICE_ID,
        pairingEpoch: epoch,
        credentialId: (
          registry.db
            .prepare("SELECT credential_id FROM tunnel_credentials WHERE device_id=?")
            .get(DEVICE_ID) as { credential_id: string }
        ).credential_id,
        generation: 1,
        apiVersion: 1,
        tunnelProto: 1,
        keyFingerprint: FINGERPRINT,
      }),
    );
    await new Promise<void>((d) => ws.once("message", () => d())); // hello
  };
  await connectDevice();

  const monitor = new DeviceMonitor(registry);
  const mux = new StreamMux(registry, monitor);
  const source = {
    dispatcherFor: (row: { id: string; transport: string }) => new TunnelTransport(row, dispatcher),
    hasLiveConnection: (id: string) => tunnel.hasConnection(id),
  };
  monitor.setTunnelSource(source);
  mux.setTunnelSource(source);
  monitor.start();

  const app = express();
  app.use(express.json());
  app.get("/api/stream", (req: Request, res: Response) => mux.open(req, res));
  app.put("/api/stream/:streamId", (req: Request, res: Response) => {
    try {
      res.json(mux.subscribe(String(req.params.streamId), req.body?.subs));
    } catch (e) {
      res
        .status((e as { status?: number }).status ?? 400)
        .json({ error: { code: "invalid", message: (e as Error).message } });
    }
  });
  const apiServer = createServer(app);
  await new Promise<void>((d) => apiServer.listen(0, "127.0.0.1", d));
  const base = `http://127.0.0.1:${(apiServer.address() as { port: number }).port}`;

  const cleanup = async () => {
    device.ws.terminate();
    dispatcher.close();
    tunnel.close();
    monitor.stop();
    apiServer.close();
    apiServer.closeAllConnections();
    server.close();
    server.closeAllConnections();
    registry.close();
    await rm(dir, { recursive: true, force: true });
  };

  // Monitor must be online before mux readers attach (they wait for online).
  const onlineBy = Date.now() + 15_000;
  while (Date.now() < onlineBy && monitor.state(DEVICE_ID)?.status !== "online")
    await new Promise((r) => setTimeout(r, 50));
  if (monitor.state(DEVICE_ID)?.status !== "online")
    throw new Error("fake device never online: " + JSON.stringify(monitor.state(DEVICE_ID)));

  return { base, registry, device, mux, dispatcher, monitor, connectDevice, cleanup };
}

/** Open a browser SSE tab; returns streamId + an async frame iterator. */
async function openTab(
  base: string,
): Promise<{ streamId: string; frames: () => AsyncGenerator<any, any, unknown> }> {
  const res = await fetch(`${base}/api/stream`);
  assert.equal(res.status, 200);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let doneStreaming = false;
  const queue: any[] = [];
  const waiters: (() => void)[] = [];
  let resolveStreamId!: (s: string) => void;
  const streamIdPromise = new Promise<string>((r) => (resolveStreamId = r));
  const wake = () => waiters.splice(0).forEach((fn) => fn());
  const pump = async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const f = JSON.parse(line.slice(5).trimStart());
            queue.push(f);
            wake();
            if (f.sub === "hello" && f.frame?.streamId) resolveStreamId(f.frame.streamId);
          }
        }
      }
    } catch {
      // tab closed / server shut down while the iterator is parked
    } finally {
      doneStreaming = true;
      wake();
    }
  };
  void pump();
  async function* frames(): AsyncGenerator<any, any, unknown> {
    // Only device data frames (sub = a subscription key); mux-internal
    // "hello"/"network" control frames are consumed and skipped.
    for (;;) {
      while (queue.length) {
        const f = queue.shift();
        if (f.sub === "hello" || f.sub === "network") continue;
        yield f;
      }
      if (doneStreaming) return;
      await new Promise<void>((r) => waiters.push(r));
    }
  }
  return { streamId: await streamIdPromise, frames };
}

test("multi-tab: own upstream per tab, late join gets its own snapshot first, unsubscribe isolation, idempotent desired-set", async () => {
  const f = await setup();
  try {
    const a = await openTab(f.base);
    await fetch(`${f.base}/api/stream/${a.streamId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subs: [`${DEVICE_ID}/device`] }),
    });
    // device now sees monitor + tab A subscriptions
    const subBy = Date.now() + 10_000;
    while (Date.now() < subBy && f.device.subscribes.length < 2)
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(f.device.subscribes.length, 2); // monitor /v1/events + tab A
    f.device.broadcast({ type: "tree", tree: { v: 1 } });

    // Tab B late join → fresh upstream, device sees a THIRD subscribe
    const b = await openTab(f.base);
    await fetch(`${f.base}/api/stream/${b.streamId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subs: [`${DEVICE_ID}/device`] }),
    });
    const threeBy = Date.now() + 10_000;
    while (Date.now() < threeBy && f.device.subscribes.length < 3)
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(f.device.subscribes.length, 3);
    // new subscriptionId (never reused)
    assert.notEqual(f.device.subscribes[2].subscriptionId, f.device.subscribes[1].subscriptionId);
    // snapshot-first on the new reader: broadcast hello+tree, B sees them
    f.device.broadcast({ type: "hello", apiVersion: 1 });
    f.device.broadcast({ type: "tree", tree: { v: 2 } });
    const bSeen: string[] = [];
    const bIter = b.frames();
    const bDone = (async () => {
      for await (const fr of bIter) {
        bSeen.push(fr.frame.type);
        if (bSeen.length >= 2) break;
      }
    })();
    await bDone;
    assert.deepEqual(bSeen, ["hello", "tree"], "snapshot before deltas on late join");

    // Unsubscribe A: A's subscription released; B + monitor keep flowing
    await fetch(`${f.base}/api/stream/${a.streamId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subs: [] }),
    });
    const unsubBy = Date.now() + 5000;
    while (Date.now() < unsubBy && f.device.unsubscribes.length < 1)
      await new Promise((r) => setTimeout(r, 30));
    assert.equal(f.device.unsubscribes.length, 1);
    f.device.broadcast({ type: "tree", tree: { v: 3 } });
    const bIter2 = b.frames();
    const next = await bIter2.next();
    assert.equal(next.value.frame.tree.v, 3, "B keeps receiving after A unsubscribed");

    // Desired-set idempotent: repeat same keys → no new subscribe at device
    const before = f.device.subscribes.length;
    await fetch(`${f.base}/api/stream/${b.streamId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subs: [`${DEVICE_ID}/device`] }),
    });
    assert.equal(f.device.subscribes.length, before, "repeat same id/sub is idempotent");
  } finally {
    await f.cleanup();
  }
});

test("tunnel reconnect: browser streamId kept, fresh subscriptionId on the new connection", async () => {
  const f = await setup();
  try {
    const tab = await openTab(f.base);
    await fetch(`${f.base}/api/stream/${tab.streamId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subs: [`${DEVICE_ID}/device`] }),
    });
    const firstSub = f.device.subscribes.at(-1)!.subscriptionId;
    // kill the device connection; mux retries through the tunnel connector leg
    f.device.ws.terminate();
    await new Promise((r) => setTimeout(r, 100));
    // reconnect a NEW fake device connection (the device daemon reconnects)
    await f.connectDevice();
    const reconnectBy = Date.now() + 10_000;
    while (Date.now() < reconnectBy && f.device.subscribes.length <= 2)
      await new Promise((r) => setTimeout(r, 50));
    const secondSub = f.device.subscribes.at(-1)!.subscriptionId;
    assert.notEqual(secondSub, firstSub, "new subscriptionId per lifecycle");
    // data flows again to the SAME browser stream (skip any disconnected note)
    f.device.broadcast({ type: "tree", tree: { v: 9 } });
    const iter = tab.frames();
    for (;;) {
      const next = await iter.next();
      assert.ok(!next.done, "stream must keep flowing after reconnect");
      if (next.value.frame.type === "tree") {
        assert.equal(next.value.frame.tree.v, 9);
        break;
      }
    }
  } finally {
    await f.cleanup();
  }
});

test("reader caps: >20 keys rejected 400; 128th device reader faulted alone, existing readers keep working", async () => {
  const f = await setup();
  try {
    // >20 keys on one tab → 400
    const tab = await openTab(f.base);
    const tooMany = await fetch(`${f.base}/api/stream/${tab.streamId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subs: Array.from({ length: 21 }, (_, i) => `${DEVICE_ID}/session/s${i}`),
      }),
    });
    assert.equal(tooMany.status, 400);

    // Fill to the device reader cap: monitor holds 1, so 127 mux readers fit.
    // One long-lived reader is opened first and must survive the cap.
    const keeper = await openTab(f.base);
    await fetch(`${f.base}/api/stream/${keeper.streamId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subs: [`${DEVICE_ID}/session/keeper`] }),
    });
    const others: { streamId: string }[] = [];
    for (let i = 0; i < 126; i++) {
      const t = await openTab(f.base);
      others.push(t);
      const r = await fetch(`${f.base}/api/stream/${t.streamId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subs: [`${DEVICE_ID}/session/s${i}`] }),
      });
      assert.equal(r.status, 200, `reader ${i} should be admitted`);
    }
    // Next reader: cap hit → fault frame on THAT reader only.
    const overflow = await openTab(f.base);
    await fetch(`${f.base}/api/stream/${overflow.streamId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subs: [`${DEVICE_ID}/session/overflow`] }),
    });
    // the overflow reader sees a fault for its key
    const iter = overflow.frames();
    const fault = await Promise.race([
      iter.next(),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 3000)),
    ]);
    assert.notEqual(fault, "timeout", "cap must be reported to the rejected reader");
    assert.equal((fault as { value: { frame: { type: string } } }).value.frame.type, "fault");
    // keeper still flows
    f.device.broadcast({ type: "tree", tree: { v: 42 } });
    const keeperIter = keeper.frames();
    const kept = await Promise.race([
      keeperIter.next(),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 3000)),
    ]);
    assert.notEqual(kept, "timeout", "existing readers must survive a cap rejection");
    assert.equal(
      (kept as { value: { frame: { frame: { tree: { v: number } } } } }).value.frame.tree.v,
      42,
    );
  } finally {
    await f.cleanup();
  }
});
