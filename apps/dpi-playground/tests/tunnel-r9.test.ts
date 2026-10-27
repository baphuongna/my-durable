/**
 * R9 tunnel robustness — the three P2 fixes from the R8 audit (area 4).
 *
 * 4.1 Grace sets evict by TTL as well as capacity, and an evicted correlation's
 *     late frame is inert (dropped), never a foreign-frame cut: reconnect churn
 *     must not amplify into connection storms. The capacity caps stay as the
 *     hard memory backstop, and never-issued correlations still cut (T-7).
 * 4.3 Un-keyed tunnel mutations carry a deterministic idempotency key, so a
 *     retry after a connection swap replays device-side instead of double-applying.
 * 4.4 Cache-loss recovery mints are rate-limited per device per hour; a flapping
 *     link stops inflating credential generations, and normal rotation is untouched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { Audit } from "../apps/dpi-playground-hub/src/audit.js";
import { TunnelServer } from "../apps/dpi-playground-hub/src/tunnel.js";
import {
  TunnelDispatcher,
  TunnelTransport,
} from "../apps/dpi-playground-hub/src/tunnel-transport.js";
import { RotationService } from "../apps/dpi-playground-hub/src/rotation.js";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const HUB_ID = "99157cf3-2a44-4d55-8b01-7d3a9c0f5e21";
const FINGERPRINT = `sha256:${"7".repeat(64)}`;
const until = async (probe: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (probe()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout waiting for ${what}`);
};

interface DeviceRow {
  id: string;
  uid: string;
  epoch: string;
  credentialId: string;
  token: string;
}

interface Fixture {
  registry: NetworkRegistry;
  audit: Audit;
  tunnel: TunnelServer;
  dispatcher: TunnelDispatcher;
  rotation: RotationService;
  addDevice(id: string): DeviceRow;
  connect(d: DeviceRow, credential?: { credentialId: string; generation: number; token: string }): Promise<WebSocket>;
  cleanup(): Promise<void>;
}

async function fixture(dispatcherOptions?: ConstructorParameters<typeof TunnelDispatcher>[1]): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "dpi-r9-"));
  const registry = new NetworkRegistry(join(dir, "net.sqlite"));
  registry.clearTunnelState();
  const audit = new Audit(registry);
  const tunnel = new TunnelServer(registry, audit, HUB_ID);
  const dispatcher = new TunnelDispatcher(tunnel, { audit, ...dispatcherOptions });
  const rotation = new RotationService(registry, audit, tunnel);
  const addDevice = (id: string): DeviceRow => {
    const uid = randomUUID();
    const epoch = randomUUID();
    const token =
      "dpt_" +
      Buffer.from(randomUUID() + randomUUID())
        .toString("base64url")
        .slice(0, 43);
    const credentialId = randomUUID();
    const t0 = Date.now();
    registry.db
      .prepare(
        `INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,created_at,updated_at,transport)
         VALUES(?, 'R9 Dev', 'url', NULL, NULL, 'ui', 0, ?, 'checking', ?, ?, 'tunnel')`,
      )
      .run(id, uid, t0, t0);
    registry.db
      .prepare(
        `INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at)
         VALUES(?,?,?,?,'paired',1,?,?,?)`,
      )
      .run(id, epoch, "pub", FINGERPRINT, t0, t0, t0);
    registry.db
      .prepare(
        `INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at,confirmed_at)
         VALUES(?,?,?,?,?,'current',?,?)`,
      )
      .run(credentialId, id, epoch, 1, sha256(token), t0, t0);
    return { id, uid, epoch, credentialId, token };
  };
  const server = createServer((req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => tunnel.handleUpgrade(req, socket, head));
  await new Promise<void>((d) => server.listen(0, "127.0.0.1", d));
  const port = (server.address() as { port: number }).port;
  const connect = async (
    d: DeviceRow,
    credential?: { credentialId: string; generation: number; token: string },
  ): Promise<WebSocket> => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/tunnel`, {
      headers: { authorization: `Bearer ${credential?.token ?? d.token}` },
    });
    await new Promise<void>((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
      ws.once("unexpected-response", (_q, r) => {
        r.resume();
        rej(new Error(`upgrade ${r.statusCode}`));
      });
    });
    ws.send(
      JSON.stringify({
        type: "pair-handshake",
        v: 1,
        deviceUid: d.uid,
        deviceId: d.id,
        pairingEpoch: d.epoch,
        credentialId: credential?.credentialId ?? d.credentialId,
        generation: credential?.generation ?? 1,
        apiVersion: 1,
        tunnelProto: 1,
        keyFingerprint: FINGERPRINT,
      }),
    );
    await new Promise<void>((res) => {
      const on = (buf: Buffer) => {
        if (JSON.parse(buf.toString()).type === "hello") {
          ws.off("message", on);
          res();
        }
      };
      ws.on("message", on);
    });
    return ws;
  };
  const cleanup = async () => {
    rotation.close();
    dispatcher.close();
    tunnel.close();
    server.closeAllConnections();
    await new Promise<void>((d) => server.close(() => d()));
    await rm(dir, { recursive: true, force: true });
  };
  return { registry, audit, tunnel, dispatcher, rotation, addDevice, connect, cleanup };
}

/** Wire a device ws that answers every rest-request; returns the frame log. */
const answerAll = (ws: WebSocket) => {
  const seen: { reqId: string; method: string; path: string; idempotencyKey?: string }[] = [];
  ws.on("message", (buf: Buffer) => {
    const msg = JSON.parse(buf.toString());
    if (msg.type === "rest-request" && ws.readyState === WebSocket.OPEN) {
      seen.push(msg);
      ws.send(
        JSON.stringify({ type: "rest-response", reqId: msg.reqId, status: 200, body: "ok" }),
      );
    }
  });
  return seen;
};

