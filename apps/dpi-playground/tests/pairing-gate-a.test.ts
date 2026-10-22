/**
 * Gate A remediation — pairing: GA-05 approval bound to the stored identity (revoked state, key
 * replacement, stale approvals), GA-06 bounded per-source state, S-3 valid-poll pacing, and the
 * admin mutations that must write their audit row before they take effect.
 *
 * Real PairingService + CredentialService + Audit + NetworkRegistry, real Ed25519 keys, injected
 * clock. No network.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign as edSign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { Audit, AuditUnavailableError } from "../apps/dpi-playground-hub/src/audit.js";
import { PairingService, type PairingDeps } from "../apps/dpi-playground-hub/src/pairing.js";
import { CredentialService } from "../apps/dpi-playground-hub/src/credentials.js";
import { pairingSigningPayload } from "../../dpi-sdk/src/protocol/pairing.js";
import type { TokenIssue } from "../../dpi-sdk/src/protocol/pairing.js";
import { PAIR_RATE_LIMITS } from "../../dpi-sdk/src/protocol/limits.js";

const HUB_ORIGIN = "https://pi.example.com";
const HUB_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const T0 = 1_760_000_000_000;
const DEVICE_IP = "198.51.100.7";

const keypair = () => generateKeyPairSync("ed25519");
type Keypair = ReturnType<typeof keypair>;
const pem = (k: Keypair) => k.publicKey.export({ type: "spki", format: "pem" }) as string;
const fp = (k: Keypair) =>
  `sha256:${createHash("sha256")
    .update(k.publicKey.export({ type: "spki", format: "der" }) as Buffer)
    .digest("hex")}`;

async function world(t: TestContext, opts: { issue?: PairingDeps["issue"] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "dpi-pair-ga-"));
  const registry = new NetworkRegistry(join(dir, "network.sqlite"));
  const audit = new Audit(registry);
  const clock = { now: T0 };
  const credentials = new CredentialService(registry, audit, HUB_ORIGIN, HUB_ID);
  const pairing = new PairingService({
    registry,
    audit,
    hubOrigin: HUB_ORIGIN,
    hubId: HUB_ID,
    now: () => clock.now,
    issue: opts.issue ?? ((e) => credentials.issue(e)),
    receiptValidator: (r) =>
      credentials.receiptStillValid(r) ? true : { code: credentials.receiptFailure(r) },
  });
  let adminSeq = 0;
  t.after(async () => {
    registry.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    registry,
    audit,
    clock,
    credentials,
    pairing,
    adminIp: () => `10.9.${(adminSeq >> 8) & 255}.${adminSeq++ & 255}`,
  };
}
type World = Awaited<ReturnType<typeof world>>;

async function enroll(w: World, uid: string, k: Keypair) {
  const code = w.pairing.createCode(w.adminIp());
  assert.ok(code.ok, JSON.stringify(code));
  const started = w.pairing.start(
    {
      type: "pair.request",
      v: 1,
      requestId: randomUUID(),
      code: code.value.code,
      deviceUid: uid,
      deviceName: "dev",
      publicKey: pem(k),
      keyFingerprint: fp(k),
      clientTime: 0,
    },
    DEVICE_IP,
  );
  assert.ok(started.ok, JSON.stringify(started));
  const ch = started.value;
  const payload = pairingSigningPayload({
    hubOrigin: HUB_ORIGIN,
    hubId: HUB_ID,
    enrollmentId: ch.enrollmentId,
    nonce: ch.nonce,
    issuedAt: ch.issuedAt,
    deviceUid: uid,
    keyFingerprint: fp(k),
  });
  const proof = {
    type: "pair.response" as const,
    v: 1 as const,
    enrollmentId: ch.enrollmentId,
    nonce: ch.nonce,
    signature: edSign(null, Buffer.from(payload), k.privateKey).toString("base64url"),
  };
  const first = await w.pairing.verify(proof, DEVICE_IP);
  assert.ok(first.ok && first.status === 202, JSON.stringify(first));
  return {
    codeId: code.value.codeId,
    proof,
    approval: { enrollmentId: ch.enrollmentId, deviceUid: uid, keyFingerprint: fp(k) },
  };
}
type Enrolled = Awaited<ReturnType<typeof enroll>>;

/** One valid poll, one second after the previous one (the S-3 cadence). */
async function poll(w: World, e: Enrolled) {
  w.clock.now += 1_000;
  return w.pairing.verify(e.proof, DEVICE_IP);
}

