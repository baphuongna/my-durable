/**
 * P2-09 pairing state machine: P-1/P-6/P-7/P-8/P-12/P-14, W-3 malformed,
 * rate limits, expiry boundaries. Real Ed25519 signing on the "device" side.
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

interface Fixture {
  registry: NetworkRegistry;
  audit: Audit;
  service: PairingService;
  issueCalls: { uid: string; fingerprint: string; replaceKey: boolean }[];
  clock: { now: number };
  cleanup: () => Promise<void>;
  restart: () => void;
}

async function fixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "dpi-pair-"));
  const registry = new NetworkRegistry(join(dir, "network.sqlite"));
  const audit = new Audit(registry);
  const clock = { now: 1760000000000 };
  const issueCalls: { uid: string; fingerprint: string; replaceKey: boolean }[] = [];
  let service = makeService();
  function makeService() {
    return new PairingService({
      registry,
      audit,
      hubOrigin: HUB_ORIGIN,
      hubId: HUB_ID,
      now: () => clock.now,
      issue: async (e) => {
        issueCalls.push({
          uid: e.deviceUid,
          fingerprint: e.keyFingerprint,
          replaceKey: e.replaceKey,
        });
        return {
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
        } satisfies TokenIssue;
      },
    });
  }
  return {
    registry,
    audit,
    service,
    issueCalls,
    clock,
    cleanup: () => rm(dir, { recursive: true, force: true }),
    restart: () => (service = makeService()),
    get service2() {
      return service;
    },
  } as Fixture & { service2: PairingService };
}

function deviceKey() {
  return generateKeyPairSync("ed25519");
}
const pubPem = (kp: ReturnType<typeof deviceKey>) =>
  kp.publicKey.export({ type: "spki", format: "pem" }) as string;
const fingerprintOf = (kp: ReturnType<typeof deviceKey>) =>
  `sha256:${createHash("sha256")
    .update(kp.publicKey.export({ type: "spki", format: "der" }) as Buffer)
    .digest("hex")}`;

async function enroll(fx: Fixture, kp = deviceKey()) {
  const created = fx.service.createCode("10.0.0.1");
  assert.ok(created.ok);
  const started = fx.service.start(
    {
      type: "pair.request",
      v: 1,
      requestId: uuid(),
      code: created.value.code,
      deviceUid: uuid(),
      deviceName: "dev-a",
      publicKey: pubPem(kp),
      keyFingerprint: fingerprintOf(kp),
      clientTime: 0,
    },
    "10.0.0.2",
  );
  assert.ok(started.ok, JSON.stringify(started));
  return { code: created.value.code, codeId: created.value.codeId, challenge: started.value, kp };
}

function proof(fx: Fixture, e: Awaited<ReturnType<typeof enroll>>, uid = uuid()) {
  const payload = pairingSigningPayload({
    hubOrigin: HUB_ORIGIN,
    hubId: HUB_ID,
    enrollmentId: e.challenge.enrollmentId,
    nonce: e.challenge.nonce,
    issuedAt: e.challenge.issuedAt,
    deviceUid: uid,
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

test("P-6: same requestId+tuple → same challenge; different tuple → code_in_use", async () => {
  const fx = await fixture();
  try {
    const created = fx.service.createCode("10.0.0.1");
    assert.ok(created.ok);
    const kp = deviceKey();
    const body = {
      type: "pair.request",
      v: 1,
      requestId: uuid(),
      code: created.value.code,
      deviceUid: uuid(),
      deviceName: "a",
      publicKey: pubPem(kp),
      keyFingerprint: fingerprintOf(kp),
      clientTime: 0,
    };
    const first = fx.service.start(body, "10.0.0.2");
    assert.ok(first.ok);
    const retry = fx.service.start(body, "10.0.0.2");
    assert.ok(retry.ok);
    assert.deepEqual(retry.value, first.value); // idempotent: same enrollmentId/nonce/issuedAt
    const other = fx.service.start({ ...body, deviceName: "b" }, "10.0.0.2");
    assert.ok(!other.ok && other.error.code === "code_in_use");
  } finally {
    await fx.cleanup();
  }
});

test("proof: valid signature → 202; status awaiting_approval with computed fingerprint", async () => {
  const fx = await fixture();
  try {
    const e = await enroll(fx);
    const uid = uuid();
    const r = await fx.service.verify(proof(fx, e, uid), "10.0.0.2");
    assert.ok(r.ok && r.status === 202 && r.value.state === "awaiting_approval");
    const s = fx.service.status(e.codeId);
    assert.ok(s.ok && s.value.phase === "awaiting_approval");
    const env = s.value.enrollment!;
    assert.equal(env.keyFingerprint, fingerprintOf(e.kp)); // hub-computed, not declared
    assert.ok(!JSON.stringify(s).includes("tunnelToken"));
  } finally {
    await fx.cleanup();
  }
});

test("P-7: wrong-key signature ×3 → cancelled; subsequent enrollment_cancelled; no issuance", async () => {
  const fx = await fixture();
  try {
    const e = await enroll(fx);
    const attacker = deviceKey();
    for (let i = 0; i < 3; i++) {
      const payload = pairingSigningPayload({
        hubOrigin: HUB_ORIGIN,
        hubId: HUB_ID,
        enrollmentId: e.challenge.enrollmentId,
        nonce: e.challenge.nonce,
        issuedAt: e.challenge.issuedAt,
        deviceUid: uuid(),
        keyFingerprint: fingerprintOf(e.kp),
      });
      const r = await fx.service.verify(
        {
          type: "pair.response",
          v: 1,
          enrollmentId: e.challenge.enrollmentId,
          nonce: e.challenge.nonce,
          signature: edSign(null, Buffer.from(payload), attacker.privateKey).toString("base64url"),
        },
        "10.0.0.9",
      );
      assert.ok(!r.ok, `attempt ${i} should fail`);
    }
    const after = await fx.service.verify(proof(fx, e), "10.0.0.2");
    assert.ok(!after.ok && after.error.code === "enrollment_cancelled");
    assert.equal(fx.issueCalls.length, 0); // no credential was minted or killed
    const s = fx.service.status(e.codeId);
    assert.ok(s.ok && s.value.phase === "cancelled");
  } finally {
    await fx.cleanup();
  }
});

test("P-8: stolen code + attacker's own valid proof never yields a credential; approval is the only gate", async () => {
  const fx = await fixture();
  try {
    const e = await enroll(fx); // attacker holds the stolen code and its own key
    const r = await fx.service.verify(proof(fx, e), "10.0.0.9");
    assert.ok(r.ok && r.status === 202); // nothing more until approval
    assert.equal(fx.issueCalls.length, 0);
    // wrong fingerprint → 409
    const badFp = fx.service.approve(e.codeId, {
      enrollmentId: e.challenge.enrollmentId,
      deviceUid: uuid(),
      keyFingerprint: "sha256:" + "00".repeat(32),
    });
    assert.ok(
      !badFp.ok && badFp.error.status === 409 && badFp.error.code === "fingerprint_mismatch",
    );
    // wrong enrollmentId → 409
    const badEid = fx.service.approve(e.codeId, {
      enrollmentId: uuid(),
      deviceUid: uuid(),
      keyFingerprint: fingerprintOf(e.kp),
    });
    assert.ok(!badEid.ok && badEid.error.status === 409);
    // approval before proof on a fresh code → 409
    const fresh = fx.service.createCode("10.0.0.1");
    assert.ok(fresh.ok);
    const noProof = fx.service.approve(fresh.value.codeId, {
      enrollmentId: uuid(),
      deviceUid: uuid(),
      keyFingerprint: fingerprintOf(e.kp),
    });
    assert.ok(!noProof.ok && noProof.error.status === 409);
    assert.equal(fx.issueCalls.length, 0);
    // polling stays 202 — no auto-approve ever
    const poll = await fx.service.verify(proof(fx, e), "10.0.0.9");
    assert.ok(poll.ok && poll.status === 202);
  } finally {
    await fx.cleanup();
  }
});

test("approve happy path: verify issues exactly once; retries return the SAME TokenIssue", async () => {
  const fx = await fixture();
  try {
    const e = await enroll(fx);
    const uid = uuid();
    const p = proof(fx, e, uid);
    await fx.service.verify(p, "10.0.0.2");
    const ap = fx.service.approve(e.codeId, {
      enrollmentId: e.challenge.enrollmentId,
      deviceUid: uid,
      keyFingerprint: fingerprintOf(e.kp),
    });
    assert.ok(ap.ok, JSON.stringify(ap));
    const first = await fx.service.verify(p, "10.0.0.2");
    assert.ok(first.ok && first.status === 200);
    const token = first.value as TokenIssue;
    assert.equal(token.type, "pair.token");
    fx.clock.now += 1_000; // S-3: one valid poll per second per enrollment
    const second = await fx.service.verify(p, "10.0.0.2");
    assert.ok(second.ok);
    assert.deepEqual(second.value, token); // same secret, no rotation per retry
    assert.equal(fx.issueCalls.length, 1);
    const s = fx.service.status(e.codeId);
    assert.ok(s.ok && s.value.phase === "issued" && s.value.deviceId === "dev-issued");
    assert.ok(!JSON.stringify(s).includes(token.tunnelToken)); // status never carries the token
  } finally {
    await fx.cleanup();
  }
});

test("P-1: expiry boundaries — approve/poll after expiry rejected; issued receipt lives in grace only", async () => {
  const fx = await fixture();
  try {
    const e = await enroll(fx);
    const uid = uuid();
    const p = proof(fx, e, uid);
    await fx.service.verify(p, "10.0.0.2");
    fx.service.approve(e.codeId, {
      enrollmentId: e.challenge.enrollmentId,
      deviceUid: uid,
      keyFingerprint: fingerprintOf(e.kp),
    });
    const issued = await fx.service.verify(p, "10.0.0.2");
    assert.ok(issued.ok && (issued.value as TokenIssue).type === "pair.token");
    fx.clock.now += 300_000 + 60_000; // expiry + 60s (inside grace)
    const inGrace = await fx.service.verify(p, "10.0.0.2");
    assert.ok(inGrace.ok); // retry of an ALREADY issued receipt
    fx.clock.now += 61_000; // past grace
    const past = await fx.service.verify(p, "10.0.0.2");
    assert.ok(!past.ok && past.error.code === "code_expired");

    // un-issued code after expiry: no late approval or issuance
    const fresh = fx.service.createCode("10.0.0.1");
    assert.ok(fresh.ok);
    fx.clock.now += 300_001;
    const late = fx.service.start(
      {
        type: "pair.request",
        v: 1,
        requestId: uuid(),
        code: fresh.value.code,
        deviceUid: uuid(),
        deviceName: "x",
        publicKey: pubPem(deviceKey()),
        keyFingerprint: fingerprintOf(deviceKey()),
        clientTime: 0,
      },
      "10.0.0.2",
    );
    assert.ok(!late.ok && late.error.code === "code_expired");
  } finally {
    await fx.cleanup();
  }
});

test("nonce: TTL 60s → challenge_expired; consumed nonce cannot be replayed pre-receipt", async () => {
  const fx = await fixture();
  try {
    const e = await enroll(fx);
    fx.clock.now += 61_000;
    const late = await fx.service.verify(proof(fx, e), "10.0.0.2");
    assert.ok(!late.ok && late.error.code === "challenge_expired");
  } finally {
    await fx.cleanup();
  }
});

test("P-12: cancel before issue invalidates everything; after issue → 409 already_issued; restart → enrollment_lost", async () => {
  const fx = await fixture();
  try {
    // before issue
    const e = await enroll(fx);
    await fx.service.verify(proof(fx, e), "10.0.0.2");
    const c = fx.service.cancel(e.codeId);
    assert.ok(c.ok && c.value.phase === "cancelled");
    const afterCancel = await fx.service.verify(proof(fx, e), "10.0.0.2");
    assert.ok(!afterCancel.ok && afterCancel.error.code === "enrollment_cancelled");
    const approveAfter = fx.service.approve(e.codeId, {
      enrollmentId: e.challenge.enrollmentId,
      deviceUid: uuid(),
      keyFingerprint: fingerprintOf(e.kp),
    });
    assert.ok(!approveAfter.ok && approveAfter.error.status === 410);

    // after issue → already_issued
    const e2 = await enroll(fx);
    const uid2 = uuid();
    const p2 = proof(fx, e2, uid2);
    await fx.service.verify(p2, "10.0.0.2");
    fx.service.approve(e2.codeId, {
      enrollmentId: e2.challenge.enrollmentId,
      deviceUid: uid2,
      keyFingerprint: fingerprintOf(e2.kp),
    });
    await fx.service.verify(p2, "10.0.0.2");
    const cancelIssued = fx.service.cancel(e2.codeId);
    assert.ok(
      !cancelIssued.ok &&
        cancelIssued.error.code === "already_issued" &&
        cancelIssued.error.status === 409,
    );

    // hub restart loses RAM state
    fx.restart();
    const lost = await fx.service2.verify(proof(fx, e2, uid2), "10.0.0.2");
    assert.ok(!lost.ok && lost.error.code === "enrollment_lost");
    const s = fx.service2.status(e2.codeId);
    assert.ok(!s.ok && s.error.code === "code_invalid");
  } finally {
    await fx.cleanup();
  }
});

test("P-14: changed key on an existing pairing needs replaceKey=true; unchanged key must not set it", async () => {
  const fx = await fixture();
  try {
    const uid = uuid();
    // simulate an already-paired device with an older key
    const oldKp = deviceKey();
    fx.registry.upsert({ id: "dev-old", url: "http://10.0.0.5:7900" });
    fx.registry.db.prepare("UPDATE devices SET device_uid=? WHERE id='dev-old'").run(uid);
    const t = fx.clock.now;
    fx.registry.db
      .prepare(
        "INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at) VALUES('dev-old','epoch','?','sha256:ab','paired',1,?,?,?)".replace(
          "?",
          oldKp.publicKey.export({ type: "spki", format: "pem" }) as string,
        ),
      )
      .run(t, t, t);

    const newKp = deviceKey();
    const created = fx.service.createCode("10.0.0.1");
    assert.ok(created.ok);
    const started = fx.service.start(
      {
        type: "pair.request",
        v: 1,
        requestId: uuid(),
        code: created.value.code,
        deviceUid: uid,
        deviceName: "dev-old",
        publicKey: pubPem(newKp),
        keyFingerprint: fingerprintOf(newKp),
        clientTime: 0,
      },
      "10.0.0.2",
    );
    assert.ok(started.ok);
    const p = {
      type: "pair.response",
      v: 1,
      enrollmentId: started.value.enrollmentId,
      nonce: started.value.nonce,
      signature: edSign(
        null,
        Buffer.from(
          pairingSigningPayload({
            hubOrigin: HUB_ORIGIN,
            hubId: HUB_ID,
            enrollmentId: started.value.enrollmentId,
            nonce: started.value.nonce,
            issuedAt: started.value.issuedAt,
            deviceUid: uid,
            keyFingerprint: fingerprintOf(newKp),
          }),
        ),
        newKp.privateKey,
      ).toString("base64url"),
    };
    await fx.service.verify(p, "10.0.0.2");
    const noFlag = fx.service.approve(created.value.codeId, {
      enrollmentId: started.value.enrollmentId,
      deviceUid: uid,
      keyFingerprint: fingerprintOf(newKp),
    });
    assert.ok(!noFlag.ok && noFlag.error.status === 409 && /replaceKey/.test(noFlag.error.message));
    const withFlag = fx.service.approve(created.value.codeId, {
      enrollmentId: started.value.enrollmentId,
      deviceUid: uid,
      keyFingerprint: fingerprintOf(newKp),
      replaceKey: true,
    });
    assert.ok(withFlag.ok, JSON.stringify(withFlag));
    const issued = await fx.service.verify(p, "10.0.0.2");
    assert.ok(issued.ok && (issued.value as TokenIssue).type === "pair.token");
    assert.equal(fx.issueCalls[0].replaceKey, true);
  } finally {
    await fx.cleanup();
  }
});

test("W-3 + malformed: schema rejects; non-Ed25519 key rejected; declared-fingerprint lies rejected", async () => {
  const fx = await fixture();
  try {
    const created = fx.service.createCode("10.0.0.1");
    assert.ok(created.ok);
    const kp = deviceKey();
    const base = {
      type: "pair.request",
      v: 1,
      requestId: uuid(),
      code: created.value.code,
      deviceUid: uuid(),
      deviceName: "d",
      publicKey: pubPem(kp),
      keyFingerprint: fingerprintOf(kp),
      clientTime: 0,
    };
    // unknown field
    let r = fx.service.start({ ...base, sneaky: 1 }, "10.0.0.2");
    assert.ok(!r.ok && r.error.code === "invalid");
    // bad code charset: an out-of-alphabet character is a format error (0/1/8/9 are not base32)
    r = fx.service.start({ ...base, code: "ab2c7de0" }, "10.0.0.2");
    assert.ok(!r.ok && r.error.code === "invalid");
    // unsupported length: 9 chars stays a format error
    r = fx.service.start({ ...base, code: "AB2C7DEFF" }, "10.0.0.2");
    assert.ok(!r.ok && r.error.code === "invalid");
    // lower case is CANONICALISED (human-typed path), so it reaches the lookup: unknown code, not a format error
    r = fx.service.start({ ...base, code: "ab2c7def" }, "10.0.0.2");
    assert.ok(!r.ok && r.error.code === "code_invalid" && r.error.status === 404);
    // wrong declared fingerprint
    r = fx.service.start({ ...base, keyFingerprint: "sha256:" + "01".repeat(32) }, "10.0.0.2");
    assert.ok(!r.ok && r.error.code === "fingerprint_mismatch");
    // non-Ed25519 (P-256)
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
    r = fx.service.start(
      {
        ...base,
        publicKey: ec.publicKey.export({ type: "spki", format: "pem" }) as string,
        keyFingerprint: `sha256:${createHash("sha256")
          .update(ec.publicKey.export({ type: "spki", format: "der" }) as Buffer)
          .digest("hex")}`,
      },
      "10.0.0.2",
    );
    assert.ok(!r.ok && r.error.code === "invalid" && /Ed25519/.test(r.error.message));
    // garbage PEM
    r = fx.service.start({ ...base, publicKey: "not a pem" }, "10.0.0.2");
    assert.ok(!r.ok && r.error.code === "invalid");
    // verify schema: bad signature shape
    const started = fx.service.start(base, "10.0.0.2");
    assert.ok(started.ok);
    const v = await fx.service.verify(
      {
        type: "pair.response",
        v: 1,
        enrollmentId: started.value.enrollmentId,
        nonce: started.value.nonce,
        signature: "short",
      },
      "10.0.0.2",
    );
    assert.ok(!v.ok && v.error.code === "invalid");
  } finally {
    await fx.cleanup();
  }
});

test("rates: code creation 5/min/IP then rate_limited; clientTime never drives TTL", async () => {
  const fx = await fixture();
  try {
    for (let i = 0; i < 5; i++) assert.ok(fx.service.createCode("10.7.7.7").ok);
    const sixth = fx.service.createCode("10.7.7.7");
    assert.ok(!sixth.ok && sixth.error.code === "rate_limited" && sixth.error.status === 429);
    const otherIp = fx.service.createCode("10.7.7.8"); // per-IP bucket
    assert.ok(otherIp.ok);
    // clientTime in the far future does not extend anything
    const c = fx.service.createCode("10.0.0.1");
    assert.ok(c.ok);
    fx.clock.now += 300_001;
    const late = fx.service.start(
      {
        type: "pair.request",
        v: 1,
        requestId: uuid(),
        code: c.value.code,
        deviceUid: uuid(),
        deviceName: "x",
        publicKey: pubPem(deviceKey()),
        keyFingerprint: fingerprintOf(deviceKey()),
        clientTime: 9_999_999_999_999,
      },
      "10.0.0.2",
    );
    assert.ok(!late.ok && late.error.code === "code_expired");
  } finally {
    await fx.cleanup();
  }
});

// --- Pairing code hardening: UUID v4 minted; 12- and 8-char base32 are legacy parse paths ---

const UUID_V4_CODE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_CODE = "a1b2c3d4-e5f6-4789-abcd-eff012345678";

const PAIR_REQUEST = (code: string, kp: ReturnType<typeof deviceKey>) => ({
  type: "pair.request",
  v: 1,
  requestId: uuid(),
  code,
  deviceUid: uuid(),
  deviceName: "dev-a",
  publicKey: pubPem(kp),
  keyFingerprint: fingerprintOf(kp),
  clientTime: 0,
});

/** A code entry the way the service builds one, at a legacy (base32) length. */
function injectLegacyCode(fx: Fixture, code: string): string {
  const service = fx.service as unknown as {
    codes: Map<string, { codeId: string; code: string; expiresAt: number; cancelled: boolean }>;
    byCode: Map<string, string>;
  };
  const codeId = randomUUID(); // distinct per injected entry: `uuid()` is a fixed test value
  service.codes.set(codeId, { codeId, code, expiresAt: fx.clock.now + 300_000, cancelled: false });
  service.byCode.set(code, codeId);
  return codeId;
}

