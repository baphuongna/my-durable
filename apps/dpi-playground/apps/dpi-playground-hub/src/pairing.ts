/**
 * Hub pairing enrollment service (spec 03 §4/§6) — code issue, proof,
 * approval, cancel, status. ALL state is RAM with TTL/caps; the hub restart
 * loses it on purpose (enrollment_lost). Nothing here persists credentials:
 * issuance is injected (P2-10) so the state machine can be tested alone.
 *
 * Hard rules encoded here:
 * - A code + a valid self-declared proof NEVER suffice for issuance; the
 *   operator's fingerprint-matched approval is the only gate (P-8).
 * - The hub parses the SPKI itself and computes the fingerprint; declared
 *   name/UID/fingerprint are never trusted (P-14).
 * - Nonce consume, signature counting and phase transitions are synchronous
 *   (no await between check and set).
 * - TTL/rates/caps are hub policy (P2-03 limits); requests never override.
 * - An approval is bound to the registry identity the operator saw (GA-05): issuance re-checks it
 *   inside its transaction, so a revoke, re-pair or key replacement in between voids the approval.
 * - Per-source limiter state is bounded (10,000 sources, 15 min idle TTL) and a full table refuses
 *   new sources instead of forgetting counters that are being enforced (GA-06).
 */
import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify as cryptoVerify,
} from "node:crypto";
import type { NetworkRegistry } from "../../../../dpi-sdk/src/node/registry.js";
import {
  IP_BUCKET_IDLE_TTL_MS,
  IP_BUCKET_MAX_KEYS,
  PAIR_RAM_CAPS,
  PAIR_RATE_LIMITS,
  PAIR_SIGNATURE_FAIL_LIMIT,
  PAIR_POLL_MS,
} from "../../../../dpi-sdk/src/protocol/limits.js";
import { hubProofSigningPayload, PairDeviceRequest as PairDeviceRequestSchema } from "../../../../dpi-sdk/src/protocol/pairing.js";
import type { HubIdentity } from "./hub-identity.js";
import {
  PairApproval as PairApprovalSchema,
  PairCodeState as PairCodeStateSchema,
  PairRequest as PairRequestSchema,
  PairResponse as PairResponseSchema,
  checkPairingDto,
  encodePairOffer,
  isPairCode,
  normalizePairCode,
  pairingSigningPayload,
} from "../../../../dpi-sdk/src/protocol/pairing.js";
import type { PairCodeIssue, TokenIssue } from "../../../../dpi-sdk/src/protocol/pairing.js";
import type { Audit } from "./audit.js";
import { AuditUnavailableError } from "./audit.js";
import { revokeAbandonedCredential } from "./credentials.js";
import { ipKey } from "./client-ip.js";
import { observeIdentity } from "./identity.js";
import { SlidingWindows, TokenBuckets, type Take } from "./limiter.js";
import type { PairCodeState } from "../../../../dpi-sdk/src/protocol/pairing.js";

const CODE_TTL_MS = 300_000;
const NONCE_TTL_MS = 60_000;
const RECEIPT_GRACE_MS = 120_000;

/**
 * A code as a human types it (`abcd-2345-ef67`) is canonicalised before the strict wire
 * schema sees it: only the code field is rewritten, so unknown fields are still rejected.
 */
function withCanonicalCode(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const raw = (body as { code?: unknown }).code;
  if (typeof raw !== "string") return body;
  const code = normalizePairCode(raw);
  return code && code !== raw ? { ...(body as Record<string, unknown>), code } : body;
}

export type PairingFailure = {
  ok: false;
  error: { code: string; message: string; status: number; retryAfterMs?: number };
};

interface Enrollment {
  enrollmentId: string;
  codeId: string;
  requestId: string;
  code: string;
  deviceUid: string;
  deviceName: string;
  /** Machine description shown to the operator before approval (device-initiated flow). */
  hostname?: string;
  platform?: string;
  publicKeyPem: string;
  computedFingerprint: string;
  declaredFingerprint: string;
  nonce: string;
  nonceIssuedAt: number;
  nonceConsumed: boolean;
  proofVerified: boolean;
  verifiedAt?: number;
  /** Last ACCEPTED valid poll (S-3). The proof submission itself is not a poll; paced-out polls do not move it. */
  lastPollAt?: number;
  badSignatures: number;
  cancelled: boolean;
  /** Terminal: issued credential later invalidated (revoke/re-pair). NEVER re-issue this enrollment. */
  invalidated?: boolean;
  /** `identity` is the observeIdentity() stamp the operator approved against (GA-05). */
  approval?: { fingerprint: string; replaceKey: boolean; at: number; identity: string };
  issued?: { tokenIssue: TokenIssue; at: number };
  /** In-flight issuance (F03): concurrent polls share ONE promise and ONE credential. */
  issuing?: Promise<TokenIssue>;
  /** R9 1.3: first time the token was served on a 200 (optimistic — the route voids it if the socket died before the flush). */
  receiptDeliveredAt?: number;
  /** Monotonic 200-with-token counter: lets the route void a stale optimistic marker without erasing a newer delivery. */
  receiptSeq?: number;
}

interface CodeEntry {
  codeId: string;
  code: string;
  expiresAt: number;
  cancelled: boolean;
  enrollmentId?: string;
  /** Audit run-1: minted by the UNAUTHENTICATED device-initiated flow — counts
   * against the deviceMintedCodes sub-cap, not the operator's reserve. */
  deviceMinted?: true;
}

/** One live pairing request as the admin list renders it (no secrets). */
export interface PendingPairing {
  codeId: string;
  expiresAt: number;
  phase: "awaiting_device" | "awaiting_proof" | "approved_ready" | "cancelled";
  enrollmentId?: string;
  deviceUid?: string;
  deviceName?: string;
  hostname?: string;
  platform?: string;
  keyFingerprint?: string;
  proofVerified?: boolean;
  startedAt?: number;
}

