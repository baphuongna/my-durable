/**
 * P2-10: atomic UID mapping, issuance transaction, receipt cache validation.
 * Real CredentialService + real PairingService end-to-end (real Ed25519 keys).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { Audit } from "../apps/dpi-playground-hub/src/audit.js";
import { PairingService } from "../apps/dpi-playground-hub/src/pairing.js";
import { CredentialService } from "../apps/dpi-playground-hub/src/credentials.js";
import { checkPairingDto, pairingSigningPayload, TokenIssue as TokenIssueSchema, type TokenIssue } from "../../dpi-sdk/src/protocol/pairing.js";

const HUB_ORIGIN = "https://pi.example.com";
const HUB_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const uuid = () => randomUuid();
function randomUuid() {
  return "12345678-1234-1234-1234-123456789012".replace(/[0-9]/g, () => Math.floor(Math.random() * 10).toString());
}

interface World {
  registry: NetworkRegistry;
  audit: Audit;
  credentials: CredentialService;
  pairing: PairingService;
  clock: { now: number };
  cleanup: () => Promise<void>;
}

async function world(failAt?: "preflight" | "after-prepare" | "after-commit"): Promise<World> {
  const dir = await mkdtemp(join(tmpdir(), "dpi-cred-"));
  const registry = new NetworkRegistry(join(dir, "network.sqlite"));
  const audit = new Audit(registry);
  const clock = { now: 1760000000000 };
  const credentials = new CredentialService(registry, audit, HUB_ORIGIN, HUB_ID, failAt);
  const pairing = new PairingService({
    registry, audit, hubOrigin: HUB_ORIGIN, hubId: HUB_ID,
    now: () => clock.now,
    issue: (e) => credentials.issue(e),
    receiptValidator: (t) => (credentials.receiptStillValid(t) ? true : { code: credentials.receiptFailure(t) }),
  });
  return { registry, audit, credentials, pairing, clock, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const kpOf = () => generateKeyPairSync("ed25519");
const pubPem = (kp: ReturnType<typeof kpOf>) => kp.publicKey.export({ type: "spki", format: "pem" }) as string;
const fpOf = (kp: ReturnType<typeof kpOf>) =>
  `sha256:${createHash("sha256").update(kp.publicKey.export({ type: "spki", format: "der" }) as Buffer).digest("hex")}`;

/** Full pair flow through the REAL services; returns the TokenIssue. */
async function pairThrough(w: World, deviceUid: string, kp = kpOf(), name = "device-x", replaceKey = false): Promise<TokenIssue> {
  const code = w.pairing.createCode("10.0.0.1");
  assert.ok(code.ok);
  const started = w.pairing.start(
    { type: "pair.request", v: 1, requestId: uuid(), code: code.value.code, deviceUid, deviceName: name, publicKey: pubPem(kp), keyFingerprint: fpOf(kp), clientTime: 0 },
    "10.0.0.2",
  );
  assert.ok(started.ok, JSON.stringify(started));
  const payload = pairingSigningPayload({ hubOrigin: HUB_ORIGIN, hubId: HUB_ID, enrollmentId: started.value.enrollmentId, nonce: started.value.nonce, issuedAt: started.value.issuedAt, deviceUid, keyFingerprint: fpOf(kp) });
  const proofBody = { type: "pair.response", v: 1, enrollmentId: started.value.enrollmentId, nonce: started.value.nonce, signature: edSign(null, Buffer.from(payload), kp.privateKey).toString("base64url") };
  const v1 = await w.pairing.verify(proofBody, "10.0.0.2");
  assert.ok(v1.ok && v1.status === 202);
  const ap = w.pairing.approve(code.value.codeId, { enrollmentId: started.value.enrollmentId, deviceUid, keyFingerprint: fpOf(kp), ...(replaceKey ? { replaceKey: true } : {}) });
  assert.ok(ap.ok, JSON.stringify(ap));
  const v2 = await w.pairing.verify(proofBody, "10.0.0.2");
  assert.ok(v2.ok && v2.status === 200, JSON.stringify(v2));
  return v2.value as TokenIssue;
}

test("issuance: atomic rows + audit in one transaction; token hash only, never plaintext", async () => {
  const w = await world();
  try {
    const uid = uuid();
    const kp = kpOf();
    const issue = await pairThrough(w, uid, kp);
    assert.ok(checkPairingDto(TokenIssueSchema, issue));
    // registry rows
    const dev = w.registry.db.prepare("SELECT * FROM devices WHERE id=?").get(issue.deviceId) as Record<string, unknown>;
    assert.equal(dev.transport, "tunnel");
    assert.equal(dev.url, null);
    assert.equal(dev.token, null);
    assert.equal(dev.device_uid, uid);
    const pairingRow = w.registry.db.prepare("SELECT * FROM pairings WHERE device_id=?").get(issue.deviceId) as Record<string, unknown>;
    assert.equal(pairingRow.status, "paired");
    assert.equal(pairingRow.credential_generation, 1);
    assert.equal(pairingRow.key_fingerprint, fpOf(kp));
    const cred = w.registry.db.prepare("SELECT * FROM tunnel_credentials WHERE credential_id=?").get(issue.credentialId) as Record<string, unknown>;
    assert.equal(cred.status, "current");
    assert.equal(cred.generation, 1);
    assert.equal(cred.token_hash, createHash("sha256").update(issue.tunnelToken).digest("hex"));
    // audit row exists in the same DB
    const events = w.registry.db.prepare("SELECT action FROM events WHERE action='pair.success'").all() as { action: string }[];
    assert.equal(events.length, 1);
    // no plaintext token anywhere in the DB dump
    const dump = JSON.stringify(w.registry.db.prepare("SELECT * FROM tunnel_credentials").all()) + JSON.stringify(pairingRow);
    assert.ok(!dump.includes(issue.tunnelToken));
    assert.ok(!dump.includes("dpt_"));
  } finally { await w.cleanup(); }
});

