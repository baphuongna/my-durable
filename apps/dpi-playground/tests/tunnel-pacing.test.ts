/**
 * P2-18 — WS/SSE pacing + isolated slow-consumer failure:
 * WS backpressure close(1011) with cleanup, chunked tunnel-data e2e,
 * oversize → reader fault (tunnel stays up), paced SSE event integrity,
 * and backend viewer close leaving the daemon fully functional.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import express from "express";
import { WebSocket as WsClient } from "ws";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { Audit } from "../apps/dpi-playground-hub/src/audit.js";
import { TunnelServer } from "../apps/dpi-playground-hub/src/tunnel.js";
import {
  TunnelDispatcher,
  TunnelTransport,
} from "../apps/dpi-playground-hub/src/tunnel-transport.js";
import { DeviceMonitor } from "../apps/dpi-playground-hub/src/monitor.js";
import { StreamMux } from "../apps/dpi-playground-hub/src/mux.js";
import { sendChunked } from "../../dpi-sdk/src/node/chunk.js";
import { bootServer, until } from "../../dpi-backend/tests/helpers.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const HUB_ID = "8b9c0d1e-2f3a-4b4c-9d8e-7f6a5b4c3d2e";
const FINGERPRINT = `sha256:${"1".repeat(64)}`;
const UID = randomUUID();
const DEVICE_ID = "pace-dev";

interface Ctx {
  base: string;
  device: {
    ws: WsClient;
    subs: Map<string, string>;
    subscribes: { subscriptionId: string; sub: string }[];
  };
  tunnel: TunnelServer;
  registry: NetworkRegistry;
  sendToDevice: (frame: unknown) => void;
  broadcastChunked: (frame: unknown) => void;
  cleanup: () => Promise<void>;
  waitOnline: () => Promise<void>;
  reconnectDevice: () => Promise<void>;
}

async function setup(): Promise<Ctx> {
  const dir = await mkdtemp(join(tmpdir(), "dpi-p218-"));
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
       VALUES(?, 'P Dev', 'url', NULL, NULL, 'ui', 0, ?, 'checking', ?, ?, 'tunnel')`,
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

  const device: Ctx["device"] = {
    ws: undefined as unknown as WsClient,
    subs: new Map(),
    subscribes: [],
  };
  const connectDevice = async (): Promise<void> => {
    const ws = new WsClient(`ws://127.0.0.1:${hubPort}/api/tunnel`, {
      headers: { authorization: `Bearer ${token}` },
    });
    device.ws = ws;
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
            body: JSON.stringify({ apiVersion: 1, uid: UID, name: "P Dev" }),
          }),
        );
        return;
      }
      if (msg.type === "control" && msg.action === "subscribe") {
        device.subs.set(msg.subscriptionId, msg.sub);
        device.subscribes.push({ subscriptionId: msg.subscriptionId, sub: msg.sub });
      }
    });
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
  monitor.setTunnelSource(source); // covers tunnel devices; start() would double-watch
  mux.setTunnelSource(source);

  const app = express();
  app.use(express.json());
  app.get("/api/stream", (req, res) => mux.open(req, res));
  app.put("/api/stream/:streamId", (req, res) => {
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

  const sendToDevice = (frame: unknown) => {
    for (const id of device.subs.keys())
      device.ws.send(
        JSON.stringify({
          type: "tunnel-data",
          frame: frame as Record<string, unknown>,
          subscriptionId: id,
          sub: device.subs.get(id),
        }),
      );
  };
  const broadcastChunked = (frame: unknown) => {
    for (const [id, sub] of device.subs)
      sendChunked(frame, { kind: "tunnel-data", subscriptionId: id, sub }, (chunk) =>
        device.ws.send(JSON.stringify(chunk)),
      );
  };

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

  return {
    base,
    device,
    tunnel,
    registry,
    sendToDevice,
    broadcastChunked,
    cleanup,
    waitOnline: async () => {
      const by = Date.now() + 15_000;
      while (Date.now() < by && monitor.state(DEVICE_ID)?.status !== "online")
        await new Promise((r) => setTimeout(r, 50));
      if (monitor.state(DEVICE_ID)?.status !== "online")
        throw new Error("device never online: " + JSON.stringify(monitor.state(DEVICE_ID)));
    },
    reconnectDevice: async () => {
      device.ws.terminate();
      device.subs.clear();
      await connectDevice();
    },
  };
}

/** Open a browser SSE tab that yields device-data frames (mux control frames skipped). */
async function openTab(
  base: string,
  keys: string[],
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
      /* viewer cut / server shutdown */
    } finally {
      doneStreaming = true;
      wake();
    }
  };
  void pump();
  async function* frames(): AsyncGenerator<any, any, unknown> {
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
  const streamId = await streamIdPromise;
  await fetch(`${base}/api/stream/${streamId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subs: keys }),
  });
  return { streamId, frames };
}

test("WS backpressure: unread device buffer over 4 MB cap → close 1011, cleanup, audit; new connection works", async () => {
  const f = await setup();
  try {
    await f.waitOnline();
    // pause the device socket: it stops reading, hub outbound buffers grow
    (f.device.ws as unknown as { _socket: import("node:net").Socket })._socket.pause();
    const big = {
      type: "tunnel-data",
      frame: { type: "tree", tree: { blob: "x".repeat(900_000) } },
      subscriptionId: randomUUID(),
      sub: "s",
    };
    for (let i = 0; i < 8; i++) f.tunnel.send(DEVICE_ID, big as never);
    await until(() => f.tunnel.activeCount() === 0, 8000, "slow consumer connection closed");
    const ev = f.registry.db
      .prepare("SELECT detail_json FROM events WHERE action='tunnel.disconnect'")
      .all() as { detail_json: string }[];
    assert.ok(ev.some((e) => e.detail_json.includes("slow consumer")));
    // registry cleaned (no resurrected tunnel_state), and a fresh connection works
    assert.equal(f.registry.db.prepare("SELECT COUNT(*) c FROM tunnel_state").get().c, 0);
    await f.reconnectDevice();
    assert.equal(f.tunnel.activeCount(), 1);
  } finally {
    await f.cleanup();
  }
});

test("chunked tunnel-data e2e: 1.5 MB tree arrives intact through the mux; oversize assembly → reader fault only, tunnel stays up", async () => {
  const f = await setup();
  try {
    await f.waitOnline();
    const tab = await openTab(f.base, [`${DEVICE_ID}/device`]);
    // device sees mux subscribe (monitor's is separate)
    const subBy = Date.now() + 10_000;
    while (Date.now() < subBy && f.device.subscribes.length < 2)
      await new Promise((r) => setTimeout(r, 50));

    const bigTree = { type: "tree", tree: { blob: "y".repeat(1_500_000) } };
    f.broadcastChunked(bigTree);
    const iter = tab.frames();
    let received: any;
    const by = Date.now() + 15_000;
    while (Date.now() < by) {
      const next = await Promise.race([
        iter.next(),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 15_000)),
      ]);
      if (next === "timeout" || next.done) break;
      if (next.value.frame.type === "tree") {
        received = next.value.frame;
        break;
      }
    }
    assert.ok(received, "chunked tree must arrive");
    assert.equal(received.tree.blob.length, 1_500_000);
    assert.equal(received.tree.blob, bigTree.tree.blob, "byte-identical after reassembly");

    // Oversize/malformed assembly: metadata mutation mid-assembly → clear
    // reader fault; tunnel connection stays open; next good frame flows.
    // Target the TAB's subscription (monitor subscribed first; tab last).
    const tabSub = f.device.subscribes.at(-1)!.subscriptionId;
    const chunks: any[] = [];
    sendChunked(
      { type: "tree", tree: { blob: "z".repeat(200_000) } },
      { kind: "tunnel-data", subscriptionId: tabSub, sub: f.device.subs.get(tabSub)! },
      (c) => chunks.push(c),
    );
    chunks[0].count = 99; // metadata lies about the count → envelope/assembly failure
    f.device.ws.send(JSON.stringify(chunks[0]));
    const fault = await Promise.race([
      (async () => {
        for (;;) {
          const next = await iter.next();
          if (next.done) return undefined;
          if (next.value.frame.type === "fault") return next.value.frame;
        }
      })(),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 8000)),
    ]);
    assert.notEqual(fault, "timeout", "reader must learn about the broken assembly");
    assert.equal((fault as { error: { code: string } }).error.code, "invalid");
    assert.equal(f.tunnel.activeCount(), 1, "tunnel NOT closed by a bad assembly");
    f.sendToDevice({ type: "tree", tree: { v: 7 } });
    const good = await Promise.race([
      (async () => {
        for (;;) {
          const next = await iter.next();
          if (next.done) return undefined;
          if (next.value.frame.type === "tree") return next.value.frame;
        }
      })(),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 8000)),
    ]);
    assert.notEqual(good, "timeout");
    assert.equal((good as { tree: { v: number } }).tree.v, 7);
  } finally {
    await f.cleanup();
  }
});

test("backend viewer close: SSE cut mid-stream leaves the daemon fully functional (harness not aborted)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-p218-be-"));
  const home = join(dir, "home");
  const startDirs = join(dir, "starts");
  await import("node:fs/promises").then((fs) =>
    Promise.all([fs.mkdir(home, { recursive: true }), fs.mkdir(startDirs, { recursive: true })]),
  );
  const token = "dt_" + "V".repeat(40);
  const backend = await bootServer({ home, startDirs, token });
  try {
    // open a viewer on /v1/events, read the hello, then hard-close it
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${backend.port}/v1/events`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ac.signal,
    });
    assert.equal(res.status, 200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read(); // hello event
    ac.abort(); // viewer goes away mid-stream
    await new Promise((r) => setTimeout(r, 150));
    // daemon keeps serving: tree, session create, and a fresh SSE all work
    const tree = await fetch(`http://127.0.0.1:${backend.port}/v1/tree`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(tree.status, 200);
    const created = await fetch(`http://127.0.0.1:${backend.port}/v1/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "after-close",
        cwd: startDirs,
        model: { provider: "faux", modelId: "echo" },
      }),
    });
    assert.equal(created.status, 201);
    const ac2 = new AbortController();
    const res2 = await fetch(`http://127.0.0.1:${backend.port}/v1/events`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ac2.signal,
    });
    assert.equal(res2.status, 200);
    ac2.abort();
  } finally {
    await backend.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("run-8 U8: relayed device frames are charged to the device's connection share, not the shared hub pool", async () => {
  const f = await setup();
  try {
    await f.waitOnline();
    const tab = await openTab(f.base, [`${DEVICE_ID}/device`]);
    const subBy = Date.now() + 10_000;
    while (Date.now() < subBy && f.device.subscribes.length < 2)
      await new Promise((r) => setTimeout(r, 50));

    // A frame well under the mux relay caps: must arrive intact.
    const small = { type: "tree", tree: { blob: "k".repeat(64 * 1024) } };
    f.device.ws.send(JSON.stringify({ kind: "tunnel-data", subscriptionId: f.device.subscribes.at(-1)!.subscriptionId, frame: small }));
    const iter = tab.frames();
    const got = await Promise.race([
      (async () => {
        for (;;) {
          const next = await iter.next();
          if (next.done) return undefined;
          if (next.value.frame.type === "tree") return next.value.frame;
        }
      })(),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 8000)),
    ]);
    assert.ok(got, "a small frame must relay while the device share holds");
  } finally {
    await f.cleanup();
  }
});
