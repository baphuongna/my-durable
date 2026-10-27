/**
 * R9 audit fixes (hub side):
 * 1.2 — a same-identity retry with a FRESH requestId re-enters its own live
 *       enrollment (same challenge) instead of 409-locking the code against its
 *       owner for the whole TTL; a different identity still gets 409 code_in_use.
 * 1.3 — when the receipt grace lapses with the token never delivered (device
 *       cancelled/crashed mid-poll — the route reports the dead socket), the
 *       sweep revokes the undeliverable credential (pair.abandoned). A DELIVERED
 *       receipt is never auto-revoked.
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
import { pairingSigningPayload } from "../../dpi-sdk/src/protocol/pairing.js";
import type { TokenIssue } from "../../dpi-sdk/src/protocol/pairing.js";

const HUB_ORIGIN = "https://pi.example.com";
const HUB_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const uuid = () => "1f2e3d4c-5b6a-7988-8796-a5b4c3d2e1f1";

interface Fixture {
  registry: NetworkRegistry;
  audit: Audit;
  service: PairingService;
  clock: { now: number };
  cleanup: () => Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "dpi-pair-r9-"));
  const registry = new NetworkRegistry(join(dir, "network.sqlite"));
  const audit = new Audit(registry);
  const clock = { now: 1760000000000 };
  const service = new PairingService({
    registry,
    audit,
    hubOrigin: HUB_ORIGIN,
    hubId: HUB_ID,
    now: () => clock.now,
    issue: async (e) =>
      ({
        type: "pair.token",
        v: 1,
        enrollmentId: e.enrollmentId,
        deviceUid: e.deviceUid,
        deviceId: "dev-issued",
        pairingEpoch: uuid(),
        credentialId: uuid(),
        generation: 1,
        hubId: HUB_ID,
        hubOrigin: HUB_ORIGIN,
        hubUrl: `${HUB_ORIGIN}/api/tunnel`,
        tunnelToken: `dpt_${"C".repeat(43)}`,
        issuedAt: clock.now,
        expiresAt: null,
      }) satisfies TokenIssue,
  });
  return {
    registry,
    audit,
    service,
    clock,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function deviceKey() {
  return generateKeyPairSync("ed25519");
}
const pubPem = (kp: ReturnType<typeof deviceKey>) =>
  kp.publicKey.export({ type: "spki", format: "pem" }) as string;
const fingerprintOf = (kp: ReturnType<typeof deviceKey>) =>
  `sha256:${createHash("sha256")
    .update(kp.publicKey.export({ format: "der", type: "spki" }) as Buffer)
    .digest("hex")}`;

async function enroll(fx: Fixture, kp = deviceKey(), uid = uuid()) {
  const created = fx.service.createCode("10.0.0.1");
  assert.ok(created.ok);
  const started = fx.service.start(
    {
      type: "pair.request",
      v: 1,
      requestId: uuid(),
      code: created.value.code,
      deviceUid: uid,
      deviceName: "dev-a",
      publicKey: pubPem(kp),
      keyFingerprint: fingerprintOf(kp),
      clientTime: 0,
    },
    "10.0.0.2",
  );
  assert.ok(started.ok, JSON.stringify(started));
  return { code: created.value.code, codeId: created.value.codeId, challenge: started.value, kp, uid };
}

function proof(fx: Fixture, e: Awaited<ReturnType<typeof enroll>>) {
  const payload = pairingSigningPayload({
    hubOrigin: HUB_ORIGIN,
    hubId: HUB_ID,
    enrollmentId: e.challenge.enrollmentId,
    nonce: e.challenge.nonce,
    issuedAt: e.challenge.issuedAt,
    deviceUid: e.uid,
    keyFingerprint: fingerprintOf(e.kp),
  });
  return {
    type: "pair.response",
    v: 1,
    enrollmentId: e.challenge.enrollmentId,
    nonce: e.challenge.nonce,
    signature: edSign(null, Buffer.from(payload), e.kp.privateKey).toString("base64url"),
  };
}

/** The registry rows CredentialService.issue would have committed for this TokenIssue. */
function seedIssuedRows(fx: Fixture, e: Awaited<ReturnType<typeof enroll>>, issue: TokenIssue) {
  const now = fx.clock.now;
  fx.registry.db
    .prepare(
      "INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,created_at,updated_at,transport) VALUES(?,?,'url',NULL,NULL,'ui',0,?,'checking',?,?,'tunnel')",
    )
    .run(issue.deviceId, "dev-a", e.uid, now, now);
  fx.registry.db
    .prepare(
      "INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at) VALUES(?,?,?,?,'paired',1,?,?,?)",
    )
    .run(issue.deviceId, issue.pairingEpoch, pubPem(e.kp), fingerprintOf(e.kp), now, now, now);
  fx.registry.db
    .prepare(
      "INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at) VALUES(?,?,?,1,?,'current',?)",
    )
    .run(issue.credentialId, issue.deviceId, issue.pairingEpoch, "0".repeat(64), now);
}

const pairingRow = (fx: Fixture, deviceId: string) =>
  fx.registry.db
    .prepare("SELECT status FROM pairings WHERE device_id=?")
    .get(deviceId) as { status: string } | undefined;