test("issuance: existing LAN row converts (identity preserved, url/token cleared)", async () => {
  const w = await world();
  try {
    const uid = uuid();
    w.registry.upsert({ id: "known-dev", url: "http://10.0.0.5:7900", token: "lan-token-xxxxxxxxxxxxxxxxxxxxxxxx" });
    w.registry.db.prepare("UPDATE devices SET device_uid=? WHERE id='known-dev'").run(uid);
    const issue = await pairThrough(w, uid);
    assert.equal(issue.deviceId, "known-dev"); // same identity
    const dev = w.registry.db.prepare("SELECT * FROM devices WHERE id='known-dev'").get() as Record<string, unknown>;
    assert.equal(dev.transport, "tunnel");
    assert.equal(dev.url, null);
    assert.equal(dev.token, null);
  } finally { await w.cleanup(); }
});

test("preflight: duplicate device_uid rows → identity_conflict, nothing mutated", async () => {
  const w = await world();
  try {
    const uid = uuid();
    w.registry.upsert({ id: "dup-a", url: "http://10.0.0.1:7900" });
    w.registry.upsert({ id: "dup-b", url: "http://10.0.0.2:7900" });
    // v1's unique index prevents duplicates from ever appearing normally; the
    // preflight guard covers DBs corrupted behind the index's back.
    w.registry.db.exec("DROP INDEX devices_uid_unique");
    w.registry.db.prepare("UPDATE devices SET device_uid=? WHERE id='dup-a'").run(uid);
    w.registry.db.prepare("UPDATE devices SET device_uid=? WHERE id='dup-b'").run(uid);
    await assert.rejects(w.credentials.issue({ enrollmentId: uuid(), codeId: uuid(), deviceUid: uid, deviceName: "x", publicKeyPem: pubPem(kpOf()), keyFingerprint: fpOf(kpOf()), replaceKey: false }), /identity_conflict|maps to 2 rows/);
  } finally { await w.cleanup(); }
});

test("re-pair: old epoch revoked (tombstones kept), new epoch current gen 1; stale receipt refused", async () => {
  const w = await world();
  try {
    const uid = uuid();
    const first = await pairThrough(w, uid, kpOf(), "dev");
    const secondKp = kpOf();
    // Re-pair with a changed key requires replaceKey (P2-09 rule) — approve with flag.
    const code = w.pairing.createCode("10.0.0.1");
    assert.ok(code.ok);
    const started = w.pairing.start({ type: "pair.request", v: 1, requestId: uuid(), code: code.value.code, deviceUid: uid, deviceName: "dev", publicKey: pubPem(secondKp), keyFingerprint: fpOf(secondKp), clientTime: 0 }, "10.0.0.2");
    assert.ok(started.ok);
    const payload = pairingSigningPayload({ hubOrigin: HUB_ORIGIN, hubId: HUB_ID, enrollmentId: started.value.enrollmentId, nonce: started.value.nonce, issuedAt: started.value.issuedAt, deviceUid: uid, keyFingerprint: fpOf(secondKp) });
    const proofBody = { type: "pair.response", v: 1, enrollmentId: started.value.enrollmentId, nonce: started.value.nonce, signature: edSign(null, Buffer.from(payload), secondKp.privateKey).toString("base64url") };
    await w.pairing.verify(proofBody, "10.0.0.2");
    const ap = w.pairing.approve(code.value.codeId, { enrollmentId: started.value.enrollmentId, deviceUid: uid, keyFingerprint: fpOf(secondKp), replaceKey: true });
    assert.ok(ap.ok, JSON.stringify(ap));
    const v2 = await w.pairing.verify(proofBody, "10.0.0.2");
    assert.ok(v2.ok && (v2.value as TokenIssue).type === "pair.token");
    const second = v2.value as TokenIssue;
    assert.notEqual(second.pairingEpoch, first.pairingEpoch);

    // old epoch credentials: revoked, hashes retained as tombstones
    const oldCred = w.registry.db.prepare("SELECT status, token_hash FROM tunnel_credentials WHERE credential_id=?").get(first.credentialId) as { status: string; token_hash: string };
    assert.equal(oldCred.status, "revoked");
    assert.equal(oldCred.token_hash.length, 64); // tombstone kept
    // receipt validation
    assert.equal(w.credentials.receiptStillValid(first), false);
    assert.equal(w.credentials.receiptFailure(first), "paired_elsewhere");
    assert.equal(w.credentials.receiptStillValid(second), true);
  } finally { await w.cleanup(); }
});

