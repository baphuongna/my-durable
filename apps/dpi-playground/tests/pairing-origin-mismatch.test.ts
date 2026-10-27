/**
 * Hub pairing origin-mismatch detection (R6 cli finding 5).
 *
 * A hub started WITHOUT DPI_HUB_ORIGIN signs its payloads as
 * https://<hostname> while a device on the LAN signs the origin it DIALED
 * (e.g. http://192.168.1.50:4781). Every proof then "fails" signature
 * verification, and the old code counted each one toward
 * PAIR_SIGNATURE_FAIL_LIMIT — the enrollment read as an ATTACK and died with
 * "Too many invalid signatures; enrollment cancelled".
 *
 * The wire proof carries no declared origin (the signing payload binds one but
 * it is never sent), so verify() takes a best-effort `requestOrigin` — the
 * origin of the HTTP request itself. When the SAME signature verifies under
 * the request origin, the hub answers `origin_mismatch` with the fix spelled
 * out instead of counting a generic invalid signature.
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
import { pairingSigningPayload, type TokenIssue } from "../../dpi-sdk/src/protocol/pairing.js";

/** The hub runs WITHOUT DPI_HUB_ORIGIN: it signs as its hostname default. */
const HUB_ORIGIN = "https://fileserver.local";
/** What the device actually dialed to reach it on the LAN. */
const DIALED_ORIGIN = "http://192.168.1.50:4781";
const HUB_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const uuid = () => "1f2e3d4c-5b6a-7988-8796-a5b4c3d2e1f1";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "dpi-pair-origin-"));
  const registry = new NetworkRegistry(join(dir, "network.sqlite"));
  const audit = new Audit(registry);
  const clock = { now: 1_760_000_000_000 };
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
  return { service, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

interface Enrolled {
  challenge: { enrollmentId: string; nonce: string; issuedAt: number; hubId: string };
  kp: ReturnType<typeof generateKeyPairSync>;
  deviceUid: string;
}

async function enroll(service: PairingService): Promise<Enrolled> {
  const created = service.createCode("10.0.0.1");
  assert.ok(created.ok);
  const kp = generateKeyPairSync("ed25519");
  const fingerprint = `sha256:${createHash("sha256")
    .update(kp.publicKey.export({ type: "spki", format: "der" }) as Buffer)
    .digest("hex")}`;
  const deviceUid = uuid();
  const started = service.start(
    {
      type: "pair.request",
      v: 1,
      requestId: uuid(),
      code: created.value.code,
      deviceUid,
      deviceName: "lan-device",
      publicKey: kp.publicKey.export({ type: "spki", format: "pem" }) as string,
      keyFingerprint: fingerprint,
      clientTime: 0,
    },
    "10.0.0.2",
  );
  assert.ok(started.ok, JSON.stringify(started));
  return { challenge: started.value as Enrolled["challenge"], kp, deviceUid };
}

/** A proof signed for a SPECIFIC hub origin — the payload binds it normatively. */
function proofFor(e: Enrolled, hubOrigin: string) {
  const payload = pairingSigningPayload({
    hubOrigin,
    hubId: e.challenge.hubId,
    enrollmentId: e.challenge.enrollmentId,
    nonce: e.challenge.nonce,
    issuedAt: e.challenge.issuedAt,
    deviceUid: e.deviceUid,
    keyFingerprint: `sha256:${createHash("sha256")
      .update(e.kp.publicKey.export({ type: "spki", format: "der" }) as Buffer)
      .digest("hex")}`,
  });
  return {
    type: "pair.response" as const,
    v: 1 as const,
    enrollmentId: e.challenge.enrollmentId,
    nonce: e.challenge.nonce,
    signature: edSign(null, Buffer.from(payload), e.kp.privateKey).toString("base64url"),
  };
}

test("device signed for its DIALED origin: origin_mismatch, not an invalid-signature tally", async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const e = await enroll(fx.service);

  const r = await fx.service.verify(proofFor(e, DIALED_ORIGIN), "10.0.0.2", DIALED_ORIGIN);
  assert.ok(!r.ok, "the proof still fails (the hub cannot accept it)");
  assert.equal(r.error.code, "origin_mismatch");
  assert.equal(r.error.status, 409);
  assert.match(r.error.message, /origin mismatch: device signed for http:\/\/192\.168\.1\.50:4781/);
  assert.match(r.error.message, /hub signs as https:\/\/fileserver\.local/);
  assert.match(r.error.message, /set DPI_HUB_ORIGIN on the hub/);
});

test("an origin-mismatch proof does NOT count toward the cancel limit — a correct proof still passes after it", async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const e = await enroll(fx.service);

  // Hammer it with mismatched proofs well past PAIR_SIGNATURE_FAIL_LIMIT.
  for (let i = 0; i < 8; i += 1) {
    const bad = await fx.service.verify(proofFor(e, DIALED_ORIGIN), "10.0.0.2", DIALED_ORIGIN);
    assert.equal((bad as { ok: false }).error.code, "origin_mismatch", `attempt ${i}`);
  }
  // The same proof WITH the hub's origin now verifies → awaiting_approval.
  const good = await fx.service.verify(proofFor(e, HUB_ORIGIN), "10.0.0.2", DIALED_ORIGIN);
  assert.ok(good.ok, "enrollment survives mismatched attempts — it was never an attack");
  const value = good.value as { type: string; state?: string };
  assert.match(`${value.type} ${value.state ?? ""}`, /pair\.pending|awaiting_approval/);
});

test("without requestOrigin the old behavior holds: generic signature_invalid, counted", async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const e = await enroll(fx.service);
  const r = await fx.service.verify(proofFor(e, DIALED_ORIGIN), "10.0.0.2");
  assert.ok(!r.ok);
  assert.equal((r as { error: { code: string } }).error.code, "signature_invalid");
  assert.equal((r as { error: { status: number } }).error.status, 401);
});

test("a genuinely WRONG key is never dressed up as origin_mismatch", async (t) => {
  const fx = await fixture();
  t.after(fx.cleanup);
  const e = await enroll(fx.service);
  const stranger = generateKeyPairSync("ed25519");
  const proof = proofFor(e, DIALED_ORIGIN);
  // Sign the same payload with a DIFFERENT key: fails under both origins.
  const payload = pairingSigningPayload({
    hubOrigin: DIALED_ORIGIN,
    hubId: e.challenge.hubId,
    enrollmentId: e.challenge.enrollmentId,
    nonce: e.challenge.nonce,
    issuedAt: e.challenge.issuedAt,
    deviceUid: e.deviceUid,
    keyFingerprint: "sha256:" + "0".repeat(64),
  });
  const forged = {
    ...proof,
    signature: edSign(null, Buffer.from(payload), stranger.privateKey).toString("base64url"),
  };
  const r = await fx.service.verify(forged, "10.0.0.2", DIALED_ORIGIN);
  assert.ok(!r.ok);
  assert.equal((r as { error: { code: string } }).error.code, "signature_invalid");
});
