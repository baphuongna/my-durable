/**
 * Run-11 Unit A (h1-1 MED + h4-5 LOW) — playground hub relay CPU churn.
 *
 *  h1-1: an oversized CHUNKED device tree must fault at the relay cap with
 *        ZERO JSON.stringify of the frame — the raw-bytes pre-check in
 *        mux.follow() (reassembledFrameBytes, recorded at the reassembly push
 *        seam) faults before the serialization seam, the subscription
 *        survives, and the drop counters stay untouched (fault, never a
 *        silent drop — r9 relay contract).
 *  h4-5: a per-subscription token bucket (capacity 4, refill 2/s, reset full
 *        at every (re)connect) coalesces back-to-back tree bursts: ≤5 of 10
 *        legal trees relay, coalescedTreeFrames is set via relayStats(), and
 *        a single legal chunked tree still relays VERBATIM (the relay stays a
 *        pipe — byte parity with the monitor was reverted on purpose).
 *
 * Harness: real TunnelServer + WS device + TunnelDispatcher + monitor + mux
 * (same shape as tests/tunnel-pacing.test.ts, the proven e2e path for
 * chunked tunnel-data through the mux).
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
import { until } from "../../dpi-backend/tests/helpers.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const HUB_ID = "8b9c0d1e-2f3a-4b4c-9d8e-7f6a5b4c3d2e";
const FINGERPRINT = `sha256:${"3".repeat(64)}`;
const UID = randomUUID();
// run-15: shared with relay-stale-r15.test.ts (raw-text fixtures must match
// the registry row this harness inserts).
export const DEVICE_ID = "churn-dev";

/** run-15 u1-*: this harness is shared with tests/relay-stale-r15.test.ts —
 *  importing this module also registers the r11 tests below (they stay green
 *  as pinned r11 behavior; run-15 u1-1 re-timed the burst window, see the
 *  comment inside the h4-5 burst test). */
export interface Ctx {
  base: string;
  mux: StreamMux;
  monitor: DeviceMonitor;
  device: { subs: Map<string, string>; subscribes: { subscriptionId: string; sub: string }[] };
  sendToDevice: (frame: unknown) => void;
  broadcastChunked: (frame: unknown) => void;
  /** run-15: raw wire access — send an arbitrary pre-built message on the
   *  device WS (the only way to put NON-canonical JSON on the wire:
   *  sendChunked/broadcastChunked serialize an object, we need raw text). */
  sendWire: (msg: unknown) => void;
  /** run-15 u1-2: drop the device WS and bring it back with the SAME
   *  credentials — the mux follow() loop reconnects (a later while-iteration)
   *  while the tab's SSE stream stays open. */
  reconnectDevice: () => Promise<void>;
  waitOnline: () => Promise<void>;
  waitForMuxSubscribe: () => Promise<void>;
  cleanup: () => Promise<void>;
}