test("hardening: a minted code is a canonical UUID v4 and 500 mints are all distinct", async () => {
  const fx = await fixture();
  try {
    const codes: string[] = [];
    for (let i = 0; i < 500; i++) {
      const created = fx.service.createCode(`10.0.${i >> 8}.${i & 0xff}`);
      assert.ok(created.ok, `mint ${i} refused`);
      assert.match(created.value.code, UUID_V4_CODE, `mint ${i} is UUID v4`);
      assert.ok(created.value.pairUrl.endsWith(`/pair?code=${created.value.code}&v=1`), `mint ${i} pairUrl`);
      codes.push(created.value.code);
    }
    assert.equal(new Set(codes).size, 500, "500 mints are all distinct");
    assert.equal(new Set(codes.map((c) => c.slice(0, 1))).size > 1, true, "the first character varies");
  } finally {
    await fx.cleanup();
  }
});

test("hardening: an upper-case UUID resolves and starts the same code", async () => {
  const fx = await fixture();
  try {
    const created = fx.service.createCode("10.0.0.1");
    assert.ok(created.ok);
    const code = created.value.code;
    const upper = code.toUpperCase();
    assert.notEqual(upper, code);

    // resolveCode (admin handoff) returns the canonical lower-case code and a v=1 URL
    const r = fx.service.resolveCode({ code: upper });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.value.code, code);
    assert.equal(r.value.codeId, created.value.codeId);
    assert.ok(r.value.pairUrl.endsWith(`/pair?code=${code}&v=1`), "the scrubbed URL carries the canonical code");

    // start accepts it and binds it to the SAME entry: the same tuple lower-cased returns the same challenge
    const kp = deviceKey();
    const request = PAIR_REQUEST(upper, kp);
    const started = fx.service.start(request, "10.0.0.2");
    assert.ok(started.ok, JSON.stringify(started));
    const lowerRetry = fx.service.start({ ...request, code }, "10.0.0.3");
    assert.ok(lowerRetry.ok, JSON.stringify(lowerRetry));
    assert.equal(
      (lowerRetry.value as { enrollmentId: string }).enrollmentId,
      (started.value as { enrollmentId: string }).enrollmentId,
      "upper and lower case renderings are the same code",
    );
    // A different device on the canonical code hits the SAME entry → code_in_use.
    const other = fx.service.start(PAIR_REQUEST(code, deviceKey()), "10.0.0.4");
    assert.ok(!other.ok && other.error.code === "code_in_use", JSON.stringify(other));

    // Non-UUID rubbish and hyphen-less hex are format errors, never lookups.
    for (const bad of [code.replace(/-/g, ""), "ABCD2345EF678", "AB2C7DE0", "ABCD2345EF", "not-a-code"]) {
      const badResolve = fx.service.resolveCode({ code: bad });
      assert.ok(!badResolve.ok && badResolve.error.status === 400 && badResolve.error.code === "code_invalid", bad);
      const badStart = fx.service.start(PAIR_REQUEST(bad, deviceKey()), "10.0.0.5");
      assert.ok(!badStart.ok && badStart.error.status === 400, bad);
    }
    // exactly one body key stays required
    const extra = fx.service.resolveCode({ code, extra: 1 });
    assert.ok(!extra.ok && extra.error.status === 400 && extra.error.code === "code_invalid");
  } finally {
    await fx.cleanup();
  }
});

