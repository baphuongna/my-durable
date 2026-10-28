/**
 * R15 (run-2 h11b): an unauthenticated device-initiated pairing request that
 * FAILS (wrong fingerprint / bad SPKI) must leave NO persistent audit row —
 * the row is written only when the mint survives, so the accumulation rate is
 * bounded by the RAM caps (100 live device codes, 5-7 min TTL) instead of
 * only per-IP token buckets. Failed attempts keep their aggregated denial
 * accounting (failWindows).
 * Level: unit, scratch sqlite only (hermetic).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { Audit } from "../apps/dpi-playground-hub/src/audit.js";
import { PairingService } from "../apps/dpi-playground-hub/src/pairing.js";

const HUB_ORIGIN = "https://pi.example.com";
const HUB_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const uuid = () => crypto.randomUUID();

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "dpi-p11b-fix-"));
  const registry = new NetworkRegistry(join(dir, "network.sqlite"));
  const audit = new Audit(registry);
  const clock = { now: 1760000000000 };
  const service = new PairingService({
    registry,
    audit,
    hubOrigin: HUB_ORIGIN,
    hubId: HUB_ID,
    now: () => clock.now,
    issue: async () => {
      throw new Error("probe must never issue");
    },
  });
  const rows = () =>
    new DatabaseSync(join(dir, "network.sqlite"), { readOnly: true })
      .prepare("SELECT COUNT(*) c FROM events WHERE action='pair.code_created'")
      .get() as { c: number };
  return { service, clock, rows, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("R15 h11b: failed unauth device mints write no audit row; successes do", async () => {
  const f = await fixture();
  try {
    const kp = generateKeyPairSync("ed25519");
    const publicKey = kp.publicKey.export({ type: "spki", format: "pem" }) as string;
    const body = (extra: Record<string, unknown> = {}) => ({
      type: "pair.device-request",
      v: 1,
      requestId: uuid(),
      deviceUid: uuid(),
      deviceName: "faux",
      hostname: "h",
      platform: "p",
      publicKey,
      keyFingerprint: "sha256:" + "0".repeat(64), // WRONG on purpose
      clientTime: f.clock.now,
      ...extra,
    });

    // Failed attempts (wrong fingerprint): no persistent rows.
    for (let i = 0; i < 5; i++) {
      const r = await f.service.requestForDevice(body(), `10.9.0.${i + 1}`);
      assert.equal(r.ok, false);
      assert.equal((r as { error?: { code?: string } }).error?.code, "fingerprint_mismatch");
    }
    assert.equal(f.rows().c, 0, "failed anonymous mints must not persist audit rows");
    assert.equal(f.service.listPending().length, 0, "and must recycle RAM slots");

    // Control: a genuine key with its REAL fingerprint survives -> 1 row.
    const fp = `sha256:${createHash("sha256")
      .update(kp.publicKey.export({ type: "spki", format: "der" }) as Buffer)
      .digest("hex")}`;
    const ok = await f.service.requestForDevice(body({ keyFingerprint: fp }), "10.9.1.1");
    assert.equal(ok.ok, true, "honest request still succeeds");
    assert.equal(f.rows().c, 1, "successful device mint writes exactly one row");
    assert.equal(f.service.listPending().length, 1);
  } finally {
    f.cleanup();
  }
});