const deniedCount = (f: Fixture) =>
  (f.registry.db.prepare("SELECT COUNT(*) c FROM events WHERE action='auth.denied'").get() as { c: number }).c;

// ---------------------------------------------------------------------- 4.1

test("R9-4.1: grace sets evict by TTL; an evicted correlation's late frame is inert — capacity stays the memory backstop, never-issued reqIds still cut", async () => {
  let clock = 0;
  const f = await fixture({ deadlineMs: 250, graceTtlMs: 5_000, now: () => clock });
  try {
    const d = f.addDevice("r9-grace");
    const ws = await f.connect(d);
    const transport = new TunnelTransport({ id: d.id, transport: "tunnel" }, f.dispatcher);
    // A: the device stays silent → the hub abandons it (stamped at fake t=0).
    const silent = new Promise<string>((resolve) => {
      const on = (buf: Buffer) => {
        const msg = JSON.parse(buf.toString());
        if (msg.type === "rest-request") {
          ws.off("message", on);
          resolve(msg.reqId as string);
        }
      };
      ws.on("message", on);
    });
    const timedOut = assert.rejects(
      transport.request({ method: "GET", path: "/v1/tree" }, AbortSignal.timeout(10_000)),
      (e: { status?: number }) => e.status === 504,
    );
    const abandonedReqId = await silent;
    await timedOut;

    // From here the device answers everything; round-trips are ordering barriers.
    answerAll(ws);
    const roundtrip = () =>
      transport.request({ method: "GET", path: "/v1/tree" }, AbortSignal.timeout(5_000));

    // Within the grace TTL: a late frame for the OWN abandoned request is benign.
    clock = 2_000;
    ws.send(
      JSON.stringify({ type: "rest-response", reqId: abandonedReqId, status: 200, body: "late" }),
    );
    assert.equal((await roundtrip()).status, 200);
    assert.equal(ws.readyState, WebSocket.OPEN);
    assert.equal(deniedCount(f), 0, "in-grace late frame is not a foreign-response attack");

    // Churn the settled set far past its cap inside one TTL window: the capacity
    // cap stays the hard memory backstop (bounded at 256).
    for (let i = 0; i < 300; i++)
      assert.equal((await roundtrip()).status, 200, `round trip ${i}`);
    assert.equal(f.dispatcher.graceSizes().settled, 256, "capacity backstop bounds the settled map");

    // Past the TTL the entries are unmatchable and are swept; the late frame for
    // the TTL-evicted correlation is INERT (ring-remembered), never a cut.
    clock = 2_000 + 5_001;
    assert.equal((await roundtrip()).status, 200); // insert sweeps the expired entries
    const sizes = f.dispatcher.graceSizes();
    assert.ok(sizes.settled <= 256, "settled map stays bounded after the TTL sweep");
    assert.ok(sizes.dropped > 0, "expired correlations are remembered as dropped");
    ws.send(
      JSON.stringify({ type: "rest-response", reqId: abandonedReqId, status: 200, body: "later" }),
    );
    assert.equal((await roundtrip()).status, 200);
    assert.equal(ws.readyState, WebSocket.OPEN, "a TTL-evicted own correlation never cuts the tunnel");
    assert.equal(deniedCount(f), 0);

    // A never-issued correlation is still foreign: deny + close 1008 (T-7 intact).
    const closed = new Promise<void>((res) => ws.once("close", res));
    ws.send(
      JSON.stringify({
        type: "rest-response",
        reqId: randomUUID(),
        status: 200,
        body: "attack",
      }),
    );
    await closed;
    assert.equal(deniedCount(f), 1, "never-issued reqId still cuts the sender");
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------- 4.3

test("R9-4.3: un-keyed mutations get a deterministic dpi-auto idempotency key — identical across a connection swap, reads stay un-keyed, client keys win", async () => {
  const f = await fixture();
  try {
    const d = f.addDevice("r9-idem");
    let ws = await f.connect(d);
    const transport = new TunnelTransport({ id: d.id, transport: "tunnel" }, f.dispatcher);
    const seen = answerAll(ws);
    const auto = (method: string, path: string, body: unknown) =>
      "dpi-auto-" + sha256(`${method} ${path}\u0000${JSON.stringify(body)}`);

    await transport.request(
      { method: "POST", path: "/v1/sessions", body: { name: "x" } },
      AbortSignal.timeout(5_000),
    );
    assert.equal(seen[0].idempotencyKey, auto("POST", "/v1/sessions", { name: "x" }));

    // A different body derives a different key.
    await transport.request(
      { method: "POST", path: "/v1/sessions", body: { name: "y" } },
      AbortSignal.timeout(5_000),
    );
    assert.notEqual(seen[1].idempotencyKey, seen[0].idempotencyKey);

    // Reads are never keyed: nothing to deduplicate.
    await transport.request({ method: "GET", path: "/v1/tree" }, AbortSignal.timeout(5_000));
    assert.equal(seen[2].idempotencyKey, undefined);

    // A client-supplied key always wins (the SDK contract is unchanged).
    await transport.request(
      { method: "POST", path: "/v1/sessions", body: { name: "z" }, idempotencyKey: "client-key" },
      AbortSignal.timeout(5_000),
    );
    assert.equal(seen[3].idempotencyKey, "client-key");

    // The swap scenario: the connection dies mid-mutation (hub answers 503,
    // pending abandoned), the device reconnects, the caller retries the SAME
    // mutation — the retry must land on the SAME key so the device-side
    // requests-table replay refuses the duplicate instead of double-applying.
    ws.removeAllListeners("message");
    const firstFrame = new Promise<{ reqId: string; idempotencyKey?: string }>((resolve) => {
      const on = (buf: Buffer) => {
        const msg = JSON.parse(buf.toString());
        if (msg.type === "rest-request") {
          ws.off("message", on);
          resolve(msg);
        }
      };
      ws.on("message", on);
    });
    const swap = transport.request(
      { method: "POST", path: "/v1/sessions", body: { name: "swap" } },
      AbortSignal.timeout(10_000),
    );
    const swapped = await firstFrame; // device received it, connection dies before answering
    ws.terminate();
    await assert.rejects(swap, (e: { status?: number }) => e.status === 503);
    ws = await f.connect(d); // fresh connection, fresh reqId — SAME key required
    const seen2 = answerAll(ws);
    const retried = await transport.request(
      { method: "POST", path: "/v1/sessions", body: { name: "swap" } },
      AbortSignal.timeout(5_000),
    );
    assert.equal(retried.status, 200);
    assert.equal(seen2[0].idempotencyKey, swapped.idempotencyKey, "retry after swap reuses the auto key");
    assert.equal(seen2[0].idempotencyKey, auto("POST", "/v1/sessions", { name: "swap" }));
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------- 4.4

test("R9-4.4: recovery mints are rate-limited per device — the N+1th flap is refused without minting; normal rotation stays untouched", async () => {
  const f = await fixture();
  // A dedicated service with test policy: 40 ms cache TTL, 3 recoveries/hour.
  (f as { rotation?: RotationService }).rotation?.close();
  const dir = await mkdtemp(join(tmpdir(), "dpi-r9-rot-"));
  const registry = new NetworkRegistry(join(dir, "net.sqlite"));
  registry.clearTunnelState();
  const audit = new Audit(registry);
  const tunnel = new TunnelServer(registry, audit, HUB_ID);
  const rotation = new RotationService(registry, audit, tunnel, {
    cacheTtlMs: 40,
    recoveryLimitPerHour: 3,
  });
  const addDevice = (f2: Fixture, id: string): DeviceRow => {
    const uid = randomUUID();
    const epoch = randomUUID();
    const token =
      "dpt_" +
      Buffer.from(randomUUID() + randomUUID())
        .toString("base64url")
        .slice(0, 43);
    const credentialId = randomUUID();
    const t0 = Date.now();
    registry.db
      .prepare(
        `INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,created_at,updated_at,transport)
         VALUES(?, 'R9 Rot', 'url', NULL, NULL, 'ui', 0, ?, 'checking', ?, ?, 'tunnel')`,
      )
      .run(id, uid, t0, t0);
    registry.db
      .prepare(
        `INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at)
         VALUES(?,?,?,?,'paired',1,?,?,?)`,
      )
      .run(id, epoch, "pub", FINGERPRINT, t0, t0, t0);
    registry.db
      .prepare(
        `INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at,confirmed_at)
         VALUES(?,?,?,?,?,'current',?,?)`,
      )
      .run(credentialId, id, epoch, 1, sha256(token), t0, t0);
    return { id, uid, epoch, credentialId, token };
  };
  const server = createServer((req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => tunnel.handleUpgrade(req, socket, head));
  await new Promise<void>((d) => server.listen(0, "127.0.0.1", d));
  const port = (server.address() as { port: number }).port;
  /** Connect the device speaking `cred` (default: its G1 credential) and ignore rotate frames. */
  const connect = async (
    d: DeviceRow,
    apply?: (msg: { pairingEpoch: string; credentialId: string; generation: number; rotationId: string }) => void,
    cred?: { credentialId: string; generation: number; token: string },
  ): Promise<WebSocket> => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/tunnel`, {
      headers: { authorization: `Bearer ${cred?.token ?? d.token}` },
    });
    await new Promise<void>((res, rej) => {
      ws.once("open", res);
      ws.once("unexpected-response", (_q, r) => {
        r.resume();
        rej(new Error(`upgrade ${r.statusCode}`));
      });
    });
    let helloWait: (() => void) | undefined;
    ws.on("message", (buf: Buffer) => {
      const msg = JSON.parse(buf.toString());
      if (msg.type === "hello") {
        if (helloWait) helloWait();
        return;
      }
      if (msg.type === "control" && msg.action === "token-rotate") apply?.(msg);
    });
    ws.send(
      JSON.stringify({
        type: "pair-handshake",
        v: 1,
        deviceUid: d.uid,
        deviceId: d.id,
        pairingEpoch: d.epoch,
        credentialId: cred?.credentialId ?? d.credentialId,
        generation: cred?.generation ?? 1,
        apiVersion: 1,
        tunnelProto: 1,
        keyFingerprint: FINGERPRINT,
      }),
    );
    await new Promise<void>((res) => {
      helloWait = res;
      const on = (buf: Buffer) => {
        if (JSON.parse(buf.toString()).type === "hello") res();
      };
      ws.once("message", on); // resolves on the first hello whichever fires
    });
    return ws;
  };
  const count = (action: string) =>
    (
      registry.db.prepare("SELECT COUNT(*) c FROM events WHERE action=?").get(action) as { c: number }
    ).c;
  const creds = (id: string) =>
    registry.db
      .prepare("SELECT generation, status FROM tunnel_credentials WHERE device_id=? ORDER BY generation")
      .all(id) as { generation: number; status: string }[];
  const pairing = (id: string) =>
    registry.db
      .prepare("SELECT credential_generation, rotation_id FROM pairings WHERE device_id=?")
      .get(id) as { credential_generation: number; rotation_id: string | null };
  try {
    // d1: the asymmetric flap. Online rotation never delivered, cache expires
    // (40 ms), every reconnect on G1 mints the next generation — until the cap.
    const d1 = addDevice(f, "r9-flap");
    let ws = await connect(d1);
    const started = await rotation.startRotation(d1.id, "admin:test");
    assert.equal(started.ok && started.mode, "online", "handshake settled before startRotation");
    await until(() => creds(d1.id).length === 2, 5_000, "online mint G2");
    // One flap = cache expiry → drop the link → reconnect still speaking G1 →
    // the hub recovers from cache loss and mints the next generation. Each mint
    // is awaited: the recovery runs on the hub's handshake, asynchronously.
    const flap = async (expectCreds: number) => {
      await until(
        () => !rotation.plaintextCacheHas(pairing(d1.id).rotation_id ?? ""),
        2_000,
        "cache TTL expiry",
      );
      ws.terminate();
      ws = await connect(d1); // still speaking G1
      await until(() => creds(d1.id).length === expectCreds, 5_000, `recovery mint (G${expectCreds})`);
    };
    await flap(3); // recovery #1
    await flap(4); // recovery #2
    await flap(5); // recovery #3
    assert.equal(pairing(d1.id).credential_generation, 5);
    assert.equal(count("token.rotate_regenerated"), 3);

    // The N+1th recovery is refused: no mint, no growth, audit rate_limited.
    await until(
      () => !rotation.plaintextCacheHas(pairing(d1.id).rotation_id ?? ""),
      2_000,
      "cache TTL expiry before the refused flap",
    );
    ws.terminate();
    ws = await connect(d1);
    await until(() => count("rate_limited") >= 1, 5_000, "the refusal audit row");
    assert.equal(creds(d1.id).length, 5, "no credential row is minted past the limit");
    assert.equal(pairing(d1.id).credential_generation, 5, "generation stops climbing");
    assert.equal(count("token.rotate_regenerated"), 3, "no further recovery mint");
    assert.ok(pairing(d1.id).rotation_id !== null, "rotation stays pending — re-pair is the way out");

    // Normal rotation is NOT blocked (per-device limiter, different code path):
    // d2 starts, delivers and acks a routine rotation while d1 is refused.
    const d2 = addDevice(f, "r9-normal");
    const ws2 = await connect(d2, (msg) => {
      // The device applies and acks over the connection the token arrived on.
      ws2.send(
        JSON.stringify({
          type: "control",
          action: "token-rotate-ack",
          rotationId: msg.rotationId,
          credentialId: msg.credentialId,
          generation: msg.generation,
          pairingEpoch: msg.pairingEpoch,
        }),
      );
    });
    await rotation.startRotation(d2.id, "admin:test");
    await until(() => pairing(d2.id).rotation_id === null, 5_000, "d2 rotation completed");
    assert.equal(creds(d2.id).find((c) => c.generation === 2)?.status, "current");
    assert.equal(creds(d2.id).find((c) => c.generation === 1)?.status, "retired");
    ws.terminate();
    ws2?.terminate();
  } finally {
    rotation.close();
    tunnel.close();
    server.closeAllConnections();
    await new Promise<void>((d) => server.close(() => d()));
    await rm(dir, { recursive: true, force: true });
    await f.cleanup();
  }
});
