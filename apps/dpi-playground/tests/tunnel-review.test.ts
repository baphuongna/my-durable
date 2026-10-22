/**
 * Review 2026-10-20 regressions — hub transport (Cluster C).
 * F08 stale rotation intent from an old epoch is cleared on handshake (no UNIQUE crash, no hub kill).
 * F09 a foreign tunnel-chunk cannot settle the victim's pending request; the sender is cut.
 * F13 pending-handshake reservation is held until the application handshake completes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { Audit } from "../apps/dpi-playground-hub/src/audit.js";
import { TunnelServer } from "../apps/dpi-playground-hub/src/tunnel.js";
import { TunnelDispatcher, TunnelTransport } from "../apps/dpi-playground-hub/src/tunnel-transport.js";
import { RotationService } from "../apps/dpi-playground-hub/src/rotation.js";
import type { NetworkDevice } from "../../dpi-sdk/src/models.js";
import { ByteBudget, sendChunked } from "../../dpi-sdk/src/node/chunk.js";
import { makeTestCa, trustedAgent } from "./harness/ca.js";
import { bootCaddyDeploy, CADDY_BINARY, type CaddyHandle } from "./harness/caddy.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const HUB_ID = "0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c99";
const mint = () => "dpt_" + Buffer.from(randomUUID() + randomUUID()).toString("base64url").slice(0, 43);

interface DeviceRow {
  id: string;
  uid: string;
  epoch: string;
  credentialId: string;
  token: string;
}

async function fixture(
  policy?: ConstructorParameters<typeof TunnelServer>[4],
  dispatcherOptions?: ConstructorParameters<typeof TunnelDispatcher>[1],
) {
  const dir = await mkdtemp(join(tmpdir(), "dpi-trev-"));
  const registry = new NetworkRegistry(join(dir, "net.sqlite"));
  registry.clearTunnelState();
  const audit = new Audit(registry);
  const tunnel = new TunnelServer(registry, audit, HUB_ID, {}, policy);
  const dispatcher = new TunnelDispatcher(tunnel, { audit, ...dispatcherOptions });
  const addDevice = (id: string): DeviceRow => {
    const uid = randomUUID();
    const epoch = randomUUID();
    const token = mint();
    const credentialId = randomUUID();
    const t0 = Date.now();
    registry.db
      .prepare(
        `INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,created_at,updated_at,transport)
         VALUES(?, 'T Dev', 'url', NULL, NULL, 'ui', 0, ?, 'checking', ?, ?, 'tunnel')`,
      )
      .run(id, uid, t0, t0);
    registry.db
      .prepare(
        `INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at)
         VALUES(?,?,?,?,'paired',1,?,?,?)`,
      )
      .run(id, epoch, "pub", `sha256:${"9".repeat(64)}`, t0, t0, t0);
    registry.db
      .prepare(
        `INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at,confirmed_at)
         VALUES(?,?,?,?,?,'current',?,?)`,
      )
      .run(credentialId, id, epoch, 1, sha(token), t0, t0);
    return { id, uid, epoch, credentialId, token };
  };
  const server = createServer((req, res) => res.writeHead(req.url === "/healthz" ? 200 : 404).end());
  server.on("upgrade", (req, socket, head) => tunnel.handleUpgrade(req, socket, head));
  await new Promise<void>((d) => server.listen(0, "127.0.0.1", d));
  const port = (server.address() as { port: number }).port;
  /** Open + handshake a device ws; resolves once hello arrived. */
  const connect = async (d: DeviceRow): Promise<WebSocket> => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/tunnel`, { headers: { authorization: `Bearer ${d.token}` } });
    await new Promise<void>((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
      ws.once("unexpected-response", (_q, r) => {
        r.resume();
        rej(new Error(`upgrade ${r.statusCode}`));
      });
    });
    ws.send(JSON.stringify({
      type: "pair-handshake", v: 1, deviceUid: d.uid, deviceId: d.id, pairingEpoch: d.epoch,
      credentialId: d.credentialId, generation: 1, apiVersion: 1, tunnelProto: 1,
      keyFingerprint: `sha256:${"9".repeat(64)}`,
    }));
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
    tunnel.close();
    server.closeAllConnections();
    await new Promise<void>((d) => server.close(() => d()));
    await rm(dir, { recursive: true, force: true });
  };
  return { registry, audit, tunnel, dispatcher, addDevice, connect, cleanup, port };
}

test("R01: chunked reader payloads cannot bypass device frame validation", async () => {
  const f = await fixture();
  const ctl = new AbortController();
  try {
    const device = f.addDevice("r01-reader");
    const ws = await f.connect(device);
    const iterator = f.dispatcher.watch(device.id, { path: "/v1/events", consumerId: "review" }, ctl.signal)[Symbol.asyncIterator]();
    const subscribed = once(ws, "message");
    const first = iterator.next();
    const [raw] = await subscribed;
    const subscription = JSON.parse(raw.toString());
    const send = (value: unknown) => sendChunked(
      value, { kind: "tunnel-data", subscriptionId: subscription.subscriptionId, sub: subscription.sub },
      (chunk) => ws.send(JSON.stringify(chunk)),
    );
    assert.ok(send({ type: "network", devices: [] }).ok);
    assert.equal((await first).value?.type, "fault", "an invalid inner frame faults the reader, never the global network");
    const next = iterator.next();
    const payload = "漢𝄞".repeat(20_000);
    assert.ok(send({ type: "doc", kind: "fixture", value: payload }).ok);
    assert.deepEqual((await next).value, { type: "doc", kind: "fixture", value: payload });
    assert.equal(ws.readyState, WebSocket.OPEN, "the isolated bad reader frame does not break the tunnel");
    ws.close();
  } finally {
    ctl.abort();
    await f.cleanup();
  }
});

test("F08 regression: rotation intent from a DEAD epoch is cleared at handshake — no UNIQUE crash, tunnel stays up", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-f08-"));
  const registry = new NetworkRegistry(join(dir, "net.sqlite"));
  registry.clearTunnelState();
  const audit = new Audit(registry);
  const tunnel = new TunnelServer(registry, audit, HUB_ID);
  const rotation = new RotationService(registry, audit, tunnel, { cacheTtlMs: 1 }); // cache always expired
  const server = createServer();
  server.on("upgrade", (req, socket, head) => tunnel.handleUpgrade(req, socket, head));
  await new Promise<void>((d) => server.listen(0, "127.0.0.1", d));
  const port = (server.address() as { port: number }).port;
  try {
    const t0 = Date.now();
    const uid = randomUUID();
    const oldEpoch = randomUUID();
    const newEpoch = randomUUID();
    registry.db
      .prepare(
        `INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,created_at,updated_at,transport)
         VALUES('f08-dev','F08','url',NULL,NULL,'ui',0,?,'checking',?,?, 'tunnel')`,
      )
      .run(uid, t0, t0);
    registry.db
      .prepare(
        `INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at)
         VALUES(?,?,?,?,'paired',2,?,?,?)`,
      )
      .run("f08-dev", newEpoch, "pub", `sha256:${"9".repeat(64)}`, t0, t0, t0);
    // The live credential of the NEW epoch (what the device actually holds).
    const newToken = mint();
    registry.db
      .prepare(
        `INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at,confirmed_at)
         VALUES(?,?,?,?,?,'current',?,?)`,
      )
      .run(randomUUID(), "f08-dev", newEpoch, 2, sha(newToken), t0, t0);
    // STALE rotation intent left by the old epoch (the re-pair bug): target
    // credential belongs to the OLD epoch that no longer exists.
    const staleTarget = randomUUID();
    registry.db
      .prepare(
        `INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at,revoked_at)
         VALUES(?,?,?,3,?,'revoked',?,?)`,
      )
      .run(staleTarget, "f08-dev", oldEpoch, sha(mint()), t0, t0);
    registry.db
      .prepare("UPDATE pairings SET rotation_id=?, rotation_target_credential_id=?, rotation_started_at=? WHERE device_id=?")
      .run(randomUUID(), staleTarget, t0, "f08-dev");

    const row = registry.db.prepare("SELECT credential_id FROM tunnel_credentials WHERE device_id=? AND pairing_epoch=?").get("f08-dev", newEpoch) as { credential_id: string };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/tunnel`, { headers: { authorization: `Bearer ${newToken}` } });
    await new Promise<void>((d) => ws.once("open", d));
    let sawHello = false;
    ws.on("message", (buf: Buffer) => {
      if (JSON.parse(buf.toString()).type === "hello") sawHello = true;
    });
    ws.send(JSON.stringify({
      type: "pair-handshake", v: 1, deviceUid: uid, deviceId: "f08-dev", pairingEpoch: newEpoch,
      credentialId: row.credential_id, generation: 2, apiVersion: 1, tunnelProto: 1, keyFingerprint: `sha256:${"9".repeat(64)}`,
    }));
    await new Promise((r) => setTimeout(r, 400));
    // The stale intent was cleared — NOT recovered (no second 'current', no crash).
    const p = registry.db.prepare("SELECT rotation_id, rotation_target_credential_id FROM pairings WHERE device_id='f08-dev'").get() as { rotation_id: string | null; rotation_target_credential_id: string | null };
    assert.equal(p.rotation_id, null, "stale rotation intent cleared");
    assert.equal(p.rotation_target_credential_id, null);
    const currents = registry.db.prepare("SELECT COUNT(*) c FROM tunnel_credentials WHERE device_id='f08-dev' AND status='current'").get() as { c: number };
    assert.equal(currents.c, 1, "exactly one current credential (no UNIQUE-violating recovery mint)");
    const cleared = registry.db.prepare("SELECT COUNT(*) c FROM events WHERE action='rotation.stale_cleared'").get() as { c: number };
    assert.ok(cleared.c >= 1, "stale clear is audited");
    assert.ok(sawHello, "handshake completed — the hub process survived");
    ws.close();
  } finally {
    tunnel.close();
    await new Promise<void>((d) => server.close(() => d()));
    server.closeAllConnections();
    await rm(dir, { recursive: true, force: true });
  }
  void rotation;
});

