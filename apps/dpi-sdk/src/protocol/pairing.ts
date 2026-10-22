/**
 * Pairing protocol DTOs — Durable Agent Network P2 (spec 03 §5).
 *
 * Strict TypeBox schemas: unknown fields are rejected everywhere. Schema
 * checks are necessary but NOT sufficient: cross-field/state invariants and
 * origin normalization live in the exported helpers below and in the hub
 * state machine (03 §4).
 *
 * This module must stay browser-safe: no Node builtin imports.
 */
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { PAIR_CODE_LENGTH, PAIR_CODE_LEGACY_LENGTH, PAIR_CODE_UUID_LENGTH } from "./limits.js";

const Strict = { additionalProperties: false } as const;

const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  minLength: 36,
  maxLength: 36,
});
// Strict end anchor: JS `$` alone can still match before a final newline, so
// DeviceId uses an explicit lookahead. All other patterns are length-clamped
// (min===max), which also rejects trailing-newline inputs.
const DeviceId = Type.String({
  pattern: "^[a-z0-9][a-z0-9-]{0,31}(?![\\s\\S])",
  minLength: 1,
  maxLength: 32,
});
const Fingerprint = Type.String({ pattern: "^sha256:[0-9a-f]{64}$", minLength: 71, maxLength: 71 });
const Nonce = Type.String({ pattern: "^[A-Za-z0-9_-]{43}$", minLength: 43, maxLength: 43 });
const TunnelToken = Type.String({ pattern: "^dpt_[A-Za-z0-9_-]{43}$", minLength: 47, maxLength: 47 });
/**
 * Canonical lower-case UUID v4: any hex is NOT a code, so the version nibble must be 4 and the
 * variant nibble 8/9/a/b.
 */
const UUID_V4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
/**
 * One pattern for every accepted code shape: the minted UUID v4, plus the 12- and 8-char base32
 * forms that links already in flight still carry. `$` alone can match before a final newline, so
 * the pattern ends with an explicit lookahead — the length clamp below cannot catch a newline
 * when min and max differ.
 */
export const PAIR_CODE_PATTERN = `^(?:${UUID_V4}|[A-Z2-7]{12}|[A-Z2-7]{8})(?![\\s\\S])`;
const PairCode = Type.String({
  pattern: PAIR_CODE_PATTERN,
  minLength: PAIR_CODE_LEGACY_LENGTH,
  maxLength: PAIR_CODE_UUID_LENGTH,
});

const PAIR_CODE_RE = new RegExp(PAIR_CODE_PATTERN);
/** Shape test for the UUID family — used to pick the normalisation rule, never to accept on its own. */
const UUID_SHAPED_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/**
 * Exact-shape check for a pairing code, with NO trimming: a value with a leading/trailing space
 * or a newline is not a code. Consumers that accept a typed value use `normalizePairCode`.
 */
export function isPairCode(value: unknown): value is string {
  if (typeof value !== "string" || value.length > PAIR_CODE_UUID_LENGTH) return false;
  return PAIR_CODE_RE.test(value);
}

/**
 * Canonicalise a code a human typed or pasted. The two families canonicalise differently, so the
 * shape decides first:
 * - UUID v4 (`A1B2…-E5F6-4789-ABCD-EFF012345678`): hyphens are structure — only the case changes.
 * - base32 (`abcd-2345-ef67`, `ABCD 2345 EF67`): hyphens/spaces are group separators — they go
 *   and the result is upper case.
 * Anything that does not fit either family exactly (a hyphen-less hex run, a 10/11/13-char run,
 * non-alphabet characters, a truncated group like `ABCD-2345`) is refused.
 */
export function normalizePairCode(raw: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (UUID_SHAPED_RE.test(raw)) {
    const lower = raw.toLowerCase();
    return isPairCode(lower) ? lower : undefined; // version/variant nibbles must be v4
  }
  const compact = raw.replace(/[\s-]+/g, "").toUpperCase();
  if (!isPairCode(compact)) return undefined;
  if (/[\s-]/.test(raw) && compact.length !== PAIR_CODE_LENGTH) return undefined;
  return compact;
}

