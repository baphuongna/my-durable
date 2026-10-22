/**
 * S-1 / S-2 — exact edges of the public pairing buckets, on an injected clock.
 *   S-1  POST /api/pair/code   5 per minute, burst 5    → the 6th is refused, one token returns every 12 s
 *   S-2  POST /api/pair/start  20 per minute, burst 20  → the 21st is refused, one token returns every 3 s
 * An unknown code answers 404 once the bucket let the request through, so 404 vs 429 tells the two apart.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { Audit } from "../apps/dpi-playground-hub/src/audit.js";
import { PairingService } from "../apps/dpi-playground-hub/src/pairing.js";

const HUB_ORIGIN = "https://pi.example.com";
const HUB_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const T0 = 1_760_000_000_000;

const key = generateKeyPairSync("ed25519");
const PUBLIC_PEM = key.publicKey.export({ type: "spki", format: "pem" }) as string;
const FINGERPRINT = `sha256:${createHash("sha256").update(key.publicKey.export({ type: "spki", format: "der" }) as Buffer).digest("hex")}`;

async function service(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "dpi-pair-limits-"));
  const registry = new NetworkRegistry(join(dir, "network.sqlite"));
  const clock = { now: T0 };
  const pairing = new PairingService({
    registry, audit: new Audit(registry), hubOrigin: HUB_ORIGIN, hubId: HUB_ID, now: () => clock.now,
    issue: async () => {
      throw new Error("issuance is not part of these tests");
    },
  });
  t.after(async () => {
    registry.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { pairing, clock };
}

/** A well-formed start request for a code nobody minted: it passes the bucket and stops at the code check. */
const startUnknownCode = (pairing: PairingService, ip: string) =>
  pairing.start(
    { type: "pair.request", v: 1, requestId: randomUUID(), code: "AAAAAAAA", deviceUid: randomUUID(), deviceName: "dev",
      publicKey: PUBLIC_PEM, keyFingerprint: FINGERPRINT, clientTime: 0 },
    ip,
  );

const tag = (r: { ok: true } | { ok: false; error: { status: number; code: string } }) => (r.ok ? "ok" : `${r.error.status}:${r.error.code}`);

test("S-1: the 6th code in a minute is refused and a token returns exactly every 12 s", async (t) => {
  const { pairing, clock } = await service(t);
  const mint = (ip = "10.0.0.1") => tag(pairing.createCode(ip));

  assert.deepEqual([1, 2, 3, 4, 5].map(() => mint()), ["ok", "ok", "ok", "ok", "ok"]);
  assert.equal(mint(), "429:rate_limited", "6th request in the same instant");

  clock.now = T0 + 11_999;
  assert.equal(mint(), "429:rate_limited", "1 ms before the first refill");
  clock.now = T0 + 12_000;
  assert.equal(mint(), "ok", "the refilled token");
  assert.equal(mint(), "429:rate_limited", "only one token came back");

  clock.now = T0 + 12_000 + 24_000;
  assert.deepEqual([mint(), mint(), mint()], ["ok", "ok", "429:rate_limited"], "24 s later: exactly two more");
});

test("S-1: the refusal carries the wait until the next token", async (t) => {
  const { pairing } = await service(t);
  for (let i = 0; i < 5; i++) assert.ok(pairing.createCode("10.0.0.1").ok);
  const refused = pairing.createCode("10.0.0.1");
  assert.ok(!refused.ok);
  assert.equal(refused.error.status, 429);
  assert.equal(refused.error.retryAfterMs, 12_000);
});

test("S-2: the 21st start in a minute is refused and a token returns exactly every 3 s", async (t) => {
  const { pairing, clock } = await service(t);
  const ip = "198.51.100.7";
  const results = Array.from({ length: 20 }, () => tag(startUnknownCode(pairing, ip)));
  assert.deepEqual(new Set(results), new Set(["404:code_invalid"]), "20 requests reach the code check");
  const refused = startUnknownCode(pairing, ip);
  assert.ok(!refused.ok && refused.error.status === 429 && /starts/.test(refused.error.message), JSON.stringify(refused));

  clock.now = T0 + 2_999;
  assert.equal(tag(startUnknownCode(pairing, ip)), "429:rate_limited", "1 ms before the first refill");
  clock.now = T0 + 3_000;
  assert.equal(tag(startUnknownCode(pairing, ip)), "404:code_invalid", "the refilled token");
  assert.equal(tag(startUnknownCode(pairing, ip)), "429:rate_limited", "only one token came back");
});

test("S-1 / S-2: each source has its own bucket", async (t) => {
  const { pairing } = await service(t);
  for (let i = 0; i < 5; i++) assert.ok(pairing.createCode("10.0.0.1").ok);
  assert.equal(tag(pairing.createCode("10.0.0.1")), "429:rate_limited");
  assert.equal(tag(pairing.createCode("10.0.0.2")), "ok", "another admin source is untouched");

  for (let i = 0; i < 21; i++) startUnknownCode(pairing, "198.51.100.7");
  assert.equal(tag(startUnknownCode(pairing, "198.51.100.7")), "429:rate_limited");
  assert.equal(tag(startUnknownCode(pairing, "198.51.100.8")), "404:code_invalid", "another device source is untouched");
});
