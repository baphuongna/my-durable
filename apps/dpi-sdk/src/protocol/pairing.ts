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
import {
  PAIR_CODE_LENGTH,
  PAIR_CODE_LEGACY_LENGTH,
  PAIR_CODE_UUID_LENGTH,
  PAIR_OFFER_MAX_AHEAD_MS,
  PAIR_OFFER_MAX_JSON_BYTES,
  PAIR_OFFER_SKEW_MS,
} from "./limits.js";

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
const TunnelToken = Type.String({
  pattern: "^dpt_[A-Za-z0-9_-]{43}$",
  minLength: 47,
  maxLength: 47,
});
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
const UUID_SHAPED_RE =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

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
    /** Machine description the operator sees BEFORE approving (like orca/paseo offers). */
    hostname: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    platform: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    publicKey: Type.String({ minLength: 1, maxLength: 256 }), // Ed25519 SPKI PEM
    keyFingerprint: Fingerprint,
    clientTime: Type.Integer(),
    /**
     * Hub-proof challenge (offer v3): present only when the offer pinned a hub
     * key fingerprint. The hub answers with its public key + a signature over
     * hubProofSigningPayload(...subject: enrollmentId) so the device can check
     * the responder owns the pinned key BEFORE any credential is accepted.
     * Optional keeps v1 wire shape: only v3-offer flows ever set it.
     */
    hubNonce: Type.Optional(Nonce),
  },
  Strict,
);

/**
 * Device-INITIATED enrollment (the shape orca/paseo use): the machine asks the
 * hub for a code instead of waiting for an operator-minted one, so the operator
 * never has to carry a secret across machines. The tuple is still the full
 * identity — name, hostname, platform, public key — and the hub still computes
 * the fingerprint itself and still requires a human approval.
 */
export const PairDeviceRequest = Type.Object(
  {
    type: Type.Literal("pair.device-request"),
    v: Type.Literal(1),
    requestId: Uuid,
    deviceUid: Uuid,
    deviceName: Type.String({ minLength: 1, maxLength: 64 }),
    hostname: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    platform: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    publicKey: Type.String({ minLength: 1, maxLength: 256 }),
    keyFingerprint: Fingerprint,
    clientTime: Type.Integer(),
    /** Offer-v3 hub pinning, exactly as the operator-minted flow carries it. */
    hubNonce: Type.Optional(Nonce),
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
    /** Present iff the request carried hubNonce (offer v3 pinning). */
    hubPublicKey: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), // Ed25519 SPKI PEM
    hubKeyFingerprint: Type.Optional(Fingerprint),
    /** Ed25519 over hubProofSigningPayload({..., subject: enrollmentId, nonce: request hubNonce}). */
    hubSignature: Type.Optional(
      Type.String({ pattern: "^[A-Za-z0-9_-]{86}$", minLength: 86, maxLength: 86 }),
    ),
  },
  Strict,
);