test("F09 regression: foreign tunnel-chunk cannot settle the victim's request; the ATTACKER is cut", async () => {
  const f = await fixture();
  try {
    const victim = f.addDevice("f09-victim");
    const attacker = f.addDevice("f09-attacker");
    const victimWs = await f.connect(victim);
    const attackerWs = await f.connect(attacker);

    // Hub→victim request that the victim leaves pending.
    const victimRow = { id: victim.id, transport: "tunnel" } as unknown as NetworkDevice;
    const transport = new TunnelTransport(victimRow, f.dispatcher);
    const result = transport.request({ method: "GET", path: "/v1/tree" }, AbortSignal.timeout(5000));
    let victimReqId = "";
    await new Promise<void>((res) => {
      victimWs.on("message", (buf: Buffer) => {
        const msg = JSON.parse(buf.toString());
        if (msg.type === "rest-request") {
          victimReqId = msg.reqId;
          res();
        }
      });
    });

    // The attacker sends a rest-response chunk carrying the VICTIM's reqId.
    attackerWs.send(JSON.stringify({
      type: "tunnel-chunk", v: 1, kind: "rest-response", reqId: victimReqId,
      messageId: randomUUID(), index: 0, count: 1, totalBytes: 8, data: Buffer.from("x".repeat(8)).toString("base64"),
    }));
    await new Promise((r) => setTimeout(r, 300));

    // Attacker is denied + closed; the victim's request is UNAFFECTED.
    assert.notEqual(attackerWs.readyState, WebSocket.OPEN, "attacker connection cut");
    const denied = f.registry.db.prepare("SELECT detail_json FROM events WHERE action='auth.denied'").all() as { detail_json: string }[];
    assert.ok(denied.some((e) => e.detail_json.includes("foreign_chunk")), "foreign chunk audited");
    // The victim now answers normally — the hub must deliver 200, not a 502.
    victimWs.send(JSON.stringify({ type: "rest-response", reqId: victimReqId, status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }));
    const res = await result;
    assert.equal(res.status, 200, "victim request settled by its OWNER, never by the attacker's chunk");
    victimWs.close();
  } finally {
    await f.cleanup();
  }
});