async function pair(w: World, uid: string, k: Keypair, replaceKey = false): Promise<TokenIssue> {
  const e = await enroll(w, uid, k);
  const approved = w.pairing.approve(e.codeId, {
    ...e.approval,
    ...(replaceKey ? { replaceKey: true } : {}),
  });
  assert.ok(approved.ok, JSON.stringify(approved));
  const got = await poll(w, e);
  assert.ok(got.ok && got.status === 200, JSON.stringify(got));
  return got.value as TokenIssue;
}

const tag = (
  r: { ok: true; status?: number } | { ok: false; error: { status: number; code: string } },
) => (r.ok ? `ok:${r.status ?? ""}` : `${r.error.status}:${r.error.code}`);
const pairingRow = (w: World, deviceId: string) =>
  w.registry.db
    .prepare("SELECT status, key_fingerprint, pairing_epoch FROM pairings WHERE device_id=?")
    .get(deviceId) as { status: string; key_fingerprint: string; pairing_epoch: string };
const credentialStatus = (w: World, credentialId: string) =>
  (
    w.registry.db
      .prepare("SELECT status FROM tunnel_credentials WHERE credential_id=?")
      .get(credentialId) as { status: string }
  ).status;

// ---------------------------------------------------------------------------------- GA-05

test("GA-05: after a revoke a DIFFERENT key is reported as a key change and needs replaceKey (P-14)", async (t) => {
  const w = await world(t);
  const uid = randomUUID();
  const first = await pair(w, uid, keypair());
  w.credentials.revoke(first.deviceId, "user", "admin:test");

  const replacement = keypair();
  const e = await enroll(w, uid, replacement);
  const st = w.pairing.status(e.codeId);
  assert.ok(st.ok);
  assert.equal(
    st.value.enrollment?.keyChanged,
    true,
    "the revoked pairing still has a key on record",
  );

  const plain = w.pairing.approve(e.codeId, e.approval);
  assert.ok(
    !plain.ok && plain.error.status === 409 && /replaceKey/.test(plain.error.message),
    JSON.stringify(plain),
  );
  assert.ok(w.pairing.approve(e.codeId, { ...e.approval, replaceKey: true }).ok);

  const issued = await poll(w, e);
  assert.ok(issued.ok && issued.status === 200, JSON.stringify(issued));
  assert.deepEqual(
    { ...pairingRow(w, first.deviceId) },
    {
      status: "paired",
      key_fingerprint: fp(replacement),
      pairing_epoch: (issued.value as TokenIssue).pairingEpoch,
    },
  );
});

test("GA-05 / P-3: re-pair after a revoke with the SAME key keeps the registry id and needs no replaceKey", async (t) => {
  const w = await world(t);
  const uid = randomUUID();
  const k = keypair();
  const first = await pair(w, uid, k);
  w.credentials.revoke(first.deviceId, "user", "admin:test");

  const e = await enroll(w, uid, k);
  const st = w.pairing.status(e.codeId);
  assert.ok(st.ok);
  assert.equal(st.value.enrollment?.keyChanged, false);
  const spurious = w.pairing.approve(e.codeId, { ...e.approval, replaceKey: true });
  assert.ok(
    !spurious.ok && /has not changed/.test(spurious.error.message),
    JSON.stringify(spurious),
  );
  assert.ok(w.pairing.approve(e.codeId, e.approval).ok);

  const issued = await poll(w, e);
  assert.ok(issued.ok && issued.status === 200);
  const again = issued.value as TokenIssue;
  assert.equal(again.deviceId, first.deviceId, "same registry id");
  assert.notEqual(again.pairingEpoch, first.pairingEpoch);
  assert.equal(pairingRow(w, first.deviceId).status, "paired");
});

