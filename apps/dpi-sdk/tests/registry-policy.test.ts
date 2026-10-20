/**
 * P2-06 writer policy: transport in DTO, tunnel identity protection, unique
 * UID learning, history-preserving removal, tunnel-state lifecycle, null-URL
 * DTO safety (D-2 / P-9 / S-7 adjacent).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NetworkRegistry, toPublic } from "../src/node/registry.js";

const uid = () => "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";

async function tempRegistry() {
  const dir = await mkdtemp(join(tmpdir(), "dpi-pol-"));
  const registry = new NetworkRegistry(join(dir, "network.sqlite"));
  return { registry, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("policy: toPublic carries transport, nulls URL for tunnel, keeps hasToken LAN-only", async () => {
  const { registry, cleanup } = await tempRegistry();
  try {
    registry.upsert({ id: "lan-dev", url: "http://10.0.0.5:7900", token: "x".repeat(43) });
    const lan = toPublic(registry.get("lan-dev")!);
    assert.equal(lan.transport, "lan");
    assert.equal(lan.url, "http://10.0.0.5:7900");
    assert.equal(lan.hasToken, true);

    registry.upsert({ id: "t-dev", url: "http://10.0.0.6:7900", token: "y".repeat(43) });
    registry.setTransportTunnel("t-dev");
    const tun = toPublic(registry.get("t-dev")!);
    assert.equal(tun.transport, "tunnel");
    assert.equal(tun.url, null); // null URL — no link building downstream
    assert.equal(tun.hasToken, false); // NOT unauthorized — just no LAN token
    // metadata never contains secrets
    const raw = JSON.stringify(tun);
    assert.ok(!raw.includes("y".repeat(10)));
    // pairing/tunnel diagnostics pass through when provided
    const withMeta = toPublic(registry.get("t-dev")!, undefined, {
      pairing: { status: "paired", keyFingerprint: "sha256:" + "ab".repeat(32), pairedAt: 1, credentialGeneration: 2, rotationPending: false },
      tunnel: { state: "connected", readerCount: 3 },
    });
    assert.equal(withMeta.pairing?.credentialGeneration, 2);
    assert.equal(withMeta.tunnel?.readerCount, 3);
  } finally {
    await cleanup();
  }
});

test("policy: generic upsert/seed cannot restore URL/token or flip tunnel identity", async () => {
  const { registry, cleanup } = await tempRegistry();
  try {
    registry.upsert({ id: "t-dev", url: "http://10.0.0.6:7900", token: "secret-token-xxxxxxxxxxxxxxxxxxxxx" });
    registry.setTransportTunnel("t-dev");
    // seed-style re-upsert with old config endpoint: only display metadata syncs
    const row = registry.upsert({ id: "t-dev", name: "New Name", url: "http://old-endpoint:7900", token: "leaked-attempt-aaaaaaaaaaaaaaaaaaa", source: "config" });
    assert.equal(row.transport, "tunnel");
    assert.equal(row.url, null);
    assert.equal(row.token, null);
    assert.equal(row.name, "New Name");
    // setToken refuses tunnel rows
    assert.throws(() => registry.setToken("t-dev", "z".repeat(40)), /tunnel/);
  } finally {
    await cleanup();
  }
});

test("policy: back-to-LAN requires no active credentials and explicit input", async () => {
  const { registry, cleanup } = await tempRegistry();
  try {
    registry.upsert({ id: "t-dev", url: "http://10.0.0.6:7900" });
    registry.setTransportTunnel("t-dev");
    // simulate active credential
    const t = Date.now();
    registry.db
      .prepare("INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at) VALUES('t-dev','e','pk','sha256:ab','paired',1,?,?,?)")
      .run(t, t, t);
    registry.db
      .prepare("INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at) VALUES('c1','t-dev','e',1,?,'current',?)")
      .run("a".repeat(64), t);
    assert.throws(() => registry.setTransportLan("t-dev", "http://10.0.0.9:7900", null), /active tunnel credentials/);
    // revoke → switch works, requires new endpoint input
    registry.db.prepare("UPDATE tunnel_credentials SET status='revoked', revoked_at=? WHERE credential_id='c1'").run(t);
    assert.throws(() => registry.setTransportLan("t-dev", "ftp://bad", null), /http or https/);
    const back = registry.setTransportLan("t-dev", "http://10.0.0.9:7900", "n".repeat(43));
    assert.equal(back.transport, "lan");
    assert.equal(back.url, "http://10.0.0.9:7900");
  } finally {
    await cleanup();
  }
});

test("policy: rows with history are never hard-deleted (pruneConfig keeps them too)", async () => {
  const { registry, cleanup } = await tempRegistry();
  try {
    registry.upsert({ id: "hist-dev", url: "http://10.0.0.5:7900", source: "config" });
    const t = Date.now();
    registry.db
      .prepare("INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at) VALUES('hist-dev','e','pk','sha256:ab','revoked',1,?,?,?)")
      .run(t, t, t);
    assert.throws(() => registry.remove("hist-dev"), /tombstones are retained/);
    // config row disappears from YAML → prune must not delete the identity
    registry.pruneConfig([]);
    assert.ok(registry.get("hist-dev"));
    // plain LAN row without history can still be removed
    registry.upsert({ id: "plain-dev", url: "http://10.0.0.7:7900", source: "config" });
    registry.pruneConfig([]);
    assert.ok(!registry.get("plain-dev"));
  } finally {
    await cleanup();
  }
});

test("policy: learnUid unique mapping — conflict reported, not stolen; non-canonical rejected", async () => {
  const { registry, cleanup } = await tempRegistry();
  try {
    registry.upsert({ id: "a", url: "http://10.0.0.1:7900" });
    registry.upsert({ id: "b", url: "http://10.0.0.2:7900" });
    const u = uid();
    assert.deepEqual(registry.learnUid("a", u), { ok: true });
    // another row tries to learn the same UID → conflict, b keeps NULL uid
    const r = registry.learnUid("b", u);
    assert.equal(r.ok, false);
    assert.equal("conflict" in r && r.conflict, "a");
    assert.equal(registry.get("b")!.deviceUid, null);
    // non-canonical never mapped
    assert.equal(registry.learnUid("b", u.toUpperCase()).ok, false);
    assert.equal(registry.learnUid("b", `${u} `).ok, false);
    assert.equal(registry.get("b")!.deviceUid, null);
    // idempotent same-row
    assert.deepEqual(registry.learnUid("a", u), { ok: true });
  } finally {
    await cleanup();
  }
});

test("policy: tunnel_state cleared at boot, snapshots throttled by caller", async () => {
  const { registry, cleanup } = await tempRegistry();
  try {
    registry.upsert({ id: "t-dev", url: "http://10.0.0.6:7900" });
    registry.recordTunnelState("t-dev", { connectionId: "conn-1", readerCount: 2 });
    let row = registry.db.prepare("SELECT connection_id, reader_count FROM tunnel_state WHERE device_id='t-dev'").get() as { connection_id: string; reader_count: number };
    assert.equal(row.connection_id, "conn-1");
    registry.recordTunnelState("t-dev", { connectionId: "conn-2", readerCount: 5 });
    row = registry.db.prepare("SELECT connection_id, reader_count FROM tunnel_state WHERE device_id='t-dev'").get() as { connection_id: string; reader_count: number };
    assert.equal(row.connection_id, "conn-2");
    assert.equal(row.reader_count, 5);
    registry.clearTunnelState();
    const count = (registry.db.prepare("SELECT count(*) AS n FROM tunnel_state").get() as { n: number }).n;
    assert.equal(count, 0);
  } finally {
    await cleanup();
  }
});