test("F09 follow-up: late own chunks after timeout or completion are ignored without closing the tunnel", async () => {
  const budget = new ByteBudget("late-response-test", 32 * 1024 * 1024);
  const f = await fixture(undefined, { deadlineMs: 1000, budget });
  try {
    const d = f.addDevice("f09-late");
    const ws = await f.connect(d);
    const transport = new TunnelTransport({ id: d.id, transport: "tunnel" }, f.dispatcher);
    const firstRequest = new Promise<string>((resolve) => {
      ws.once("message", (buf: Buffer) => resolve(JSON.parse(buf.toString()).reqId));
    });
    const expired = assert.rejects(
      transport.request({ method: "GET", path: "/v1/tree" }, AbortSignal.timeout(5000)),
      (e: { status?: number }) => e.status === 504,
    );
    const expiredReqId = await firstRequest;
    await expired;
    assert.equal(budget.used, 0);

    const lateChunk = (reqId: string) => ws.send(JSON.stringify({
      type: "tunnel-chunk", v: 1, kind: "rest-response", reqId,
      messageId: randomUUID(), index: 0, count: 1, totalBytes: 16 * 1024 * 1024,
      data: Buffer.from("late").toString("base64"),
    }));
    let completedReqId = "";
    ws.on("message", (buf: Buffer) => {
      const msg = JSON.parse(buf.toString());
      if (msg.type === "rest-request" && ws.readyState === WebSocket.OPEN) {
        completedReqId = msg.reqId;
        ws.send(JSON.stringify({ type: "rest-response", reqId: msg.reqId, status: 200, body: "ok" }));
      }
    });

    lateChunk(expiredReqId);
    assert.equal((await transport.request({ method: "GET", path: "/v1/tree" }, AbortSignal.timeout(5000))).status, 200);
    lateChunk(completedReqId);
    // A second round-trip is an ordering barrier for the second late chunk.
    assert.equal((await transport.request({ method: "GET", path: "/v1/tree" }, AbortSignal.timeout(5000))).status, 200);
    assert.equal(ws.readyState, WebSocket.OPEN);
    assert.equal(budget.used, 0, "late chunks never reserve their advertised 16 MiB");
    const denied = f.registry.db.prepare("SELECT COUNT(*) c FROM events WHERE action='auth.denied'").get() as { c: number };
    assert.equal(denied.c, 0, "own settled correlations are not foreign-response attacks");
    ws.close();
  } finally {
    await f.cleanup();
  }
});