test("GA-05: an approval given before a revoke cannot bring the revoked pairing back", async (t) => {
  const w = await world(t);
  const uid = randomUUID();
  const k = keypair();
  const first = await pair(w, uid, k);
  const pending = await enroll(w, uid, k);
  assert.ok(w.pairing.approve(pending.codeId, pending.approval).ok); // approved against the live pairing
  w.credentials.revoke(first.deviceId, "compromise", "admin:test");

  const got = await poll(w, pending);
  assert.ok(
    !got.ok && got.error.status === 409 && got.error.code === "identity_changed",
    JSON.stringify(got),
  );
  assert.equal(
    pairingRow(w, first.deviceId).status,
    "revoked",
    "revoke is not undone by a stale approval",
  );
  const live = w.registry.db
    .prepare("SELECT count(*) AS n FROM tunnel_credentials WHERE device_id=? AND status='current'")
    .get(first.deviceId) as { n: number };
  assert.equal(live.n, 0, "no credential was minted");

  // The approval is void: the enrollment waits for a NEW approval, taken against the revoked state.
  const waiting = await poll(w, pending);
  assert.ok(waiting.ok && waiting.status === 202, JSON.stringify(waiting));
  assert.ok(w.pairing.approve(pending.codeId, pending.approval).ok);
  const issued = await poll(w, pending);
  assert.ok(issued.ok && issued.status === 200, JSON.stringify(issued));
});

test("GA-05: an approved enrollment cannot restore the previous key after a deliberate key replacement", async (t) => {
  const w = await world(t);
  const uid = randomUUID();
  const k1 = keypair();
  const k2 = keypair();
  await pair(w, uid, k1);
  const stale = await enroll(w, uid, k1);
  assert.ok(w.pairing.approve(stale.codeId, stale.approval).ok); // key unchanged at that moment → no replaceKey

  const replaced = await pair(w, uid, k2, true); // the operator then replaces the key explicitly

  const got = await poll(w, stale);
  assert.ok(
    !got.ok && got.error.status === 409 && got.error.code === "identity_changed",
    JSON.stringify(got),
  );
  assert.equal(pairingRow(w, replaced.deviceId).key_fingerprint, fp(k2), "the replaced key stays");
  assert.equal(credentialStatus(w, replaced.credentialId), "current");
});

test("GA-05: two enrollments approved for the same NEW device cannot supersede each other silently", async (t) => {
  const w = await world(t);
  const uid = randomUUID();
  const a = await enroll(w, uid, keypair());
  const b = await enroll(w, uid, keypair());
  assert.ok(w.pairing.approve(a.codeId, a.approval).ok);
  assert.ok(w.pairing.approve(b.codeId, b.approval).ok);

  const ia = await poll(w, a);
  assert.ok(ia.ok && ia.status === 200);
  const ib = await poll(w, b);
  assert.ok(!ib.ok && ib.error.code === "identity_changed", JSON.stringify(ib));
  assert.equal(credentialStatus(w, (ia.value as TokenIssue).credentialId), "current");
});

test("GA-05: CredentialService.issue refuses to replace a stored key without replaceKey, even when called directly", async (t) => {
  const w = await world(t);
  const uid = randomUUID();
  const k1 = keypair();
  const k2 = keypair();
  const first = await pair(w, uid, k1);
  w.credentials.revoke(first.deviceId, "user", "admin:test");
  const events = () =>
    (
      w.registry.db
        .prepare("SELECT count(*) AS n FROM events WHERE action='pair.success'")
        .get() as { n: number }
    ).n;
  const before = events();

  await assert.rejects(
    w.credentials.issue({
      enrollmentId: randomUUID(),
      codeId: randomUUID(),
      deviceUid: uid,
      deviceName: "dev",
      publicKeyPem: pem(k2),
      keyFingerprint: fp(k2),
      replaceKey: false,
    }),
    (e: unknown) => (e as { code?: string }).code === "key_replacement_required",
  );
  assert.equal(pairingRow(w, first.deviceId).key_fingerprint, fp(k1));
  assert.equal(pairingRow(w, first.deviceId).status, "revoked");
  assert.equal(events(), before, "no audit row for an issuance that did not happen");
});

test("GA-05: CredentialService.issue rejects a stale identity stamp and mutates nothing", async (t) => {
  const w = await world(t);
  const uid = randomUUID();
  const k = keypair();
  await assert.rejects(
    w.credentials.issue({
      enrollmentId: randomUUID(),
      codeId: randomUUID(),
      deviceUid: uid,
      deviceName: "dev",
      publicKeyPem: pem(k),
      keyFingerprint: fp(k),
      replaceKey: false,
      expectedIdentity: "stale",
    }),
    (e: unknown) => (e as { code?: string }).code === "identity_changed",
  );
  const rows = w.registry.db
    .prepare("SELECT count(*) AS n FROM devices WHERE device_uid=?")
    .get(uid) as { n: number };
  assert.equal(rows.n, 0);
});

// ---------------------------------------------------------------------------------- GA-06

