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
 */
import { createHash, createPublicKey, randomBytes, randomUUID, verify as cryptoVerify } from "node:crypto";
import type { NetworkRegistry } from "../../../../dpi-sdk/src/node/registry.js";
import {
  PAIR_RAM_CAPS,
  PAIR_RATE_LIMITS,
  PAIR_SIGNATURE_FAIL_LIMIT,
  PAIR_POLL_MS,
} from "../../../../dpi-sdk/src/protocol/limits.js";
import {
  PairApproval as PairApprovalSchema,
  PairCodeState as PairCodeStateSchema,
  PairRequest as PairRequestSchema,
  PairResponse as PairResponseSchema,
  checkPairingDto,
  pairingSigningPayload,
} from "../../../../dpi-sdk/src/protocol/pairing.js";
import type { PairCodeIssue, TokenIssue } from "../../../../dpi-sdk/src/protocol/pairing.js";
import type { Audit } from "./audit.js";
import type { PairCodeState } from "../../../../dpi-sdk/src/protocol/pairing.js";

const CODE_TTL_MS = 300_000;
const NONCE_TTL_MS = 60_000;
const RECEIPT_GRACE_MS = 120_000;
const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export type PairingFailure = { ok: false; error: { code: string; message: string; status: number; retryAfterMs?: number } };

interface Enrollment {
  enrollmentId: string;
  codeId: string;
  requestId: string;
  code: string;
  deviceUid: string;
  deviceName: string;
  publicKeyPem: string;
  computedFingerprint: string;
  declaredFingerprint: string;
  nonce: string;
  nonceIssuedAt: number;
  nonceConsumed: boolean;
  proofVerified: boolean;
  verifiedAt?: number;
  badSignatures: number;
  cancelled: boolean;
  approval?: { fingerprint: string; replaceKey: boolean; at: number };
  issued?: { tokenIssue: TokenIssue; at: number };
}

interface CodeEntry {
  codeId: string;
  code: string;
  expiresAt: number;
  cancelled: boolean;
  enrollmentId?: string;
}

/** Small token bucket + fixed-window counters per key (rates are policy). */
class RateLimiter {
  private tokens = new Map<string, number>();
  private lastRefill = new Map<string, number>();
  private windows = new Map<string, number[]>();

  constructor(private readonly capacity: number, private readonly perMinute: number) {}

  take(key: string, now: number): boolean {
    const last = this.lastRefill.get(key) ?? now;
    const refill = ((now - last) / 60_000) * this.perMinute;
    const t = Math.min(this.capacity, (this.tokens.get(key) ?? this.capacity) + refill);
    if (t < 1) {
      this.tokens.set(key, t);
      this.lastRefill.set(key, now);
      return false;
    }
    this.tokens.set(key, t - 1);
    this.lastRefill.set(key, now);
    return true;
  }

  countWindow(key: string, now: number, windowMs: number): number {
    const list = (this.windows.get(key) ?? []).filter((ts) => now - ts < windowMs);
    this.windows.set(key, list);
    return list.length;
  }
  recordWindow(key: string, now: number) {
    const list = (this.windows.get(key) ?? []);
    list.push(now);
    this.windows.set(key, list);
  }
}

