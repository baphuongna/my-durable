/**
 * W-3 schema tests: pairing DTOs — valid/invalid round-trips, unknown-field
 * rejection, enum coverage, canonical encodings and size boundaries
 * (spec 08 W-3; boundary set from 03 §5/§6).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PAIRING_DTOS,
  PAIR_CODE_PATTERN,
  PairChallenge,
  PairCodeIssue,
  PairCodeState,
  PairError,
  PairRequest,
  PairResponse,
  TokenIssue,
  checkPairingDto,
  hubProofSigningPayload,
  isPairCode,
  normalizePairCode,
  parseHubOrigin,
  pairingSigningPayload,
  strictTokenBytes,
} from "../src/protocol/pairing.js";
import {
  PAIR_CODE_LENGTH,
  PAIR_CODE_LEGACY_LENGTH,
  PAIR_CODE_UUID_LENGTH,
  assertLimitsConfig,
} from "../src/protocol/limits.js";

const uuid = () => "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const fp = () => "sha256:" + "ab".repeat(32);
const nonce = () => "A".repeat(43);
const dpt = () => "dpt_" + "A".repeat(43);

test("W-3: twelve DTOs exported for coverage", () => {
  // + PairDeviceRequest / PairDeviceRequestAck (device-initiated enrollment).
  assert.equal(PAIRING_DTOS.length, 12);
});

test("W-3: PairRequest valid round-trip", () => {
  const value = {
    type: "pair.request",
    v: 1,
    requestId: uuid(),
    code: "AB2C7DEF",
    deviceUid: uuid(),
    deviceName: "desk-lamp",
    publicKey: "-----BEGIN PUBLIC KEY-----",
    keyFingerprint: fp(),
    clientTime: 1760000000000,
  };
  assert.ok(checkPairingDto(PairRequest, value));
});

test("W-3: unknown fields rejected on every DTO", () => {
  for (const schema of PAIRING_DTOS) {
    const sample: Record<string, unknown> = {
      type: "pair.error",
      v: 1,
      code: "code_invalid",
      message: "x",
    };
    // Build one known-valid sample per schema via its own check where cheap;
    // the generic unknown-field property: appending extra key must fail.
    const withExtra = { ...sample, extra: 1 };
    const before = checkPairingDto(schema, sample);
    const after = checkPairingDto(schema, withExtra);
    if (before)
      assert.ok(!after, `extra field must be rejected for ${JSON.stringify(schema).slice(0, 60)}`);
  }
  const req = {
    type: "pair.request",
    v: 1,
    requestId: uuid(),
    code: "AB2C7DEF",
    deviceUid: uuid(),
    deviceName: "d",
    publicKey: "k",
    keyFingerprint: fp(),
    clientTime: 1,
    sneaky: true,
  };
  assert.ok(!checkPairingDto(PairRequest, req));
});

test("W-3: code boundaries — 7/9 chars, lowercase, RFC4648-confusable 0/1 rejected", () => {
  const base = {
    type: "pair.request",
    v: 1,
    requestId: uuid(),
    deviceUid: uuid(),
    deviceName: "d",
    publicKey: "k",
    keyFingerprint: fp(),
    clientTime: 1,
  };
  for (const code of ["AB2C7DE", "AB2C7DEFF", "ab2c7def", "AB2C7DE0", "AB2C7DE1"]) {
    assert.ok(!checkPairingDto(PairRequest, { ...base, code }), code);
  }
  assert.ok(checkPairingDto(PairRequest, { ...base, code: "AB2C7DEF" }));
});

test("W-3: fingerprint boundaries — 63/65 hex, uppercase, wrong prefix", () => {
  const base = {
    type: "pair.request",
    v: 1,
    requestId: uuid(),
    code: "AB2C7DEF",
    deviceUid: uuid(),
    deviceName: "d",
    publicKey: "k",
    clientTime: 1,
  };
  assert.ok(
    !checkPairingDto(PairRequest, { ...base, keyFingerprint: "sha256:" + "ab".repeat(31) }),
  );
  assert.ok(
    !checkPairingDto(PairRequest, { ...base, keyFingerprint: "sha256:" + "AB".repeat(32) }),
  );
  assert.ok(!checkPairingDto(PairRequest, { ...base, keyFingerprint: "md5:" + "ab".repeat(32) }));
  assert.ok(checkPairingDto(PairRequest, { ...base, keyFingerprint: fp() }));
});

test("W-3: canonical UUID — uppercase, trailing newline, wrong shape rejected", () => {
  const base = {
    type: "pair.request",
    v: 1,
    code: "AB2C7DEF",
    deviceName: "d",
    publicKey: "k",
    keyFingerprint: fp(),
    clientTime: 1,
  };
  const upper = uuid().toUpperCase();
  assert.ok(!checkPairingDto(PairRequest, { ...base, requestId: upper, deviceUid: uuid() }));
  assert.ok(
    !checkPairingDto(PairRequest, { ...base, requestId: `${uuid()}\n`, deviceUid: uuid() }),
  );
  assert.ok(!checkPairingDto(PairRequest, { ...base, requestId: "not-a-uuid", deviceUid: uuid() }));
  assert.ok(checkPairingDto(PairRequest, { ...base, requestId: uuid(), deviceUid: uuid() }));
});

test("W-3: PairResponse signature is exactly 86 base64url chars", () => {
  const good = {
    type: "pair.response",
    v: 1,
    enrollmentId: uuid(),
    nonce: nonce(),
    signature: "B".repeat(86),
  };
  assert.ok(checkPairingDto(PairResponse, good));
  assert.ok(!checkPairingDto(PairResponse, { ...good, signature: "B".repeat(85) }));
  assert.ok(!checkPairingDto(PairResponse, { ...good, signature: `B`.repeat(85) + "+" }));
});

test("W-3: PairError code enum coverage — all 15 codes accepted, junk rejected", () => {
  const codes = [
    "code_invalid",
    "code_expired",
    "code_used",
    "code_in_use",
    "rate_limited",
    "signature_invalid",
    "clock_skew",
    "paired_elsewhere",
    "hub_required",
    "fingerprint_mismatch",
    "identity_conflict",
    "enrollment_lost",
    "enrollment_cancelled",
    "already_issued",
    "challenge_expired",
  ];
  assert.equal(codes.length, 15);
  for (const code of codes) {
    assert.ok(checkPairingDto(PairError, { type: "pair.error", v: 1, code, message: "m" }), code);
  }
  assert.ok(
    !checkPairingDto(PairError, { type: "pair.error", v: 1, code: "mystery", message: "m" }),
  );
  assert.ok(
    !checkPairingDto(PairError, {
      type: "pair.error",
      v: 1,
      code: "code_invalid",
      message: "m",
      retryAfterMs: 0,
    }),
  );
});

test("W-3: TokenIssue — tunnelToken shape, expiresAt strictly null, generation >= 1", () => {
  const good = {
    type: "pair.token",
    v: 1,
    enrollmentId: uuid(),
    deviceUid: uuid(),
    deviceId: "abc123",
    pairingEpoch: uuid(),
    credentialId: uuid(),
    generation: 1,
    hubId: uuid(),
    hubOrigin: "https://pi.example.com",
    hubUrl: "https://pi.example.com/api/tunnel",
    tunnelToken: dpt(),
    issuedAt: 1760000000000,
    expiresAt: null,
  };
  assert.ok(checkPairingDto(TokenIssue, good));
  assert.ok(!checkPairingDto(TokenIssue, { ...good, tunnelToken: "dpX_" + "A".repeat(43) }));
  assert.ok(!checkPairingDto(TokenIssue, { ...good, tunnelToken: "dpt_" + "A".repeat(42) }));
  assert.ok(!checkPairingDto(TokenIssue, { ...good, generation: 0 }));
  assert.ok(!checkPairingDto(TokenIssue, { ...good, expiresAt: 123 }));
  assert.ok(!checkPairingDto(TokenIssue, { ...good, deviceId: "-abc" }));
  assert.ok(!checkPairingDto(TokenIssue, { ...good, deviceId: "a".repeat(33) }));
  assert.ok(!checkPairingDto(TokenIssue, { ...good, deviceId: "abc\n" })); // lookahead anchor
});

test("W-3: PairCodeState phases — all 8 accepted, bogus rejected, enrollment optional", () => {
  const phases = [
    "open",
    "awaiting_proof",
    "awaiting_approval",
    "approved",
    "issued",
    "connected",
    "cancelled",
    "expired",
  ];
  assert.equal(phases.length, 8);
  for (const phase of phases) {
    assert.ok(
      checkPairingDto(PairCodeState, {
        type: "pair.code-state",
        v: 1,
        codeId: uuid(),
        expiresAt: 1,
        phase,
      }),
      phase,
    );
  }
  assert.ok(
    !checkPairingDto(PairCodeState, {
      type: "pair.code-state",
      v: 1,
      codeId: uuid(),
      expiresAt: 1,
      phase: "pairing",
    }),
  );
  const withEnrollment = {
    type: "pair.code-state",
    v: 1,
    codeId: uuid(),
    expiresAt: 1,
    phase: "awaiting_approval" as const,
    enrollment: {
      enrollmentId: uuid(),
      deviceUid: uuid(),
      deviceName: "d",
      keyFingerprint: fp(),
      proofVerified: true,
      keyChanged: false,
    },
  };
  assert.ok(checkPairingDto(PairCodeState, withEnrollment));
});

test("W-3: PairCodeIssue — code + urls bounded", () => {
  const good = {
    type: "pair.code",
    v: 1,
    codeId: uuid(),
    code: "ZZ7Y6X2W",
    expiresAt: 1,
    hubOrigin: "https://h.example",
    pairUrl: "https://h.example/pair?code=ZZ7Y6X2W&v=1",
  };
  assert.ok(checkPairingDto(PairCodeIssue, good));
  assert.ok(!checkPairingDto(PairCodeIssue, { ...good, code: "zz9y8x7w" }));
  assert.ok(!checkPairingDto(PairCodeIssue, { ...good, hubOrigin: "h".repeat(2049) }));
});

test("parseHubOrigin — HTTPS-only canonical origin, no userinfo/query/fragment/base path", () => {
  assert.deepEqual(parseHubOrigin("https://pi.example.com"), {
    ok: true,
    origin: "https://pi.example.com",
    tunnelUrl: "https://pi.example.com/api/tunnel",
  });
  assert.deepEqual(parseHubOrigin("https://pi.example.com:8443/"), {
    ok: true,
    origin: "https://pi.example.com:8443",
    tunnelUrl: "https://pi.example.com:8443/api/tunnel",
  });
  assert.equal(parseHubOrigin("http://pi.example.com").ok, false);
  assert.equal(parseHubOrigin("wss://pi.example.com").ok, false);
  assert.equal(parseHubOrigin("https://pi.example.com/hub").ok, false);
  assert.equal(parseHubOrigin("https://pi.example.com/pair?code=X").ok, false);
  assert.equal(parseHubOrigin("https://user:pw@pi.example.com").ok, false);
  assert.equal(parseHubOrigin("https://pi.example.com#f").ok, false);
  assert.equal(parseHubOrigin("  https://pi.example.com").ok, false);
  assert.equal(parseHubOrigin("").ok, false);
});

test("signing payload — exact element order", () => {
  const s = pairingSigningPayload({
    hubOrigin: "https://pi.example.com",
    hubId: uuid(),
    enrollmentId: uuid(),
    nonce: nonce(),
    issuedAt: 1760000000000,
    deviceUid: uuid(),
    keyFingerprint: fp(),
  });
  const parsed = JSON.parse(s) as string[];
  assert.equal(parsed[0], "dpi-pair-v1");
  assert.equal(parsed.length, 8);
});

test("strictTokenBytes — base64url charset, trailing newline, decoded byte length", () => {
  const tok = "A".repeat(43); // 32 bytes
  assert.ok(strictTokenBytes(tok, 32));
  assert.ok(!strictTokenBytes(`${tok}\n`, 32));
  assert.ok(!strictTokenBytes(tok, 33));
  assert.ok(!strictTokenBytes(tok.replace(/A$/, "+"), 32));
  assert.ok(!strictTokenBytes(tok.replace(/A$/, "="), 32));
});

test("limits config self-check", () => {
  assert.doesNotThrow(assertLimitsConfig);
});

// --- Pairing code hardening: UUID v4 minted; 12- and 8-char base32 are legacy parse paths ---

const UUID_CODE = "a1b2c3d4-e5f6-4789-abcd-eff012345678";

const requestBase = {
  type: "pair.request",
  v: 1,
  requestId: uuid(),
  deviceUid: uuid(),
  deviceName: "d",
  publicKey: "k",
  keyFingerprint: fp(),
  clientTime: 1,
};

test("hardening: code shape constants — UUID v4 minted, 12 and 8 char base32 legacy", () => {
  assert.equal(PAIR_CODE_LENGTH, 12);
  assert.equal(PAIR_CODE_LEGACY_LENGTH, 8);
  assert.equal(PAIR_CODE_UUID_LENGTH, 36);
  // One pattern, three accepted families — every consumer reads this string.
  const re = new RegExp(PAIR_CODE_PATTERN);
  assert.ok(re.test(UUID_CODE));
  assert.ok(re.test("ABCD2345EF67"));
  assert.ok(re.test("AB2C7DEF"));
});

test("hardening: a UUID v4 code validates; 12- and 8-char base32 codes still parse", () => {
  assert.ok(checkPairingDto(PairRequest, { ...requestBase, code: UUID_CODE }));
  assert.ok(checkPairingDto(PairRequest, { ...requestBase, code: "ABCD2345EF67" }));
  assert.ok(checkPairingDto(PairRequest, { ...requestBase, code: "AB2C7DEF" }));
  assert.ok(
    checkPairingDto(PairCodeIssue, {
      type: "pair.code",
      v: 1,
      codeId: uuid(),
      code: UUID_CODE,
      expiresAt: 1,
      hubOrigin: "https://h.example",
      pairUrl: `https://h.example/pair?code=${UUID_CODE}&v=1`,
    }),
  );
});

test("hardening: only canonical UUID v4 is a code — not any hex string", () => {
  for (const bad of [
    UUID_CODE.toUpperCase(), // canonical form is lower case
    "a1b2c3d4e5f64789abcdeff012345678", // hyphens dropped: 32 hex, not a UUID
    "a1b2c3d4-e5f6-5789-abcd-eff012345678", // version nibble 5
    "a1b2c3d4-e5f6-4789-7bcd-eff012345678", // variant nibble 7
    "g1b2c3d4-e5f6-4789-abcd-eff012345678", // not hex
    "a1b2c3d4-e5f6-4789-abcd-eff01234567", // one hex short
    ` ${UUID_CODE}`,
  ]) {
    assert.ok(!checkPairingDto(PairRequest, { ...requestBase, code: bad }), bad);
    assert.equal(isPairCode(bad), false, bad);
  }
});

test("hardening: 10/11/13 chars, non-alphabet and trailing newline are rejected", () => {
  for (const code of ["ABCD2345EF", "ABCD2345EF6", "ABCD2345EF67A", "AB2C7DEFG", "AB2C7DE0"]) {
    assert.ok(!checkPairingDto(PairRequest, { ...requestBase, code }), code);
    assert.equal(isPairCode(code), false, code);
  }
  // `$` alone matches before a final newline; the strict end anchor must not.
  for (const code of ["AB2C7DEF\n", "ABCD2345EF67\n", `${UUID_CODE}\n`]) {
    assert.ok(!checkPairingDto(PairRequest, { ...requestBase, code }), JSON.stringify(code));
    assert.equal(isPairCode(code), false, JSON.stringify(code));
  }
});

test("hardening: isPairCode accepts UUID v4, 12 and 8 char base32 — nothing else, no trim", () => {
  assert.equal(isPairCode(UUID_CODE), true);
  assert.equal(isPairCode("ABCD2345EF67"), true);
  assert.equal(isPairCode("AB2C7DEF"), true);
  for (const bad of [
    "",
    " ABCD2345EF67",
    "ABCD2345EF67 ",
    "abcd2345ef67",
    "ABCD-2345-EF67",
    12,
    null,
    undefined,
    {},
  ]) {
    assert.equal(isPairCode(bad), false, JSON.stringify(bad));
  }
});

test("hardening: normalizePairCode canonicalises typed/grouped codes", () => {
  // base32 family: separators go, case is normalised
  assert.equal(normalizePairCode("abcd-2345-ef67"), "ABCD2345EF67");
  assert.equal(normalizePairCode("ABCD 2345 EF67"), "ABCD2345EF67");
  assert.equal(normalizePairCode("ABCD-2345-EF67"), "ABCD2345EF67");
  assert.equal(normalizePairCode("ABCD2345EF67"), "ABCD2345EF67");
  assert.equal(normalizePairCode("AB2C7DEF"), "AB2C7DEF");
  // UUID family: hyphens are structure, so they stay; only the case changes
  assert.equal(normalizePairCode(UUID_CODE.toUpperCase()), UUID_CODE);
  assert.equal(normalizePairCode(UUID_CODE), UUID_CODE);
  // A grouped base32 value is the human rendering of a 12-char code: a truncated group is refused.
  assert.equal(normalizePairCode("ABCD-2345"), undefined);
  assert.equal(normalizePairCode("ABCD 2345 EF67 GHIJ"), undefined);
  assert.equal(normalizePairCode("ABCD2345EF678"), undefined);
  assert.equal(normalizePairCode("AB2C7DE0"), undefined);
  assert.equal(normalizePairCode(""), undefined);
  // …and a hyphen-less or malformed UUID is not rescued into the base32 family
  assert.equal(normalizePairCode("a1b2c3d4e5f64789abcdeff012345678"), undefined);
  assert.equal(normalizePairCode("a1b2c3d4-e5f6-5789-abcd-eff012345678"), undefined);
  // Round-trip: whatever normalises is exactly what the schema accepts.
  for (const raw of [
    "abcd-2345-ef67",
    "AB2C7DEF",
    "ABCD 2345 EF67",
    UUID_CODE.toUpperCase(),
    UUID_CODE,
  ]) {
    const canonical = normalizePairCode(raw);
    assert.ok(canonical && isPairCode(canonical), raw);
    assert.ok(checkPairingDto(PairRequest, { ...requestBase, code: canonical }), raw);
  }
});

// --- Pairing offer links (v2): the whole handoff rides the #offer= fragment ---

import {
  decodePairOffer,
  encodePairOffer,
  parsePairOfferUrl,
  readPairOffer,
  type PairOfferV2,
  type PairOfferV3,
} from "../src/protocol/pairing.js";
import { PAIR_OFFER_MAX_AHEAD_MS, PAIR_OFFER_SKEW_MS } from "../src/protocol/limits.js";

const OFFER_HUB = "https://pi.example.com";
const OFFER_ID = "1a2b3c4d-5e6f-4a5b-8c9d-0e1f2a3b4c5d";
const OFFER_CODE = "a1b2c3d4-e5f6-4789-abcd-eff012345678"; // minted family: canonical UUID v4
const OFFER_NOW = 1760000000000;

const offer = (over: Partial<Omit<PairOfferV2, "v">> = {}): PairOfferV2 => ({
  v: 2,
  hub: OFFER_HUB,
  id: OFFER_ID,
  code: OFFER_CODE,
  exp: OFFER_NOW + 240_000,
  ...over,
});
/** Encode arbitrary JSON as the wire payload, bypassing encodePairOffer (tamper tests). */
const rawOf = (json: unknown) => Buffer.from(JSON.stringify(json), "utf8").toString("base64url");