export interface PairDeviceAck {
  type: "pair.device-ack";
  v: 1;
  codeId: string;
  code: string;
  expiresAt: number;
  hubOrigin: string;
  hubId: string;
  challenge: unknown;
}

export interface PairingDeps {
  registry: NetworkRegistry;
  audit: Audit;
  hubOrigin: string;
  hubId: string;
  /** Offer-v3 pinning: present on every real hub; absent only in legacy harnesses. */
  identity?: HubIdentity;
  /**
   * Issuance boundary (P2-10 CredentialService). Returns the committed TokenIssue. It must reject with
   * `code: "identity_changed"` when `expectedIdentity` no longer matches the registry (GA-05).
   */
  issue?: (enrollment: {
    enrollmentId: string;
    codeId: string;
    deviceUid: string;
    deviceName: string;
    publicKeyPem: string;
    keyFingerprint: string;
    replaceKey: boolean;
    expectedIdentity: string;
  }) => Promise<TokenIssue>;
  /** Cached-receipt validation (P2-10): replay only while the credential is live. */
  receiptValidator?: (tokenIssue: TokenIssue) => true | { code: string };
  /** Test-harness clock (P2-04 policy: constructor injection, never HTTP). */
  now?: () => number;
}

export class PairingService {
  private codes = new Map<string, CodeEntry>(); // by codeId
  private byCode = new Map<string, string>(); // code → codeId
  private enrollments = new Map<string, Enrollment>();
  private readonly now: () => number;
  private readonly createLimiter: TokenBuckets;
  private readonly startLimiter: TokenBuckets;
  private readonly verifyLimiter: TokenBuckets;
  /** Sliding-window failure counter, keyed by IP ONLY (changing code/UID must not reset it). */
  private readonly failWindows: SlidingWindows;

  constructor(private readonly deps: PairingDeps) {
    this.now = deps.now ?? Date.now;
    const perIp = (rate: { capacity: number; perMinute: number }) =>
      new TokenBuckets(
        { ...rate, maxKeys: IP_BUCKET_MAX_KEYS, idleTtlMs: IP_BUCKET_IDLE_TTL_MS },
        this.now,
      );
    this.createLimiter = perIp(PAIR_RATE_LIMITS.codeCreate);
    this.startLimiter = perIp(PAIR_RATE_LIMITS.start);
    this.verifyLimiter = perIp(PAIR_RATE_LIMITS.verifyTotal);
    this.failWindows = new SlidingWindows(
      {
        windowMs: PAIR_RATE_LIMITS.verifyFails.windowMinutes * 60_000,
        maxKeys: IP_BUCKET_MAX_KEYS,
      },
      this.now,
      // Audit run-1: only counters AT/ABOVE the enforcement threshold are
      // protected from eviction when the table is full; a sub-threshold entry
      // blocks nobody, so a fresh key is admitted instead of inheriting a 429
      // created by other keys' failures (a zero-failure source must never be
      // blocked by table pressure).
      PAIR_RATE_LIMITS.verifyFails.perWindow,
    );
  }

  /** Recorded on auth failures only; a valid poll never counts. */
  private noteFailure(ip: string): void {
    this.failWindows.record(ip);
  }

  /**
   * S-1: >= perWindow failures inside the window → fail closed for that IP. A source the full table
   * cannot track is refused as well: forgetting an enforced counter would hand its owner a reset.
   */
  private failureBlocked(ip: string): boolean {
    return (
      this.failWindows.saturatedFor(ip) ||
      this.failWindows.count(ip) >= PAIR_RATE_LIMITS.verifyFails.perWindow
    );
  }

  private fail(
    status: number,
    code: string,
    message: string,
    retryAfterMs?: number,
  ): PairingFailure {
    return {
      ok: false,
      error: { status, code, message, ...(retryAfterMs ? { retryAfterMs } : {}) },
    };
  }

  private rateLimited(taken: Extract<Take, { ok: false }>, tooMany: string): PairingFailure {
    return this.fail(
      429,
      "rate_limited",
      taken.reason === "full" ? "Pairing is busy; retry later" : tooMany,
      taken.retryAfterMs,
    );
  }

  private ok<T>(value: T): { ok: true; value: T } {
    return { ok: true, value };
  }

  /**
   * v3 offer link (v2 without an identity key), minted from the SAME values
   * the v1 pairUrl uses (same code, same expiry): the whole handoff — hub
   * origin, hubId, code, expiry, pinned hub-key fingerprint — rides the
   * #offer= fragment, which no server or CDN ever sees in a log.
   */
  private offerUrlFor(code: string, expiresAt: number): string {
    const identity = this.deps.identity;
    return `${this.deps.hubOrigin}/pair#offer=${encodePairOffer(
      identity
        ? {
            v: 3,
            hub: this.deps.hubOrigin,
            id: this.deps.hubId,
            code,
            exp: expiresAt,
            kfp: identity.fingerprint,
          }
        : { v: 2, hub: this.deps.hubOrigin, id: this.deps.hubId, code, exp: expiresAt },
    )}`;
  }

  /** Mint a single-use code entry (shared by the admin and device-initiated flows). */
  private mintEntry(actor: "admin" | "device"): CodeEntry {
    const now = this.now();
    let code = "";
    do {
      // A code is a bearer secret authorising one enrollment: canonical UUID v4 = 122 random bits.
      // The re-mint guard is kept: it costs nothing and makes "two live codes share a string" impossible.
      code = randomUUID();
    } while (this.byCode.has(code));
    const entry: CodeEntry = {
      codeId: randomUUID(),
      code,
      expiresAt: now + CODE_TTL_MS,
      cancelled: false,
      ...(actor === "device" ? { deviceMinted: true as const } : {}),
    };
    this.deps.audit.append({
      actor,
      action: "pair.code_created",
      outcome: "ok",
      detail: { codeId: entry.codeId, expiresAt: entry.expiresAt, ...(actor === "device" ? { initiated: "device" } : {}) },
    });
    this.codes.set(entry.codeId, entry);
    this.byCode.set(code, entry.codeId);
    return entry;
  }

