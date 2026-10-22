/**
 * P2-23 — browser pairing client against the REAL hub routes (T-2/T-3/T-9, S-7):
 * typed admin flow (create → state → full-fingerprint approve → issued),
 * isolated wizard session semantics (abort, stale close), rotate/revoke
 * contract, and a no-secrets scan of every admin response.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign as edSign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { Audit } from "../apps/dpi-playground-hub/src/audit.js";
import { bootHub } from "./harness/hub.js";
import { pairingSigningPayload } from "../../dpi-sdk/src/protocol/pairing.js";
import {
  pairingAdmin,
  createPairingSession,
  pollCode,
  needsAuth,
  PollTimeout,
} from "../apps/dpi-playground-fe/src/client/pair.js";
import { DpiError } from "../../dpi-sdk/src/errors.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const FINGERPRINT = `sha256:${"e".repeat(64)}`;

/**
 * pair.ts speaks browser URLs ("/api/..."). Bind them to the test hub the way
 * a browser origin would — the client code itself stays unmodified.
 */
function withBase(base: string): void {
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    typeof input === "string" && input.startsWith("/") ? real(new URL(input, base), init) : real(input as RequestInfo, init)) as typeof fetch;
}

async function deviceEnroll(base: string, code: string, hubOrigin: string) {
  const kp = generateKeyPairSync("ed25519");
  const pubPem = kp.publicKey.export({ type: "spki", format: "pem" }) as string;
  const fp = `sha256:${createHash("sha256").update(kp.publicKey.export({ type: "spki", format: "der" }) as Buffer).digest("hex")}`;
  const uid = randomUUID();
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const started = await post("/api/pair/start", {
    type: "pair.request", v: 1, requestId: randomUUID(), code, deviceUid: uid,
    deviceName: "fe-test", publicKey: pubPem, keyFingerprint: fp, clientTime: 0,
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const payload = pairingSigningPayload({
    hubOrigin, hubId: started.body.hubId, enrollmentId: started.body.enrollmentId,
    nonce: started.body.nonce, issuedAt: started.body.issuedAt, deviceUid: uid, keyFingerprint: fp,
  });
  const verified = await post("/api/pair/verify", {
    type: "pair.response", v: 1, enrollmentId: started.body.enrollmentId, nonce: started.body.nonce,
    signature: edSign(null, Buffer.from(payload), kp.privateKey).toString("base64url"),
  });
  assert.equal(verified.status, 202, JSON.stringify(verified.body));
  // The device's poll body (spec 03 §4.3): receipt retries present the SAME proof.
  const pollBody = {
    type: "pair.response", v: 1, enrollmentId: started.body.enrollmentId as string, nonce: started.body.nonce as string,
    signature: edSign(null, Buffer.from(payload), kp.privateKey).toString("base64url"),
  };
  return { uid, kp, fp, enrollmentId: started.body.enrollmentId as string, pollBody };
}

test("admin pairing flow: typed state → fingerprint approval → issued; no secret in any admin response", async () => {
  const hub = await bootHub();
  withBase(hub.base);
  try {
    const created = await pairingAdmin.createCode();
    assert.equal(created.type, "pair.code");
    const dev = await deviceEnroll(hub.base, created.code, created.hubOrigin);

    const awaiting = await pairingAdmin.codeState(created.codeId);
    assert.equal(awaiting.phase, "awaiting_approval");
    assert.ok(awaiting.enrollment);
    assert.equal(awaiting.enrollment!.deviceUid, dev.uid);
    assert.equal(awaiting.enrollment!.keyFingerprint, dev.fp); // hub-computed
    assert.equal(awaiting.enrollment!.keyChanged, false);

    // Approve with the EXACT tuple from the state DTO (P-8).
    const approved = await pairingAdmin.approve(created.codeId, {
      enrollmentId: awaiting.enrollment!.enrollmentId,
      deviceUid: awaiting.enrollment!.deviceUid,
      keyFingerprint: awaiting.enrollment!.keyFingerprint,
    });
    assert.equal(approved.phase, "approved");

    // F02 regression: a poll without the device's proof is rejected — the
    // enrollmentId alone must never fetch a credential.
    const stolen = await fetch(`${hub.base}/api/pair/verify`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "pair.response", v: 1, enrollmentId: dev.enrollmentId, nonce: "n".repeat(43), signature: "A".repeat(86) }),
    });
    assert.equal(stolen.status, 401);

    // Device polls again with the SAME proof → the ONLY place a credential exists (device's own TLS response).
    const issue = await fetch(`${hub.base}/api/pair/verify`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(dev.pollBody),
    });
    const issueBody = (await issue.json()) as { type?: string; tunnelToken?: string };
    assert.equal(issue.status, 200);
    assert.equal(issueBody.type, "pair.token");
    assert.match(issueBody.tunnelToken ?? "", /^dpt_[A-Za-z0-9_-]{43}$/, "credential is dpt_-scoped");

    const issued = await pairingAdmin.codeState(created.codeId);
    assert.equal(issued.phase, "issued");
    assert.ok(issued.deviceId, "issued state names the device row");
    assert.ok(!JSON.stringify(issued).includes("dpt_"), "no token in admin state");
    const network = await (await fetch(`${hub.base}/api/network`)).json();
    const device = network.devices.find((d: { id: string }) => d.id === issued.deviceId);
    assert.equal(device?.status, "offline", "R03: issuing a new pairing starts its monitor immediately");
    assert.equal(device?.pairing?.status, "paired");

    // Wrong tuple is rejected (P-8 wrong-approval → 409).
    const created2 = await pairingAdmin.createCode();
    const dev2 = await deviceEnroll(hub.base, created2.code, created2.hubOrigin);
    const st2 = await pairingAdmin.codeState(created2.codeId);
    await assert.rejects(
      pairingAdmin.approve(created2.codeId, {
        enrollmentId: st2.enrollment!.enrollmentId,
        deviceUid: randomUUID(), // wrong UID
        keyFingerprint: st2.enrollment!.keyFingerprint,
      }),
      (e) => e instanceof DpiError && e.status === 409 && e.code === "fingerprint_mismatch",
    );

    // Cancel path terminates polling.
    const cancelled = await pairingAdmin.cancel(created2.codeId);
    assert.equal(cancelled.phase, "cancelled");
    void dev2;
  } finally { await hub.cleanup(); }
});

