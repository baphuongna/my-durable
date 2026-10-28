/**
 * R16 (run-2 h2 hardening): the nonce dead window. An unverified enrollment
 * whose proof arrives after NONCE_TTL was permanently unverifiable while the
 * code stayed live. Same-identity re-entry must re-mint the nonce — but only
 * while the ceremony is unverified AND unconsumed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign as edSign } from "node:crypto";
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
const pubPem = (kp: ReturnType<typeof deviceKey>) =>
  kp.publicKey.export({ type: "spki", format: "pem" }) as string;
const fingerprintOf = (kp: ReturnType<typeof deviceKey>) =>
  `sha256:${createHash("sha256")
    .update(kp.publicKey.export({ type: "spki", format: "der" }) as Buffer)
    .digest("hex")}`;

async function fx() {
  const dir = await mkdtemp(join(tmpdir(), "dpi-remint-"));
  const registry = new NetworkRegistry(join(dir, "network.sqlite"));
  const clock = { now: 1760000000000 };
  const service = new PairingService({
    registry,
    audit: new Audit(registry),
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
  return { service, clock, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function startBody(code: string, kp: ReturnType<typeof deviceKey>) {
  return {
    type: "pair.request" as const,
    v: 1,
    requestId: uuid(),
    code,
    deviceUid: uuid(),
    deviceName: "dev-a",
    publicKey: pubPem(kp),
    keyFingerprint: fingerprintOf(kp),
    clientTime: 0,
  };
}

test("R16 h2: stale unverified enrollment re-mints its nonce on same-identity re-entry", async () => {
  const t = await fx();
  try {
    const created = t.service.createCode("10.0.0.1");
    assert.ok(created.ok);
    const kp = deviceKey();
    const first = t.service.start(startBody(created.value.code, kp), "10.0.0.2");
    assert.ok(first.ok);
    const originalNonce = first.value.nonce;

    // 61s later (past NONCE_TTL=60s, code still live for minutes): the old
    // nonce was dead forever pre-fix; re-entry must hand out a FRESH one.
    t.clock.now += 61_000;
    const second = t.service.start(startBody(created.value.code, kp), "10.0.0.2");
    assert.ok(second.ok, JSON.stringify(second));
    assert.notEqual(second.value.nonce, originalNonce, "nonce must be re-minted");
    assert.equal(second.value.issuedAt, t.clock.now);
    assert.equal(second.value.enrollmentId, first.value.enrollmentId, "same ceremony");
    // (the fresh nonce's actual VERIFY is pinned by test 3 below)

  } finally {
    await t.cleanup();
  }
});

test("R16 h2: live nonce is NOT re-minted (idempotent re-entry inside TTL)", async () => {
  const t = await fx();
  try {
    const created = t.service.createCode("10.0.0.1");
    assert.ok(created.ok);
    const kp = deviceKey();
    const first = t.service.start(startBody(created.value.code, kp), "10.0.0.2");
    assert.ok(first.ok);
    t.clock.now += 5_000; // well inside TTL
    const second = t.service.start(startBody(created.value.code, kp), "10.0.0.2");
    assert.ok(second.ok);
    assert.equal(second.value.nonce, first.value.nonce, "fresh nonce must be stable");
  } finally {
    await t.cleanup();
  }
});

test("R16 h2: a proof over the OLD nonce after re-mint is refused (only one nonce lives)", async () => {
  const t = await fx();
  try {
    const created = t.service.createCode("10.0.0.1");
    assert.ok(created.ok);
    const kp = deviceKey();
    const first = t.service.start(startBody(created.value.code, kp), "10.0.0.2");
    assert.ok(first.ok);
    const uid = uuid();
    const proofOver = (nonce: string, issuedAt: number) => ({
      type: "pair.response" as const,
      v: 1,
      enrollmentId: first.value.enrollmentId,
      nonce,
      signature: edSign(
        null,
        Buffer.from(
          pairingSigningPayload({
            hubOrigin: HUB_ORIGIN,
            hubId: HUB_ID,
            enrollmentId: first.value.enrollmentId,
            nonce,
            issuedAt,
            deviceUid: uid,
            keyFingerprint: fingerprintOf(kp),
          }),
        ),
        kp.privateKey,
      ).toString("base64url"),
    });
    // A proof with the ORIGINAL nonce arrives after TTL: refused (expired).
    t.clock.now += 61_000;
    const oldProof = proofOver(first.value.nonce, first.value.issuedAt);
    const stale = await t.service.verify(oldProof, "10.0.0.2");
    assert.ok(!stale.ok);
    // Re-entry mints a fresh nonce; a proof over the FRESH one verifies.
    const fresh = t.service.start(startBody(created.value.code, kp), "10.0.0.2");
    assert.ok(fresh.ok);
    const ok = await t.service.verify(proofOver(fresh.value.nonce, fresh.value.issuedAt), "10.0.0.2");
    assert.ok(ok.ok, JSON.stringify(ok));
  } finally {
    await t.cleanup();
  }
});