  /** POST /api/pair/code (admin) — mint a fresh single-use code. */
  createCode(address: string): { ok: true; value: PairCodeIssue } | PairingFailure {
    const taken = this.createLimiter.take(ipKey(address));
    if (!taken.ok) return this.rateLimited(taken, "Too many codes; slow down");
    if (this.codes.size >= PAIR_RAM_CAPS.codes)
      return this.fail(429, "rate_limited", "Pairing capacity reached; retry later", 60_000);
    const entry = this.mintEntry("admin");
    const code = entry.code;
    return this.ok({
      type: "pair.code",
      v: 1,
      codeId: entry.codeId,
      code,
      expiresAt: entry.expiresAt,
      hubOrigin: this.deps.hubOrigin,
      pairUrl: `${this.deps.hubOrigin}/pair?code=${code}&v=1`,
      offerUrl: this.offerUrlFor(code, entry.expiresAt),
    });
  }

  /**
   * POST /api/pair/request (public, rate-limited) — DEVICE-INITIATED enrollment.
   *
   * The machine that wants to pair asks for a code instead of receiving one, so
   * the request carries its whole identity (name, hostname, platform, public
   * key) and the operator reads it in the approval list — the shape orca/paseo
   * offers have. Nothing gets weaker: the hub mints the same 122-bit single-use
   * code, parses the key itself, owns the challenge nonce, and the credential is
   * still issued only by a human approval carrying the hub-computed fingerprint.
   */
  requestForDevice(body: unknown, address: string): { ok: true; value: PairDeviceAck } | PairingFailure {
    const ip = ipKey(address);
    if (this.failureBlocked(ip))
      return this.fail(429, "rate_limited", "Too many pairing failures; slow down", 60_000);
    const taken = this.createLimiter.take(ip);
    if (!taken.ok) return this.rateLimited(taken, "Too many pairing requests; slow down");
    // Audit run-1: the UNAUTH mint draws from its own sub-cap — the operator's
    // reserve (codes − deviceMintedCodes slots) can never be exhausted by
    // anonymous visitors, so admin minting stays available under attack.
    if (this.deviceMintedCount() >= PAIR_RAM_CAPS.deviceMintedCodes)
      return this.fail(429, "rate_limited", "Too many device-initiated requests; retry later", 60_000);
    if (this.codes.size >= PAIR_RAM_CAPS.codes)
      return this.fail(429, "rate_limited", "Pairing capacity reached; retry later", 60_000);
    const request = body as { type?: unknown } | null;
    if (request?.type !== "pair.device-request" || !checkPairingDto(PairDeviceRequestSchema, request))
      return this.fail(400, "invalid", "pair.device-request body failed schema validation");

    const entry = this.mintEntry("device");
    const started = this.start({ ...(request as object), type: "pair.request", v: 1, code: entry.code }, address);
    if (!started.ok) {
      // The enrollment never existed: drop the code so a failed request leaves nothing behind.
      this.codes.delete(entry.codeId);
      this.byCode.delete(entry.code);
      return started;
    }
    return this.ok({
      type: "pair.device-ack",
      v: 1,
      codeId: entry.codeId,
      code: entry.code,
      expiresAt: entry.expiresAt,
      hubOrigin: this.deps.hubOrigin,
      hubId: this.deps.hubId,
      challenge: started.value,
    });
  }

  /**
   * GET /api/pair/codes (admin) — every live code with the machine identity the
   * operator needs to decide. Deliberately carries NO code, token or key
   * material: identity + hub-computed fingerprint + phase only.
   */
  listPending(): PendingPairing[] {
    const now = this.now();
    const out: PendingPairing[] = [];
    for (const entry of this.codes.values()) {
      if (entry.cancelled || now >= entry.expiresAt) continue;
      const enrollment = entry.enrollmentId ? this.enrollments.get(entry.enrollmentId) : undefined;
      const phase = !enrollment
        ? "awaiting_device"
        : enrollment.cancelled
          ? "cancelled"
          : enrollment.proofVerified
            ? "approved_ready"
            : "awaiting_proof";
      out.push({
        codeId: entry.codeId,
        expiresAt: entry.expiresAt,
        phase,
        ...(enrollment
          ? {
              enrollmentId: enrollment.enrollmentId,
              deviceUid: enrollment.deviceUid,
              deviceName: enrollment.deviceName,
              ...(enrollment.hostname ? { hostname: enrollment.hostname } : {}),
              ...(enrollment.platform ? { platform: enrollment.platform } : {}),
              keyFingerprint: enrollment.computedFingerprint,
              proofVerified: enrollment.proofVerified,
              startedAt: enrollment.nonceIssuedAt,
            }
          : {}),
      });
    }
    return out;
  }

  /** Admin handoff lookup. Reuses a code; never creates an enrollment or approves it. */
  resolveCode(body: unknown): { ok: true; value: PairCodeIssue } | PairingFailure {
    const raw = (body as { code?: unknown } | null)?.code;
    const code = typeof raw === "string" ? normalizePairCode(raw) : undefined;
    if (!body || typeof body !== "object" || Object.keys(body).length !== 1 || !isPairCode(code))
      return this.fail(400, "code_invalid", "Invalid pairing handoff");
    const codeId = this.byCode.get(code);
    const entry = codeId ? this.codes.get(codeId) : undefined;
    if (!entry) return this.fail(404, "code_invalid", "Unknown pairing code");
    const state = this.status(entry.codeId);
    if (!state.ok) return state;
    return this.ok({
      type: "pair.code",
      v: 1,
      codeId: entry.codeId,
      code: entry.code,
      expiresAt: entry.expiresAt,
      hubOrigin: this.deps.hubOrigin,
      pairUrl: `${this.deps.hubOrigin}/pair?code=${entry.code}&v=1`,
      offerUrl: this.offerUrlFor(entry.code, entry.expiresAt),
    });
  }