test("revoke invalidates the cached receipt (invalid, not paired_elsewhere)", async () => {
  const w = await world();
  try {
    const issue = await pairThrough(w, uuid(), kpOf(), "dev");
    // simulate operator revoke
    const t = Date.now();
    w.audit.withTransaction(() => {
      w.registry.db.prepare("UPDATE tunnel_credentials SET status='revoked', revoked_at=? WHERE device_id=? AND status IN ('current','previous')").run(t, issue.deviceId);
      w.registry.db.prepare("UPDATE pairings SET status='revoked', updated_at=? WHERE device_id=?").run(t, issue.deviceId);
      w.audit.append({ actor: "admin", action: "pair.revoke", outcome: "ok", detail: { deviceId: issue.deviceId } });
    });
    assert.equal(w.credentials.receiptStillValid(issue), false);
    assert.equal(w.credentials.receiptFailure(issue), "invalid"); // same epoch, revoked
  } finally { await w.cleanup(); }
});

test("transaction injection: after-prepare rolls back EVERYTHING", async () => {
  const w = await world("after-prepare");
  try {
    await assert.rejects(
      w.credentials.issue({ enrollmentId: uuid(), codeId: uuid(), deviceUid: uuid(), deviceName: "x", publicKeyPem: pubPem(kpOf()), keyFingerprint: fpOf(kpOf()), replaceKey: false }),
      /after-prepare/,
    );
    assert.equal((w.registry.db.prepare("SELECT count(*) AS n FROM tunnel_credentials").get() as { n: number }).n, 0);
    assert.equal((w.registry.db.prepare("SELECT count(*) AS n FROM pairings").get() as { n: number }).n, 0);
    assert.equal((w.registry.db.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n, 0);
    const devices = (w.registry.db.prepare("SELECT count(*) AS n FROM devices WHERE transport='tunnel'").get() as { n: number }).n;
    assert.equal(devices, 0); // no partial identity row
  } finally { await w.cleanup(); }
});

test("commit/cache gap: after-commit throws but the DB is committed (documented gap → enrollment_lost on restart)", async () => {
  const w = await world("after-commit");
  try {
    await assert.rejects(
      w.credentials.issue({ enrollmentId: uuid(), codeId: uuid(), deviceUid: uuid(), deviceName: "x", publicKeyPem: pubPem(kpOf()), keyFingerprint: fpOf(kpOf()), replaceKey: false }),
      /after-commit/,
    );
    // The credential IS committed; only the response was lost. The device
    // cannot replay it (RAM receipt gone with the code) — new code + approval.
    const n = (w.registry.db.prepare("SELECT count(*) AS n FROM tunnel_credentials").get() as { n: number }).n;
    assert.equal(n, 1);
  } finally { await w.cleanup(); }
});

test("pairing integration: after re-pair the FIRST enrollment's cached verify fails paired_elsewhere", async () => {
  const w = await world();
  try {
    const uid = uuid();
    const kp1 = kpOf();
    // first enrollment (kept alive for the cached-retry path)
    const code1 = w.pairing.createCode("10.0.0.1");
    assert.ok(code1.ok);
    const s1 = w.pairing.start({ type: "pair.request", v: 1, requestId: uuid(), code: code1.value.code, deviceUid: uid, deviceName: "dev", publicKey: pubPem(kp1), keyFingerprint: fpOf(kp1), clientTime: 0 }, "10.0.0.2");
    assert.ok(s1.ok);
    const payload1 = pairingSigningPayload({ hubOrigin: HUB_ORIGIN, hubId: HUB_ID, enrollmentId: s1.value.enrollmentId, nonce: s1.value.nonce, issuedAt: s1.value.issuedAt, deviceUid: uid, keyFingerprint: fpOf(kp1) });
    const proof1 = { type: "pair.response", v: 1, enrollmentId: s1.value.enrollmentId, nonce: s1.value.nonce, signature: edSign(null, Buffer.from(payload1), kp1.privateKey).toString("base64url") };
    await w.pairing.verify(proof1, "10.0.0.2");
    w.pairing.approve(code1.value.codeId, { enrollmentId: s1.value.enrollmentId, deviceUid: uid, keyFingerprint: fpOf(kp1) });
    const issued1 = await w.pairing.verify(proof1, "10.0.0.2");
    assert.ok(issued1.ok && (issued1.value as TokenIssue).type === "pair.token");

    // second enrollment re-pairs the same uid with a NEW key (replaceKey)
    await pairThrough(w, uid, kpOf(), "dev", true);

    // cached retry of the FIRST enrollment must NOT return its stale secret
    const stale = await w.pairing.verify(proof1, "10.0.0.2");
    assert.ok(!stale.ok && stale.error.code === "paired_elsewhere", JSON.stringify(stale));
  } finally { await w.cleanup(); }
});