test("offer: encode/decode round-trip — canonical field order, base64url without padding", () => {
  const raw = encodePairOffer(offer());
  assert.match(raw, /^[A-Za-z0-9_-]+$/); // standard base64url, no padding, nothing else
  assert.ok(!raw.includes("="));
  // canonical JSON: exactly v,hub,id,code,exp in that order, short keys
  const bytes = Buffer.from(raw, "base64url");
  assert.deepEqual(JSON.parse(bytes.toString("utf8")), offer());
  assert.deepEqual(Object.keys(JSON.parse(bytes.toString("utf8"))), [
    "v",
    "hub",
    "id",
    "code",
    "exp",
  ]);
  assert.deepEqual(decodePairOffer(raw, OFFER_NOW), offer());
  // decode is clock-relative: the same raw offer decodes while fresh and fails once stale
  assert.equal(decodePairOffer(raw, offer().exp + PAIR_OFFER_MAX_AHEAD_MS), undefined);
});

test("offer: strict decode — tampering any field yields undefined, never a throw", () => {
  const good = offer();
  const tampers: [name: string, json: Record<string, unknown>][] = [
    ["wrong version", { ...good, v: 1 }],
    ["http origin", { ...good, hub: "http://pi.example.com" }],
    ["userinfo in hub", { ...good, hub: "https://user:pw@pi.example.com" }],
    ["hub with base path", { ...good, hub: "https://pi.example.com/hub" }],
    ["non-canonical hub form", { ...good, hub: "https://pi.example.com/" }],
    ["unknown field", { ...good, extra: 1 }],
    ["missing field", { v: 2, hub: OFFER_HUB, id: OFFER_ID, code: OFFER_CODE }],
    ["wrong UUID shape (id)", { ...good, id: OFFER_ID.toUpperCase() }],
    ["wrong UUID shape (code)", { ...good, code: "a1b2c3d4-e5f6-5789-abcd-eff012345678" }],
    ["legacy base32 code", { ...good, code: "ABCD2345EF67" }],
    ["exp in the past (beyond skew)", { ...good, exp: OFFER_NOW - PAIR_OFFER_SKEW_MS - 1 }],
    ["exp too far ahead", { ...good, exp: OFFER_NOW + PAIR_OFFER_MAX_AHEAD_MS + 1 }],
    ["exp not an integer", { ...good, exp: OFFER_NOW + 0.5 }],
    ["exp not a number", { ...good, exp: String(OFFER_NOW) }],
  ];
  for (const [name, json] of tampers) {
    assert.equal(decodePairOffer(rawOf(json), OFFER_NOW), undefined, name);
  }
  // never throws: garbage, empty, huge, non-UTF8-safe payloads all just return undefined
  for (const junk of ["", "!!!", "e30", rawOf({ v: 2 }), "a".repeat(4096), "\ud800"]) {
    assert.equal(decodePairOffer(junk, OFFER_NOW), undefined, JSON.stringify(junk.slice(0, 20)));
  }
});