  private liveCode(code: string, now: number): CodeEntry | "invalid" | "expired" | "cancelled" {
    const codeId = this.byCode.get(code);
    if (!codeId) return "invalid";
    const entry = this.codes.get(codeId)!;
    if (entry.cancelled) return "cancelled";
    if (now >= entry.expiresAt && !entry.enrollmentId) return "expired";
    return entry;
  }

  /** Hub-identity proof for a device that pinned kfp (offer v3): sign the canonical payload over the enrollment. */
  private hubProof(hubNonce: string, enrollmentId: string) {
    const identity = this.deps.identity;
    if (!identity) return undefined;
    return {
      hubPublicKey: identity.publicKeyPem,
      hubKeyFingerprint: identity.fingerprint,
      hubSignature: identity.signPayload(
        hubProofSigningPayload({
          hubOrigin: this.deps.hubOrigin,
          hubId: this.deps.hubId,
          subject: `pair:${enrollmentId}`,
          nonce: hubNonce,
        }),
      ),
    };
  }

  /** POST /api/pair/start — issue a challenge bound to one immutable tuple. */
  start(body: unknown, address: string): { ok: true; value: PairChallengeOut } | PairingFailure {
    const now = this.now();
    const ip = ipKey(address);
    if (this.failureBlocked(ip))
      return this.fail(429, "rate_limited", "Too many pairing failures; slow down", 60_000);
    const taken = this.startLimiter.take(ip);
    if (!taken.ok) return this.rateLimited(taken, "Too many pairing starts; slow down");
    // A grouped or lower-case code from a client is the same code: canonicalise it first.
    const request = withCanonicalCode(body);
    if (!checkPairingDto(PairRequestSchema, request)) {
      this.noteFailure(ip);
      return this.fail(400, "invalid", "pair.request body failed schema validation");
    }
    const req = request as {
      requestId: string;
      code: string;
      deviceUid: string;
      deviceName: string;
      hostname?: string;
      platform?: string;
      publicKey: string;
      keyFingerprint: string;
      clientTime: number;
      hubNonce?: string;
    };
    const live = this.liveCode(req.code, now);
    if (live === "invalid") {
      this.noteFailure(ip); // code guessing
      return this.fail(404, "code_invalid", "Unknown pairing code");
    }
    if (live === "expired") {
      this.noteFailure(ip);
      return this.fail(410, "code_expired", "Pairing code expired");
    }
    if (live === "cancelled")
      return this.fail(410, "enrollment_cancelled", "Pairing code cancelled");

    // Same identity → the SAME live ceremony (R9 audit 1.2). The tuple is the
    // device's real identity — deviceUid + deviceName + declared fingerprint +
    // the public key itself; requestId is deliberately IGNORED on a match: the
    // device mints one per start(), so a retry after a lost hub response (the
    // enrollment committed but the challenge never arrived) would otherwise
    // 409-lock the code against its own owner for the rest of the TTL. A match
    // re-enters the existing enrollment — same challenge nonce, same state —
    // which is only usable by the holder of that key. A DIFFERENT identity
    // still gets 409 code_in_use (double-claim stays dead), and the enrollment
    // creation below is untouched (sync check-then-set).
    if (live.enrollmentId) {
      const existing = this.enrollments.get(live.enrollmentId)!;
      const sameIdentity =
        existing.deviceUid === req.deviceUid &&
        existing.deviceName === req.deviceName &&
        existing.declaredFingerprint === req.keyFingerprint &&
        existing.publicKeyPem === req.publicKey;
      if (!sameIdentity)
        return this.fail(409, "code_in_use", "This code is reserved for another enrollment");
      if (existing.cancelled) return this.fail(410, "enrollment_cancelled", "Enrollment cancelled");
      if (now >= live.expiresAt) return this.fail(410, "code_expired", "Pairing code expired");
      return this.ok({
        type: "pair.challenge",
        v: 1,
        enrollmentId: existing.enrollmentId,
        nonce: existing.nonce,
        issuedAt: existing.nonceIssuedAt,
        hubId: this.deps.hubId,
        ...(req.hubNonce ? this.hubProof(req.hubNonce, existing.enrollmentId) : {}),
      });
    }

    // Parse the key ourselves; never trust the declared fingerprint/name/UID.
    let fingerprint: string;
    try {
      const key = createPublicKey(req.publicKey);
      if (key.asymmetricKeyType !== "ed25519") {
        this.noteFailure(ip);
        return this.fail(400, "invalid", "publicKey must be Ed25519");
      }
      const der = key.export({ format: "der", type: "spki" }) as Buffer;
      fingerprint = `sha256:${createHash("sha256").update(der).digest("hex")}`;
    } catch {
      this.noteFailure(ip);
      return this.fail(400, "invalid", "publicKey is not a parseable SPKI PEM");
    }
    if (fingerprint !== req.keyFingerprint) {
      this.noteFailure(ip);
      return this.fail(
        409,
        "fingerprint_mismatch",
        "Declared fingerprint does not match the submitted public key",
      );
    }

    if (this.enrollments.size >= PAIR_RAM_CAPS.enrollments)
      return this.fail(429, "rate_limited", "Enrollment capacity reached; retry later", 60_000);

    const enrollment: Enrollment = {
      enrollmentId: randomUUID(),
      codeId: live.codeId,
      requestId: req.requestId,
      code: req.code,
      deviceUid: req.deviceUid,
      deviceName: req.deviceName,
      ...(req.hostname ? { hostname: req.hostname } : {}),
      ...(req.platform ? { platform: req.platform } : {}),
      publicKeyPem: req.publicKey,
      computedFingerprint: fingerprint,
      declaredFingerprint: req.keyFingerprint,
      nonce: randomBytes(32).toString("base64url"),
      nonceIssuedAt: now,
      nonceConsumed: false,
      proofVerified: false,
      badSignatures: 0,
      cancelled: false,
    };
    this.enrollments.set(enrollment.enrollmentId, enrollment);
    live.enrollmentId = enrollment.enrollmentId;
    return this.ok({
      type: "pair.challenge",
      v: 1,
      enrollmentId: enrollment.enrollmentId,
      nonce: enrollment.nonce,
      issuedAt: enrollment.nonceIssuedAt,
      hubId: this.deps.hubId,
      ...(req.hubNonce ? this.hubProof(req.hubNonce, enrollment.enrollmentId) : {}),
    });
  }