test("RR: a late answer to an abandoned request survives normal-traffic FIFO churn (no false foreign_response)", async () => {
  const budget = new ByteBudget("abandoned-grace-test", 32 * 1024 * 1024);
  const f = await fixture(undefined, { deadlineMs: 800, budget });
  try {
    const d = f.addDevice("rr-abandoned");
    const ws = await f.connect(d);
    const transport = new TunnelTransport({ id: d.id, transport: "tunnel" }, f.dispatcher);
    // R1: the device never answers within the deadline; the hub abandons the request.
    const silent = new Promise<string>((resolve) => {
      const on = (buf: Buffer) => {
        const msg = JSON.parse(buf.toString());
        if (msg.type === "rest-request") {
          ws.off("message", on);
          resolve(msg.reqId);
        }
      };
      ws.on("message", on);
    });
    const timedOut = assert.rejects(
      transport.request({ method: "GET", path: "/v1/tree" }, AbortSignal.timeout(10_000)),
      (e: { status?: number }) => e.status === 504,
    );
    const silentReqId = await silent;
    await timedOut;
    // Normal traffic churns the settled FIFO far past its 256-entry cap.
    ws.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.type === "rest-request" && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "rest-response", reqId: msg.reqId, status: 200, body: "ok" }));
    });
    for (let i = 0; i < 300; i++)
      assert.equal((await transport.request({ method: "GET", path: "/v1/tree" }, AbortSignal.timeout(5_000))).status, 200, `round trip ${i}`);
    // NOW the device answers the abandoned request (plain and chunked): benign, never foreign.
    ws.send(JSON.stringify({ type: "rest-response", reqId: silentReqId, status: 200, body: "late" }));
    ws.send(JSON.stringify({
      type: "tunnel-chunk", v: 1, kind: "rest-response", reqId: silentReqId,
      messageId: randomUUID(), index: 0, count: 1, totalBytes: 16 * 1024 * 1024,
      data: Buffer.from("late").toString("base64"),
    }));
    // A round trip is the ordering barrier for both late frames.
    assert.equal((await transport.request({ method: "GET", path: "/v1/tree" }, AbortSignal.timeout(5_000))).status, 200);
    assert.equal(ws.readyState, WebSocket.OPEN, "the tunnel survives a late own response after heavy churn");
    assert.equal(budget.used, 0, "late frames never reserve their advertised bytes");
    const denied = f.registry.db.prepare("SELECT COUNT(*) c FROM events WHERE action='auth.denied'").get() as { c: number };
    assert.equal(denied.c, 0, "an abandoned own correlation is not a foreign-response attack");
    ws.close();
  } finally {
    await f.cleanup();
  }
});

