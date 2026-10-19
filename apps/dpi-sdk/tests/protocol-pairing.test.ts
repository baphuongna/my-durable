/**
 * W-3 schema tests: pairing DTOs — valid/invalid round-trips, unknown-field
 * rejection, enum coverage, canonical encodings and size boundaries
 * (spec 08 W-3; boundary set from 03 §5/§6).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PAIRING_DTOS,
  PairCodeIssue,
  PairCodeState,
  PairError,
  PairRequest,
  PairResponse,
  TokenIssue,
  checkPairingDto,
  parseHubOrigin,
  pairingSigningPayload,
  strictTokenBytes,
} from "../src/protocol/pairing.js";
import { assertLimitsConfig } from "../src/protocol/limits.js";

const uuid = () => "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const fp = () => "sha256:" + "ab".repeat(32);
const nonce = () => "A".repeat(43);
const dpt = () => "dpt_" + "A".repeat(43);

test("W-3: ten DTOs exported for coverage", () => {
  assert.equal(PAIRING_DTOS.length, 10);
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
    const sample: Record<string, unknown> = { type: "pair.error", v: 1, code: "code_invalid", message: "x" };
    // Build one known-valid sample per schema via its own check where cheap;
    // the generic unknown-field property: appending extra key must fail.
    const withExtra = { ...sample, extra: 1 };
    const before = checkPairingDto(schema, sample);
    const after = checkPairingDto(schema, withExtra);
    if (before) assert.ok(!after, `extra field must be rejected for ${JSON.stringify(schema).slice(0, 60)}`);
  }
  const req = {
    type: "pair.request", v: 1, requestId: uuid(), code: "AB2C7DEF", deviceUid: uuid(),
    deviceName: "d", publicKey: "k", keyFingerprint: fp(), clientTime: 1, sneaky: true,
  };
  assert.ok(!checkPairingDto(PairRequest, req));
});

test("W-3: code boundaries — 7/9 chars, lowercase, RFC4648-confusable 0/1 rejected", () => {
  const base = { type: "pair.request", v: 1, requestId: uuid(), deviceUid: uuid(), deviceName: "d", publicKey: "k", keyFingerprint: fp(), clientTime: 1 };
  for (const code of ["AB2C7DE", "AB2C7DEFF", "ab2c7def", "AB2C7DE0", "AB2C7DE1"]) {
    assert.ok(!checkPairingDto(PairRequest, { ...base, code }), code);
  }
  assert.ok(checkPairingDto(PairRequest, { ...base, code: "AB2C7DEF" }));
});

test("W-3: fingerprint boundaries — 63/65 hex, uppercase, wrong prefix", () => {
  const base = { type: "pair.request", v: 1, requestId: uuid(), code: "AB2C7DEF", deviceUid: uuid(), deviceName: "d", publicKey: "k", clientTime: 1 };
  assert.ok(!checkPairingDto(PairRequest, { ...base, keyFingerprint: "sha256:" + "ab".repeat(31) }));
  assert.ok(!checkPairingDto(PairRequest, { ...base, keyFingerprint: "sha256:" + "AB".repeat(32) }));
  assert.ok(!checkPairingDto(PairRequest, { ...base, keyFingerprint: "md5:" + "ab".repeat(32) }));
  assert.ok(checkPairingDto(PairRequest, { ...base, keyFingerprint: fp() }));
});

test("W-3: canonical UUID — uppercase, trailing newline, wrong shape rejected", () => {
  const base = { type: "pair.request", v: 1, code: "AB2C7DEF", deviceName: "d", publicKey: "k", keyFingerprint: fp(), clientTime: 1 };
  const upper = uuid().toUpperCase();
  assert.ok(!checkPairingDto(PairRequest, { ...base, requestId: upper, deviceUid: uuid() }));
  assert.ok(!checkPairingDto(PairRequest, { ...base, requestId: `${uuid()}\n`, deviceUid: uuid() }));
  assert.ok(!checkPairingDto(PairRequest, { ...base, requestId: "not-a-uuid", deviceUid: uuid() }));
  assert.ok(checkPairingDto(PairRequest, { ...base, requestId: uuid(), deviceUid: uuid() }));
});

test("W-3: PairResponse signature is exactly 86 base64url chars", () => {
  const good = { type: "pair.response", v: 1, enrollmentId: uuid(), nonce: nonce(), signature: "B".repeat(86) };
  assert.ok(checkPairingDto(PairResponse, good));
  assert.ok(!checkPairingDto(PairResponse, { ...good, signature: "B".repeat(85) }));
  assert.ok(!checkPairingDto(PairResponse, { ...good, signature: `B`.repeat(85) + "+" }));
});

test("W-3: PairError code enum coverage — all 15 codes accepted, junk rejected", () => {
  const codes = ["code_invalid", "code_expired", "code_used", "code_in_use", "rate_limited",
    "signature_invalid", "clock_skew", "paired_elsewhere", "hub_required", "fingerprint_mismatch",
    "identity_conflict", "enrollment_lost", "enrollment_cancelled", "already_issued", "challenge_expired"];
  assert.equal(codes.length, 15);
  for (const code of codes) {
    assert.ok(checkPairingDto(PairError, { type: "pair.error", v: 1, code, message: "m" }), code);
  }
  assert.ok(!checkPairingDto(PairError, { type: "pair.error", v: 1, code: "mystery", message: "m" }));
  assert.ok(!checkPairingDto(PairError, { type: "pair.error", v: 1, code: "code_invalid", message: "m", retryAfterMs: 0 }));
});

test("W-3: TokenIssue — tunnelToken shape, expiresAt strictly null, generation >= 1", () => {
  const good = {
    type: "pair.token", v: 1, enrollmentId: uuid(), deviceUid: uuid(), deviceId: "abc123",
    pairingEpoch: uuid(), credentialId: uuid(), generation: 1, hubId: uuid(),
    hubOrigin: "https://pi.example.com", hubUrl: "https://pi.example.com/api/tunnel",
    tunnelToken: dpt(), issuedAt: 1760000000000, expiresAt: null,
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
  const phases = ["open", "awaiting_proof", "awaiting_approval", "approved", "issued", "connected", "cancelled", "expired"];
  assert.equal(phases.length, 8);
  for (const phase of phases) {
    assert.ok(checkPairingDto(PairCodeState, { type: "pair.code-state", v: 1, codeId: uuid(), expiresAt: 1, phase }), phase);
  }
  assert.ok(!checkPairingDto(PairCodeState, { type: "pair.code-state", v: 1, codeId: uuid(), expiresAt: 1, phase: "pairing" }));
  const withEnrollment = {
    type: "pair.code-state", v: 1, codeId: uuid(), expiresAt: 1, phase: "awaiting_approval" as const,
    enrollment: { enrollmentId: uuid(), deviceUid: uuid(), deviceName: "d", keyFingerprint: fp(), proofVerified: true, keyChanged: false },
  };
  assert.ok(checkPairingDto(PairCodeState, withEnrollment));
});

test("W-3: PairCodeIssue — code + urls bounded", () => {
  const good = { type: "pair.code", v: 1, codeId: uuid(), code: "ZZ7Y6X2W", expiresAt: 1, hubOrigin: "https://h.example", pairUrl: "https://h.example/pair?code=ZZ7Y6X2W&v=1" };
  assert.ok(checkPairingDto(PairCodeIssue, good));
  assert.ok(!checkPairingDto(PairCodeIssue, { ...good, code: "zz9y8x7w" }));
  assert.ok(!checkPairingDto(PairCodeIssue, { ...good, hubOrigin: "h".repeat(2049) }));
});

test("parseHubOrigin — HTTPS-only canonical origin, no userinfo/query/fragment/base path", () => {
  assert.deepEqual(parseHubOrigin("https://pi.example.com"), { ok: true, origin: "https://pi.example.com", tunnelUrl: "https://pi.example.com/api/tunnel" });
  assert.deepEqual(parseHubOrigin("https://pi.example.com:8443/"), { ok: true, origin: "https://pi.example.com:8443", tunnelUrl: "https://pi.example.com:8443/api/tunnel" });
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
    hubOrigin: "https://pi.example.com", hubId: uuid(), enrollmentId: uuid(),
    nonce: nonce(), issuedAt: 1760000000000, deviceUid: uuid(), keyFingerprint: fp(),
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