  /** POST /api/pair/verify — proof, poll, and (post-approval) issuance.
   *  `requestOrigin` is the origin the device DIALED (`${protocol}://${host}` of
   *  the HTTP request), best-effort from the route. The wire proof carries no
   *  declared origin (the signing payload binds one, but it is never sent), so
   *  this is the only signal that separates "wrong key" from "the hub signs as
   *  a different origin than the device dialed" — see the mismatch branch in
   *  the first-proof path (R6 cli finding 5). */
  async verify(
    body: unknown,
    address: string,
    requestOrigin?: string,
  ): Promise<
    { ok: true; value: PairPendingOut | TokenIssue; status: number; receiptSeq?: number } | PairingFailure
  > {
    const now = this.now();
    const ip = ipKey(address);
    if (this.failureBlocked(ip))
      return this.fail(429, "rate_limited", "Too many pairing failures; slow down", 60_000);
    const taken = this.verifyLimiter.take(ip);
    if (!taken.ok) return this.rateLimited(taken, "Too many verify requests; slow down");
    if (!checkPairingDto(PairResponseSchema, body)) {
      this.noteFailure(ip);
      return this.fail(400, "invalid", "pair.response body failed schema validation");
    }
    const req = body as { enrollmentId: string; nonce: string; signature: string };
    const enrollment = this.enrollments.get(req.enrollmentId);
    if (!enrollment) {
      this.noteFailure(ip);
      return this.fail(
        410,
        "enrollment_lost",
        "Enrollment not found (hub restart or new code required)",
      );
    }
    if (enrollment.cancelled) return this.fail(410, "enrollment_cancelled", "Enrollment cancelled");
    const code = this.codes.get(enrollment.codeId)!;

    // Verified receipt: pre-approval poll → 202; post-approval → (cached) TokenIssue.
    if (enrollment.proofVerified) {
      // F02: EVERY poll re-presents the original proof. The enrollmentId is
      // never a bearer credential — the caller must hold the device private
      // key (spec 03 §4.3: poll bằng cùng body, retry đúng proof).
      if (req.nonce !== enrollment.nonce || !this.signatureOk(enrollment, req.signature)) {
        this.noteFailure(ip);
        this.deps.audit.denied("auth.denied", ip, {
          stage: "pair.verify",
          enrollmentId: enrollment.enrollmentId,
          reason: "receipt_proof_mismatch",
        });
        return this.fail(401, "signature_invalid", "Proof does not match the verified enrollment");
      }
      // F01: invalidation is TERMINAL. A revoked/re-paired credential never
      // leads to a re-issue of this enrollment; a NEW enrollment with a NEW
      // operator approval is required.
      if (enrollment.invalidated)
        return this.fail(
          410,
          "reauth_required",
          "Issued credential is no longer active; re-pair required",
        );
      // S-3: a valid poll is accepted at most once per PAIR_POLL_MS per enrollment. Judged only now that
      // the proof checked out, so a caller without the device key can never burn the device's slot, and a
      // paced-out poll is not an auth failure. A clock that stepped back never locks the device out.
      if (enrollment.lastPollAt !== undefined) {
        const elapsed = now - enrollment.lastPollAt;
        if (elapsed >= 0 && elapsed < PAIR_POLL_MS)
          return this.fail(
            429,
            "rate_limited",
            "Polling too fast; wait before the next poll",
            PAIR_POLL_MS - elapsed,
          );
      }
      enrollment.lastPollAt = now;
      if (enrollment.issued) {
        if (now > code.expiresAt + RECEIPT_GRACE_MS)
          return this.fail(410, "code_expired", "Receipt grace window passed");
        // Re-validate before returning the cached secret: revoked/re-paired
        // credentials must never be replayed just because the TTL is open.
        if (this.deps.receiptValidator) {
          const verdict = this.deps.receiptValidator(enrollment.issued.tokenIssue);
          if (verdict !== true) {
            enrollment.issued = undefined; // drop the cached secret
            enrollment.invalidated = true; // …and end this enrollment (F01)
            return this.fail(
              410,
              verdict.code,
              "Issued credential is no longer active; re-pair required",
            );
          }
        }
        return this.markReceiptServed(enrollment, {
          ok: true,
          value: enrollment.issued.tokenIssue,
          status: 200,
        });
      }
      if (now >= code.expiresAt)
        return this.fail(410, "code_expired", "Pairing code expired before approval");
      if (!enrollment.approval)
        return {
          ok: true,
          value: {
            type: "pair.pending",
            v: 1,
            enrollmentId: enrollment.enrollmentId,
            state: "awaiting_approval",
            expiresAt: code.expiresAt,
            pollAfterMs: PAIR_POLL_MS,
          },
          status: 202,
        };
      // Approved + not yet issued. F03: issuance is serialized per enrollment
      // — concurrent polls share ONE in-flight promise and get the SAME
      // credential (no await between the check and the assignment).
      if (!this.deps.issue) return this.fail(500, "invalid", "Issuance service unavailable");
      const approval = enrollment.approval;
      const inflight =
        enrollment.issuing ??
        this.deps
          .issue({
            enrollmentId: enrollment.enrollmentId,
            codeId: enrollment.codeId,
            deviceUid: enrollment.deviceUid,
            deviceName: enrollment.deviceName,
            publicKeyPem: enrollment.publicKeyPem,
            keyFingerprint: enrollment.computedFingerprint,
            replaceKey: approval.replaceKey,
            expectedIdentity: approval.identity,
          })
          .then((tokenIssue) => {
            // pair.success is audited INSIDE the issuance transaction (P2-10).
            enrollment.issued = { tokenIssue, at: this.now() };
            return tokenIssue;
          });
      enrollment.issuing = inflight;
      try {
        const tokenIssue = await inflight;
        return this.markReceiptServed(enrollment, { ok: true, value: tokenIssue, status: 200 });
      } catch (e) {
        const code = (e as { code?: unknown }).code;
        if (code === "identity_changed" || code === "key_replacement_required") {
          // GA-05: the registry moved since the operator approved (revoke, re-pair, key replacement,
          // another enrollment). Nothing was issued; the approval is void and a new one, taken against
          // the current state, is required.
          if (enrollment.approval === approval) enrollment.approval = undefined;
          return this.fail(
            409,
            "identity_changed",
            "Device identity changed since approval; approve again",
          );
        }
        if (e instanceof AuditUnavailableError)
          return this.fail(
            503,
            "audit_unavailable",
            "Audit storage is unavailable; the credential was not issued",
          );
        // Any other issuance fault is ours, not the caller's: fixed text, detail stays in the log.
        return this.fail(500, "internal", "Issuance failed");
      } finally {
        if (enrollment.issuing === inflight) enrollment.issuing = undefined;
      }
    }

    // First proof: nonce must be live; consume atomically (sync section).
    if (enrollment.nonceConsumed) {
      this.noteFailure(ip);
      return this.fail(410, "challenge_expired", "Nonce already consumed");
    }
    if (req.nonce !== enrollment.nonce) {
      this.noteFailure(ip);
      return this.fail(400, "invalid", "Nonce mismatch");
    }
    if (now - enrollment.nonceIssuedAt > NONCE_TTL_MS) {
      this.noteFailure(ip);
      return this.fail(410, "challenge_expired", "Challenge expired; request a new code");
    }
    if (now >= code.expiresAt) return this.fail(410, "code_expired", "Pairing code expired");

    let valid = false;
    try {
      valid = this.verifySignature(enrollment, req.signature, this.deps.hubOrigin);
    } catch {
      valid = false;
    }
    if (!valid) {
      // R6 cli finding 5: a hub started WITHOUT DPI_HUB_ORIGIN signs as
      // https://<hostname> while a LAN device signs the origin it dialed —
      // every proof then "fails" and reads like an attack. When the same
      // signature verifies under the request's origin, this is a misconfigured
      // origin, not a bad key: say so and do NOT count it toward the cancel limit.
      if (
        requestOrigin &&
        requestOrigin !== this.deps.hubOrigin &&
        this.verifySignature(enrollment, req.signature, requestOrigin)
      ) {
        this.deps.audit.denied("auth.denied", ip, {
          stage: "pair.verify",
          enrollmentId: enrollment.enrollmentId,
          originMismatch: `device=${requestOrigin} hub=${this.deps.hubOrigin}`,
        });
        return this.fail(
          409,
          "origin_mismatch",
          `origin mismatch: device signed for ${requestOrigin}, hub signs as ${this.deps.hubOrigin} — set DPI_HUB_ORIGIN on the hub`,
        );
      }
      enrollment.badSignatures += 1;
      this.noteFailure(ip); // sliding-window IP counter (S-1): code/UID change does not reset
      this.deps.audit.denied("auth.denied", ip, {
        stage: "pair.verify",
        enrollmentId: enrollment.enrollmentId,
      });
      if (enrollment.badSignatures >= PAIR_SIGNATURE_FAIL_LIMIT) {
        enrollment.cancelled = true;
        code.cancelled = true;
        return this.fail(
          410,
          "enrollment_cancelled",
          "Too many invalid signatures; enrollment cancelled",
        );
      }
      return this.fail(401, "signature_invalid", "Signature verification failed");
    }
    // Consume + create receipt — no await between check and set.
    enrollment.nonceConsumed = true;
    enrollment.proofVerified = true;
    enrollment.verifiedAt = now;
    return {
      ok: true,
      value: {
        type: "pair.pending",
        v: 1,
        enrollmentId: enrollment.enrollmentId,
        state: "awaiting_approval",
        expiresAt: code.expiresAt,
        pollAfterMs: PAIR_POLL_MS,
      },
      status: 202,
    };
  }

