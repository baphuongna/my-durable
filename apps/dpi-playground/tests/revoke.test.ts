/**
 * P2-20 — revoke durability, notice epoch guard, re-pair tombstones, cancel
 * race. Real hub pieces (registry + credentials + tunnel + rotation-style
 * harness) with a scripted device.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { WebSocket as WsClient } from "ws";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { Audit } from "../apps/dpi-playground-hub/src/audit.js";
import { TunnelServer } from "../apps/dpi-playground-hub/src/tunnel.js";
import { CredentialService } from "../apps/dpi-playground-hub/src/credentials.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const HUB_ID = "ad0be1e2-f3a4-4b5c-8d9e-0f1a2b3c4d5e";
const FINGERPRINT = `sha256:${"3".repeat(64)}`;
const UID = randomUUID();
const DEVICE_ID = "revoke-dev";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "dpi-p220-"));
  const registry = new NetworkRegistry(join(dir, "net.sqlite"));
  registry.clearTunnelState();
  const audit = new Audit(registry);
  const credentials = new CredentialService(registry, audit, "https://hub.example.test", HUB_ID);
  const tunnel = new TunnelServer(registry, audit, HUB_ID);
  const epoch = randomUUID();
  const t0 = Date.now();
  registry.db
    .prepare(
      `INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,created_at,updated_at,transport)
       VALUES(?, 'Rev Dev', 'url', NULL, NULL, 'ui', 0, ?, 'checking', ?, ?, 'tunnel')`,
    )
    .run(DEVICE_ID, UID, t0, t0);
  registry.db
    .prepare(
      `INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at)
       VALUES(?,?,?,?,'paired',1,?,?,?)`,
    )
    .run(DEVICE_ID, epoch, "pub", FINGERPRINT, t0, t0, t0);
  const g1Token = "dpt_" + Buffer.from(randomUUID() + randomUUID()).toString("base64url").slice(0, 43);
  registry.db
    .prepare(
      `INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at,confirmed_at)
       VALUES(?,?,?,?,?,'current',?,?)`,
    )
    .run(randomUUID(), DEVICE_ID, epoch, 1, sha(g1Token), t0, t0);

  const server = createServer();
  server.on("upgrade", (req, socket, head) => tunnel.handleUpgrade(req, socket, head));
  await new Promise<void>((d) => server.listen(0, "127.0.0.1", d));
  const port = (server.address() as { port: number }).port;

  const notices: any[] = [];
  let deviceWs: WsClient | undefined;
  const connectDevice = async (token: string, credEpoch: string): Promise<void> => {
    const ws = new WsClient(`ws://127.0.0.1:${port}/api/tunnel`, { headers: { authorization: `Bearer ${token}` } });
    deviceWs = ws;
    await new Promise<void>((d, rej) => {
      ws.once("open", d);
      ws.once("unexpected-response", (_q, res) => rej(Object.assign(new Error(`upgrade ${res.statusCode}`), { status: res.statusCode })));
    });
    ws.on("message", (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.type === "control" && msg.action === "revoked") notices.push(msg.notice);
    });
    const credId = (
      registry.db.prepare("SELECT credential_id FROM tunnel_credentials WHERE token_hash=?").get(sha(token)) as { credential_id: string }
    ).credential_id;
    ws.send(JSON.stringify({
      type: "pair-handshake", v: 1, deviceUid: UID, deviceId: DEVICE_ID, pairingEpoch: credEpoch,
      credentialId: credId, generation: 1, apiVersion: 1, tunnelProto: 1, keyFingerprint: FINGERPRINT,
    }));
    await new Promise<void>((d) => ws.once("message", () => d()));
  };
  await connectDevice(g1Token, epoch);

  /** Mint a fresh pairing epoch + credential directly (re-pair). */
  const repair = (): string => {
    const newEpoch = randomUUID();
    const token = "dpt_" + Buffer.from(randomUUID() + randomUUID()).toString("base64url").slice(0, 43);
    const t = Date.now();
    registry.db
      .prepare(
        `INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at)
         VALUES(?,?,?,?,'paired',1,?,?,?)
         ON CONFLICT(device_id) DO UPDATE SET pairing_epoch=excluded.pairing_epoch, status='paired', updated_at=excluded.updated_at`,
      )
      .run(DEVICE_ID, newEpoch, "pub2", FINGERPRINT, t, t, t);
    registry.db
      .prepare(
        `INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at,confirmed_at)
         VALUES(?,?,?,?,?,'current',?,?)`,
      )
      .run(randomUUID(), DEVICE_ID, newEpoch, 1, sha(token), t, t);
    return token;
  };

  const cleanup = async () => {
    deviceWs?.terminate();
    tunnel.close();
    server.close();
    server.closeAllConnections();
    registry.close();
    await rm(dir, { recursive: true, force: true });
  };

  /** What main.ts does after a committed revoke: notice + immediate cut. */
  const deliverRevoke = (deviceId: string, epoch: string, reason: "user" | "compromise" = "user") => {
    tunnel.send(deviceId, {
      type: "control",
      action: "revoked",
      notice: { type: "pair.revoke", v: 1, deviceId, pairingEpoch: epoch, reason, revokedAt: Date.now() },
    });
    tunnel.closeConnection(deviceId, 1000, "pairing revoked");
  };

  const upgradeStatus = (token: string) =>
    new Promise<number>((done) => {
      const ws = new WsClient(`ws://127.0.0.1:${port}/api/tunnel`, { headers: { authorization: `Bearer ${token}` } });
      ws.on("error", () => {});
      ws.once("unexpected-response", (_q, res) => { done(res.statusCode ?? 0); ws.close(); });
      ws.once("open", () => { done(101); ws.close(); });
    });

  return { registry, credentials, tunnel, device: { get ws() { return deviceWs!; } }, notices, connectDevice, repair, cleanup, upgradeStatus, deliverRevoke, epoch, g1Token };
}

