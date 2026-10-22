/**
 * Review 2026-10-22 — rotation delivery robustness:
 * a token-rotate whose first send never landed is redelivered once on the live
 * connection before the plaintext TTL; a wedged device gets no generation
 * inflation; startRotation refuses devices without a live pairing (nothing is
 * recorded); the stale-intent clear is one transaction with its audit row.
 *
 * Real RotationService + TunnelServer + Audit + NetworkRegistry with a
 * scripted fake device. No network beyond loopback.
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
import { RotationService } from "../apps/dpi-playground-hub/src/rotation.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const HUB_ID = "1b2c3d4e-5f60-4789-9abc-def012345678";
const FINGERPRINT = `sha256:${"7".repeat(64)}`;
const UID = randomUUID();
const DEVICE_ID = "rot2-dev";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const until = async (fn: () => boolean, timeout: number, what: string) => {
  const by = Date.now() + timeout;
  while (Date.now() < by) {
    if (fn()) return;
    await sleep(40);
  }
  assert.fail(`timed out waiting for ${what}`);
};

async function setup(opts: { cacheTtlMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "dpi-rotrev-"));
  const registry = new NetworkRegistry(join(dir, "net.sqlite"));
  registry.clearTunnelState();
  const audit = new Audit(registry);
  const tunnel = new TunnelServer(registry, audit, HUB_ID);
  const rotation = new RotationService(registry, audit, tunnel, { cacheTtlMs: opts.cacheTtlMs });
  const epoch = randomUUID();
  const t0 = Date.now();
  registry.db
    .prepare(
      `INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,created_at,updated_at,transport)
       VALUES(?, 'Rot2 Dev', 'url', NULL, NULL, 'ui', 0, ?, 'checking', ?, ?, 'tunnel')`,
    )
    .run(DEVICE_ID, UID, t0, t0);
  registry.db
    .prepare(
      `INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at)
       VALUES(?,?,?,?,'paired',1,?,?,?)`,
    )
    .run(DEVICE_ID, epoch, "pub", FINGERPRINT, t0, t0, t0);
  const g1Token =
    "dpt_" +
    Buffer.from(randomUUID() + randomUUID())
      .toString("base64url")
      .slice(0, 43);
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

  const device = {
    ws: undefined as unknown as WsClient,
    file: { pairingEpoch: epoch, credentialId: "", generation: 1, tunnelToken: g1Token },
    rotationsReceived: [] as {
      rotationId: string;
      credentialId: string;
      generation: number;
      tunnelToken: string;
      pairingEpoch: string;
    }[],
    applyRotations: true,
  };
  let connects = 0;
  const connectDevice = async (): Promise<void> => {
    connects++;
    const ws = new WsClient(`ws://127.0.0.1:${port}/api/tunnel`, {
      headers: { authorization: `Bearer ${device.file.tunnelToken}` },
    });
    device.ws = ws;
    await new Promise<void>((d, rej) => {
      ws.once("open", d);
      ws.once("unexpected-response", (_q, res) => rej(new Error(`upgrade ${res.statusCode}`)));
    });
    ws.on("message", (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.type === "control" && msg.action === "token-rotate") {
        device.rotationsReceived.push(msg);
        if (!device.applyRotations) return;
        if (
          msg.pairingEpoch !== device.file.pairingEpoch ||
          msg.generation <= device.file.generation
        )
          return;
        device.file = {
          pairingEpoch: msg.pairingEpoch,
          credentialId: msg.credentialId,
          generation: msg.generation,
          tunnelToken: msg.tunnelToken,
        };
        ws.send(
          JSON.stringify({
            type: "control",
            action: "token-rotate-ack",
            rotationId: msg.rotationId,
            credentialId: msg.credentialId,
            generation: msg.generation,
            pairingEpoch: msg.pairingEpoch,
          }),
        );
      }
    });
    const current = registry.db
      .prepare("SELECT credential_id FROM tunnel_credentials WHERE token_hash=?")
      .get(sha(device.file.tunnelToken)) as { credential_id: string } | undefined;
    device.file.credentialId = current?.credential_id ?? device.file.credentialId;
    ws.send(
      JSON.stringify({
        type: "pair-handshake",
        v: 1,
        deviceUid: UID,
        deviceId: DEVICE_ID,
        pairingEpoch: device.file.pairingEpoch,
        credentialId: device.file.credentialId,
        generation: device.file.generation,
        apiVersion: 1,
        tunnelProto: 1,
        keyFingerprint: FINGERPRINT,
      }),
    );
    await new Promise<void>((d) => ws.once("message", () => d())); // hello
  };

  const rows = () => {
    const creds = registry.db
      .prepare(
        "SELECT credential_id, generation, status FROM tunnel_credentials WHERE device_id=? ORDER BY generation",
      )
      .all(DEVICE_ID) as { credential_id: string; generation: number; status: string }[];
    const p = registry.db
      .prepare(
        "SELECT credential_generation, rotation_id, rotation_target_credential_id, rotation_requested_at FROM pairings WHERE device_id=?",
      )
      .get(DEVICE_ID) as {
      credential_generation: number;
      rotation_id: string | null;
      rotation_target_credential_id: string | null;
      rotation_requested_at: number | null;
    };
    return { creds, p };
  };

  const cleanup = async () => {
    device.ws?.terminate();
    rotation.close();
    tunnel.close();
    server.close();
    server.closeAllConnections();
    registry.close();
    await rm(dir, { recursive: true, force: true });
  };
  return {
    registry,
    audit,
    tunnel,
    rotation,
    device,
    rows,
    connectDevice,
    cleanup,
    connects: () => connects,
    epoch,
    g1Token,
  };
}

test("RR: a token-rotate that never left the hub is redelivered on the live connection (no reconnect, same rotationId)", async () => {
  const f = await setup({ cacheTtlMs: 2_000 }); // reminder fires at ~250 ms
  try {
    await f.connectDevice();
    const realSend = f.tunnel.send.bind(f.tunnel);
    let blockRotate = true;
    f.tunnel.send = ((id: string, frame: { action?: string }) =>
      blockRotate && frame.action === "token-rotate"
        ? false
        : realSend(id, frame as never)) as never;
    const r = f.rotation.startRotation(DEVICE_ID, "admin:test");
    f.tunnel.send = realSend as never;
    blockRotate = false;
    assert.ok(r.ok && r.mode === "online");
    assert.equal(
      f.device.rotationsReceived.length,
      0,
      "the first deliver() was refused by the socket",
    );
    const startedRotationId = f.rows().p.rotation_id;
    assert.ok(startedRotationId, "rotation is in flight");

    await until(() => f.device.rotationsReceived.length === 1, 5_000, "pre-TTL redelivery");
    assert.equal(
      f.device.rotationsReceived[0].rotationId,
      startedRotationId,
      "the SAME rotation, not a new generation",
    );
    assert.equal(f.connects(), 1, "no reconnect was needed");
    await until(() => !f.rows().p.rotation_id, 5_000, "the redelivered token acks normally");
  } finally {
    await f.cleanup();
  }
});

test("RR: a wedged device gets exactly one reminder; no generation inflation while the connection stays live", async () => {
  const f = await setup({ cacheTtlMs: 1_200 }); // reminder ~250 ms, TTL 1200 ms
  try {
    await f.connectDevice();
    f.device.applyRotations = false; // receives control frames, never applies, never acks
    const r = f.rotation.startRotation(DEVICE_ID, "admin:test");
    assert.ok(r.ok);
    await until(() => f.device.rotationsReceived.length === 1, 3_000, "first delivery");
    await until(() => f.device.rotationsReceived.length === 2, 3_000, "the one reminder");
    assert.equal(
      f.device.rotationsReceived[1].rotationId,
      f.device.rotationsReceived[0].rotationId,
      "same token redelivered",
    );

    await sleep(1_600); // the TTL passes with the connection live
    assert.equal(
      f.device.rotationsReceived.length,
      2,
      "nothing further: no generation inflation on a wedged device",
    );
    assert.equal(f.connects(), 1, "still the same connection");
    assert.ok(f.rows().p.rotation_id, "rotation stays pending; the reconnect path owns recovery");
    assert.equal(
      f.rows().creds.filter((c) => c.status === "current").length,
      1,
      "exactly one current credential",
    );
  } finally {
    await f.cleanup();
  }
});

test("RR: startRotation refuses unknown and unpaired devices and records nothing", async () => {
  const f = await setup();
  try {
    const started = () =>
      f.registry.db
        .prepare("SELECT COUNT(*) c FROM events WHERE action='token.rotate_started'")
        .get() as { c: number };
    const before = started().c;

    const ghost = f.rotation.startRotation("ghost", "admin:test");
    assert.ok(!ghost.ok && ghost.code === "unknown_device", JSON.stringify(ghost));

    // A configured tunnel device that never paired (offline, so the request branch would run).
    const t0 = Date.now();
    f.registry.db
      .prepare(
        `INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,created_at,updated_at,transport)
         VALUES(?, 'Bare Dev', 'url', NULL, NULL, 'ui', 0, ?, 'checking', ?, ?, 'tunnel')`,
      )
      .run("bare-dev", randomUUID(), t0, t0);
    const bare = f.rotation.startRotation("bare-dev", "admin:test");
    assert.ok(!bare.ok && bare.code === "no_pairing", JSON.stringify(bare));

    assert.equal(
      started().c,
      before,
      "no token.rotate_started audit row for a rotation that did not start",
    );
    assert.equal(
      (
        f.registry.db
          .prepare("SELECT COUNT(*) c FROM pairings WHERE device_id='bare-dev'")
          .get() as { c: number }
      ).c,
      0,
      "no pairing row appeared",
    );
  } finally {
    await f.cleanup();
  }
});

test("RR: the stale-rotation clear rolls back when its audit row cannot be written", async () => {
  const f = await setup();
  try {
    // Plant a stale intent: the rotation target is a credential this epoch never minted.
    const staleRotation = randomUUID();
    f.registry.db
      .prepare(
        "UPDATE pairings SET rotation_id=?, rotation_target_credential_id=?, rotation_started_at=? WHERE device_id=?",
      )
      .run(staleRotation, randomUUID(), Date.now(), DEVICE_ID);

    const realAppend = f.audit.append.bind(f.audit);
    let failStale = true;
    f.audit.append = ((event: { action: string }) => {
      if (failStale && event.action === "rotation.stale_cleared")
        throw new Error("audit: injected append failure");
      return realAppend(event as never);
    }) as never;

    await f.connectDevice(); // the handshake meets the stale intent while audit fails
    await sleep(300);
    assert.ok(f.rows().p.rotation_id, "unaudited, the clear must not take effect (rolled back)");

    failStale = false;
    f.device.ws.close();
    await until(() => f.tunnel.activeCount() === 0, 5_000, "closed");
    await f.connectDevice(); // next handshake retries, now with audit storage healthy
    await sleep(300);
    assert.equal(f.rows().p.rotation_id, null, "the clear lands once it can be audited");
    const cleared = f.registry.db
      .prepare("SELECT COUNT(*) c FROM events WHERE action='rotation.stale_cleared'")
      .get() as { c: number };
    assert.equal(cleared.c, 1, "exactly one audited clear");
  } finally {
    await f.cleanup();
  }
});