test("offer: exp window boundaries — 30 s skew back, 10 minutes ahead", () => {
  assert.deepEqual(
    decodePairOffer(rawOf(offer({ exp: OFFER_NOW - PAIR_OFFER_SKEW_MS })), OFFER_NOW),
    offer({ exp: OFFER_NOW - PAIR_OFFER_SKEW_MS }),
  );
  assert.equal(
    decodePairOffer(rawOf(offer({ exp: OFFER_NOW - PAIR_OFFER_SKEW_MS - 1 })), OFFER_NOW),
    undefined,
  );
  assert.deepEqual(
    decodePairOffer(rawOf(offer({ exp: OFFER_NOW + PAIR_OFFER_MAX_AHEAD_MS })), OFFER_NOW),
    offer({ exp: OFFER_NOW + PAIR_OFFER_MAX_AHEAD_MS }),
  );
  assert.equal(
    decodePairOffer(rawOf(offer({ exp: OFFER_NOW + PAIR_OFFER_MAX_AHEAD_MS + 1 })), OFFER_NOW),
    undefined,
  );
  // the structural reader is freshness-blind: it is how a caller distinguishes "expired" from "junk"
  const expired = rawOf(offer({ exp: OFFER_NOW - 60_000 }));
  assert.equal(decodePairOffer(expired, OFFER_NOW), undefined);
  assert.deepEqual(readPairOffer(expired), offer({ exp: OFFER_NOW - 60_000 }));
});