test("F09 follow-up: settling a request releases its partial assembly before late chunks are ignored", async () => {
  const budget = new ByteBudget("partial-response-test", 256_000);
  const f = await fixture(undefined, { deadlineMs: 2000, budget });
  try {
    const d = f.addDevice("f09-partial");
    const ws = await f.connect(d);
    const transport = new TunnelTransport({ id: d.id, transport: "tunnel" }, f.dispatcher);
    let tail = "";
    const partialSent = new Promise<void>((resolve) => {
      ws.once("message", (buf: Buffer) => {
        const req = JSON.parse(buf.toString());
        const chunks: string[] = [];
        const sent = sendChunked(
          { type: "rest-response", reqId: req.reqId, status: 200, body: "x".repeat(100_000) },
          { kind: "rest-response", reqId: req.reqId },
          (chunk) => chunks.push(JSON.stringify(chunk)),
        );
        assert.ok(sent.ok);
        ws.send(chunks[0]);
        tail = chunks[1];
        resolve();
      });
    });
    const expired = assert.rejects(
      transport.request({ method: "GET", path: "/v1/tree" }, AbortSignal.timeout(5000)),
      (e: { status?: number }) => e.status === 504,
    );
    await partialSent;
    const pong = once(ws, "pong");
    ws.ping();
    await pong; // server processed the partial chunk before this ordering barrier
    assert.ok(budget.used > 100_000, "a live partial response was admitted");
    await expired;
    assert.equal(budget.used, 0, "settlement releases the partial buffer immediately, not 30 seconds later");
    ws.on("message", (buf: Buffer) => {
      const req = JSON.parse(buf.toString());
      if (req.type === "rest-request")
        ws.send(JSON.stringify({ type: "rest-response", reqId: req.reqId, status: 200, body: "ok" }));
    });
    ws.send(tail);
    assert.equal((await transport.request({ method: "GET", path: "/v1/tree" }, AbortSignal.timeout(5000))).status, 200);
    assert.equal(budget.used, 0);
    ws.close();
  } finally {
    await f.cleanup();
  }
});