  /** Proof check shared by first-verify and every receipt poll (F02). */
  private signatureOk(enrollment: Enrollment, signature: string): boolean {
    return this.verifySignature(enrollment, signature, this.deps.hubOrigin);
  }

  /**
   * R9 (audit 1.3): stamp the optimistic "delivered" marker on every 200 that
   * carries the token, with a monotonic sequence so the route can void exactly
   * the serve it is reporting (see markReceiptLost). Fail-safe default: without
   * any route feedback the marker stays set — forgetting the hook can never
   * mass-retire receipts; only an observed dead socket can.
   */
  private markReceiptServed(
    enrollment: Enrollment,
    outcome: { ok: true; value: TokenIssue; status: number },
  ): { ok: true; value: TokenIssue; status: number; receiptSeq: number } {
    enrollment.receiptSeq = (enrollment.receiptSeq ?? 0) + 1;
    enrollment.receiptDeliveredAt = this.now();
    return { ...outcome, receiptSeq: enrollment.receiptSeq };
  }

  /**
   * R9 (audit 1.3): the verify route reports the token response never flushed —
   * the client vanished mid-poll (local cancel, crash), so the plaintext died
   * with the socket. Void the optimistic marker for THAT serve only: a newer
   * 200 since then is a real delivery and must survive. If the receipt grace
   * then lapses still undelivered, sweep() revokes the orphan credential.
   */
  markReceiptLost(enrollmentId: string, servedSeq: number): void {
    const enrollment = this.enrollments.get(enrollmentId);
    if (!enrollment || enrollment.receiptSeq !== servedSeq) return;
    enrollment.receiptDeliveredAt = undefined;
  }

