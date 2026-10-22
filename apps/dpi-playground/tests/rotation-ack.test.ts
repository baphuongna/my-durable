/**
 * GA-15 / spec 03 §8.2: a rotation ACK must come from the connection the token was sent over.
 *
 * The tunnel is faked on purpose: with the real server a device can only ever hold one authenticated
 * connection, so a frame from "some other connection" cannot be produced through sockets. The
 * RotationService, the registry and the audit log are real.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { Audit } from "../apps/dpi-playground-hub/src/audit.js";
import { RotationService } from "../apps/dpi-playground-hub/src/rotation.js";
import type { TunnelServer } from "../apps/dpi-playground-hub/src/tunnel.js";
import { newTunnelToken } from "../apps/dpi-playground-hub/src/tunnel-token.js";

const DEVICE_ID = "ack-dev";
const FINGERPRINT = `sha256:${"3".repeat(64)}`;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const until = async (fn: () => boolean, timeout = 2000, what = "cond") => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error(`timeout: ${what}`);
};

interface Sent { connectionId: string; frame: Record<string, unknown> }

/** Just the part of TunnelServer a RotationService talks to. */
class FakeTunnel {
  connectionId: string | undefined;
  readonly sent: Sent[] = [];
  private readonly openers: Array<(c: unknown) => void> = [];
  private readonly framers: Array<(c: unknown, f: unknown) => void> = [];
  addOpenListener(fn: (c: unknown) => void) { this.openers.push(fn); }
  addDeviceFrameListener(fn: (c: unknown, f: unknown) => void) { this.framers.push(fn); }
  hasConnection() { return this.connectionId !== undefined; }
  connectionIdOf() { return this.connectionId; }
  send(_deviceId: string, frame: Record<string, unknown>) {
    if (!this.connectionId) return false;
    this.sent.push({ connectionId: this.connectionId, frame });
    return true;
  }
  /** The device (re)connects on `connectionId`, presenting the credential it holds. */
  connect(connectionId: string, credentialId: string, generation: number) {
    this.connectionId = connectionId;
    for (const fn of this.openers) fn({ deviceId: DEVICE_ID, connectionId, credentialId, generation });
  }
  ack(connectionId: string, token: Record<string, unknown>) {
    const frame = {
      type: "control", action: "token-rotate-ack",
      rotationId: token.rotationId, credentialId: token.credentialId, generation: token.generation, pairingEpoch: token.pairingEpoch,
    };
    for (const fn of this.framers) fn({ deviceId: DEVICE_ID, connectionId }, frame);
  }
}

async function setup(opts: { cacheTtlMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "dpi-ack-"));
  const registry = new NetworkRegistry(join(dir, "net.sqlite"));
  const audit = new Audit(registry);
  const tunnel = new FakeTunnel();
  const rotation = new RotationService(registry, audit, tunnel as unknown as TunnelServer, { cacheTtlMs: opts.cacheTtlMs });
  const epoch = randomUUID();
  const g1 = randomUUID();
  const t0 = Date.now();
  registry.db
    .prepare(
      `INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,created_at,updated_at,transport)
       VALUES(?, 'Ack Dev', 'url', NULL, NULL, 'ui', 0, ?, 'checking', ?, ?, 'tunnel')`,
    )
    .run(DEVICE_ID, randomUUID(), t0, t0);
  registry.db
    .prepare(
      `INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at)
       VALUES(?,?,?,?,'paired',1,?,?,?)`,
    )
    .run(DEVICE_ID, epoch, "pub", FINGERPRINT, t0, t0, t0);
  registry.db
    .prepare(
      `INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at,confirmed_at)
       VALUES(?,?,?,1,?,'current',?,?)`,
    )
    .run(g1, DEVICE_ID, epoch, sha(newTunnelToken()), t0, t0);

  const state = () => ({
    pending: (registry.db.prepare("SELECT rotation_id FROM pairings WHERE device_id=?").get(DEVICE_ID) as { rotation_id: string | null }).rotation_id,
    statuses: Object.fromEntries(
      (registry.db.prepare("SELECT generation, status FROM tunnel_credentials WHERE device_id=?").all(DEVICE_ID) as { generation: number; status: string }[]).map((r) => [r.generation, r.status]),
    ),
    completed: (registry.db.prepare("SELECT count(*) AS n FROM events WHERE action='token.rotate_completed'").get() as { n: number }).n,
  });
  return {
    tunnel, rotation, state, g1,
    cleanup: async () => { rotation.close(); registry.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test("GA-15: an ACK from a connection that was never sent the token does not complete the rotation", async () => {
  const f = await setup();
  try {
    f.tunnel.connect("conn-A", f.g1, 1);
    assert.ok(f.rotation.startRotation(DEVICE_ID, "admin:test").ok);
    const token = f.tunnel.sent.at(-1)!.frame;
    assert.equal(f.tunnel.sent.at(-1)!.connectionId, "conn-A");

    f.tunnel.ack("conn-B", token); // exact tuple, wrong connection
    assert.ok(f.state().pending, "still pending");
    assert.deepEqual(f.state().statuses, { 1: "previous", 2: "current" });
    assert.equal(f.state().completed, 0);

    f.tunnel.ack("conn-A", token); // the connection that received it
    assert.equal(f.state().pending, null);
    assert.deepEqual(f.state().statuses, { 1: "retired", 2: "current" });
    assert.equal(f.state().completed, 1);
  } finally {
    await f.cleanup();
  }
});

test("GA-15: after a resend only the connection that received the resend can acknowledge", async () => {
  const f = await setup();
  try {
    f.tunnel.connect("conn-A", f.g1, 1);
    f.rotation.startRotation(DEVICE_ID, "admin:test");
    const token = f.tunnel.sent.at(-1)!.frame;

    f.tunnel.connect("conn-B", f.g1, 1); // reconnects still on the previous credential → same rotation is resent
    const resend = f.tunnel.sent.at(-1)!;
    assert.equal(resend.connectionId, "conn-B");
    assert.equal(resend.frame.rotationId, token.rotationId, "the same rotation, not a new one");

    f.tunnel.ack("conn-A", token); // the superseded connection
    assert.ok(f.state().pending, "the old connection's ACK no longer counts");
    f.tunnel.ack("conn-B", token);
    assert.equal(f.state().pending, null);
    assert.equal(f.state().completed, 1);
  } finally {
    await f.cleanup();
  }
});

test("GA-15: the delivery connection stays authoritative after the plaintext cache has expired", async () => {
  const f = await setup({ cacheTtlMs: 20 });
  try {
    f.tunnel.connect("conn-A", f.g1, 1);
    f.rotation.startRotation(DEVICE_ID, "admin:test");
    const token = f.tunnel.sent.at(-1)!.frame;
    await until(() => !f.rotation.plaintextCacheHas(String(token.rotationId)), 2000, "cache forgot the token");

    f.tunnel.ack("conn-A", token);
    assert.equal(f.state().pending, null, "a slow device that persisted the token is still acknowledged");
    assert.equal(f.state().completed, 1);
  } finally {
    await f.cleanup();
  }
});