test("F10 follow-up: real WSS clients through reference Caddy have separate, spoof-resistant IP quotas", { timeout: 30_000 }, async () => {
  const f = await fixture({ ipPerMinute: 1, globalPerMinute: 120 });
  let ca: Awaited<ReturnType<typeof makeTestCa>> | undefined;
  let caddy: CaddyHandle | undefined;
  let agent: Awaited<ReturnType<typeof trustedAgent>> | undefined;
  try {
    ca = await makeTestCa();
    agent = await trustedAgent(ca);
    const adminHash = execFileSync(CADDY_BINARY, ["hash-password", "--plaintext", "tunnel-proxy-test-only"], { encoding: "utf8" }).trim();
    caddy = await bootCaddyDeploy({
      hubPort: f.port, certFile: join(ca.dir, "hub.crt"), keyFile: join(ca.dir, "hub.key"), adminHash,
    });
    const attempt = (from: string, forgedIp: string) => new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(caddy!.httpsBase.replace("https:", "wss:") + "/api/tunnel", {
        agent, localAddress: from, handshakeTimeout: 3000,
        headers: { authorization: `Bearer ${mint()}`, "x-forwarded-for": forgedIp },
      });
      ws.once("error", reject);
      ws.once("open", () => {
        ws.terminate();
        reject(new Error("unknown credential unexpectedly upgraded"));
      });
      ws.once("unexpected-response", (req, res) => {
        res.resume();
        res.once("end", () => {
          resolve(res.statusCode!);
          req.destroy();
        });
      });
    });
    assert.equal(await attempt("127.0.0.1", "198.51.100.1"), 401);
    assert.equal(await attempt("127.0.0.2", "127.0.0.1"), 401, "B must not inherit A's exhausted IP bucket");
    assert.equal(await attempt("127.0.0.1", "198.51.100.2"), 429, "forged XFF cannot reset A's bucket");

    const { clientIp } = await import("../apps/dpi-playground-hub/src/client-ip.js");
    const ip = (peer: string, forwarded: string | string[]) =>
      clientIp({ socket: { remoteAddress: peer }, headers: { "x-forwarded-for": forwarded } } as unknown as IncomingMessage);
    assert.equal(ip("198.51.100.9", "203.0.113.9"), "198.51.100.9", "non-loopback peers cannot assert XFF");
    assert.equal(ip("::ffff:198.51.100.9", "203.0.113.9"), "::ffff:198.51.100.9");
    assert.equal(ip("::1", "2001:db8::7"), "2001:db8::7");
    assert.equal(ip("::ffff:7f00:1", "203.0.113.7"), "203.0.113.7");
    assert.equal(ip("127.0.0.1", "203.0.113.7, 198.51.100.8"), "198.51.100.8", "stop at the nearest untrusted hop");
    assert.equal(ip("127.0.0.1", "not-an-ip"), "127.0.0.1");
    assert.equal(ip("127.0.0.1", ["203.0.113.7"]), "127.0.0.1");
  } finally {
    agent?.destroy();
    try {
      await caddy?.stop();
    } finally {
      await f.cleanup();
      if (ca) await rm(ca.dir, { recursive: true, force: true });
    }
  }
});

test("RR: a peer that never answers the close handshake loses its socket after the grace, counters freed at once", async () => {
  const f = await fixture({ teardownGraceMs: 150 } as never);
  try {
    const d = f.addDevice("rr-grace");
    const ws = await f.connect(d);
    assert.equal(f.tunnel.activeCount(), 1);
    // A wedged device: its TCP write path accepts nothing more, so the server's close
    // frame is never echoed and the close handshake never completes.
    const sock = (ws as unknown as { _socket: import("node:net").Socket })._socket;
    const sockClosed = new Promise<void>((res) => sock.once("close", () => res()));
    sock.write = (() => true) as never;
    f.tunnel.closeConnection(d.id, 1000, "wedged test");
    assert.equal(f.tunnel.activeCount(), 0, "counters are released at teardown, not when the peer dies");
    const gone = await Promise.race([sockClosed.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), 3_000))]);
    assert.equal(gone, true, "the server terminated the dead socket after the close grace");
    ws.terminate();
  } finally {
    await f.cleanup();
  }
});