  /** Ed25519 proof check for a given hub origin — the signing payload binds it,
   *  so the SAME signature can be retried under the request's origin (F02 + R6
   *  cli finding 5: origin-mismatch detection without a protocol change). */
  private verifySignature(enrollment: Enrollment, signature: string, hubOrigin: string): boolean {
    const payload = pairingSigningPayload({
      hubOrigin,
      hubId: this.deps.hubId,
      enrollmentId: enrollment.enrollmentId,
      nonce: enrollment.nonce,
      issuedAt: enrollment.nonceIssuedAt,
      deviceUid: enrollment.deviceUid,
      keyFingerprint: enrollment.computedFingerprint,
    });
    try {
      return cryptoVerify(
        null,
        Buffer.from(payload, "utf8"),
        createPublicKey(enrollment.publicKeyPem),
        Buffer.from(signature, "base64url"),
      );
    } catch {
      return false;
    }
  }

  /** POST /api/pair/codes/:codeId/approve (admin) — the ONLY issuance gate. */
  approve(codeId: string, body: unknown): { ok: true; value: PairCodeState } | PairingFailure {
    if (!checkPairingDto(PairApprovalSchema, body))
      return this.fail(400, "invalid", "approval body failed schema validation");
    const approval = body as {
      enrollmentId: string;
      deviceUid: string;
      keyFingerprint: string;
      replaceKey?: boolean;
    };
    const code = this.codes.get(codeId);
    const now = this.now();
    if (!code) return this.fail(404, "code_invalid", "Unknown code");
    const enrollment = code.enrollmentId ? this.enrollments.get(code.enrollmentId) : undefined;
    if (!enrollment) return this.fail(409, "invalid", "No enrollment to approve yet");
    if (enrollment.cancelled || code.cancelled)
      return this.fail(410, "enrollment_cancelled", "Enrollment cancelled");
    if (!enrollment.proofVerified)
      return this.fail(409, "invalid", "Proof not verified yet; nothing to approve");
    if (now >= code.expiresAt) return this.fail(410, "code_expired", "Pairing code expired");
    // Immutable tuple must match the enrollment exactly.
    if (
      approval.enrollmentId !== enrollment.enrollmentId ||
      approval.deviceUid !== enrollment.deviceUid ||
      approval.keyFingerprint !== enrollment.computedFingerprint
    )
      return this.fail(
        409,
        "fingerprint_mismatch",
        "Approval tuple does not match the verified enrollment",
      );
    if (enrollment.approval) return this.fail(409, "invalid", "Already approved");

    // A DIFFERENT key than the one on record — in ANY pairing state, a revoked pairing keeps its key —
    // requires replaceKey=true (P-14).
    const identity = observeIdentity(this.deps.registry, enrollment.deviceUid);
    const keyChanged =
      identity.storedFingerprint !== undefined &&
      identity.storedFingerprint !== enrollment.computedFingerprint;
    if (keyChanged && !approval.replaceKey)
      return this.fail(
        409,
        "invalid",
        "Device has a different key on record; re-confirm with replaceKey=true",
      );
    if (approval.replaceKey && !keyChanged)
      return this.fail(409, "invalid", "replaceKey set but the key has not changed");

    // F04: the audit row commits FIRST. A failed append throws here with the
    // enrollment still un-approved — fail-closed means a storage outage can
    // never leave a silently-live approval behind.
    this.deps.audit.append({
      actor: "admin",
      action: "pair.approved",
      outcome: "ok",
      detail: {
        codeId,
        enrollmentId: enrollment.enrollmentId,
        keyFingerprint: enrollment.computedFingerprint,
        replaceKey: keyChanged,
        ...(keyChanged ? { replacedKeyFingerprint: identity.storedFingerprint } : {}),
      },
    });
    enrollment.approval = {
      fingerprint: enrollment.computedFingerprint,
      replaceKey: keyChanged,
      at: now,
      identity: identity.stamp,
    };
    const s = this.status(codeId);
    return s.ok ? this.ok(s.value) : s;
  }

  /** POST /api/pair/codes/:codeId/cancel (admin). */
  cancel(codeId: string): { ok: true; value: PairCodeState } | PairingFailure {
    const code = this.codes.get(codeId);
    if (!code) return this.fail(404, "code_invalid", "Unknown code");
    const enrollment = code.enrollmentId ? this.enrollments.get(code.enrollmentId) : undefined;
    // R14 cold review: an IN-FLIGHT issuance is already committing a credential
    // (registry row + tunnel token) — cancelling mid-flight would delete the
    // bookkeeping while the device still receives a live pair.token, stranding
    // a ghost credential no sweep can ever see. Treat in-flight as issued:
    // the operator revokes the resulting credential instead.
    if (enrollment?.issued || enrollment?.issuing)
      return this.fail(409, "already_issued", "Credential already issued; revoke it instead");
    // Audit row first (as for approve): a cancel that cannot be audited does not take effect.
    this.deps.audit.append({
      actor: "admin",
      action: "pair.cancelled",
      outcome: "ok",
      detail: { codeId },
    });
    code.cancelled = true;
    if (enrollment) {
      enrollment.cancelled = true;
      enrollment.nonceConsumed = true;
      enrollment.invalidated = true;
    }
    const s = this.status(codeId);
    if (!s.ok) return s;
    // Audit run-1 (capacity reclaim): an UNISSUED code holds a RAM slot for
    // nothing — cancel now frees it immediately instead of waiting out
    // TTL+grace+sweep, so the operator's own remediation actually restores
    // minting capacity (nothing was issued; no receipt can exist).
    this.byCode.delete(code.code);
    this.codes.delete(codeId);
    if (enrollment) this.enrollments.delete(code.enrollmentId!);
    return s;
  }

