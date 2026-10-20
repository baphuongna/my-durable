/**
 * Review 2026-10-20 regressions — pairing lifecycle (Cluster A).
 * F01 invalidation terminal · F02 proof on every poll · F03 issuance serialized
 * F04 audit-before-approval · F14 keyChanged pre-approval · F15 sweep removes issued receipts.
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
const deviceKey = () => generateKeyPairSync("ed25519");
const pubPem = (kp: ReturnType<typeof deviceKey>) => kp.publicKey.export({ type: "spki", format: "pem" }) as string;
const fingerprintOf = (kp: ReturnType<typeof deviceKey>) =>
  `sha256:${createHash("sha256").update(kp.publicKey.export({ type: "spki", format: "der" }) as Buffer).digest("hex")}`;

interface Fx {
  registry: NetworkRegistry;
  audit: Audit;
  service: PairingService;
  issueCount: () => number;
  revoke: { v: boolean };
  clock: { now: number };
  cleanup: () => Promise<void>;
}
async function fixture(): Promise<Fx> {
  const dir = await mkdtemp(join(tmpdir(), "dpi-pl-"));
  const registry = new NetworkRegistry(join(dir, "network.sqlite"));
  const audit = new Audit(registry);
  const clock = { now: 1760000000000 };
  let issued = 0;
  const revoked = { v: false };
  const service = new PairingService({
    registry, audit, hubOrigin: HUB_ORIGIN, hubId: HUB_ID,
    now: () => clock.now,
    issue: async (e) => {
      issued++;
      return {
        type: "pair.token", v: 1, enrollmentId: e.enrollmentId, deviceUid: e.deviceUid,
        deviceId: "dev-issued", pairingEpoch: uuid(), credentialId: `cred-${issued}`, generation: 1,
        hubId: HUB_ID, hubOrigin: HUB_ORIGIN, hubUrl: `${HUB_ORIGIN}/api/tunnel`,
        tunnelToken: `dpt_${"C".repeat(43)}`, issuedAt: clock.now, expiresAt: null,
      } satisfies TokenIssue;
    },
    receiptValidator: () => (revoked.v ? { code: "revoked" as const } : true as const),
  });
  return { registry, audit, service, issueCount: () => issued, revoke: revoked, clock, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

interface Enrolled {
  codeId: string;
  uid: string;
  proofBody: { type: "pair.response"; v: 1; enrollmentId: string; nonce: string; signature: string };
  kp: ReturnType<typeof deviceKey>;
}
async function enroll(fx: Fx, kp = deviceKey(), uid = uuid()): Promise<Enrolled> {
  const created = fx.service.createCode("10.0.0.1");
  assert.ok(created.ok);
  const started = fx.service.start(
    { type: "pair.request", v: 1, requestId: uuid(), code: created.value.code, deviceUid: uid,
      deviceName: "dev-a", publicKey: pubPem(kp), keyFingerprint: fingerprintOf(kp), clientTime: 0 },
    "10.0.0.2",
  );
  assert.ok(started.ok, JSON.stringify(started));
  const payload = pairingSigningPayload({
    hubOrigin: HUB_ORIGIN, hubId: HUB_ID, enrollmentId: started.value.enrollmentId,
    nonce: started.value.nonce, issuedAt: started.value.issuedAt, deviceUid: uid, keyFingerprint: fingerprintOf(kp),
  });
  const proofBody = {
    type: "pair.response" as const, v: 1 as const, enrollmentId: started.value.enrollmentId,
    nonce: started.value.nonce, signature: edSign(null, Buffer.from(payload), kp.privateKey).toString("base64url"),
  };
  const verified = await fx.service.verify(proofBody, "10.0.0.2");
  assert.ok(verified.ok && verified.status === 202, JSON.stringify(verified));
  return { codeId: created.value.codeId, uid, proofBody, kp };
}
async function approve(fx: Fx, e: Enrolled) {
  const st = fx.service.status(e.codeId);
  assert.ok(st.ok);
  const r = fx.service.approve(e.codeId, {
    enrollmentId: st.value.enrollment!.enrollmentId, deviceUid: st.value.enrollment!.deviceUid,
    keyFingerprint: st.value.enrollment!.keyFingerprint,
  });
  assert.ok(r.ok, JSON.stringify(r));
}

test("F01 regression: revoked receipt → enrollment TERMINAL, no re-issue on later polls", async (t) => {
  const fx = await fixture();
  t.after(() => fx.cleanup());
  const e = await enroll(fx);
  await approve(fx, e);
  const got = await fx.service.verify(e.proofBody, "10.0.0.2");
  assert.ok(got.ok && got.status === 200);
  assert.equal(fx.issueCount(), 1);
  fx.revoke.v = true; // credential revoked downstream
  const r1 = await fx.service.verify(e.proofBody, "10.0.0.2");
  assert.ok(!r1.ok, "receipt re-validation fails");
  const r2 = await fx.service.verify(e.proofBody, "10.0.0.2");
  assert.ok(!r2.ok && (r2.error.code === "revoked" || r2.error.code === "reauth_required"), `terminal, got ${JSON.stringify(r2.ok ? r2.value : r2.error)}`);
  assert.equal(fx.issueCount(), 1, "no second credential is EVER minted for this enrollment");
});

test("F02 regression: proof mismatch on a verified receipt → 401, never a token", async (t) => {
  const fx = await fixture();
  t.after(() => fx.cleanup());
  const e = await enroll(fx);
  await approve(fx, e);
  const bad = { ...e.proofBody, nonce: "x".repeat(43), signature: "A".repeat(86) };
  const poll = await fx.service.verify(bad, "10.9.9.9");
  assert.ok(!poll.ok && poll.error.status === 401, `401, got ${JSON.stringify(poll.ok ? poll.value : poll.error)}`);
  assert.equal(fx.issueCount(), 0, "no issuance for a proof-less poll");
  // The legitimate device still gets its credential with the SAME proof.
  const good = await fx.service.verify(e.proofBody, "10.0.0.2");
  assert.ok(good.ok && good.status === 200);
});

test("F03 regression: concurrent approved polls → ONE issuance, ONE credential", async (t) => {
  const fx = await fixture();
  t.after(() => fx.cleanup());
  const e = await enroll(fx);
  await approve(fx, e);
  const [a, b] = await Promise.all([fx.service.verify(e.proofBody, "10.0.0.2"), fx.service.verify(e.proofBody, "10.0.0.2")]);
  assert.ok(a.ok && a.status === 200 && b.ok && b.status === 200, `both 200: ${JSON.stringify([a, b])}`);
  assert.equal(fx.issueCount(), 1, "deps.issue called exactly once");
  assert.equal((a.value as TokenIssue).credentialId, (b.value as TokenIssue).credentialId, "same credential");
  const again = await fx.service.verify(e.proofBody, "10.0.0.2");
  assert.ok(again.ok && (again.value as TokenIssue).credentialId === (a.value as TokenIssue).credentialId);
});

test("F04 regression: audit failure on approve → approval NOT live; later polls never issue", async (t) => {
  const fx = await fixture();
  t.after(() => fx.cleanup());
  const e = await enroll(fx);
  const realAppend = fx.audit.append.bind(fx.audit);
  fx.audit.append = ((entry: { action: string }) => {
    if (entry.action === "pair.approved") throw new Error("audit storage down");
    return realAppend(entry as never);
  }) as never;
  assert.throws(() => {
    const st = fx.service.status(e.codeId);
    assert.ok(st.ok);
    const r = fx.service.approve(e.codeId, { enrollmentId: st.value.enrollment!.enrollmentId, deviceUid: st.value.enrollment!.deviceUid, keyFingerprint: st.value.enrollment!.keyFingerprint });
    assert.ok(r.ok, JSON.stringify(r));
  }, /audit storage down/);
  fx.audit.append = realAppend as never;
  const poll = await fx.service.verify(e.proofBody, "10.0.0.2");
  assert.ok(poll.ok && poll.status === 202, `still awaiting a REAL approval, got ${JSON.stringify(poll.ok ? { status: poll.status } : poll.error)}`);
  assert.equal(fx.issueCount(), 0);
});

test("F14 regression: status reports keyChanged BEFORE approval (from enrollment key vs stored pairing)", async (t) => {
  const fx = await fixture();
  t.after(() => fx.cleanup());
  // A device already paired with key A.
  const oldKp = deviceKey();
  const oldUid = uuid();
  const now = String(fx.clock.now);
  fx.registry.db.prepare(
    "INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,created_at,updated_at,transport) VALUES(?,?,'url',NULL,NULL,'ui',0,?,'checking',?,?,'tunnel')",
  ).run("dev-old", "dev-old", oldUid, now, now);
  fx.registry.db.prepare(
    "INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at) VALUES(?,?,?,?,'paired',1,?,?,?)",
  ).run("dev-old", uuid(), pubPem(oldKp), fingerprintOf(oldKp), now, now, now);
  // The same UID enrolls again with key B → keyChanged must be visible pre-approval.
  const e = await enroll(fx, deviceKey(), oldUid);
  const st = fx.service.status(e.codeId);
  assert.ok(st.ok && st.value.enrollment);
  assert.equal(st.value.enrollment!.keyChanged, true, "keyChanged true BEFORE approval");
  // And the approve gate still enforces replaceKey for a changed key.
  const ap = fx.service.approve(e.codeId, { enrollmentId: st.value.enrollment!.enrollmentId, deviceUid: oldUid, keyFingerprint: st.value.enrollment!.keyFingerprint });
  assert.ok(!ap.ok && ap.error.code === "invalid" && /replaceKey/.test(ap.error.message));
  const ap2 = fx.service.approve(e.codeId, { enrollmentId: st.value.enrollment!.enrollmentId, deviceUid: oldUid, keyFingerprint: st.value.enrollment!.keyFingerprint, replaceKey: true });
  assert.ok(ap2.ok, JSON.stringify(ap2));
});

test("F15 regression: sweep drops issued receipts past expiry+grace; keeps them inside grace", async (t) => {
  const fx = await fixture();
  t.after(() => fx.cleanup());
  const e = await enroll(fx);
  await approve(fx, e);
  const got = await fx.service.verify(e.proofBody, "10.0.0.2");
  assert.ok(got.ok && got.status === 200);
  fx.clock.now += 300_000; // code expiry (CODE_TTL 5 min)
  const inGrace = await fx.service.verify(e.proofBody, "10.0.0.2");
  assert.ok(inGrace.ok && inGrace.status === 200, "grace window: receipt still readable");
  fx.service.sweep(); // inside grace (120s): nothing dropped
  const still = await fx.service.verify(e.proofBody, "10.0.0.2");
  assert.ok(still.ok && still.status === 200, "sweep inside grace keeps the receipt");
  fx.clock.now += 121_000; // past grace
  fx.service.sweep();
  const gone = await fx.service.verify(e.proofBody, "10.0.0.2");
  assert.ok(!gone.ok && gone.error.code === "enrollment_lost", "issued receipt dropped past grace — no plaintext token outlives its TTL");
});