test("hardening: legacy 12- and 8-char base32 codes still resolve and start; unknown codes are 404", async () => {
  const fx = await fixture();
  try {
    const legacy12 = "ABCD2345EF67";
    const legacy8 = "AB2C7DEF";
    injectLegacyCode(fx, legacy12);
    injectLegacyCode(fx, legacy8);

    for (const legacy of [legacy12, legacy8]) {
      const r = fx.service.resolveCode({ code: legacy });
      assert.ok(r.ok, JSON.stringify(r));
      assert.equal(r.value.code, legacy);
      assert.ok(r.value.pairUrl.endsWith(`/pair?code=${legacy}&v=1`), "an in-flight legacy link keeps working");
      const started = fx.service.start(PAIR_REQUEST(legacy, deviceKey()), "10.0.0.2");
      assert.ok(started.ok && started.value.type === "pair.challenge", JSON.stringify(started));
    }

    // A grouped 12-char code is the human rendering of a legacy code → same entry.
    const grouped = fx.service.resolveCode({ code: "ABCD-2345-EF67" });
    assert.ok(grouped.ok && grouped.value.code === legacy12, JSON.stringify(grouped));
    // …but a truncated group is a format error, not an 8-char code.
    const truncated = fx.service.resolveCode({ code: "ABCD-2345" });
    assert.ok(!truncated.ok && truncated.error.status === 400 && truncated.error.code === "code_invalid");

    // A legacy code nobody minted is a LOOKUP miss (404), never a schema/format error.
    for (const unknown of ["ZZ7Y6X2W", "ZZ7Y6X2WABCD"]) {
      const r = fx.service.resolveCode({ code: unknown });
      assert.ok(!r.ok && r.error.status === 404 && r.error.code === "code_invalid", unknown);
      const s = fx.service.start(PAIR_REQUEST(unknown, deviceKey()), "10.0.0.9");
      assert.ok(!s.ok && s.error.status === 404 && s.error.code === "code_invalid", unknown);
    }
  } finally {
    await fx.cleanup();
  }
});