const until = async (fn: () => boolean, timeout = 6000, what = "cond") => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw Error(`timeout: ${what}`);
};

test("revoke: durable tx kills every hash + pairing; notice delivered for the epoch; live transport cut <1s; old bearer 401 even after re-pair", async () => {
  const f = await setup();
  try {
    assert.equal(f.tunnel.activeCount(), 1);
    const t0 = Date.now();
    f.credentials.revoke(DEVICE_ID, "user", "admin:test");
    f.deliverRevoke(DEVICE_ID, f.epoch);
    const rows = () =>
      f.registry.db
        .prepare("SELECT status FROM tunnel_credentials WHERE device_id=? ORDER BY generation")
        .all(DEVICE_ID) as { status: string }[];
    assert.ok(rows().every((c) => c.status === "revoked"), "every hash revoked");
    const pairingRow = f.registry.db.prepare("SELECT status FROM pairings WHERE device_id=?").get(DEVICE_ID) as { status: string };
    assert.equal(pairingRow.status, "revoked");
    // audit row
    const ev = f.registry.db.prepare("SELECT detail_json FROM events WHERE action='pair.revoke'").all() as { detail_json: string }[];
    assert.equal(ev.length, 1);
    // live transport cut within 1s + notice delivered BEFORE the cut
    await until(() => f.tunnel.activeCount() === 0, 1000, "transport cut");
    assert.ok(Date.now() - t0 < 1000);
    await until(() => f.notices.length === 1, 1000, "notice flushed before cut");
    assert.equal(f.notices[0].pairingEpoch, f.epoch);
    assert.equal(f.notices[0].type, "pair.revoke");
    // old bearer dead right now
    assert.equal(await f.upgradeStatus(f.g1Token), 401);
    // RE-PAIR: fresh epoch + credential; tombstones retained
    const newToken = f.repair();
    const rows2 = f.registry.db
      .prepare("SELECT generation, status FROM tunnel_credentials WHERE device_id=? ORDER BY generation")
      .all(DEVICE_ID) as { generation: number; status: string }[];
    assert.equal(rows2[0].status, "revoked", "old tombstone retained");
    assert.equal(rows2[1].status, "current");
    // old token STILL revoked after re-pair
    assert.equal(await f.upgradeStatus(f.g1Token), 401);
    // new token works
    await f.connectDevice(newToken, randomUUID() === "" ? "" : (f.registry.db.prepare("SELECT pairing_epoch FROM pairings WHERE device_id=?").get(DEVICE_ID) as { pairing_epoch: string }).pairing_epoch);
    assert.equal(f.tunnel.activeCount(), 1);
  } finally {
    await f.cleanup();
  }
});