const credentialRow = (fx: Fixture, credentialId: string) =>
  fx.registry.db
    .prepare("SELECT status FROM tunnel_credentials WHERE credential_id=?")
    .get(credentialId) as { status: string } | undefined;

test("R9 1.2: same identity + FRESH requestId re-enters its enrollment; a different identity still gets 409", async (t) => {
  const fx = await fixture();
  t.after(() => fx.cleanup());
  const kp = deviceKey();
  const uid = uuid();
  const created = fx.service.createCode("10.0.0.1");
  assert.ok(created.ok);
  const body = (requestId: string, key = kp) => ({
    type: "pair.request",
    v: 1,
    requestId,
    code: created.value.code,
    deviceUid: uid,
    deviceName: "dev-a",
    publicKey: pubPem(key),
    keyFingerprint: fingerprintOf(key),
    clientTime: 0,
  });

  // First start(): the hub creates the enrollment — then the response is LOST
  // (the scenario: flaky Wi-Fi after the hub committed).
  const first = fx.service.start(body(uuid()), "10.0.0.2");
  assert.ok(first.ok, JSON.stringify(first));

  // Retry mints a fresh requestId but the same device identity (uid+name+key).
  // It must get the SAME live ceremony — not 409 code_in_use for 5 minutes.
  const retry = fx.service.start(body(uuid()), "10.0.0.2");
  assert.ok(retry.ok, JSON.stringify(retry));
  assert.equal(retry.value.enrollmentId, first.value.enrollmentId, "same enrollment");
  assert.equal(retry.value.nonce, first.value.nonce, "same challenge nonce");
  assert.equal(retry.value.issuedAt, first.value.issuedAt, "same challenge issuedAt");

  // A DIFFERENT key (another device claiming the code) is still locked out.
  const other = deviceKey();
  const thief = fx.service.start(body(uuid(), other), "10.0.0.2");
  assert.ok(!thief.ok);
  assert.equal(thief.error.code, "code_in_use");
  assert.equal(thief.error.status, 409);
});

test("R9 1.3: receipt grace lapses with the token never delivered → sweep revokes the ghost credential (pair.abandoned)", async (t) => {
  const fx = await fixture();
  t.after(() => fx.cleanup());
  const e = await enroll(fx);
  const pb = proof(fx, e);
  const first = await fx.service.verify(pb, "10.0.0.2");
  assert.ok(first.ok && first.status === 202, "proof accepted, awaiting approval");
  const ap = fx.service.approve(e.codeId, {
    enrollmentId: e.challenge.enrollmentId,
    deviceUid: e.uid,
    keyFingerprint: fingerprintOf(e.kp),
  });
  assert.ok(ap.ok, JSON.stringify(ap));

  // The issuance poll arrives; the hub issues… and the response dies on a socket
  // the device already abandoned (local cancel race). The route reports the
  // loss exactly like the real /api/pair/verify wiring does.
  const issued = await fx.service.verify(pb, "10.0.0.2");
  assert.ok(issued.ok && issued.status === 200 && issued.value.type === "pair.token");
  assert.equal(issued.receiptSeq, 1);
  seedIssuedRows(fx, e, issued.value as TokenIssue);
  fx.service.markReceiptLost(e.challenge.enrollmentId, issued.receiptSeq!);

  fx.clock.now += 300_000 + 121_000; // code TTL + receipt grace, fully lapsed
  fx.service.sweep();

  assert.equal(pairingRow(fx, "dev-issued")?.status, "revoked", "ghost pairing retired");
  assert.equal(
    credentialRow(fx, (issued.value as TokenIssue).credentialId)?.status,
    "revoked",
    "undeliverable credential retired through the normal state machine",
  );
  const abandoned = fx.registry.db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE action='pair.abandoned'")
    .get() as { n: number };
  assert.equal(abandoned.n, 1, "one pair.abandoned audit row");
});

test("R9 1.3 control: a DELIVERED receipt is never auto-revoked by the grace sweep", async (t) => {
  const fx = await fixture();
  t.after(() => fx.cleanup());
  const e = await enroll(fx);
  const pb = proof(fx, e);
  const first = await fx.service.verify(pb, "10.0.0.2");
  assert.ok(first.ok && first.status === 202);
  assert.ok(fx.service.approve(e.codeId, {
    enrollmentId: e.challenge.enrollmentId,
    deviceUid: e.uid,
    keyFingerprint: fingerprintOf(e.kp),
  }).ok);
  const issued = await fx.service.verify(pb, "10.0.0.2");
  assert.ok(issued.ok && issued.status === 200 && issued.value.type === "pair.token");
  seedIssuedRows(fx, e, issued.value as TokenIssue);
  // The device READ the token (socket flushed) — no markReceiptLost.

  fx.clock.now += 300_000 + 121_000;
  fx.service.sweep();

  assert.equal(pairingRow(fx, "dev-issued")?.status, "paired", "healthy pairing untouched");
  assert.equal(
    credentialRow(fx, (issued.value as TokenIssue).credentialId)?.status,
    "current",
    "delivered credential stays current",
  );
  const abandoned = fx.registry.db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE action='pair.abandoned'")
    .get() as { n: number };
  assert.equal(abandoned.n, 0, "no abandonment audit for a delivered receipt");
});