export const PairRequest = Type.Object(
  {
    type: Type.Literal("pair.request"),
    v: Type.Literal(1),
    requestId: Uuid,
    code: PairCode,
    deviceUid: Uuid,
    deviceName: Type.String({ minLength: 1, maxLength: 64 }),
    publicKey: Type.String({ minLength: 1, maxLength: 256 }), // Ed25519 SPKI PEM
    keyFingerprint: Fingerprint,
    clientTime: Type.Integer(),
  },
  Strict,
);

export const PairChallenge = Type.Object(
  {
    type: Type.Literal("pair.challenge"),
    v: Type.Literal(1),
    enrollmentId: Uuid,
    nonce: Nonce,
    issuedAt: Type.Integer(),
    hubId: Uuid, // deployment ID, not a cryptographic fingerprint
  },
  Strict,
);

export const PairResponse = Type.Object(
  {
    type: Type.Literal("pair.response"),
    v: Type.Literal(1),
    enrollmentId: Uuid,
    nonce: Nonce,
    signature: Type.String({ pattern: "^[A-Za-z0-9_-]{86}$", minLength: 86, maxLength: 86 }),
  },
  Strict,
);

export const PairPending = Type.Object(
  {
    type: Type.Literal("pair.pending"),
    v: Type.Literal(1),
    enrollmentId: Uuid,
    state: Type.Literal("awaiting_approval"),
    expiresAt: Type.Integer(),
    pollAfterMs: Type.Integer({ minimum: 1 }),
  },
  Strict,
);

export const TokenIssue = Type.Object(
  {
    type: Type.Literal("pair.token"),
    v: Type.Literal(1),
    enrollmentId: Uuid,
    deviceUid: Uuid,
    deviceId: DeviceId,
    pairingEpoch: Uuid,
    credentialId: Uuid,
    generation: Type.Integer({ minimum: 1 }),
    hubId: Uuid,
    hubOrigin: Type.String(),
    hubUrl: Type.String(),
    tunnelToken: TunnelToken,
    issuedAt: Type.Integer(),
    expiresAt: Type.Null(),
  },
  Strict,
);

export const PairApproval = Type.Object(
  {
    enrollmentId: Uuid,
    deviceUid: Uuid,
    keyFingerprint: Fingerprint,
    replaceKey: Type.Optional(Type.Boolean()),
  },
  Strict,
);

export const RevokeNotice = Type.Object(
  {
    type: Type.Literal("pair.revoke"),
    v: Type.Literal(1),
    deviceId: DeviceId,
    pairingEpoch: Uuid,
    reason: Type.Union([
      Type.Literal("user"),
      Type.Literal("compromise"),
      Type.Literal("hub_migrated"),
    ]),
    revokedAt: Type.Integer(),
  },
  Strict,
);

