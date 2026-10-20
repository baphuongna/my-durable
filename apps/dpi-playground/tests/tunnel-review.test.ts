/**
 * Review 2026-10-20 regressions — hub transport (Cluster C).
 * F08 stale rotation intent from an old epoch is cleared on handshake (no UNIQUE crash, no hub kill).
 * F09 a foreign tunnel-chunk cannot settle the victim's pending request; the sender is cut.
 * F13 pending-handshake reservation is held until the application handshake completes.
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
import { TunnelDispatcher, TunnelTransport } from "../apps/dpi-playground-hub/src/tunnel-transport.js";
import { RotationService } from "../apps/dpi-playground-hub/src/rotation.js";
import type { NetworkDevice } from "../../dpi-sdk/src/models.js";

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

async function fixture(policy?: ConstructorParameters<typeof TunnelServer>[4]) {
  const dir = await mkdtemp(join(tmpdir(), "dpi-trev-"));
  const registry = new NetworkRegistry(join(dir, "net.sqlite"));
  registry.clearTunnelState();
  const audit = new Audit(registry);
  const tunnel = new TunnelServer(registry, audit, HUB_ID, {}, policy);
  const dispatcher = new TunnelDispatcher(tunnel, { audit });
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
  const server = createServer();
  server.on("upgrade", (req, socket, head) => tunnel.handleUpgrade(req, socket, head));
  await new Promise<void>((d) => server.listen(0, "127.0.0.1", d));
  const port = (server.address() as { port: number }).port;
  /** Open + handshake a device ws; resolves once hello arrived. */
  const connect = async (d: DeviceRow): Promise<WebSocket> => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/tunnel`, { headers: { authorization: `Bearer ${d.token}` } });
    await new Promise<void>((res, rej) => {
      ws.once("open", res);
      ws.once("unexpected-response", (_q, r) => rej(new Error(`upgrade ${r.statusCode}`)));
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
    await new Promise<void>((d) => server.close(() => d()));
    server.closeAllConnections();
    await rm(dir, { recursive: true, force: true });
  };
  return { registry, audit, tunnel, dispatcher, addDevice, connect, cleanup, port };
}

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