  /** GET /api/pair/codes/:codeId (admin) — phase metadata, never a token. */
  status(codeId: string): { ok: true; value: PairCodeState } | PairingFailure {
    const now = this.now();
    const code = this.codes.get(codeId);
    if (!code) return this.fail(404, "code_invalid", "Unknown code");
    const enrollment = code.enrollmentId ? this.enrollments.get(code.enrollmentId) : undefined;
    const issued = enrollment?.issued;
    const readableUntil = code.expiresAt + RECEIPT_GRACE_MS;
    if (!issued && !code.cancelled && now >= code.expiresAt && now <= readableUntil) {
      // Un-issued expired code: still reportable inside grace for the wizard.
    }
    const phase: PairCodeState["phase"] = issued
      ? "issued"
      : code.cancelled || enrollment?.cancelled
        ? "cancelled"
        : now >= code.expiresAt && !enrollment?.proofVerified
          ? "expired"
          : now >= code.expiresAt
            ? "expired"
            : enrollment?.approval
              ? "approved"
              : enrollment?.proofVerified
                ? "awaiting_approval"
                : enrollment
                  ? "awaiting_proof"
                  : "open";
    const state: PairCodeState = {
      type: "pair.code-state",
      v: 1,
      codeId,
      expiresAt: code.expiresAt,
      phase,
      ...(enrollment
        ? {
            enrollment: {
              enrollmentId: enrollment.enrollmentId,
              deviceUid: enrollment.deviceUid,
              deviceName: enrollment.deviceName,
              keyFingerprint: enrollment.computedFingerprint,
              proofVerified: enrollment.proofVerified,
              // F14: key change is computed from the CURRENT enrollment key
              // vs the key on record (any pairing state) — available BEFORE
              // approval, so the wizard can offer the replace-key confirmation in time.
              keyChanged: (() => {
                const stored = observeIdentity(
                  this.deps.registry,
                  enrollment.deviceUid,
                ).storedFingerprint;
                return stored !== undefined && stored !== enrollment.computedFingerprint;
              })(),
            },
          }
        : {}),
      ...(issued ? { deviceId: issued.tokenIssue.deviceId } : {}),
    };
    return checkPairingDto(PairCodeStateSchema, state)
      ? { ok: true, value: state }
      : this.fail(500, "internal", "status serialization failed");
  }

  /** Audit run-1: live device-minted codes (derived from the map — it cannot
   * drift from mint/delete/sweep/cancel paths). */
  private deviceMintedCount(): number {
    let n = 0;
    for (const entry of this.codes.values()) if (entry.deviceMinted) n += 1;
    return n;
  }

  /** Drop expired entries (hub housekeeping). F15: past expiry+grace the
   * entry goes REGARDLESS of issued — receipts hold a plaintext token and
   * grace is exactly how long the device may re-read it. Also forgets idle
   * per-source limiter state (GA-06). */
  sweep(): void {
    const now = this.now();
    this.createLimiter.sweep();
    this.startLimiter.sweep();
    this.verifyLimiter.sweep();
    this.failWindows.sweep();
    for (const [codeId, code] of this.codes) {
      if (now > code.expiresAt + RECEIPT_GRACE_MS) {
        this.retireUndeliveredReceipt(code);
        this.byCode.delete(code.code);
        this.codes.delete(codeId);
        if (code.enrollmentId) this.enrollments.delete(code.enrollmentId);
      }
    }
  }

  /**
   * R9 (audit 1.3): the receipt grace lapsed with the token never delivered —
   * its plaintext only ever existed in this RAM cache, so the committed
   * credential is permanently unusable (device cancelled locally / crashed
   * mid-poll, operator approved anyway). Retire it through the normal revoke
   * state machine instead of stranding a `paired` ghost forever. A DELIVERED
   * receipt is never touched; re-pairing remains the device's recovery path.
   */
  private retireUndeliveredReceipt(code: CodeEntry): void {
    const enrollment = code.enrollmentId ? this.enrollments.get(code.enrollmentId) : undefined;
    const issue = enrollment?.issued;
    if (!enrollment || !issue || enrollment.receiptDeliveredAt !== undefined) return;
    // R9 6.2 (false-positive guard): markReceiptLost can fire when `close` races
    // `finish` AFTER a fully-flushed response — revoking then would kill a WORKING
    // pairing. If the device ever CONNECTED with this credential (a tunnel.connect
    // audit row naming it), the receipt self-evidently reached it: never revoke.
    try {
      const inUse = this.deps.registry.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE action='tunnel.connect' AND detail_json LIKE ?")
        .get(`%${issue.tokenIssue.credentialId}%`) as { n: number };
      if (inUse.n > 0) {
        enrollment.receiptDeliveredAt = this.now(); // correct the marker, not just skip
        return;
      }
    } catch {
      // Audit table unreadable: fall through and revoke (pre-R9 behavior) — a
      // stray ghost is a lesser evil than never cleaning abandoned credentials.
    }
    try {
      const retired = revokeAbandonedCredential(this.deps.registry, this.deps.audit, issue.tokenIssue);
      if (retired)
        console.warn(
          `[pairing] receipt for enrollment ${enrollment.enrollmentId} was never delivered; abandoned credential ${issue.tokenIssue.credentialId} revoked (pair.abandoned)`,
        );
    } catch (error) {
      // F15 still wins: the RAM entry must go at expiry+grace even if the
      // revoke could not commit (e.g. audit outage). The credential then lives
      // on as before this fix — an operator revoke cleans it up.
      console.warn(
        `[pairing] could not revoke the undelivered credential for enrollment ${enrollment.enrollmentId}`,
        error,
      );
    }
  }
}

export type PairChallengeOut = {
  type: "pair.challenge";
  v: 1;
  enrollmentId: string;
  nonce: string;
  issuedAt: number;
  hubId: string;
};
export type PairPendingOut = {
  type: "pair.pending";
  v: 1;
  enrollmentId: string;
  state: "awaiting_approval";
  expiresAt: number;
  pollAfterMs: number;
};