test("GA-06: per-source pairing state stops at 10,000 sources, refuses new ones, keeps known counters, and drains after 15 min", async (t) => {
  const w = await world(t);
  const hit = (ip: string) => tag(w.pairing.start({}, ip)); // schema failure: counted by the start bucket and the failure window
  const source = (i: number) => `2001:db8:${i.toString(16)}::1`; // a source is a /64: each i is another one
  for (let i = 0; i < 10_000; i++) assert.equal(hit(source(i)), "400:invalid", `source ${i}`);

  assert.equal(
    hit(source(0xffff)),
    "429:rate_limited",
    "table full: a NEW source is refused, nothing is evicted",
  );

  // A known source keeps its OWN counters: 1 start used, the bucket (capacity 20) still admits exactly 19 more.
  const known = Array.from({ length: 40 }, () => hit(source(0)));
  assert.equal(
    known.filter((r) => r === "400:invalid").length,
    19,
    "counters of a known source are neither reset nor evicted",
  );

  w.clock.now += 15 * 60_000; // idle TTL
  w.pairing.sweep();
  assert.equal(
    hit(source(0xffff)),
    "400:invalid",
    "idle entries are forgotten, the table accepts new sources again",
  );
});

test("RR: moving through the addresses of one /64 buys neither a fresh start quota nor a fresh failure window", async (t) => {
  const w = await world(t);
  const hit = (ip: string) => tag(w.pairing.start({}, ip));
  const inBlock = (n: number) => `2001:db8:9:9::${n.toString(16)}`;
  const first = Array.from({ length: 40 }, (_, n) => hit(inBlock(n + 1)));
  assert.equal(
    first.filter((r) => r === "400:invalid").length,
    20,
    "the start bucket (capacity 20) is shared by the whole block",
  );
  assert.ok(first.slice(20).every((r) => r === "429:rate_limited"));
  assert.equal(hit("2001:db8:9:a::1"), "400:invalid", "the next /64 has its own quota");

  const mapped = ["198.51.100.8", "::ffff:198.51.100.8", "::ffff:c633:6408"];
  const used = Array.from({ length: 21 }, (_, n) => hit(mapped[n % 3]));
  assert.equal(
    used.filter((r) => r === "400:invalid").length,
    20,
    "an IPv4 client is one source in every spelling",
  );
});

test("RR: verify failures from different addresses of one /64 add up in ONE failure window; another /64 is untouched", async (t) => {
  const w = await world(t);
  const lost = async (ip: string) =>
    tag(
      await w.pairing.verify(
        {
          type: "pair.response",
          v: 1,
          enrollmentId: randomUUID(),
          nonce: "n".repeat(43),
          signature: "A".repeat(86),
        },
        ip,
      ),
    );
  for (let n = 1; n <= PAIR_RATE_LIMITS.verifyFails.perWindow; n++)
    assert.equal(
      await lost(`2001:db8:8:8::${n.toString(16)}`),
      "410:enrollment_lost",
      `failure ${n}`,
    );
  assert.equal(
    await lost("2001:db8:8:8::ffff"),
    "429:rate_limited",
    "the block is fail-closed whichever address it speaks from",
  );
  assert.equal(
    await lost("2001:db8:8:9::1"),
    "410:enrollment_lost",
    "a different /64 is not affected",
  );
});

// ---------------------------------------------------------------------------------- S-3

test("S-3: a valid poll is accepted once per second per enrollment; extra polls are 429 and are not failures", async (t) => {
  const w = await world(t);
  const e = await enroll(w, randomUUID(), keypair()); // the proof itself is not a poll
  const first = await w.pairing.verify(e.proof, DEVICE_IP);
  assert.equal(tag(first), "ok:202");

  const early = await w.pairing.verify(e.proof, DEVICE_IP);
  assert.ok(
    !early.ok && early.error.status === 429 && early.error.code === "rate_limited",
    JSON.stringify(early),
  );
  assert.ok(
    early.error.retryAfterMs !== undefined &&
      early.error.retryAfterMs > 0 &&
      early.error.retryAfterMs <= 1_000,
  );

  const burst = new Set<string>();
  for (let i = 0; i < 150; i++) burst.add(tag(await w.pairing.verify(e.proof, DEVICE_IP)));
  assert.deepEqual([...burst], ["429:rate_limited"]);

  w.clock.now += 1_000;
  assert.equal(
    tag(await w.pairing.verify(e.proof, DEVICE_IP)),
    "ok:202",
    "150 paced-out polls did not fail-block the source (S-1 counts auth failures only)",
  );
});

