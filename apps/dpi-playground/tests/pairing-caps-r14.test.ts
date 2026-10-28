/**
 * Audit run-1 (hub pairing RAM caps + failWindows eviction):
 *
 * 1. PAIR_RAM_CAPS split — anonymous device-initiated mints draw from their own
 *    sub-cap (deviceMintedCodes); the operator's admin mint keeps a reserved
 *    share of the global codes cap and stays available under saturation.
 * 2. cancel() FREES capacity for unissued codes (no more flag-only remediation:
 *    the operator's own cancel restores minting immediately).
 * 3. SlidingWindows eviction — a full table admits a fresh key by evicting a
 *    sub-threshold entry; an at/above-floor counter is never evicted while a
 *    weaker one exists (GA-06 intact).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, createHash, randomUUID } from "node:crypto";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { Audit } from "../apps/dpi-playground-hub/src/audit.js";
import { CredentialService } from "../apps/dpi-playground-hub/src/credentials.js";
import { PairingService } from "../apps/dpi-playground-hub/src/pairing.js";
import { SlidingWindows } from "../apps/dpi-playground-hub/src/limiter.js";
import { PAIR_RAM_CAPS, PAIR_RATE_LIMITS } from "../../dpi-sdk/src/protocol/limits.js";

const HUB_ORIGIN = "https://pi.example.com";
const HUB_ID = "0f1e2d3c-4b5a-6978-8c9d-0e1f2a3b4c5d";
const MIN = 60_000;

async function world() {
  const dir = await mkdtemp(join(tmpdir(), "dpi-caps-"));
  const registry = new NetworkRegistry(join(dir, "network.sqlite"));
  const audit = new Audit(registry);
  const clock = { now: 1760000000000 };
  const credentials = new CredentialService(registry, audit, HUB_ORIGIN, HUB_ID);
  const pairing = new PairingService({
    registry,
    audit,
    hubOrigin: HUB_ORIGIN,
    hubId: HUB_ID,
    now: () => clock.now,
    issue: (e) => credentials.issue(e),
    receiptValidator: (t) => (credentials.receiptStillValid(t) ? true : { code: credentials.receiptFailure(t) }),
  });
  return { pairing, clock, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const kpOf = () => generateKeyPairSync("ed25519");
const pubPem = (kp: ReturnType<typeof kpOf>) => kp.publicKey.export({ type: "spki", format: "pem" }) as string;
const fpOf = (kp: ReturnType<typeof kpOf>) =>
  `sha256:${createHash("sha256").update(kp.publicKey.export({ format: "der", type: "spki" }) as Buffer).digest("hex")}`;

/** A schema-valid device-initiated request from a distinct /64 source. */
const deviceRequest = (kp: ReturnType<typeof kpOf>, uid: string) => ({
  type: "pair.device-request",
  v: 1,
  requestId: randomUUID(),
  deviceUid: uid,
  deviceName: `attacker-${uid.slice(0, 8)}`,
  hostname: "box",
  platform: "linux-x64 node v22",
  publicKey: pubPem(kp),
  keyFingerprint: fpOf(kp),
  clientTime: Date.now(),
});

const srcIp = (i: number) => `2001:db8:${i.toString(16).padStart(4, "0")}::1`;

test("device-initiated mints are sub-capped; the operator's reserve survives saturation", async () => {
  const w = await world();
  try {
    // Saturate the device sub-cap from distinct /64 sources (5 mints per source).
    let minted = 0;
    outer: for (let s = 0; s < Math.ceil(PAIR_RAM_CAPS.deviceMintedCodes / 5) + 2; s += 1) {
      for (let r = 0; r < 5; r += 1) {
        const ack = w.pairing.requestForDevice(deviceRequest(kpOf(), randomUUID()), srcIp(s));
        if (!ack.ok) {
          assert.equal(ack.error.status, 429);
          assert.match(ack.error.message, /Too many device-initiated requests/);
          break outer;
        }
        minted += 1;
      }
    }
    assert.equal(minted, PAIR_RAM_CAPS.deviceMintedCodes, `exactly the sub-cap mints (${minted})`);

    // The operator's mint still works: the global cap holds reserved slots.
    const admin = w.pairing.createCode("203.0.113.10");
    assert.equal(admin.ok, true, "admin mint must survive device-mint saturation");

    // Even at the sub-cap the GLOBAL cap is far away: admin can keep minting.
    for (let i = 0; i < 3; i += 1) {
      const more = w.pairing.createCode(`198.51.100.${i + 1}`);
      assert.equal(more.ok, true);
    }
  } finally {
    await w.cleanup();
  }
});

