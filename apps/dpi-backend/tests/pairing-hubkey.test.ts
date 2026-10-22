/**
 * Offer v3 — hub-key pinning (comparison gap #6, mutation proofs).
 *
 * The v3 offer carries `kfp` (sha256 of the hub identity key's SPKI). The
 * device challenges the hub with a nonce, verifies the proof BEFORE signing
 * the hub's own challenge, refuses a TokenIssue whose hubKeyFingerprint
 * differs, and persists ONLY the offer-carried pin. Every refusal here is a
 * MUTATION: flip one piece of an otherwise-honest ceremony and the device
 * must refuse — never save, never trust the declared value.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { DevicePairing } from "../src/pairing.js";
import { pairingPath, type PairingFile } from "../src/pairing-files.js";
import { until } from "./helpers.js";
import { PAIR_HUB_ID, PAIR_NOW, PAIR_UID, pairHub } from "./pairing-hub.js";
import { encodePairOffer } from "../../dpi-sdk/src/protocol/pairing.js";

const ORIGIN = "https://h.example.com";
const CODE = "c1d2e3f4-a5b6-4789-abcd-eff012345678";

const offerV3Url = (kfp: string, exp = PAIR_NOW + 300_000) =>
  `${ORIGIN}/pair#offer=${encodePairOffer({ v: 3, hub: ORIGIN, id: PAIR_HUB_ID, code: CODE, exp, kfp })}`;

const opened: DevicePairing[] = [];
afterEach(() => {
  for (const dp of opened.splice(0)) if (dp.status().pending) dp.cancel();
});

const open = (home: string, hub: ReturnType<typeof pairHub>) => {
  const dp = new DevicePairing({ uid: PAIR_UID } as never, home, "dev", undefined, {
    fetchImpl: hub.fetchImpl,
    pollMs: 5,
    now: () => PAIR_NOW,
  });
  opened.push(dp);
  return dp;
};

const scratch = async () => {
  const home = await mkdtemp(join(tmpdir(), "dpi-v3-"));
  return { home, done: () => rm(home, { recursive: true, force: true }) };
};

const savedPin = (home: string): string | undefined => {
  if (!existsSync(pairingPath(home))) return undefined;
  return (JSON.parse(readFileSync(pairingPath(home), "utf8")) as PairingFile).hubKeyFingerprint;
};

test("v3 happy path: honest proof — the request carries a hubNonce, the pin lands in pairing.json", async () => {
  const s = await scratch();
  const hub = pairHub({ origin: ORIGIN, held: true, identity: { kind: "honest" } });
  const dp = open(s.home, hub);
  try {
    const started = await dp.start({ code: "", pairUrl: offerV3Url(hub.identityFingerprint) });
    assert.equal(started.state, "pairing");
    const start = hub.calls.find((c) => c.url.endsWith("/api/pair/start"))!;
    assert.match(start.body.hubNonce, /^[A-Za-z0-9_-]{43}$/, "the device challenged the hub");
    hub.approve();
    await until(() => dp.status().state === "paired");
    assert.equal(savedPin(s.home), hub.identityFingerprint, "pairing.json pins the offer's kfp");
  } finally {
    await s.done();
  }
});

test("MUTATION: offer pins a DIFFERENT hub key — refused before any proof is accepted", async () => {
  const s = await scratch();
  const hub = pairHub({ origin: ORIGIN, identity: { kind: "honest" } });
  const dp = open(s.home, hub);
  try {
    const wrongKfp = hub.identityFingerprint.replace(/.$/, (c) => (c === "a" ? "b" : "a"));
    await assert.rejects(
      () => dp.start({ code: "", pairUrl: offerV3Url(wrongKfp) }),
      (e: Error & { code?: string }) => {
        assert.match(e.message, /differs from the offer's pin/);
        return e.code === "hub_proof_failed";
      },
      "a fingerprint mismatch is a refusal, not a warning",
    );
    assert.equal(dp.status().state, "unpaired");
    assert.ok(!existsSync(pairingPath(s.home)), "no credential file was written");
  } finally {
    await s.done();
  }
});

test("MUTATION: the hub proves with the WRONG key (signature verifies, fingerprint differs)", async () => {
  const s = await scratch();
  const hub = pairHub({ origin: ORIGIN, identity: { kind: "wrong-key" } });
  const dp = open(s.home, hub);
  try {
    await assert.rejects(
      () => dp.start({ code: "", pairUrl: offerV3Url(hub.identityFingerprint) }),
      (e: Error & { code?: string }) => e.code === "hub_proof_failed",
    );
    assert.ok(!existsSync(pairingPath(s.home)));
  } finally {
    await s.done();
  }
});

test("MUTATION: right key, GARBAGE signature — refused", async () => {
  const s = await scratch();
  const hub = pairHub({ origin: ORIGIN, identity: { kind: "garbage-signature" } });
  const dp = open(s.home, hub);
  try {
    await assert.rejects(
      () => dp.start({ code: "", pairUrl: offerV3Url(hub.identityFingerprint) }),
      (e: Error & { code?: string }) => e.code === "hub_proof_failed",
    );
    assert.ok(!existsSync(pairingPath(s.home)));
  } finally {
    await s.done();
  }
});

test("MUTATION: TokenIssue carries a DIFFERENT hubKeyFingerprint — the credential is not saved", async () => {
  const s = await scratch();
  const hub = pairHub({
    origin: ORIGIN,
    identity: { kind: "honest" },
    issue: { hubKeyFingerprint: `sha256:${"9a".repeat(32)}` },
  });
  const dp = open(s.home, hub);
  try {
    await dp.start({ code: "", pairUrl: offerV3Url(hub.identityFingerprint) });
    await until(() => dp.status().lastError !== undefined);
    assert.equal(dp.status().state, "unpaired");
    assert.match(
      dp.status().lastError ?? "",
      /hubKeyFingerprint differs from the fingerprint pinned in the offer/,
    );
    assert.ok(!existsSync(pairingPath(s.home)), "the mismatched credential was NOT saved");
  } finally {
    await s.done();
  }
});

test("v2 offer on the same harness: no hubNonce sent, no pin written (legacy path untouched)", async () => {
  const s = await scratch();
  // identity configured but the offer is v2: the device must NOT challenge
  const hub = pairHub({ origin: ORIGIN, identity: { kind: "honest" } });
  const dp = open(s.home, hub);
  try {
    const v2Url = `${ORIGIN}/pair#offer=${encodePairOffer({ v: 2, hub: ORIGIN, id: PAIR_HUB_ID, code: CODE, exp: PAIR_NOW + 300_000 })}`;
    await dp.start({ code: "", pairUrl: v2Url });
    await until(() => dp.status().state === "paired");
    const start = hub.calls.find((c) => c.url.endsWith("/api/pair/start"))!;
    assert.equal(start.body.hubNonce, undefined, "a v2 offer never challenges the hub");
    assert.equal(
      savedPin(s.home),
      undefined,
      "an issue-declared fingerprint is never pinned from a v2 flow",
    );
  } finally {
    await s.done();
  }
});