test("offer: parsePairOfferUrl — only <origin>/pair with a lone #offer= fragment", () => {
  const link = `${OFFER_HUB}/pair#offer=${encodePairOffer(offer())}`;
  const parsed = parsePairOfferUrl(link, OFFER_NOW);
  assert.ok(parsed);
  assert.deepEqual(parsed.offer, offer());
  assert.equal(parsed.rest, `${OFFER_HUB}/pair`); // the URL minus its fragment, safe to keep
  // /pair/ with a trailing slash is the same page
  assert.ok(parsePairOfferUrl(`${OFFER_HUB}/pair/#offer=${encodePairOffer(offer())}`, OFFER_NOW));
  for (const bad of [
    `${OFFER_HUB}/other#offer=${encodePairOffer(offer())}`, // not /pair
    `${OFFER_HUB}/pair?x=1#offer=${encodePairOffer(offer())}`, // a stray query
    `${OFFER_HUB}/pair?code=${OFFER_CODE}&v=1#offer=${encodePairOffer(offer())}`, // v1+v2 mixed
    `${OFFER_HUB}/pair#offer=!!!`, // not base64url
    `${OFFER_HUB}/pair#offer=`, // empty payload
    `${OFFER_HUB}/pair#offer=${encodePairOffer(offer({ hub: "https://other.example.com" }))}`, // minted by another hub
    `https://user:pw@pi.example.com/pair#offer=${encodePairOffer(offer())}`, // userinfo in the link
    `${OFFER_HUB}/pair#offer=${encodePairOffer(offer())}x`, // trailing junk after the payload
    `not a url`,
  ]) {
    assert.equal(parsePairOfferUrl(bad, OFFER_NOW), undefined, bad.slice(0, 60));
  }
  // a fresh-looking link at a stale clock is still just undefined (no throw)
  assert.equal(parsePairOfferUrl(link, offer().exp + 605_000), undefined);
});