export const PairError = Type.Object(
  {
    type: Type.Literal("pair.error"),
    v: Type.Literal(1),
    code: Type.Union([
      Type.Literal("code_invalid"),
      Type.Literal("code_expired"),
      Type.Literal("code_used"),
      Type.Literal("code_in_use"),
      Type.Literal("rate_limited"),
      Type.Literal("signature_invalid"),
      Type.Literal("clock_skew"),
      Type.Literal("paired_elsewhere"),
      Type.Literal("hub_required"),
      Type.Literal("fingerprint_mismatch"),
      Type.Literal("identity_conflict"),
      Type.Literal("enrollment_lost"),
      Type.Literal("enrollment_cancelled"),
      Type.Literal("already_issued"),
      Type.Literal("challenge_expired"),
    ]),
    message: Type.String({ maxLength: 512 }),
    retryAfterMs: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  Strict,
);

export const PairCodeIssue = Type.Object(
  {
    type: Type.Literal("pair.code"),
    v: Type.Literal(1),
    codeId: Uuid,
    code: PairCode,
    expiresAt: Type.Integer(),
    hubOrigin: Type.String({ maxLength: 2048 }),
    pairUrl: Type.String({ maxLength: 4096 }),
  },
  Strict,
);

const PairCodeStatePhase = Type.Union([
  Type.Literal("open"),
  Type.Literal("awaiting_proof"),
  Type.Literal("awaiting_approval"),
  Type.Literal("approved"),
  Type.Literal("issued"),
  Type.Literal("connected"),
  Type.Literal("cancelled"),
  Type.Literal("expired"),
]);

export const PairCodeState = Type.Object(
  {
    type: Type.Literal("pair.code-state"),
    v: Type.Literal(1),
    codeId: Uuid,
    expiresAt: Type.Integer(),
    phase: PairCodeStatePhase,
    enrollment: Type.Optional(
      Type.Object(
        {
          enrollmentId: Uuid,
          deviceUid: Uuid,
          deviceName: Type.String({ minLength: 1, maxLength: 64 }),
          keyFingerprint: Fingerprint,
          proofVerified: Type.Boolean(),
          keyChanged: Type.Boolean(),
        },
        Strict,
      ),
    ),
    deviceId: Type.Optional(DeviceId),
    error: Type.Optional(PairError),
  },
  Strict,
);

export type PairRequest = Static<typeof PairRequest>;
export type PairChallenge = Static<typeof PairChallenge>;
export type PairResponse = Static<typeof PairResponse>;
export type PairPending = Static<typeof PairPending>;
export type TokenIssue = Static<typeof TokenIssue>;
export type PairApproval = Static<typeof PairApproval>;
export type RevokeNotice = Static<typeof RevokeNotice>;
export type PairError = Static<typeof PairError>;
export type PairCodeIssue = Static<typeof PairCodeIssue>;
export type PairCodeState = Static<typeof PairCodeState>;

/** The ten wire DTOs — used by schema-coverage tests (W-3). */
export const PAIRING_DTOS = [
  PairRequest,
  PairChallenge,
  PairResponse,
  PairPending,
  TokenIssue,
  PairApproval,
  RevokeNotice,
  PairError,
  PairCodeIssue,
  PairCodeState,
] as const;

export function checkPairingDto<T extends (typeof PAIRING_DTOS)[number]>(
  schema: T,
  value: unknown,
): value is Static<T> {
  return Value.Check(schema, value);
}

/**
 * Canonical hub origin: HTTPS only, no userinfo/query/fragment/base path.
 * The tunnel WSS URL is always derived from this same origin + /api/tunnel.
 */
export function parseHubOrigin(
  input: string,
): { ok: true; origin: string; tunnelUrl: string } | { ok: false; error: string } {
  if (typeof input !== "string" || input.length === 0 || input.length > 2048) {
    return { ok: false, error: "origin: empty or too long" };
  }
  if (/\s|\n|\r|\t/.test(input)) {
    return { ok: false, error: "origin: whitespace not allowed" };
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, error: "origin: not a valid URL" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, error: "origin: HTTPS origin required" };
  }
  if (url.username || url.password) {
    return { ok: false, error: "origin: userinfo not allowed" };
  }
  if (url.search || url.hash) {
    return { ok: false, error: "origin: query/fragment not allowed" };
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    return { ok: false, error: "origin: base path not allowed" };
  }
  return { ok: true, origin: url.origin, tunnelUrl: `${url.origin}/api/tunnel` };
}

/** Exact Ed25519 signing payload — element order is normative (03 §4.2). */
export function pairingSigningPayload(parts: {
  hubOrigin: string;
  hubId: string;
  enrollmentId: string;
  nonce: string;
  issuedAt: number;
  deviceUid: string;
  keyFingerprint: string;
}): string {
  return JSON.stringify([
    "dpi-pair-v1",
    parts.hubOrigin,
    parts.hubId,
    parts.enrollmentId,
    parts.nonce,
    parts.issuedAt,
    parts.deviceUid,
    parts.keyFingerprint,
  ]);
}

/**
 * Base64url byte-length validation for credential-bearing strings read from
 * files/env (which may carry a trailing newline). Protocol contexts use the
 * strict patterns above; this guards the persistence/compare layer.
 */
export function strictTokenBytes(input: string, expectedBytes: number): boolean {
  if (input.includes("=") || input.includes("+") || input.includes("/")) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(input)) return false; // trailing newline/space/charset
  const chars = input.length;
  if (chars !== Math.ceil((expectedBytes * 8) / 6)) return false;
  try {
    const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
    return globalThis.atob(b64).length === expectedBytes;
  } catch {
    return false;
  }
}