export async function setup(): Promise<Ctx> {
  const dir = await mkdtemp(join(tmpdir(), "dpi-r11-churn-"));
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
       VALUES(?, 'Churn Dev', 'url', NULL, NULL, 'ui', 0, ?, 'checking', ?, ?, 'tunnel')`,
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

  const device: Ctx["device"] = { subs: new Map(), subscribes: [] };
  // run-15 u1-2: `ws` is reassignable — reconnectDevice() swaps the socket so
  // a later while-iteration of mux.follow() exercises the RECONNECT path.
  let ws = new WsClient(`ws://127.0.0.1:${hubPort}/api/tunnel`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const bindDevice = (sock: WsClient) => {
    sock.on("message", (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.type === "rest-request" && msg.path === "/v1/device") {
        sock.send(
          JSON.stringify({
            type: "rest-response",
            reqId: msg.reqId,
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ apiVersion: 1, uid: UID, name: "Churn Dev" }),
          }),
        );
        return;
      }
      if (msg.type === "control" && msg.action === "subscribe") {
        device.subs.set(msg.subscriptionId, msg.sub);
        device.subscribes.push({ subscriptionId: msg.subscriptionId, sub: msg.sub });
      }
    });
  };
  const handshake = (sock: WsClient) =>
    sock.send(
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
  bindDevice(ws);
  await new Promise<void>((d) => ws.once("open", d));
  handshake(ws);
  await new Promise<void>((d) => ws.once("message", () => d())); // hello

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
    for (const [id, sub] of device.subs)
      ws.send(
        JSON.stringify({
          type: "tunnel-data",
          frame: frame as Record<string, unknown>,
          subscriptionId: id,
          sub,
        }),
      );
  };
  const broadcastChunked = (frame: unknown) => {
    for (const [id, sub] of device.subs)
      sendChunked(frame, { kind: "tunnel-data", subscriptionId: id, sub }, (chunk) =>
        ws.send(JSON.stringify(chunk)),
      );
  };
  const sendWire = (msg: unknown) => ws.send(JSON.stringify(msg));
  const reconnectDevice = async () => {
    ws.terminate();
    // The old subscriptionIds died with the old socket (a real device forgets
    // them too); resending their frames on the new connection would trip the
    // hub's foreign-subscription guard and cut the fresh connection.
    device.subs.clear();
    ws = new WsClient(`ws://127.0.0.1:${hubPort}/api/tunnel`, {
      headers: { authorization: `Bearer ${token}` },
    });
    bindDevice(ws);
    await new Promise<void>((d) => ws.once("open", d));
    handshake(ws);
    await new Promise<void>((d) => ws.once("message", () => d())); // hello
  };

  return {
    base,
    mux,
    monitor,
    device,
    sendToDevice,
    broadcastChunked,
    sendWire,
    reconnectDevice,
    waitOnline: async () => {
      await until(
        () => monitor.state(DEVICE_ID)?.status === "online",
        15_000,
        "device never online",
      );
    },
    waitForMuxSubscribe: async () => {
      // monitor's /v1/events subscribe lands first; the tab's is second
      await until(() => device.subscribes.length >= 2, 10_000, "mux tab subscribe");
    },
    cleanup: async () => {
      ws.terminate();
      dispatcher.close();
      tunnel.close();
      monitor.stop();
      apiServer.close();
      apiServer.closeAllConnections();
      server.close();
      server.closeAllConnections();
      registry.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Open a browser SSE tab; frames() yields non-hello/non-network mux frames.
 *  run-15: exported for relay-stale-r15.test.ts (same harness, same tab). */
export async function openTab(
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

/** Next frame matching pred, or undefined after ms.
 *  run-15 caveat: on TIMEOUT the underlying generator keeps ONE armed
 *  next() that will consume the next arriving frame — only use this when the
 *  expected outcome is a MATCH, or nothing follows on the same generator. */
export async function next<T>(
  iter: AsyncGenerator<T, any, unknown>,
  pred: (v: T) => boolean,
  ms: number,
): Promise<T | undefined> {
  const by = Date.now() + ms;
  for (;;) {
    const remaining = by - Date.now();
    if (remaining <= 0) return undefined;
    const r = await Promise.race([
      iter.next(),
      new Promise<"timeout">((res) => setTimeout(() => res("timeout"), remaining)),
    ]);
    if (r === "timeout" || r.done) return undefined;
    if (pred(r.value)) return r.value;
  }
}

export const tree = (id: string, title = "ok") => ({
  uid: UID,
  name: "fixture",
  sessions: [{ id, title }],
  at: 1_700_000_000_000,
});

test(
  "run-11 h1-1: an oversized chunked tree faults at the relay cap WITHOUT any stringify of the frame; the subscription survives",
  { timeout: 60_000 },
  async () => {
    const f = await setup();
    // Probe the serialization seam: the mux relay call is
    // JSON.stringify({sub, frame}). Flag any call of that shape whose frame
    // carries the oversized marker. The other stringifiers of this frame —
    // the device-side chunker (JSON.stringify(frame), before the frame is
    // chunked) and the monitor's own seam (JSON.stringify(frame.tree)) — do
    // not match the {sub, frame} shape and are out of h1-1's scope.
    const MARKER = "r11-h1-1-oversized-marker";
    const orig = JSON.stringify;
    let relaySeamViolations = 0;
    JSON.stringify = function (...args: unknown[]) {
      const value = args[0] as {
        sub?: unknown;
        frame?: { tree?: { sessions?: { title?: unknown }[] } };
      } | null;
      if (
        value !== null &&
        typeof value === "object" &&
        typeof value.sub === "string" &&
        typeof value.frame?.tree?.sessions?.[0]?.title === "string" &&
        (value.frame.tree.sessions[0].title as string).includes(MARKER)
      )
        relaySeamViolations++;
      return (orig as (...a: unknown[]) => string).apply(JSON, args);
    } as typeof JSON.stringify;
    try {
      await f.waitOnline();
      const tab = await openTab(f.base, [`${DEVICE_ID}/device`]);
      await f.waitForMuxSubscribe();

      // 1 session (session-count policy passes) with a >4 MiB title: ONLY the
      // relay byte cap can fault. Chunked exactly like a real device does.
      const title = MARKER + "z".repeat(5 * 1024 * 1024);
      f.broadcastChunked({
        type: "tree",
        tree: { ...tree("huge"), sessions: [{ id: "huge", title }] },
      });

      const fault = await next(
        tab.frames(),
        (fr) =>
          fr.frame.type === "fault" && String(fr.frame.error?.message ?? "").includes("relay cap"),
        20_000,
      );
      assert.ok(fault, "the oversized chunked tree must fault at the relay cap");
      assert.equal(fault.frame.error.code, "invalid");
      assert.match(fault.frame.error.message, /relay cap \(4194304 bytes\)/);

      // h1-1 core claim: the multi-MiB frame never reached JSON.stringify at
      // the relay serialization seam.
      assert.equal(
        relaySeamViolations,
        0,
        "the oversized frame must fault on rawBytes BEFORE the relay stringify",
      );
      // A cap fault is a fault, never a silent drop: neither counter moves.
      assert.equal(f.mux.relayStats().coalescedTreeFrames, 0, "cap fault ≠ coalesce");
      assert.equal(f.mux.relayStats().droppedTreeFrames, 0, "cap fault ≠ session-policy drop");

      // Skip, not cut: a legal tree right after the fault still relays.
      f.sendToDevice({ type: "tree", tree: tree("after") });
      const after = await next(tab.frames(), (fr) => fr.frame.type === "tree", 10_000);
      assert.ok(after, "subscription survives the cap fault");
      assert.equal(after.frame.tree.sessions[0].id, "after");
    } finally {
      JSON.stringify = orig;
      await f.cleanup();
    }
  },
);

test(
  "run-11 h4-5: 10 back-to-back legal trees → ≤5 relayed and coalescedTreeFrames set via relayStats()",
  { timeout: 60_000 },
  async () => {
    const f = await setup();
    try {
      await f.waitOnline();
      const tab = await openTab(f.base, [`${DEVICE_ID}/device`]);
      await f.waitForMuxSubscribe();

      for (let i = 0; i < 10; i++) f.sendToDevice({ type: "tree", tree: tree(`t${i}`) });

      // Drain the burst window. run-15 u1-1 re-timing (NOT deletion): the
      // old "drain until 1.2 s of silence" window waited straight through the
      // new deferred flush (armed at ≥600 ms after the LAST refused tree) and
      // would count the flushed NEWEST tree as a burst relay, breaking the
      // relays+coalesced accounting below. The window now closes as soon as
      // all 10 trees are accounted for (relayed + coalesced) — that happens
      // within ms of the burst, long before any timer can fire — and the
      // deferred-flush convergence itself is pinned in relay-stale-r15.test.ts.
      const seen = new Set<string>();
      const iter = tab.frames();
      const by = Date.now() + 15_000;
      while (Date.now() < by) {
        const r = await Promise.race([
          iter.next(),
          new Promise<"idle">((res) => setTimeout(() => res("idle"), 150)),
        ]);
        if (r !== "idle" && !r.done && r.value.frame.type === "tree")
          for (const s of r.value.frame.tree.sessions) seen.add(s.id);
        if (r !== "idle" && r.done) break;
        if (seen.size + f.mux.relayStats().coalescedTreeFrames >= 10) break;
      }
      const relayed = seen.size;
      assert.ok(relayed >= 1, "the first tree after connect always relays");
      assert.ok(
        relayed <= 5,
        `the burst must coalesce to ≤5 relays, got ${relayed} (${[...seen]})`,
      );
      const stats = f.mux.relayStats();
      assert.ok(
        stats.coalescedTreeFrames >= 10 - 5,
        `coalescedTreeFrames must be set (≥5), got ${stats.coalescedTreeFrames}`,
      );
      assert.equal(
        stats.coalescedTreeFrames + relayed,
        10,
        "every burst tree either relays or is coalesced inside the burst window — nothing else drops small legal trees (the deferred flush lands ≥600 ms later, OUTSIDE this re-timed window)",
      );
    } finally {
      await f.cleanup();
    }
  },
);

test(
  "run-11 h4-5/h1-1: a single legal chunked tree relays VERBATIM through the rawBytes path",
  { timeout: 60_000 },
  async () => {
    const f = await setup();
    try {
      await f.waitOnline();
      const tab = await openTab(f.base, [`${DEVICE_ID}/device`]);
      await f.waitForMuxSubscribe();

      // >64 KiB so it actually travels as multiple chunks (the reassembled
      // frame carries a WeakMap rawBytes entry), with multibyte content at a
      // chunk-boundary-prone offset; <256 KiB so the monitor's own seam also
      // admits it (keeps the fixture's device state clean).
      const payload = "v".repeat(120_000) + "𝄞漢";
      const sent = { ...tree("one"), sessions: [{ id: "one", title: payload }] };
      f.broadcastChunked({ type: "tree", tree: sent });

      const got = await next(tab.frames(), (fr) => fr.frame.type === "tree", 20_000);
      assert.ok(got, "the chunked tree must relay");
      assert.deepEqual(got.frame.tree, sent, "byte-identical after reassembly + relay");
      assert.equal(f.mux.relayStats().coalescedTreeFrames, 0, "a single tree is never coalesced");
      assert.equal(f.mux.relayStats().droppedTreeFrames, 0);
    } finally {
      await f.cleanup();
    }
  },
);

test(
  "run-11 cold-review f1: a near-cap chunked tree (wrapper ≈ cap−200) relays VERBATIM — the raw-bytes pre-check must not over-fault the legal band",
  { timeout: 60_000 },
  async () => {
    const f = await setup();
    try {
      await f.waitOnline();
      const tab = await openTab(f.base, [`${DEVICE_ID}/device`]);
      await f.waitForMuxSubscribe();

      // Size the frame so the FULL relay wrapper ({sub, frame}) lands ~200 B
      // under RELAY_TREE_CAP_BYTES — inside the band the withdrawn 512 B
      // constant allowance used to over-fault (overhead is really
      // 17 + escaped-key bytes ≈ 35 B here). Computed from the exact same
      // JSON.stringify the hub runs, so the fixture cannot drift.
      const CAP = 4 * 1024 * 1024;
      const subKey = `${DEVICE_ID}/device`;
      const titleFor = (pad: number) => "n".repeat(pad);
      const wrapperLen = (pad: number) =>
        JSON.stringify({ sub: subKey, frame: { type: "tree", tree: tree("near", titleFor(pad)) } })
          .length;
      let lo = 1024;
      let hi = CAP;
      while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        if (wrapperLen(mid) <= CAP - 200) lo = mid;
        else hi = mid - 1;
      }
      const sent = tree("near", titleFor(lo));
      assert.ok(
        wrapperLen(lo) > CAP - 512,
        `fixture must land inside the previously over-faulted band, got ${wrapperLen(lo)}`,
      );
      f.broadcastChunked({ type: "tree", tree: sent });

      const got = await next(tab.frames(), (fr) => fr.frame.type === "tree", 20_000);
      assert.ok(got, `a legal near-cap chunked tree must relay (wrapper ${wrapperLen(lo)} ≤ cap−200)`);
      assert.deepEqual(got.frame.tree, sent, "byte-identical after reassembly + relay");
      const stats = f.mux.relayStats();
      assert.equal(stats.coalescedTreeFrames, 0, "a single tree is never coalesced");
      assert.equal(stats.droppedTreeFrames, 0);
    } finally {
      await f.cleanup();
    }
  },
);