test("offer: PairCodeIssue carries an optional bounded offerUrl alongside pairUrl", () => {
  const base = {
    type: "pair.code",
    v: 1,
    codeId: uuid(),
    code: OFFER_CODE,
    expiresAt: 1,
    hubOrigin: "https://h.example",
    pairUrl: `https://h.example/pair?code=${OFFER_CODE}&v=1`,
  };
  assert.ok(checkPairingDto(PairCodeIssue, base), "offerUrl stays optional (transition)");
  const withOffer = {
    ...base,
    offerUrl: `https://h.example/pair#offer=${encodePairOffer(offer())}`,
  };
  assert.ok(checkPairingDto(PairCodeIssue, withOffer));
  assert.ok(!checkPairingDto(PairCodeIssue, { ...withOffer, offerUrl: "h".repeat(2049) }));
});

// --- Offer v3: the pinned hub identity (kfp) rides the same fragment ---

const OFFER_KFP = `sha256:${"a1b2c3d4".repeat(8)}`;
const offerV3 = (): PairOfferV3 => ({ ...offer(), v: 3, kfp: OFFER_KFP });

test("offer v3: encode/decode round-trip — six canonical fields, kfp last", () => {
  const raw = encodePairOffer(offerV3());
  assert.match(raw, /^[A-Za-z0-9_-]+$/);
  const json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  assert.deepEqual(Object.keys(json), ["v", "hub", "id", "code", "exp", "kfp"]);
  assert.equal(json.kfp, OFFER_KFP);
  assert.deepEqual(decodePairOffer(raw, OFFER_NOW), offerV3());
  // parsePairOfferUrl accepts v3 links unchanged
  const parsed = parsePairOfferUrl(`${OFFER_HUB}/pair#offer=${raw}`, OFFER_NOW);
  assert.ok(parsed);
  assert.equal(parsed.offer.v, 3);
  assert.equal((parsed.offer as { kfp?: string }).kfp, OFFER_KFP);
});