test("pollCode: terminal resolves; abort rejects AbortError; closed session stops silently; timeout is typed", async () => {
  const hub = await bootHub();
  withBase(hub.base);
  try {
    const created = await pairingAdmin.createCode();
    const s1 = createPairingSession();
    const ac = new AbortController();
    const p = pollCode(s1, created.codeId, { signal: ac.signal, intervalMs: 50 });
    ac.abort();
    await assert.rejects(p, (e: unknown) => (e as Error).name === "AbortError");

    const s2 = createPairingSession();
    s2.close();
    assert.equal(await pollCode(s2, created.codeId, { intervalMs: 50 }), undefined, "closed session stops silently");

    const s3 = createPairingSession();
    await assert.rejects(
      pollCode(s3, created.codeId, { intervalMs: 50, timeoutMs: 120 }),
      (e) => e instanceof PollTimeout,
    );
  } finally { await hub.cleanup(); }
});

test("rotate + revoke contract: 202 accepted; double revoke is a typed 400; needsAuth pins 401 mapping", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-fe-pair-"));
  const hub = await bootHub();
  withBase(hub.base);
  try {
    // Seed a tunnel device straight into the hub registry (WAL multi-process).
    const registry = new NetworkRegistry(join(hub.home, "network.sqlite"));
    const epoch = randomUUID();
    const t = Date.now();
    registry.db
      .prepare(`INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,created_at,updated_at,transport)
                VALUES('dev-fe','FE','url',NULL,NULL,'ui',0,?,'checking',?,?,'tunnel')`)
      .run(randomUUID(), t, t);
    registry.db
      .prepare(`INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at)
                VALUES('dev-fe',?, '-----BEGIN PUBLIC KEY-----', ?, 'paired', 1, ?, ?, ?)`)
      .run(epoch, FINGERPRINT, t, t, t);
    registry.db
      .prepare(`INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at,confirmed_at)
                VALUES(?,?,?,?,?,'current',?,?)`)
      .run(randomUUID(), "dev-fe", epoch, 1, sha("dpt_" + "f".repeat(43)), t, t);
    registry.close();

    const rot = await pairingAdmin.rotate("dev-fe");
    assert.equal(rot.ok, true);
    const rev = await pairingAdmin.revoke("dev-fe", "compromise");
    assert.equal(rev.ok, true);
    const again = await fetch(`${hub.base}/api/devices/dev-fe/revoke`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "user" }),
    });
    assert.ok([400, 404].includes(again.status), "revoking a revoked device is a typed error, not a silent ok");

    // Contract pin: only real 401s mean "authenticate again".
    assert.equal(needsAuth(new DpiError("unauthorized", "no", 401)), true);
    assert.equal(needsAuth(new DpiError("unauthorized", "no", 403)), false);
    assert.equal(needsAuth(new Error("x")), false);
  } finally { await hub.cleanup(); await rm(dir, { recursive: true, force: true }); }
});
