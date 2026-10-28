/**
 * R14 cold review finding 1 — cancel-during-issuance race: cancel() refused
 * only `issued`, so an admin cancel racing an in-flight issuance deleted the
 * code/enrollment bookkeeping while the device still received a live
 * pair.token — a ghost credential no sweep could ever retire. The fix treats
 * an IN-FLIGHT issuance as issued (409 already_issued): the operator revokes
 * the resulting credential instead of cancelling a committing transaction.
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
import { pairingSigningPayload, type TokenIssue } from "../../dpi-sdk/src/protocol/pairing.js";

const HUB_ORIGIN = "https://pi.example.com";
const HUB_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const uuid = randomUUID;

const deviceKey = () => generateKeyPairSync("ed25519");
const pubPem = (kp: ReturnType<typeof deviceKey>) =>
  kp.publicKey.export({ type: "spki", format: "pem" }) as string;
const fingerprintOf = (kp: ReturnType<typeof deviceKey>) =>
  `sha256:${createHash("sha256").update(kp.publicKey.export({ format: "der", type: "spki" }) as Buffer).digest("hex")}`;

test("cancel during an in-flight issuance is refused — no ghost credential", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-race-"));
  try {
    const registry = new NetworkRegistry(join(dir, "network.sqlite"));
    const audit = new Audit(registry);
    const now = { t: 1760000000000 };
    // Issuance hangs until the test releases it — the race window, made real.
    let releaseIssue: (() => void) | undefined;
    const issueGate = new Promise<void>((done) => (releaseIssue = done));
    const service = new PairingService({
      registry,
      audit,
      hubOrigin: HUB_ORIGIN,
      hubId: HUB_ID,
      now: () => now.t,
      issue: async (e) => {
        await issueGate;
        return {
          type: "pair.token",
          v: 1,
          enrollmentId: e.enrollmentId,
          deviceUid: e.deviceUid,
          deviceId: "dev-race",
          pairingEpoch: uuid(),
          credentialId: uuid(),
          generation: 1,
          hubId: HUB_ID,
          hubOrigin: HUB_ORIGIN,
          hubUrl: `${HUB_ORIGIN}/api/tunnel`,
          tunnelToken: `dpt_${"C".repeat(43)}`,
          issuedAt: now.t,
          expiresAt: null,
        } satisfies TokenIssue;
      },
    });

    // Enroll: mint → start → verify (202 pending) → approve.
    const created = service.createCode("10.0.0.1");
    assert.ok(created.ok);
    const kp = deviceKey();
    const uid = uuid();
    const started = service.start(
      {
        type: "pair.request",
        v: 1,
        requestId: uuid(),
        code: created.value.code,
        deviceUid: uid,
        deviceName: "race-dev",
        publicKey: pubPem(kp),
        keyFingerprint: fingerprintOf(kp),
        clientTime: 0,
      },
      "10.0.0.2",
    );
    assert.ok(started.ok, JSON.stringify(started));
    const ch = started.value as { enrollmentId: string; nonce: string; issuedAt: number };
    const payload = pairingSigningPayload({
      hubOrigin: HUB_ORIGIN,
      hubId: HUB_ID,
      enrollmentId: ch.enrollmentId,
      nonce: ch.nonce,
      issuedAt: ch.issuedAt,
      deviceUid: uid,
      keyFingerprint: fingerprintOf(kp),
    });
    const proof = {
      type: "pair.response",
      v: 1,
      enrollmentId: ch.enrollmentId,
      nonce: ch.nonce,
      signature: edSign(null, Buffer.from(payload), kp.privateKey).toString("base64url"),
    };
    const pending = await service.verify(proof, "10.0.0.2");
    assert.equal(pending.status, 202);
    const approve = service.approve(created.value.codeId, {
      enrollmentId: ch.enrollmentId,
      deviceUid: uid,
      keyFingerprint: fingerprintOf(kp),
    });
    assert.ok(approve.ok, JSON.stringify(approve));

    // The device polls; issuance STARTS and hangs in flight.
    const poll = service.verify(proof, "10.0.0.2");
    await new Promise((r) => setTimeout(r, 20)); // the issuance is now in-flight

    // Admin cancels MID-ISSUANCE: must be refused (a credential is committing).
    const cancel = service.cancel(created.value.codeId);
    assert.ok(!cancel.ok && cancel.error.code === "already_issued" && cancel.error.status === 409);
    // The bookkeeping survives, so sweep/receipt retirement can still see it.
    assert.ok(service.status(created.value.codeId).ok, "the code row survives the refused cancel");

    // The device's in-flight poll completes normally with the live token.
    releaseIssue!();
    const issued = await poll;
    assert.ok(issued.ok && issued.value.type === "pair.token");

    // And NOW cancel is a clean already_issued (post-commit contract).
    const cancelAfter = service.cancel(created.value.codeId);
    assert.ok(!cancelAfter.ok && cancelAfter.error.code === "already_issued");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
