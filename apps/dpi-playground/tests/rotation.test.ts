/**
 * P2-19 — routine rotation, explicit/implicit ACK, cache-loss recovery,
 * offline request, stale-ACK guard. P-11 windows over the real
 * RotationService + TunnelServer with a scripted fake device.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { WebSocket as WsClient } from "ws";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { Audit } from "../apps/dpi-playground-hub/src/audit.js";
import { TunnelServer } from "../apps/dpi-playground-hub/src/tunnel.js";
import { RotationService } from "../apps/dpi-playground-hub/src/rotation.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const HUB_ID = "9c0d1e2f-3a4b-4c5d-8e9f-0a1b2c3d4e5f";
const FINGERPRINT = `sha256:${"2".repeat(64)}`;
const UID = randomUUID();
const DEVICE_ID = "rot-dev";
const rotations = (registry: NetworkRegistry, action?: string) =>
  registry.db
    .prepare(`SELECT action, detail_json FROM events WHERE action LIKE 'token.rotate%'${action ? " AND action=?" : ""}`)
    .all(...(action ? [action] : [])) as { action: string; detail_json: string }[];

interface Device {
  ws: WsClient;
  file: { pairingEpoch: string; credentialId: string; generation: number; tunnelToken: string };
  rotationsReceived: { rotationId: string; credentialId: string; generation: number; tunnelToken: string; pairingEpoch: string }[];
  applyRotations: boolean;
}

async function setup(opts: { cacheTtlMs?: number; now?: () => number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "dpi-p219-"));
  const registry = new NetworkRegistry(join(dir, "net.sqlite"));
  registry.clearTunnelState();
  const audit = new Audit(registry);
  const tunnel = new TunnelServer(registry, audit, HUB_ID);
  const rotation = new RotationService(registry, audit, tunnel, { cacheTtlMs: opts.cacheTtlMs, now: opts.now });
  const epoch = randomUUID();
  const t0 = Date.now();
  registry.db
    .prepare(
      `INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,created_at,updated_at,transport)
       VALUES(?, 'Rot Dev', 'url', NULL, NULL, 'ui', 0, ?, 'checking', ?, ?, 'tunnel')`,
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
  const hubPort = (server.address() as { port: number }).port;

  const device: Device = {
    ws: undefined as unknown as WsClient,
    file: { pairingEpoch: epoch, credentialId: "", generation: 1, tunnelToken: g1Token },
    rotationsReceived: [],
    applyRotations: true,
  };

  const connectDevice = async (): Promise<void> => {
    const ws = new WsClient(`ws://127.0.0.1:${hubPort}/api/tunnel`, { headers: { authorization: `Bearer ${device.file.tunnelToken}` } });
    device.ws = ws;
    await new Promise<void>((d, rej) => {
      ws.once("open", d);
      ws.once("unexpected-response", (_q, res) => rej(new Error(`upgrade ${res.statusCode}`)));
    });
    ws.on("message", (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.type === "rest-request" && msg.path === "/v1/device") {
        ws.send(JSON.stringify({ type: "rest-response", reqId: msg.reqId, status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, uid: UID, name: "Rot Dev" }) }));
        return;
      }
      if (msg.type === "control" && msg.action === "token-rotate") {
        device.rotationsReceived.push(msg);
        // The REAL connector guard: only the next generation of the CURRENT
        // pairing is applied; anything else is ignored without an ack.
        if (msg.pairingEpoch !== device.file.pairingEpoch || msg.generation <= device.file.generation) return;
        if (!device.applyRotations) return;
        // device behavior: persist (simulated), adopt, ack
        device.file = {
          pairingEpoch: msg.pairingEpoch,
          credentialId: msg.credentialId,
          generation: msg.generation,
          tunnelToken: msg.tunnelToken,
        };
        ws.send(JSON.stringify({
          type: "control",
          action: "token-rotate-ack",
          rotationId: msg.rotationId,
          credentialId: msg.credentialId,
          generation: msg.generation,
          pairingEpoch: msg.pairingEpoch,
        }));
      }
    });
    const current = registry.db
      .prepare("SELECT credential_id FROM tunnel_credentials WHERE token_hash=?")
      .get(sha(device.file.tunnelToken)) as { credential_id: string } | undefined;
    device.file.credentialId = current?.credential_id ?? device.file.credentialId;
    const hsMsg = JSON.stringify({
      type: "pair-handshake", v: 1, deviceUid: UID, deviceId: DEVICE_ID, pairingEpoch: device.file.pairingEpoch,
      credentialId: device.file.credentialId, generation: device.file.generation, apiVersion: 1, tunnelProto: 1,
      keyFingerprint: FINGERPRINT,
    });
    ws.send(hsMsg);
    const first = await new Promise<any>((d) => ws.once("message", (x) => d(JSON.parse(x.toString())))); // hello?
  };
  await connectDevice();

  const rows = () => {
    const creds = registry.db
      .prepare("SELECT credential_id, generation, status FROM tunnel_credentials WHERE device_id=? ORDER BY generation")
      .all(DEVICE_ID) as { credential_id: string; generation: number; status: string }[];
    const p = registry.db
      .prepare("SELECT credential_generation, rotation_id, rotation_target_credential_id, rotation_requested_at FROM pairings WHERE device_id=?")
      .get(DEVICE_ID) as { credential_generation: number; rotation_id: string | null; rotation_target_credential_id: string | null; rotation_requested_at: number | null };
    return { creds, p };
  };

  const cleanup = async () => {
    device.ws.terminate();
    tunnel.close();
    server.close();
    server.closeAllConnections();
    registry.close();
    await rm(dir, { recursive: true, force: true });
  };

  const originalG1Token = g1Token;
  return { registry, rotation, tunnel, device, rows, connectDevice, cleanup, server, originalG1Token };
}

const until = async (fn: () => boolean, timeout = 6000, what = "cond") => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw Error(`timeout: ${what}`);
};

test("P-11 online rotation: deliver → ack → previous retired, rotation cleared, old token dead, new token works", async () => {
  const f = await setup();
  try {
    const r = f.rotation.startRotation(DEVICE_ID, "admin:test");
    assert.ok(r.ok && r.mode === "online", JSON.stringify(r));
    await until(() => f.device.rotationsReceived.length === 1, 5000, "token-rotate delivered");
    await until(() => {
      const { p, creds } = f.rows();
      return !p.rotation_id && creds.find((c) => c.generation === 1)?.status === "retired" && creds.find((c) => c.generation === 2)?.status === "current";
    }, 5000, "rotation completed via ack");
    assert.ok(rotations(f.registry, "token.rotate_completed").length === 1);
    // sentinel: plaintext only in RAM cache, and it is dropped after completion
    await until(() => f.rotation.cacheSize() === 0, 3000, "cache dropped");
    // old token dead (retired → token_unknown), new token works
    const oldToken = f.device.rotationsReceived[0];
    assert.equal(oldToken.generation, 2);
    await f.device.ws.terminate();
    const oldUpgrade = new Promise<number>((done) => {
      const ws = new WsClient(`ws://127.0.0.1:${(f.server.address() as { port: number }).port}/api/tunnel`, { headers: { authorization: `Bearer ${f.originalG1Token}` } });
      ws.on("error", () => {}); // rejected upgrade noise; the status is what matters
      ws.once("unexpected-response", (_q, res) => { done(res.statusCode ?? 0); ws.close(); });
      ws.once("open", () => { done(101); ws.close(); });
    });
    assert.equal(await oldUpgrade, 401);
    await f.connectDevice(); // new token
    assert.equal(f.tunnel.activeCount(), 1);
  } finally {
    await f.cleanup();
  }
});

test("P-11 implicit ack: silent device reconnects on the TARGET credential → rotation completes", async () => {
  const f = await setup();
  try {
    deviceSilent(f.device); // receive token-rotate but do NOT apply/ack
    f.rotation.startRotation(DEVICE_ID, "admin:test");
    await until(() => f.device.rotationsReceived.length === 1, 5000, "delivered");
    // device "reboots" but somehow has the new credential (e.g. read the
    // rotation from another channel): reconnect with target tuple
    await f.device.ws.terminate();
    adoptLastRotation(f.device);
    await f.connectDevice();
    await until(() => {
      const { p, creds } = f.rows();
      return !p.rotation_id && creds.find((c) => c.generation === 1)?.status === "retired";
    }, 5000, "implicit ack completed");
    assert.ok(rotations(f.registry, "token.rotate_completed").some((e) => e.detail_json.includes('"via":"implicit_ack"')));
  } finally {
    await f.cleanup();
  }
});

test("P-11 resend: device ignores rotation, reconnects on previous → same rotationId resent, then ack completes", async () => {
  const f = await setup();
  try {
    deviceSilent(f.device);
    f.rotation.startRotation(DEVICE_ID, "admin:test");
    await until(() => f.device.rotationsReceived.length === 1, 5000, "first delivery");
    const firstId = f.device.rotationsReceived[0].rotationId;
    await f.device.ws.terminate();
    f.device.applyRotations = true; // device applies the resend when it arrives → acks
    await f.connectDevice(); // still G1 (previous)
    await until(() => f.device.rotationsReceived.length === 2, 5000, "resent");
    assert.equal(f.device.rotationsReceived[1].rotationId, firstId, "SAME rotationId resent from cache");
    // now the device applies → acks → completes
    await until(() => {
      const { p, creds } = f.rows();
      return !p.rotation_id && creds.find((c) => c.generation === 1)?.status === "retired";
    }, 5000, "completed after resend");
  } finally {
    await f.cleanup();
  }
});

test("P-11 cache loss: reconnect on previous with empty cache → unconfirmed current retired, next generation minted, previous kept", async () => {
  const f = await setup({ cacheTtlMs: 40 });
  try {
    deviceSilent(f.device);
    const f2 = f as unknown as { rotation: RotationService };
    void f2;
    // The service runs with a tiny cache TTL (set in setup opts below): by the
    // time the device reconnects, the RAM cache has forgotten the token —
    // hub "RAM loss" — while the DB rotation is still pending.
    f.rotation.startRotation(DEVICE_ID, "admin:test");
    await until(() => f.device.rotationsReceived.length === 1, 5000, "first delivery");
    const firstId = f.device.rotationsReceived[0].rotationId;
    await until(() => !f.rotation.plaintextCacheHas(firstId), 2_000, "TTL expiry (setup used 40 ms)");
    await f.device.ws.terminate();
    f.device.applyRotations = true; // apply + ack the regenerated rotation when it arrives
    await f.connectDevice(); // device on G1 (previous); new instance has no cache
    await until(() => f.device.rotationsReceived.length === 2, 5000, "regenerated rotation delivered");
    const second = f.device.rotationsReceived[1];
    assert.notEqual(second.rotationId, firstId);
    assert.equal(second.generation, 3, "recovery mints the next FREE generation for the epoch");
    const { creds, p } = f.rows();
    // after device applies + acks: G1 retired, G2(regenerated) current
    await until(() => !f.rows().p.rotation_id, 8000, "completed");
    const after = f.rows();
    assert.equal(after.creds.find((c) => c.generation === 1)?.status, "retired");
    assert.equal(after.creds.find((c) => c.generation === 2)?.status, "retired", "unconfirmed G2 retired");
    assert.equal(after.creds.find((c) => c.generation === 3)?.status, "current", "G3 current");
    void creds;
    assert.ok(rotations(f.registry, "token.rotate_regenerated").length === 1);
  } finally {
    await f.cleanup();
  }
});

test("P-11 offline request: rotation_requested_at only; reconnect triggers the online rotation", async () => {
  const f = await setup();
  try {
    await f.device.ws.terminate();
    await until(() => f.tunnel.activeCount() === 0, 5000, "offline");
    const r = f.rotation.startRotation(DEVICE_ID, "admin:test");
    assert.ok(r.ok && r.mode === "requested");
    const p1 = f.rows().p;
    assert.ok(p1.rotation_requested_at > 0);
    assert.equal(p1.rotation_id, null);
    assert.equal(f.rotation.cacheSize(), 0, "no plaintext minted while offline");
    // device reconnects → hub starts the rotation online automatically
    await f.connectDevice();
    await until(() => f.device.rotationsReceived.length === 1, 5000, "rotation started on reconnect");
    assert.equal(f.rows().p.rotation_requested_at, null, "request flag cleared by the online start");
  } finally {
    await f.cleanup();
  }
});

test("P-11 stale/duplicate ack and already-held rotate are ignored", async () => {
  const f = await setup();
  try {
    f.rotation.startRotation(DEVICE_ID, "admin:test");
    await until(() => f.device.rotationsReceived.length === 1, 5000, "delivered");
    const msg = f.device.rotationsReceived[0];
    await until(() => !f.rows().p.rotation_id, 5000, "completed");
    // Replay the SAME ack after completion → no state change, no crash. The hub
    // answers a ping only after dispatching every frame sent before it (ws handles
    // frames in order and tunnel.onFrame runs the listeners synchronously), so the
    // pong proves the replayed ack was PROCESSED and ignored — not merely sent.
    const ackProcessed = once(f.device.ws, "pong");
    f.device.ws.send(JSON.stringify({
      type: "control", action: "token-rotate-ack", rotationId: msg.rotationId,
      credentialId: msg.credentialId, generation: msg.generation, pairingEpoch: msg.pairingEpoch,
    }));
    f.device.ws.ping();
    await ackProcessed;
    const { creds } = f.rows();
    assert.equal(creds.find((c) => c.generation === 2)?.status, "current");
    assert.equal(creds.find((c) => c.generation === 1)?.status, "retired");
    // A re-delivered token-rotate for a generation the device ALREADY holds
    // must be ignored (no double-apply, no second ack) — legit direction.
    f.tunnel.send(DEVICE_ID, {
      type: "control",
      action: "token-rotate",
      tunnelToken: "dpt_" + "F".repeat(43),
      pairingEpoch: msg.pairingEpoch,
      rotationId: randomUUID(),
      credentialId: randomUUID(),
      generation: msg.generation, // already-held generation
    });
    // The scripted device records EVERY token-rotate it receives before its guard
    // decides to ignore it, so the second arrival is the observable that the
    // re-delivered rotate reached the device and was processed — no guessed delay.
    await until(() => f.device.rotationsReceived.length === 2, 2_000, "the already-held rotate to reach the device");
    assert.equal(f.device.file.generation, 2, "device file untouched by an already-held generation");
    const completedBefore = rotations(f.registry, "token.rotate_completed").length;
    // The real next rotation goes through the full cycle and completes.
    f.rotation.startRotation(DEVICE_ID, "admin:test");
    await until(() => !f.rows().p.rotation_id, 8000, "G3 completed via device ack");
    assert.equal(rotations(f.registry, "token.rotate_completed").length, completedBefore + 1);
  } finally {
    await f.cleanup();
  }
});

const msg2ack = (m: { rotationId: string; credentialId: string; generation: number; pairingEpoch: string }) => ({
  type: "control", action: "token-rotate-ack", rotationId: m.rotationId,
  credentialId: m.credentialId, generation: m.generation, pairingEpoch: m.pairingEpoch,
});
const deviceSilent = (d: Device) => {
  d.applyRotations = false;
};
const adoptLastRotation = (d: Device) => {
  const last = d.rotationsReceived.at(-1)!;
  d.file = { pairingEpoch: last.pairingEpoch, credentialId: last.credentialId, generation: last.generation, tunnelToken: last.tunnelToken };
};

test("GA-12: the 90-day window restarts at every confirmed rotation — a later reconnect does not rotate again", async () => {
  const DAY = 86_400_000;
  let skew = 0;
  const f = await setup({ now: () => Date.now() + skew });
  try {
    const reconnect = async () => {
      f.device.ws.terminate();
      await until(() => f.tunnel.activeCount() === 0, 5000, "offline");
      await f.connectDevice();
    };
    const started = () => rotations(f.registry, "token.rotate_started").length;

    skew = 89 * DAY;
    await reconnect();
    assert.equal(started(), 0, "day 89 is inside the first window");

    skew = 91 * DAY;
    await reconnect();
    assert.equal(started(), 1, "day 91: the first window is over, one rotation starts");
    await until(() => !f.rows().p.rotation_id, 5000, "rotation confirmed by the device");

    await reconnect();
    assert.equal(started(), 1, "day 91 again: the confirmed rotation restarted the window");

    skew = (91 + 89) * DAY;
    await reconnect();
    assert.equal(started(), 1, "89 days after the rotation is still inside the new window");

    skew = (91 + 91) * DAY;
    await reconnect();
    assert.equal(started(), 2, "91 days after the rotation the next one is due");
  } finally {
    await f.cleanup();
  }
});

test("GA-13: every rotation token is 32 random bytes (43 base64url chars), on both mint paths", async () => {
  const f = await setup({ cacheTtlMs: 40 });
  try {
    deviceSilent(f.device);
    f.rotation.startRotation(DEVICE_ID, "admin:test"); // rotateOnline
    await until(() => f.device.rotationsReceived.length === 1, 5000, "first delivery");
    await until(() => !f.rotation.plaintextCacheHas(f.device.rotationsReceived[0].rotationId), 2_000, "the 40 ms cache TTL to forget the first token");
    f.device.ws.terminate();
    await until(() => f.tunnel.activeCount() === 0, 5000, "offline");
    await f.connectDevice(); // device still on G1 → recoverFromCacheLoss mints again
    await until(() => f.device.rotationsReceived.length === 2, 5000, "regenerated delivery");

    const tokens = f.device.rotationsReceived.map((m) => m.tunnelToken);
    assert.notEqual(tokens[0], tokens[1]);
    const bytes = tokens.map((t) => {
      assert.match(t, /^dpt_[A-Za-z0-9_-]{43}$/);
      const raw = Buffer.from(t.slice(4), "base64url");
      assert.equal(raw.length, 32, "43 base64url chars carry 32 bytes");
      return raw;
    });
    // A token cut from UUID text has only ASCII bytes drawn from [0-9a-f-]; random bytes are not so confined.
    const all = Buffer.concat(bytes);
    assert.ok(all.some((b) => b >= 0x80), "token bytes are not confined to ASCII");
    assert.ok(new Set(all).size > 17, "token bytes are not confined to the UUID alphabet");
  } finally {
    await f.cleanup();
  }
});

test("GA-15: a cached plaintext token leaves RAM when its TTL ends, without anyone asking for it — and nothing is retired", async () => {
  const f = await setup({ cacheTtlMs: 60 });
  try {
    deviceSilent(f.device);
    f.rotation.startRotation(DEVICE_ID, "admin:test");
    await until(() => f.device.rotationsReceived.length === 1, 5000, "delivered");
    const { rotationId } = f.device.rotationsReceived[0];
    assert.ok(f.rotation.plaintextCacheHas(rotationId), "premise: the token is cached right after delivery");

    await until(() => !f.rotation.plaintextCacheHas(rotationId), 2000, "plaintext forgotten on its own");
    assert.equal(f.rotation.cacheSize(), 0);

    // Forgetting is a RAM matter only: the rotation is still pending and no credential changed state.
    const { p, creds } = f.rows();
    assert.equal(p.rotation_id, rotationId);
    assert.equal(creds.find((c) => c.generation === 1)?.status, "previous");
    assert.equal(creds.find((c) => c.generation === 2)?.status, "current");
    assert.equal(rotations(f.registry, "token.rotate_completed").length, 0);
  } finally {
    await f.cleanup();
  }
});