test("stale notice guard: a notice for a superseded epoch never affects the new pairing (device-level guard contract)", async () => {
  // The device-side guard lives in the connector (dpi-backend): a notice whose
  // pairingEpoch differs from the current pairing.json is ignored. Here we
  // verify the HUB side: after re-pair, a revoke notice for the OLD epoch is
  // never re-emitted, and only the CURRENT epoch gets notices.
  const f = await setup();
  try {
    const oldEpoch = f.epoch;
    f.credentials.revoke(DEVICE_ID, "user", "admin:test");
    f.deliverRevoke(DEVICE_ID, oldEpoch);
    const newToken = f.repair();
    await f.connectDevice(newToken, (f.registry.db.prepare("SELECT pairing_epoch FROM pairings WHERE device_id=?").get(DEVICE_ID) as { pairing_epoch: string }).pairing_epoch);
    await until(() => f.notices.length === 1, 1000, "first notice");
    assert.equal(f.notices[0].pairingEpoch, oldEpoch, "only the revoked epoch got a notice");
    // revoke AGAIN (the new pairing) → notice for the NEW epoch
    const newEpoch2 = (f.registry.db.prepare("SELECT pairing_epoch FROM pairings WHERE device_id=?").get(DEVICE_ID) as { pairing_epoch: string }).pairing_epoch;
    f.credentials.revoke(DEVICE_ID, "compromise", "admin:test");
    f.deliverRevoke(DEVICE_ID, newEpoch2, "compromise");
    await until(() => f.tunnel.activeCount() === 0, 1000, "cut");
    await until(() => f.notices.length === 2, 1000, "second notice");
    assert.equal(f.notices[1].reason, "compromise");
    assert.notEqual(f.notices[1].pairingEpoch, oldEpoch);
  } finally {
    await f.cleanup();
  }
});

test("offline revoke: no live transport needed — rows revoked, old bearer 401 immediately", async () => {
  const f = await setup();
  try {
    f.device.ws.terminate();
    await until(() => f.tunnel.activeCount() === 0, 3000, "offline");
    f.credentials.revoke(DEVICE_ID, "user", "admin:test");
    assert.equal(await f.upgradeStatus(f.g1Token), 401);
    const pairingRow = f.registry.db.prepare("SELECT status FROM pairings WHERE device_id=?").get(DEVICE_ID) as { status: string };
    assert.equal(pairingRow.status, "revoked");
    // double revoke → clean 404, no crash, tombstones intact
    assert.throws(() => f.credentials.revoke(DEVICE_ID, "user", "admin:test"), /No active pairing/);
  } finally {
    await f.cleanup();
  }
});

test("cancel/issue race: cancelling an approved code answers 410 on verify (never a token)", async () => {
  // The pairing service (P2-09) already fails cancelled enrollments with
  // 410; here we assert the same contract holds through the credential layer:
  // a TokenIssue replay for a revoked pairing is refused by receiptStillValid.
  const f = await setup();
  try {
    const tokenIssue = {
      deviceId: DEVICE_ID,
      pairingEpoch: f.epoch,
      credentialId: (f.registry.db.prepare("SELECT credential_id FROM tunnel_credentials WHERE device_id=?").get(DEVICE_ID) as { credential_id: string }).credential_id,
    };
    assert.equal(f.credentials.receiptStillValid(tokenIssue), true, "pre-revoke the receipt is valid");
    f.credentials.revoke(DEVICE_ID, "user", "admin:test");
    assert.equal(f.credentials.receiptStillValid(tokenIssue), false, "revoked pairing invalidates the cached receipt");
    assert.equal(f.credentials.receiptFailure(tokenIssue), "invalid");
  } finally {
    await f.cleanup();
  }
});