test("cancel frees capacity immediately for unissued codes", async () => {
  const w = await world();
  try {
    // Saturate the device sub-cap.
    for (let s = 0; s < Math.ceil(PAIR_RAM_CAPS.deviceMintedCodes / 5); s += 1) {
      for (let r = 0; r < 5; r += 1) {
        const ack = w.pairing.requestForDevice(deviceRequest(kpOf(), randomUUID()), srcIp(s));
        assert.equal(ack.ok, true, `setup mint s=${s} r=${r}`);
      }
    }
    assert.equal(w.pairing.requestForDevice(deviceRequest(kpOf(), randomUUID()), "2001:db8:ffff::1").ok, false);

    // The operator cancels one live DEVICE-minted code: the slot frees NOW.
    const codes = w.pairing.listPending();
    const target = codes.find((c) => c.phase === "awaiting_device") ?? codes[0];
    const cancelled = w.pairing.cancel(target.codeId);
    assert.equal(cancelled.ok, true);
    // The cancelled code is gone from RAM (capacity reclaimed).
    assert.equal(w.pairing.status(target.codeId).ok, false, "cancelled unissued code leaves the table");
    const after = w.pairing.requestForDevice(deviceRequest(kpOf(), randomUUID()), "2001:db8:ffff::1");
    assert.equal(after.ok, true, "a freed slot admits a new device mint");
  } finally {
    await w.cleanup();
  }
});

test("SlidingWindows: a full table evicts a sub-threshold entry to admit a fresh key", () => {
  const now = { t: 1_000_000 };
  const winMs = PAIR_RATE_LIMITS.verifyFails.windowMinutes * MIN;
  const floor = PAIR_RATE_LIMITS.verifyFails.perWindow; // pairing's floor: 100
  const w = new SlidingWindows({ windowMs: winMs, maxKeys: 2 }, () => now.t, floor);

  // Two zero/low-failure keys fill the table (each far below the floor).
  assert.equal(w.record("k1"), true);
  assert.equal(w.record("k2"), true);
  // A brand-new key is ADMITTED by evicting the oldest sub-threshold entry.
  assert.equal(w.record("k3"), true, "fresh key admitted at full table");
  assert.equal(w.saturatedFor("k4"), false, "no inherited saturation for zero-failure keys");

  // GA-06: a counter AT/ABOVE the floor is never evicted while a weaker one exists.
  const w2 = new SlidingWindows({ windowMs: winMs, maxKeys: 2 }, () => now.t, 2);
  w2.record("weak"); // count 1 < floor 2
  w2.record("enforced");
  w2.record("enforced"); // count 2 >= floor 2; table full: weak + enforced
  assert.equal(w2.record("fresh"), true, "the weak entry is evicted, not the enforced one");
  assert.equal(w2.count("enforced"), 2, "the enforced counter survived");

  const w4 = new SlidingWindows({ windowMs: winMs, maxKeys: 1 }, () => now.t, 2);
  w4.record("enforced");
  w4.record("enforced"); // count 2 >= floor, table full, NOTHING weaker exists
  assert.equal(w4.record("fresh"), false, "an enforced counter is never evicted for a fresh key");
  assert.equal(w4.saturatedFor("fresh"), true, "callers still fail closed when only enforced counters remain");
});