test("S-3: pacing is per enrollment — another enrollment from the same source polls independently", async (t) => {
  const w = await world(t);
  const a = await enroll(w, randomUUID(), keypair());
  const b = await enroll(w, randomUUID(), keypair());
  assert.equal(tag(await w.pairing.verify(a.proof, DEVICE_IP)), "ok:202");
  assert.equal(tag(await w.pairing.verify(b.proof, DEVICE_IP)), "ok:202");
});

test("S-3: a caller without the device key cannot burn the device's poll slot", async (t) => {
  const w = await world(t);
  const e = await enroll(w, randomUUID(), keypair());
  assert.equal(tag(await w.pairing.verify(e.proof, DEVICE_IP)), "ok:202");
  w.clock.now += 1_000;
  const forged = { ...e.proof, signature: "A".repeat(86) };
  assert.equal(tag(await w.pairing.verify(forged, "203.0.113.50")), "401:signature_invalid");
  assert.equal(
    tag(await w.pairing.verify(e.proof, DEVICE_IP)),
    "ok:202",
    "the forged attempt did not consume the slot",
  );
});

// ------------------------------------------------------------------- audit before effect

test("createCode: when the audit row cannot be written no code is registered", async (t) => {
  const w = await world(t);
  const realAppend = w.audit.append.bind(w.audit);
  w.audit.append = (() => {
    throw new Error("audit down");
  }) as never;
  for (let i = 0; i < 1_001; i++)
    assert.throws(
      () => w.pairing.createCode(`10.${i >> 8}.${i & 255}.1`),
      /audit down/,
      `attempt ${i}`,
    );
  w.audit.append = realAppend as never;
  const ok = w.pairing.createCode("10.250.0.1");
  assert.ok(
    ok.ok,
    `failed attempts must not consume the 1,000-code capacity: ${JSON.stringify(ok)}`,
  );
});

test("cancel: when the audit row cannot be written the code stays live", async (t) => {
  const w = await world(t);
  const e = await enroll(w, randomUUID(), keypair());
  const realAppend = w.audit.append.bind(w.audit);
  w.audit.append = ((entry: { action: string }) => {
    if (entry.action === "pair.cancelled") throw new Error("audit down");
    return realAppend(entry as never);
  }) as never;
  assert.throws(() => w.pairing.cancel(e.codeId), /audit down/);
  w.audit.append = realAppend as never;
  assert.equal(tag(await poll(w, e)), "ok:202", "an unaudited cancel must not take effect");
});

test("RR: an issuance refused by the audit floor is a 503 with fixed text; any other issuance fault is a generic 500", async (t) => {
  let mode: "floor" | "boom" | "ok" = "floor";
  let w: World;
  w = await world(t, {
    issue: (arg) => {
      if (mode === "ok") return w.credentials.issue(arg);
      return Promise.reject(
        mode === "floor"
          ? new AuditUnavailableError(
              "audit: 917504 bytes free on the registry volume (floor 33554432); audited changes are refused",
            )
          : new Error("disk geometry sector 9 offline"),
      );
    },
  });
  const uid = randomUUID();
  const e = await enroll(w, uid, keypair());
  assert.ok(w.pairing.approve(e.codeId, e.approval).ok);

  const refused = await poll(w, e);
  assert.ok(
    !refused.ok && refused.error.status === 503 && refused.error.code === "audit_unavailable",
    JSON.stringify(refused),
  );
  assert.ok(
    !/917504|floor/.test(JSON.stringify(refused)),
    "the volume figures never reach the caller",
  );

  mode = "boom";
  const crashed = await poll(w, e);
  assert.ok(
    !crashed.ok && crashed.error.status === 500 && crashed.error.code === "internal",
    JSON.stringify(crashed),
  );
  assert.ok(
    !/disk geometry/.test(JSON.stringify(crashed)),
    "the underlying fault never reaches the caller",
  );

  const minted = w.registry.db.prepare("SELECT count(*) AS n FROM tunnel_credentials").get() as {
    n: number;
  };
  assert.equal(minted.n, 0, "neither refusal minted a credential");

  mode = "ok";
  assert.equal(
    tag(await poll(w, e)),
    "ok:200",
    "the approval survives an infrastructure refusal (no silent void)",
  );
});