export interface PairingDeps {
  registry: NetworkRegistry;
  audit: Audit;
  hubOrigin: string;
  hubId: string;
  /** Issuance boundary (P2-10 CredentialService). Returns the committed TokenIssue. */
  issue?: (enrollment: {
    enrollmentId: string;
    codeId: string;
    deviceUid: string;
    deviceName: string;
    publicKeyPem: string;
    keyFingerprint: string;
    replaceKey: boolean;
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
  private createLimiter = new RateLimiter(PAIR_RATE_LIMITS.codeCreate.capacity, PAIR_RATE_LIMITS.codeCreate.perMinute);
  private startLimiter = new RateLimiter(PAIR_RATE_LIMITS.start.capacity, PAIR_RATE_LIMITS.start.perMinute);
  private verifyLimiter = new RateLimiter(PAIR_RATE_LIMITS.verifyTotal.capacity, PAIR_RATE_LIMITS.verifyTotal.perMinute);
  private readonly now: () => number;

  constructor(private readonly deps: PairingDeps) {
    this.now = deps.now ?? Date.now;
  }

  private fail(status: number, code: string, message: string, retryAfterMs?: number): PairingFailure {
    return { ok: false, error: { status, code, message, ...(retryAfterMs ? { retryAfterMs } : {}) } };
  }

  private ok<T>(value: T): { ok: true; value: T } {
    return { ok: true, value };
  }

  /** POST /api/pair/code (admin) — mint a fresh single-use code. */
  createCode(ip: string): { ok: true; value: PairCodeIssue } | PairingFailure {
    const now = this.now();
    if (!this.createLimiter.take(`ip:${ip}`, now))
      return this.fail(429, "rate_limited", "Too many codes; slow down", 60_000);
    if (this.codes.size >= PAIR_RAM_CAPS.codes)
      return this.fail(429, "rate_limited", "Pairing capacity reached; retry later", 60_000);
    let code = "";
    do {
      code = [...randomBytes(8)].map((b) => CODE_ALPHABET[b % 32]).join("");
    } while (this.byCode.has(code));
    const entry: CodeEntry = { codeId: randomUUID(), code, expiresAt: now + CODE_TTL_MS, cancelled: false };
    this.codes.set(entry.codeId, entry);
    this.byCode.set(code, entry.codeId);
    this.deps.audit.append({ actor: "admin", action: "pair.code_created", outcome: "ok", detail: { codeId: entry.codeId, expiresAt: entry.expiresAt } });
    return this.ok({
      type: "pair.code", v: 1, codeId: entry.codeId, code, expiresAt: entry.expiresAt,
      hubOrigin: this.deps.hubOrigin,
      pairUrl: `${this.deps.hubOrigin}/pair?code=${code}&v=1`,
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

  /** POST /api/pair/start — issue a challenge bound to one immutable tuple. */
  start(body: unknown, ip: string): { ok: true; value: PairChallengeOut } | PairingFailure {
    const now = this.now();
    if (!this.startLimiter.take(`ip:${ip}`, now))
      return this.fail(429, "rate_limited", "Too many pairing starts; slow down", 60_000);
    if (!checkPairingDto(PairRequestSchema, body))
      return this.fail(400, "invalid", "pair.request body failed schema validation");
    const req = body as { requestId: string; code: string; deviceUid: string; deviceName: string; publicKey: string; keyFingerprint: string; clientTime: number };
    const live = this.liveCode(req.code, now);
    if (live === "invalid") return this.fail(404, "code_invalid", "Unknown pairing code");
    if (live === "expired") return this.fail(410, "code_expired", "Pairing code expired");
    if (live === "cancelled") return this.fail(410, "enrollment_cancelled", "Pairing code cancelled");

    // Same requestId + same tuple → same live challenge (idempotent retry).
    if (live.enrollmentId) {
      const existing = this.enrollments.get(live.enrollmentId)!;
      const sameTuple =
        existing.requestId === req.requestId &&
        existing.deviceUid === req.deviceUid &&
        existing.deviceName === req.deviceName &&
        existing.declaredFingerprint === req.keyFingerprint &&
        existing.publicKeyPem === req.publicKey;
      if (!sameTuple) return this.fail(409, "code_in_use", "This code is reserved for another enrollment");
      if (existing.cancelled) return this.fail(410, "enrollment_cancelled", "Enrollment cancelled");
      if (now >= live.expiresAt) return this.fail(410, "code_expired", "Pairing code expired");
      return this.ok({
        type: "pair.challenge", v: 1, enrollmentId: existing.enrollmentId, nonce: existing.nonce,
        issuedAt: existing.nonceIssuedAt, hubId: this.deps.hubId,
      });
    }

    // Parse the key ourselves; never trust the declared fingerprint/name/UID.
    let fingerprint: string;
    try {
      const key = createPublicKey(req.publicKey);
      if (key.asymmetricKeyType !== "ed25519") return this.fail(400, "invalid", "publicKey must be Ed25519");
      const der = key.export({ format: "der", type: "spki" }) as Buffer;
      fingerprint = `sha256:${createHash("sha256").update(der).digest("hex")}`;
    } catch {
      return this.fail(400, "invalid", "publicKey is not a parseable SPKI PEM");
    }
    if (fingerprint !== req.keyFingerprint)
      return this.fail(409, "fingerprint_mismatch", "Declared fingerprint does not match the submitted public key");

    if (this.enrollments.size >= PAIR_RAM_CAPS.enrollments)
      return this.fail(429, "rate_limited", "Enrollment capacity reached; retry later", 60_000);

    const enrollment: Enrollment = {
      enrollmentId: randomUUID(),
      codeId: live.codeId,
      requestId: req.requestId,
      code: req.code,
      deviceUid: req.deviceUid,
      deviceName: req.deviceName,
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
      type: "pair.challenge", v: 1, enrollmentId: enrollment.enrollmentId, nonce: enrollment.nonce,
      issuedAt: enrollment.nonceIssuedAt, hubId: this.deps.hubId,
    });
  }

  /** POST /api/pair/verify — proof, poll, and (post-approval) issuance. */
  async verify(body: unknown, ip: string): Promise<{ ok: true; value: PairPendingOut | TokenIssue; status: number } | PairingFailure> {
    const now = this.now();
    if (!this.verifyLimiter.take(`ip:${ip}`, now))
      return this.fail(429, "rate_limited", "Too many verify requests; slow down", 60_000);
    if (!checkPairingDto(PairResponseSchema, body))
      return this.fail(400, "invalid", "pair.response body failed schema validation");
    const req = body as { enrollmentId: string; nonce: string; signature: string };
    const enrollment = this.enrollments.get(req.enrollmentId);
    if (!enrollment) return this.fail(410, "enrollment_lost", "Enrollment not found (hub restart or new code required)");
    if (enrollment.cancelled) return this.fail(410, "enrollment_cancelled", "Enrollment cancelled");
    const code = this.codes.get(enrollment.codeId)!;

    // Verified receipt: pre-approval poll → 202; post-approval → (cached) TokenIssue.
    if (enrollment.proofVerified) {
      if (enrollment.issued) {
        if (now > code.expiresAt + RECEIPT_GRACE_MS) return this.fail(410, "code_expired", "Receipt grace window passed");
        // Re-validate before returning the cached secret: revoked/re-paired
        // credentials must never be replayed just because the TTL is open.
        if (this.deps.receiptValidator) {
          const verdict = this.deps.receiptValidator(enrollment.issued.tokenIssue);
          if (verdict !== true) {
            enrollment.issued = undefined; // invalidate the cached secret
            return this.fail(410, verdict.code, "Issued credential is no longer active; re-pair required");
          }
        }
        return { ok: true, value: enrollment.issued.tokenIssue, status: 200 };
      }
      if (now >= code.expiresAt) return this.fail(410, "code_expired", "Pairing code expired before approval");
      if (!enrollment.approval)
        return { ok: true, value: { type: "pair.pending", v: 1, enrollmentId: enrollment.enrollmentId, state: "awaiting_approval", expiresAt: code.expiresAt, pollAfterMs: PAIR_POLL_MS }, status: 202 };
      // Approved + not yet issued: issuance happens once; retry returns the same response.
      if (!this.deps.issue) return this.fail(500, "invalid", "Issuance service unavailable");
      try {
        const tokenIssue = await this.deps.issue({
          enrollmentId: enrollment.enrollmentId,
          codeId: enrollment.codeId,
          deviceUid: enrollment.deviceUid,
          deviceName: enrollment.deviceName,
          publicKeyPem: enrollment.publicKeyPem,
          keyFingerprint: enrollment.computedFingerprint,
          replaceKey: enrollment.approval.replaceKey,
        });
        // pair.success is audited INSIDE the issuance transaction (P2-10).
        enrollment.issued = { tokenIssue, at: now };
        return { ok: true, value: tokenIssue, status: 200 };
      } catch (e) {
        return this.fail(500, "internal", `Issuance failed: ${(e as Error).message}`);
      }
    }

    // First proof: nonce must be live; consume atomically (sync section).
    if (enrollment.nonceConsumed) return this.fail(410, "challenge_expired", "Nonce already consumed");
    if (req.nonce !== enrollment.nonce) return this.fail(400, "invalid", "Nonce mismatch");
    if (now - enrollment.nonceIssuedAt > NONCE_TTL_MS) return this.fail(410, "challenge_expired", "Challenge expired; request a new code");
    if (now >= code.expiresAt) return this.fail(410, "code_expired", "Pairing code expired");

    const payload = pairingSigningPayload({
      hubOrigin: this.deps.hubOrigin,
      hubId: this.deps.hubId,
      enrollmentId: enrollment.enrollmentId,
      nonce: enrollment.nonce,
      issuedAt: enrollment.nonceIssuedAt,
      deviceUid: enrollment.deviceUid,
      keyFingerprint: enrollment.computedFingerprint,
    });
    let valid = false;
    try {
      valid = cryptoVerify(null, Buffer.from(payload, "utf8"), createPublicKey(enrollment.publicKeyPem), Buffer.from(req.signature, "base64url"));
    } catch {
      valid = false;
    }
    if (!valid) {
      enrollment.badSignatures += 1;
      this.deps.audit.denied("auth.denied", ip, { stage: "pair.verify", enrollmentId: enrollment.enrollmentId });
      if (enrollment.badSignatures >= PAIR_SIGNATURE_FAIL_LIMIT) {
        enrollment.cancelled = true;
        code.cancelled = true;
        return this.fail(410, "enrollment_cancelled", "Too many invalid signatures; enrollment cancelled");
      }
      return this.fail(401, "signature_invalid", "Signature verification failed");
    }
    // Consume + create receipt — no await between check and set.
    enrollment.nonceConsumed = true;
    enrollment.proofVerified = true;
    enrollment.verifiedAt = now;
    return { ok: true, value: { type: "pair.pending", v: 1, enrollmentId: enrollment.enrollmentId, state: "awaiting_approval", expiresAt: code.expiresAt, pollAfterMs: PAIR_POLL_MS }, status: 202 };
  }

  /** POST /api/pair/codes/:codeId/approve (admin) — the ONLY issuance gate. */
  approve(codeId: string, body: unknown): { ok: true; value: PairCodeState } | PairingFailure {
    if (!checkPairingDto(PairApprovalSchema, body))
      return this.fail(400, "invalid", "approval body failed schema validation");
    const approval = body as { enrollmentId: string; deviceUid: string; keyFingerprint: string; replaceKey?: boolean };
    const code = this.codes.get(codeId);
    const now = this.now();
    if (!code) return this.fail(404, "code_invalid", "Unknown code");
    const enrollment = code.enrollmentId ? this.enrollments.get(code.enrollmentId) : undefined;
    if (!enrollment) return this.fail(409, "invalid", "No enrollment to approve yet");
    if (enrollment.cancelled || code.cancelled) return this.fail(410, "enrollment_cancelled", "Enrollment cancelled");
    if (!enrollment.proofVerified) return this.fail(409, "invalid", "Proof not verified yet; nothing to approve");
    if (now >= code.expiresAt) return this.fail(410, "code_expired", "Pairing code expired");
    // Immutable tuple must match the enrollment exactly.
    if (
      approval.enrollmentId !== enrollment.enrollmentId ||
      approval.deviceUid !== enrollment.deviceUid ||
      approval.keyFingerprint !== enrollment.computedFingerprint
    )
      return this.fail(409, "fingerprint_mismatch", "Approval tuple does not match the verified enrollment");
    if (enrollment.approval) return this.fail(409, "invalid", "Already approved");

    // Re-pair with a DIFFERENT key than the stored one requires replaceKey=true (P-14).
    let keyChanged = false;
    const existing = this.findPairingByUid(enrollment.deviceUid);
    if (existing && existing.public_key !== enrollment.publicKeyPem) {
      keyChanged = true;
      if (!approval.replaceKey)
        return this.fail(409, "invalid", "Device is paired with a different key; re-confirm with replaceKey=true");
    }
    if (approval.replaceKey && !keyChanged)
      return this.fail(409, "invalid", "replaceKey set but the key has not changed");

    enrollment.approval = { fingerprint: enrollment.computedFingerprint, replaceKey: keyChanged, at: now };
    this.deps.audit.append({ actor: "admin", action: "pair.approved", outcome: "ok", detail: { codeId, enrollmentId: enrollment.enrollmentId, keyFingerprint: enrollment.computedFingerprint, replaceKey: keyChanged } });
    const s = this.status(codeId);
    return s.ok ? this.ok(s.value) : s;
  }

  /** POST /api/pair/codes/:codeId/cancel (admin). */
  cancel(codeId: string): { ok: true; value: PairCodeState } | PairingFailure {
    const code = this.codes.get(codeId);
    if (!code) return this.fail(404, "code_invalid", "Unknown code");
    const enrollment = code.enrollmentId ? this.enrollments.get(code.enrollmentId) : undefined;
    if (enrollment?.issued) return this.fail(409, "already_issued", "Credential already issued; revoke it instead");
    code.cancelled = true;
    if (enrollment) {
      enrollment.cancelled = true;
      enrollment.nonceConsumed = true;
    }
    this.deps.audit.append({ actor: "admin", action: "pair.cancelled", outcome: "ok", detail: { codeId } });
    const s = this.status(codeId);
    return s.ok ? this.ok(s.value) : s;
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
      type: "pair.code-state", v: 1, codeId, expiresAt: code.expiresAt, phase,
      ...(enrollment
        ? {
            enrollment: {
              enrollmentId: enrollment.enrollmentId,
              deviceUid: enrollment.deviceUid,
              deviceName: enrollment.deviceName,
              keyFingerprint: enrollment.computedFingerprint,
              proofVerified: enrollment.proofVerified,
              keyChanged: !!enrollment.approval?.replaceKey,
            },
          }
        : {}),
      ...(issued ? { deviceId: issued.tokenIssue.deviceId } : {}),
    };
    return checkPairingDto(PairCodeStateSchema, state) ? { ok: true, value: state } : this.fail(500, "internal", "status serialization failed");
  }

  private findPairingByUid(uid: string): { public_key: string } | undefined {
    const row = this.deps.registry.db
      .prepare(
        `SELECT p.public_key FROM pairings p JOIN devices d ON d.id = p.device_id WHERE d.device_uid=? AND p.status='paired' LIMIT 2`,
      )
      .all(uid) as { public_key: string }[];
    if (row.length !== 1) return undefined; // 0 → fresh pair; ≥2 → identity conflict is P2-10's preflight
    return row[0];
  }

  /** Drop expired entries (hub housekeeping). */
  sweep(): void {
    const now = this.now();
    for (const [codeId, code] of this.codes) {
      const issued = code.enrollmentId ? this.enrollments.get(code.enrollmentId)?.issued : undefined;
      if (now > code.expiresAt + RECEIPT_GRACE_MS && !issued) {
        this.byCode.delete(code.code);
        this.codes.delete(codeId);
        if (code.enrollmentId) this.enrollments.delete(code.enrollmentId);
      }
    }
  }
}

export type PairChallengeOut = { type: "pair.challenge"; v: 1; enrollmentId: string; nonce: string; issuedAt: number; hubId: string };
export type PairPendingOut = { type: "pair.pending"; v: 1; enrollmentId: string; state: "awaiting_approval"; expiresAt: number; pollAfterMs: number };