test("F13 follow-up: rejected HTTP upgrades release the pending handshake slot", async () => {
  const f = await fixture({ maxPendingHandshakes: 1, maxAuthenticated: 8 });
  try {
    const d = f.addDevice("f13-rejected");
    const validKey = Buffer.alloc(16, 1).toString("base64");
    for (const headers of [
      { "sec-websocket-version": "13" },
      { "sec-websocket-version": "13", "sec-websocket-key": "invalid" },
      { "sec-websocket-version": "12", "sec-websocket-key": validKey },
      { "sec-websocket-version": "13", "sec-websocket-key": validKey, "sec-websocket-protocol": ",," },
    ]) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(`http://127.0.0.1:${f.port}/api/tunnel`, {
          headers: { connection: "Upgrade", upgrade: "websocket", authorization: `Bearer ${d.token}`, ...headers },
        }, (res) => {
          res.resume();
          res.once("end", () => resolve(res.statusCode!));
        });
        req.once("error", reject);
        req.end();
      });
      assert.equal(status, 400);
      const ws = await f.connect(d);
      assert.equal(ws.readyState, WebSocket.OPEN, "a malformed upgrade must not exhaust cap=1");
      const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
      ws.close();
      await closed;
      assert.equal(f.tunnel.pendingHandshakeCount(), 0, "completion/close never double-releases the slot");
    }
  } finally {
    await f.cleanup();
  }
});

test("F13 regression: pre-handshake sockets hold the pending cap; completed handshakes release it", async () => {
  const f = await fixture({ maxPendingHandshakes: 1, maxAuthenticated: 8 });
  try {
    const d = f.addDevice("f13-dev");
    const token = d.token;
    // Socket 1: valid upgrade, NO application handshake → holds the 1-slot cap.
    const ws1 = new WebSocket(`ws://127.0.0.1:${f.port}/api/tunnel`, { headers: { authorization: `Bearer ${token}` } });
    await new Promise<void>((res) => ws1.once("open", res));
    // Socket 2: must be refused at upgrade while the slot is held.
    const ws2 = new WebSocket(`ws://127.0.0.1:${f.port}/api/tunnel`, { headers: { authorization: `Bearer ${token}` } });
    const status2 = await new Promise<number>((res) => ws2.once("unexpected-response", (_q, r) => res(r.statusCode!)));
    assert.equal(status2, 429, "cap=1 held by a pre-handshake socket");
    // Complete socket 1's handshake → the reservation frees.
    ws1.send(JSON.stringify({
      type: "pair-handshake", v: 1, deviceUid: d.uid, deviceId: d.id, pairingEpoch: d.epoch,
      credentialId: d.credentialId, generation: 1, apiVersion: 1, tunnelProto: 1, keyFingerprint: `sha256:${"9".repeat(64)}`,
    }));
    await new Promise((r) => setTimeout(r, 200));
    // Socket 3: upgrade allowed again.
    const ws3 = new WebSocket(`ws://127.0.0.1:${f.port}/api/tunnel`, { headers: { authorization: `Bearer ${token}` } });
    await new Promise<void>((res, rej) => {
      ws3.once("open", res);
      ws3.once("unexpected-response", (_q, r) => rej(new Error(`upgrade ${r.statusCode}`)));
    });
    ws3.close();
    ws1.close();
  } finally {
    await f.cleanup();
  }
});