test("offer v3: a bad or missing kfp is refused, never thrown", () => {
  const good = offerV3();
  const tampers: [name: string, json: Record<string, unknown>][] = [
    ["missing kfp", { v: 3, hub: OFFER_HUB, id: OFFER_ID, code: OFFER_CODE, exp: good.exp }],
    ["uppercase kfp", { ...good, kfp: OFFER_KFP.toUpperCase() }],
    ["short kfp", { ...good, kfp: `sha256:${"ab".repeat(31)}` }],
    ["wrong prefix", { ...good, kfp: OFFER_KFP.replace("sha256:", "sha512:") }],
    ["kfp on v2", { ...good, v: 2 }], // v2 is exactly five fields — kfp must not smuggle in
    ["v3 with extra field", { ...good, extra: 1 }],
  ];
  for (const [name, json] of tampers) {
    assert.equal(readPairOffer(rawOf(json)), undefined, name);
    assert.equal(decodePairOffer(rawOf(json), OFFER_NOW), undefined, name);
  }
  // v2 untouched: still decodes, and never reports a kfp
  const v2 = decodePairOffer(encodePairOffer(offer()), OFFER_NOW);
  assert.ok(v2 && v2.v === 2 && (v2 as { kfp?: string }).kfp === undefined);
});

test("offer v3: PairRequest.hubNonce + PairChallenge/TokenIssue proof fields are optional and strict", () => {
  const nonce = "A".repeat(43);
  const req = {
    type: "pair.request",
    v: 1,
    requestId: uuid(),
    code: OFFER_CODE,
    deviceUid: uuid(),
    deviceName: "d",
    publicKey: "-----BEGIN PUBLIC KEY-----",
    keyFingerprint: `sha256:${"0a".repeat(32)}`,
    clientTime: 1,
  };
  assert.ok(checkPairingDto(PairRequest, req), "no hubNonce (legacy v2 flow)");
  assert.ok(checkPairingDto(PairRequest, { ...req, hubNonce: nonce }));
  assert.ok(!checkPairingDto(PairRequest, { ...req, hubNonce: "short" }));
  const challenge = {
    type: "pair.challenge",
    v: 1,
    enrollmentId: uuid(),
    nonce,
    issuedAt: 1,
    hubId: uuid(),
  };
  const proof = {
    hubPublicKey: "-----BEGIN PUBLIC KEY-----",
    hubKeyFingerprint: `sha256:${"0a".repeat(32)}`,
    hubSignature: "B".repeat(86),
  };
  assert.ok(checkPairingDto(PairChallenge, challenge), "no proof fields (legacy v2 flow)");
  assert.ok(checkPairingDto(PairChallenge, { ...challenge, ...proof }));
  assert.ok(!checkPairingDto(PairChallenge, { ...challenge, hubSignature: "B".repeat(85) }));
  assert.ok(!checkPairingDto(PairChallenge, { ...challenge, hubKeyFingerprint: "sha256:ab" }));
  const issue = {
    type: "pair.token",
    v: 1,
    enrollmentId: uuid(),
    deviceUid: uuid(),
    deviceId: "dev-1",
    pairingEpoch: uuid(),
    credentialId: uuid(),
    generation: 1,
    hubId: uuid(),
    hubOrigin: OFFER_HUB,
    hubUrl: `${OFFER_HUB}/api/tunnel`,
    tunnelToken: `dpt_${"C".repeat(43)}`,
    issuedAt: 1,
    expiresAt: null,
  };
  assert.ok(checkPairingDto(TokenIssue, issue), "no hubKeyFingerprint (legacy)");
  assert.ok(checkPairingDto(TokenIssue, { ...issue, hubKeyFingerprint: OFFER_KFP }));
  assert.ok(!checkPairingDto(TokenIssue, { ...issue, hubKeyFingerprint: "nope" }));
});

test("hubProofSigningPayload — exact element order, ceremony and tunnel subjects", () => {
  const pairSubject = `pair:${uuid()}`;
  assert.equal(
    hubProofSigningPayload({
      hubOrigin: OFFER_HUB,
      hubId: OFFER_ID,
      subject: pairSubject,
      nonce: "A".repeat(43),
    }),
    JSON.stringify(["dpi-hub-proof-v1", OFFER_HUB, OFFER_ID, pairSubject, "A".repeat(43)]),
  );
  const subject = `tunnel:dev-1:${uuid()}`;
  assert.equal(
    hubProofSigningPayload({
      hubOrigin: OFFER_HUB,
      hubId: OFFER_ID,
      subject,
      nonce: "N".repeat(43),
    }),
    JSON.stringify(["dpi-hub-proof-v1", OFFER_HUB, OFFER_ID, subject, "N".repeat(43)]),
  );
});
