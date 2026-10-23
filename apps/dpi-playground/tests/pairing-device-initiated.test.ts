/**
 * Device-INITIATED pairing: the machine asks the hub for a code, so the offer
 * carries the FULL device identity (name/hostname/platform/public key) and the
 * operator never carries a secret between machines — while the code stays a
 * 122-bit single-use UUID and approval stays a human fingerprint decision.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { Audit } from "../apps/dpi-playground-hub/src/audit.js";
import { PairingService } from "../apps/dpi-playground-hub/src/pairing.js";

const HUB_ORIGIN = "https://pi.example.com";
const HUB_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const uuid = () => crypto.randomUUID();

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "dpi-pair-di-"));
  const registry = new NetworkRegistry(join(dir, "network.sqlite"));
  const audit = new Audit(registry);
  const clock = { now: 1760000000000 };
  const issued: { uid: string; fingerprint: string }[] = [];
  const service = new PairingService({
    registry,
    audit,
    hubOrigin: HUB_ORIGIN,
    hubId: HUB_ID,
    now: () => clock.now,
    issue: async (e) => {
      issued.push({ uid: e.deviceUid, fingerprint: e.keyFingerprint });
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
      };
    },
  });
  return { service, registry, audit, clock, issued, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function machine(name = "PhuongNB-Laptop") {
  const kp = generateKeyPairSync("ed25519");
  return {
    kp,
    publicKey: kp.publicKey.export({ type: "spki", format: "pem" }) as string,
    body: {
      type: "pair.device-request" as const,
      v: 1 as const,
      requestId: uuid(),
      deviceUid: uuid(),
      deviceName: name,
      hostname: "phuong-laptop",
      platform: "win32-x64 node v22",
      keyFingerprint: "",
      clientTime: 0,
    },
  };
}

const fpOf = (m: ReturnType<typeof machine>) =>
  `sha256:${createHash("sha256")
    .update(m.kp.publicKey.export({ type: "spki", format: "der" }) as Buffer)
    .digest("hex")}`;

test("a device can ask the hub for a code and gets a 122-bit one plus a challenge", async () => {
  const fx = await fixture();
  try {
    const m = machine();
    const res = fx.service.requestForDevice({ ...m.body, publicKey: m.publicKey, keyFingerprint: fpOf(m), hostname: "phuong-laptop", platform: "win32-x64 node v22" }, "10.0.0.9");
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(res.value.type, "pair.device-ack");
    // The code is still the canonical single-use UUID family (122 random bits) —
    // never a short human code.
    assert.match(res.value.code, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(res.value.hubId, HUB_ID);
    assert.equal(res.value.hubOrigin, HUB_ORIGIN);
    assert.ok(res.value.challenge.enrollmentId);
    // The device's own proof-of-possession round still gates the enrollment.
    assert.equal(fx.service.listPending().length, 1);
    const pending = fx.service.listPending()[0]!;
    assert.equal(pending.deviceName, "PhuongNB-Laptop");
    assert.equal(pending.hostname, "phuong-laptop");
    assert.equal(pending.platform, "win32-x64 node v22");
    // The hub computed the fingerprint itself.
    assert.equal(pending.keyFingerprint, fpOf(m));
    assert.equal(pending.phase, "awaiting_proof");
  } finally {
    await fx.cleanup();
  }
});

test("a declared fingerprint that does not match the key is refused (hub computes its own)", async () => {
  const fx = await fixture();
  try {
    const m = machine();
    const res = fx.service.requestForDevice(
      { ...m.body, publicKey: m.publicKey, keyFingerprint: `sha256:${"0".repeat(64)}` },
      "10.0.0.9",
    );
    assert.equal(res.ok, false);
    assert.equal(fx.service.listPending().length, 0);
  } finally {
    await fx.cleanup();
  }
});

test("device-initiated requests are rate limited per client IP", async () => {
  const fx = await fixture();
  try {
    let refused = false;
    for (let i = 0; i < 40 && !refused; i++) {
      const m = machine(`box-${i}`);
      const res = fx.service.requestForDevice(
        { ...m.body, publicKey: m.publicKey, keyFingerprint: fpOf(m) },
        "10.9.9.9",
      );
      if (!res.ok) refused = true;
    }
    assert.equal(refused, true, "the limiter must stop a burst from one IP");
  } finally {
    await fx.cleanup();
  }
});

test("pending list shows only identity, never the code or key material", async () => {
  const fx = await fixture();
  try {
    const m = machine();
    const res = fx.service.requestForDevice(
      { ...m.body, publicKey: m.publicKey, keyFingerprint: fpOf(m) },
      "10.0.0.9",
    );
    assert.ok(res.ok);
    const json = JSON.stringify(fx.service.listPending());
    assert.ok(!json.includes(res.value.code), "the code is not echoed to the admin list");
    assert.ok(!json.includes("BEGIN PUBLIC KEY"), "the public key is not echoed");
    assert.ok(json.includes(fpOf(m)), "the fingerprint IS shown — the human needs it");
  } finally {
    await fx.cleanup();
  }
});
