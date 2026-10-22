/**
 * Offer-link pairing (v2): the whole handoff (hub origin, hubId, code, expiry)
 * rides the #offer= fragment. The device pulls code + origin out of the decoded
 * offer, an expired offer fails BEFORE any network call, and the offer origin
 * joins the existing explicit-origin conflict rules unchanged.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevicePairing } from "../src/pairing.js";
import { pairingPath } from "../src/pairing-files.js";
import { readFileSync } from "node:fs";
import { until } from "./helpers.js";
import { PAIR_HUB_ID, PAIR_NOW, PAIR_UID, pairHub } from "./pairing-hub.js";
import { encodePairOffer } from "../../dpi-sdk/src/protocol/pairing.js";
import { PAIR_OFFER_SKEW_MS } from "../../dpi-sdk/src/protocol/limits.js";

const ORIGIN = "https://h.example.com";
/** Minted family: the hub only ever puts UUID v4 codes into offer links. */
const CODE = "b1b2c3d4-e5f6-4789-abcd-eff012345678";

const offerUrl = (exp: number, hub = ORIGIN, code = CODE) =>
  `${hub}/pair#offer=${encodePairOffer({ v: 2, hub, id: PAIR_HUB_ID, code, exp })}`;

const opened: DevicePairing[] = [];
// The fake clock never reaches the operation's expiry, so an operation a test leaves pending would poll forever.
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
  const home = await mkdtemp(join(tmpdir(), "dpi-offer-"));
  return { home, done: () => rm(home, { recursive: true, force: true }) };
};

test("offer link: full ceremony start→proof→approve→issued with input.pairUrl = offerUrl, zero other config", async () => {
  const s = await scratch();
  const hub = pairHub({ origin: ORIGIN, held: true });
  const dp = open(s.home, hub);
  try {
    const started = await dp.start({ code: "", pairUrl: offerUrl(PAIR_NOW + 300_000) });
    assert.equal(started.state, "pairing");
    assert.equal(started.pending?.hubOrigin, ORIGIN, "the origin comes from the offer, not --hub");
    // the code the hub received is the one from the fragment — nothing else was configured
    const start = hub.calls.find((c) => c.url.endsWith("/api/pair/start"));
    assert.ok(start, "the ceremony started");
    assert.equal(start.body.code, CODE);
    assert.equal(start.body.deviceUid, PAIR_UID);
    hub.approve();
    await until(() => dp.status().state === "paired", 3000, "paired");
    assert.equal(dp.status().hubOrigin, ORIGIN);
    assert.equal(dp.status().deviceId, "dev-9");
    assert.equal(dp.status().lastError, undefined);
    const file = JSON.parse(readFileSync(pairingPath(s.home), "utf8"));
    assert.equal(file.hubOrigin, ORIGIN);
    assert.equal(file.hubId, PAIR_HUB_ID);
  } finally {
    await s.done();
  }
});

test("offer link: an offer inside the 30 s clock-skew window still pairs", async () => {
  const s = await scratch();
  const hub = pairHub({ origin: ORIGIN });
  const dp = open(s.home, hub);
  try {
    await dp.start({ code: "", pairUrl: offerUrl(PAIR_NOW - PAIR_OFFER_SKEW_MS) });
    await until(() => dp.status().state === "paired", 3000, "paired despite exp 30 s past");
  } finally {
    await s.done();
  }
});

test("offer link: an expired offer fails with 'pairing offer expired' BEFORE any network call", async () => {
  const s = await scratch();
  const hub = pairHub({ origin: ORIGIN });
  const dp = open(s.home, hub);
  try {
    await assert.rejects(
      dp.start({ code: "", pairUrl: offerUrl(PAIR_NOW - PAIR_OFFER_SKEW_MS - 1) }),
      /pairing offer expired/,
    );
    assert.equal(hub.calls.length, 0, "no request left the device");
    assert.equal(dp.status().state, "unpaired");
  } finally {
    await s.done();
  }
});

test("offer link: an offer origin conflicting with --hub is the existing conflict error, before any network", async () => {
  const s = await scratch();
  const hub = pairHub({ origin: ORIGIN });
  const dp = open(s.home, hub);
  try {
    await assert.rejects(
      dp.start({ code: "", pairUrl: offerUrl(PAIR_NOW + 300_000), hub: "https://other.example.com" }),
      /Multiple explicit hub origins conflict/,
    );
    assert.equal(hub.calls.length, 0, "no request left the device");
  } finally {
    await s.done();
  }
});

test("offer link: junk offer fragments and mixed v1+v2 links are refused like a bad v1 pairUrl", async () => {
  const s = await scratch();
  const hub = pairHub({ origin: ORIGIN });
  const dp = open(s.home, hub);
  try {
    for (const bad of [
      `${ORIGIN}/pair#offer=!!!`, // not base64url
      `${ORIGIN}/pair#offer=${encodePairOffer({ v: 2, hub: ORIGIN, id: PAIR_HUB_ID, code: "ABCD2345EF67", exp: PAIR_NOW + 300_000 })}`, // legacy base32 code
      `${ORIGIN}/pair?code=${CODE}&v=1#offer=${encodePairOffer({ v: 2, hub: ORIGIN, id: PAIR_HUB_ID, code: CODE, exp: PAIR_NOW + 300_000 })}`, // v1+v2 mixed
      `https://other.example.com/pair#offer=${encodePairOffer({ v: 2, hub: ORIGIN, id: PAIR_HUB_ID, code: CODE, exp: PAIR_NOW + 300_000 })}`, // link hub ≠ offer hub
    ]) {
      await assert.rejects(
        dp.start({ code: "", pairUrl: bad }),
        (e: Error & { code?: string }) => e instanceof Error && e.code === "invalid",
        bad.slice(0, 60),
      );
    }
    assert.equal(hub.calls.length, 0, "no request left the device");
  } finally {
    await s.done();
  }
});