test("RR: a credential retired or revoked between the 101 and the handshake is refused at the handshake", async () => {
  const f = await fixture();
  const opened: WebSocket[] = [];
  try {
    const attempt = async (id: string, kill: (d: DeviceRow) => void) => {
      const d = f.addDevice(id);
      const ws = new WebSocket(`ws://127.0.0.1:${f.port}/api/tunnel`, { headers: { authorization: `Bearer ${d.token}` } });
      opened.push(ws);
      await new Promise<void>((res, rej) => {
        ws.once("open", res);
        ws.once("unexpected-response", (_q, r) => rej(new Error(`upgrade ${r.statusCode}`)));
      });
      // The auth snapshot is taken: NOW the credential dies (rotation completed
      // on another connection, or an admin revoke raced the upgrade).
      kill(d);
      // Bounded: a hub that wrongly completes the handshake never closes, which must FAIL the test.
      const outcome = Promise.race([
        new Promise<{ code: number }>((res) => ws.once("close", (code) => res({ code }))),
        new Promise<{ code: number }>((res) => setTimeout(() => res({ code: 0 }), 3_000)),
      ]);
      ws.send(JSON.stringify({
        type: "pair-handshake", v: 1, deviceUid: d.uid, deviceId: d.id, pairingEpoch: d.epoch,
        credentialId: d.credentialId, generation: 1, apiVersion: 1, tunnelProto: 1, keyFingerprint: `sha256:${"9".repeat(64)}`,
      }));
      return outcome;
    };
    const retired = await attempt("hs-retired", (d) =>
      f.registry.db.prepare("UPDATE tunnel_credentials SET status='retired', retired_at=? WHERE credential_id=?").run(Date.now(), d.credentialId));
    assert.equal(retired.code, 1008, "a credential retired after the 101 must not complete the handshake");
    const revoked = await attempt("hs-revoked", (d) =>
      f.registry.db.prepare("UPDATE tunnel_credentials SET status='revoked', revoked_at=? WHERE credential_id=?").run(Date.now(), d.credentialId));
    assert.equal(revoked.code, 1008, "a credential revoked after the 101 must not complete the handshake");
    assert.equal(f.tunnel.activeCount(), 0, "neither connection was registered");
  } finally {
    for (const ws of opened) ws.terminate();
    await f.cleanup();
  }
});

test("RR: a credential that merely became PREVIOUS (rotation in flight) still completes its handshake", async () => {
  const f = await fixture();
  try {
    const d = f.addDevice("hs-previous");
    const ws = new WebSocket(`ws://127.0.0.1:${f.port}/api/tunnel`, { headers: { authorization: `Bearer ${d.token}` } });
    await new Promise<void>((res, rej) => {
      ws.once("open", res);
      ws.once("unexpected-response", (_q, r) => rej(new Error(`upgrade ${r.statusCode}`)));
    });
    // rotateOnline raced the upgrade: the authed 'current' is now 'previous'.
    f.registry.db.prepare("UPDATE tunnel_credentials SET status='previous' WHERE credential_id=?").run(d.credentialId);
    ws.send(JSON.stringify({
      type: "pair-handshake", v: 1, deviceUid: d.uid, deviceId: d.id, pairingEpoch: d.epoch,
      credentialId: d.credentialId, generation: 1, apiVersion: 1, tunnelProto: 1, keyFingerprint: `sha256:${"9".repeat(64)}`,
    }));
    await new Promise<void>((res, rej) => {
      const on = (buf: Buffer) => {
        const msg = JSON.parse(buf.toString());
        if (msg.type === "hello") { ws.off("message", on); res(); }
        if (msg.type === "fault") { ws.off("message", on); rej(new Error(`fault ${msg.error.code}`)); }
      };
      ws.on("message", on);
      ws.once("close", (code) => rej(new Error(`closed ${code} before hello`)));
    });
    assert.equal(f.tunnel.activeCount(), 1, "the previous-generation reconnect path must keep working");
    ws.close();
  } finally {
    await f.cleanup();
  }
});