/** The hub's answer to a device-initiated request: the code it minted, plus the challenge. */
export const PairDeviceRequestAck = Type.Object(
  {
    type: Type.Literal("pair.device-ack"),
    v: Type.Literal(1),
    codeId: Uuid,
    code: PairCode,
    expiresAt: Type.Integer(),
    hubOrigin: Type.String(),
    hubId: Uuid,
    challenge: PairChallenge,
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
    /** Present for offer-v3 pairings: the pinned hub identity (same value the offer carried). */
    hubKeyFingerprint: Type.Optional(Fingerprint),
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
    /** v2 offer link: the whole handoff rides the #offer= fragment (never a query). */
    offerUrl: Type.Optional(Type.String({ maxLength: 2048 })),
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
  PairDeviceRequest,
  PairDeviceRequestAck,
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
    // Loopback dev hubs (one machine running both ends) speak plain HTTP. The
    // same rule as the device's own origin check: only 127.0.0.1/[::1]/localhost
    // qualify, so a hub another machine can reach is still HTTPS-only.
    const loopback =
      url.protocol === "http:" && /^(127\.0\.0\.1|\[::1\]|localhost)$/.test(url.hostname);
    if (!loopback) return { ok: false, error: "origin: HTTPS origin required" };
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

/**
 * v2 pairing offer — ONE artifact carrying identity, trust anchor and transport:
 * hub origin + hubId + code + expiry, base64url-encoded into the URL FRAGMENT
 * (`<hubOrigin>/pair#offer=…`). A fragment never leaves the client, so the
 * code cannot reach server/CDN query logs, and the origin travels inside the
 * link (no --hub needed on the device).
 */
export interface PairOfferV2 {
  v: 2;
  /** Canonical HTTPS hub origin (the transport the device pairs against). */
  hub: string;
  /** hubId trust anchor (deployment id), a canonical UUID. */
  id: string;
  /** The single-use pairing code — canonical UUID v4, the only minted family. */
  code: string;
  /** Expiry, hub epoch ms. */
  exp: number;
}

/**
 * v3 offer — v2 plus `kfp`: the sha256-of-SPKI fingerprint of the hub's
 * persistent Ed25519 identity key. The device pins it: the hub must PROVE
 * possession of that exact key during the ceremony (and on every tunnel
 * connect), so a hub swap is detectable at the device even with TLS intact.
 */
export interface PairOfferV3 extends Omit<PairOfferV2, "v"> {
  v: 3;
  /** Pinned hub identity: `sha256:<64 hex>` of the hub key's SPKI DER. */
  kfp: string;
}

export type PairOffer = PairOfferV2 | PairOfferV3;

/** base64url (no padding) of UTF-8 bytes — browser-safe, no Node builtins. */
function offerEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function offerDecode(raw: string): Uint8Array | undefined {
  if (raw === "" || !/^[A-Za-z0-9_-]+$/.test(raw)) return undefined;
  try {
    const binary = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

const OFFER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The minted family only: offer links carry a UUID v4 code, never legacy base32. */
const OFFER_CODE_RE = new RegExp(`^${UUID_V4}$`);

/**
 * Encode an offer to the exact fragment payload: canonical JSON (field order
 * v,hub,id,code,exp[,kfp] — byte-lean and deterministic), base64url, no padding.
 * Pure encoder: it does not validate; callers mint from live hub values.
 */
export function encodePairOffer(offer: PairOffer): string {
  const json =
    offer.v === 3
      ? {
          v: offer.v,
          hub: offer.hub,
          id: offer.id,
          code: offer.code,
          exp: offer.exp,
          kfp: offer.kfp,
        }
      : { v: offer.v, hub: offer.hub, id: offer.id, code: offer.code, exp: offer.exp };
  return offerEncode(new TextEncoder().encode(JSON.stringify(json)));
}

/**
 * Structural decode (freshness-blind): exactly the known fields for the
 * declared version — five for v2, six for v3 (`kfp` must be a canonical
 * `sha256:<64 hex>`) — canonical HTTPS origin (byte-exact, reusing the
 * parseHubOrigin rules), canonical UUIDs for id and code, safe-integer exp.
 * Unknown or malformed input → undefined, never a throw. Exported so a
 * caller can tell an EXPIRED offer apart from junk (decodePairOffer refuses
 * both).
 */
const OFFER_KFP_RE = /^sha256:[0-9a-f]{64}$/;
export function readPairOffer(raw: string): PairOffer | undefined {
  const bytes = offerDecode(raw);
  if (!bytes || bytes.length > PAIR_OFFER_MAX_JSON_BYTES) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
  const o = json as Record<string, unknown>;
  if (o.v !== 2 && o.v !== 3) return undefined;
  const fieldCount = o.v === 3 ? 6 : 5;
  if (Object.keys(o).length !== fieldCount) return undefined; // unknown/missing fields refuse
  if (typeof o.hub !== "string") return undefined;
  const origin = parseHubOrigin(o.hub);
  if (!origin.ok || origin.origin !== o.hub) return undefined; // canonical form, byte-exact
  if (typeof o.id !== "string" || !OFFER_UUID_RE.test(o.id)) return undefined;
  if (typeof o.code !== "string" || !OFFER_CODE_RE.test(o.code)) return undefined;
  if (typeof o.exp !== "number" || !Number.isSafeInteger(o.exp)) return undefined;
  if (o.v === 3) {
    if (typeof o.kfp !== "string" || !OFFER_KFP_RE.test(o.kfp)) return undefined;
    return { v: 3, hub: o.hub, id: o.id, code: o.code, exp: o.exp, kfp: o.kfp };
  }
  return { v: 2, hub: o.hub, id: o.id, code: o.code, exp: o.exp };
}

/**
 * Strict decode: the structural rules above PLUS freshness — exp is in the
 * future (30 s clock skew allowed) and no further ahead than 10 minutes.
 * Unknown/malformed/stale → undefined, never a throw.
 */
export function decodePairOffer(raw: string, now: number = Date.now()): PairOffer | undefined {
  const offer = readPairOffer(raw);
  if (!offer) return undefined;
  if (offer.exp < now - PAIR_OFFER_SKEW_MS) return undefined;
  if (offer.exp > now + PAIR_OFFER_MAX_AHEAD_MS) return undefined;
  return offer;
}

export interface ParsedPairOfferUrl {
  offer: PairOffer;
  /** The URL minus its fragment (`<origin>/pair`) — safe to keep in history. */
  rest: string;
}

/**
 * The raw `#offer=` payload of a URL, when the fragment is exactly one
 * unpadded base64url run — undefined otherwise. The cheap first look a caller
 * uses to tell "this is an offer link" apart from a v1 pair URL.
 */
export function pairOfferFragment(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (!u.hash.startsWith("#offer=")) return undefined;
  const payload = u.hash.slice("#offer=".length);
  return /^[A-Za-z0-9_-]+$/.test(payload) ? payload : undefined;
}

/**
 * Parse an offer LINK: only `<origin>/pair` (or `/pair/`) with the fragment
 * `#offer=<payload>` and nothing else — a stray query or any other path →
 * undefined. The offer's hub must equal the link's own origin (the hub minted
 * this link); the fragment never travels server-side.
 */
export function parsePairOfferUrl(
  url: string,
  now: number = Date.now(),
): ParsedPairOfferUrl | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (!/^\/pair\/?$/.test(u.pathname)) return undefined;
  if (u.username || u.password || u.search) return undefined; // the payload rides the fragment only
  if (!u.hash.startsWith("#offer=")) return undefined;
  const offer = decodePairOffer(u.hash.slice("#offer=".length), now);
  if (!offer || offer.hub !== u.origin) return undefined;
  return { offer, rest: `${u.origin}/pair` };
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
 * Exact Ed25519 payload the HUB signs to prove its identity key (offer v3).
 * `subject` binds the proof to one ceremony ("pair:<enrollmentId>") or one
 * tunnel session ("tunnel:<deviceId>:<pairingEpoch>") so a captured proof
 * cannot be replayed elsewhere. Element order is normative.
 */
export function hubProofSigningPayload(parts: {
  hubOrigin: string;
  hubId: string;
  subject: string;
  nonce: string;
}): string {
  return JSON.stringify([
    "dpi-hub-proof-v1",
    parts.hubOrigin,
    parts.hubId,
    parts.subject,
    parts.nonce,
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
