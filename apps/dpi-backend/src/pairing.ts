/**
 * Device-side pairing service (spec 03 §4.1/§7, plan P2-11).
 *
 * The backend is the SINGLE writer of device-keypair.json / pairing.json; the
 * TUI only drives this service over the authenticated local API. Every file
 * mutation is serialized through one active operation ID — late async
 * responses re-check it before committing so a stale turn can never
 * overwrite a newer pairing.
 *
 * Origin resolution order (03 §4.1): pair URL → --hub → DPI_HUB_URL → saved
 * origin. Multiple EXPLICIT differing origins → error before any network.
 * HTTPS-only canonical origin (protocol/pairing.ts); redirects refused.
 */
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign as edSign } from "node:crypto";
import type { Store } from "./store.js";
import {
  ensureFileMode0600,
  ensurePrivateDir,
  keypairPath,
  loadJson,
  pairingPath,
  readKeypairFile,
  removeStaleTemps,
  writeAtomic,
  type DeviceKeypair,
  type PairingFile,
} from "./pairing-files.js";
import { PAIR_HTTP_MAX_RETRIES, PAIR_HTTP_TIMEOUT_MS, PAIR_POLL_MS } from "../../dpi-sdk/src/protocol/limits.js";
import { pairingSigningPayload, parseHubOrigin } from "../../dpi-sdk/src/protocol/pairing.js";
import type { TokenIssue } from "../../dpi-sdk/src/protocol/pairing.js";

const CLOCK_SKEW_MS = 60_000;

export interface PairingStartInput {
  code: string;
  hub?: string;
  pairUrl?: string;
  force?: boolean;
}

export type PairingStatus = {
  state: "unpaired" | "pairing" | "paired" | "revoked";
  deviceUid: string;
  deviceName: string;
  fingerprint: string; // from the LOCAL key — never echoed from the hub
  hubOrigin?: string;
  deviceId?: string;
  pairingEpoch?: string;
  generation?: number;
  pending?: { hubOrigin: string; startedAt: number; note?: string };
  lastError?: string;
};

interface PendingOp {
  operationId: string;
  hubOrigin: string;
  code: string;
  requestId: string;
  deviceUid: string;
  deviceName: string;
  keyFingerprint: string;
  proof: { type: "pair.response"; v: 1; enrollmentId: string; nonce: string; signature: string };
  hubId: string;
  expiresAt: number;
  startedAt: number;
  abort: AbortController;
}

const err = (code: string, message: string) => Object.assign(new Error(message), { code, status: 400 });

const isLoopbackHost = (hostname: string) => hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
const nonEmpty = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** Why a hub-issued credential must not be saved, or undefined when it may be. The token leaves this device for hubUrl, so that is judged hardest. */
function refuseIssue(issue: TokenIssue, expect: { origin: string; hubId: string; enrollmentId: string; deviceUid: string; now: number }): string | undefined {
  const raw = issue as unknown as Record<string, unknown>;
  if (raw.enrollmentId !== expect.enrollmentId) return "enrollmentId differs from the enrollment this device started";
  if (raw.deviceUid !== expect.deviceUid) return "deviceUid is not this device's";
  if (raw.hubId !== expect.hubId) return "hubId differs from the hubId the challenge announced";
  if (raw.hubOrigin !== expect.origin) return `hubOrigin differs from the origin paired against (${expect.origin})`;
  const urlProblem = refuseTunnelUrl(raw.hubUrl, expect.origin);
  if (urlProblem) return urlProblem;
  if (typeof raw.issuedAt !== "number" || !Number.isFinite(raw.issuedAt)) return "issuedAt is not a finite number";
  if (Math.abs(expect.now - raw.issuedAt) > CLOCK_SKEW_MS) return `issuedAt is more than ${CLOCK_SKEW_MS / 1000}s from this device's clock`;
  if (!nonEmpty(raw.deviceId, 64)) return "deviceId is empty or not a string";
  if (!nonEmpty(raw.pairingEpoch, 128)) return "pairingEpoch is empty or not a string";
  if (!nonEmpty(raw.credentialId, 128)) return "credentialId is empty or not a string";
  if (typeof raw.generation !== "number" || !Number.isInteger(raw.generation) || raw.generation < 1) return "generation is not a positive integer";
  if (typeof raw.tunnelToken !== "string" || !/^dpt_[A-Za-z0-9_-]{43}$/.test(raw.tunnelToken)) return "tunnelToken is malformed";
  return undefined;
}

/** The tunnel is the paired origin's own /api/tunnel, over TLS (https is what the hub issues; ws clients upgrade it to wss). Plaintext only to this machine. */
function refuseTunnelUrl(raw: unknown, origin: string): string | undefined {
  if (typeof raw !== "string") return "hubUrl is not a string";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "hubUrl is not a valid URL";
  }
  const tls = url.protocol === "wss:" || url.protocol === "https:";
  const plain = url.protocol === "ws:" || url.protocol === "http:";
  if (!tls && !(plain && isLoopbackHost(url.hostname))) return `hubUrl scheme ${url.protocol} is not allowed (wss or https; ws or http only on a loopback host)`;
  if (url.username || url.password) return "hubUrl must not carry credentials";
  if (url.host !== new URL(origin).host) return `hubUrl host differs from the origin paired against (${origin})`;
  if (url.pathname !== "/api/tunnel" || url.search || url.hash) return "hubUrl must be exactly the origin's /api/tunnel";
  return undefined;
}

export class DevicePairing {
  private pending: PendingOp | undefined;
  private keypair: DeviceKeypair | undefined;
  private paired: PairingFile | undefined;
  private revokedNotice = false;

  constructor(
    private readonly store: Store,
    private readonly home: string,
    private readonly deviceName: string,
    private readonly envHubUrl: string | undefined,
    private readonly hooks: { now?: () => number; fetchImpl?: typeof fetch; stopOldConnector?: (origin: string) => void; onPaired?: () => void; pollMs?: number } = {},
  ) {
    ensurePrivateDir(home);
    removeStaleTemps(home);
    this.loadKeypair();
    this.paired = loadJson<PairingFile>(pairingPath(home));
    if (this.paired) ensureFileMode0600(pairingPath(home));
    if (this.paired) ensurePrivateDir(home);
  }

  private get now() {
    return this.hooks.now ?? Date.now;
  }

  private loadKeypair(): void {
    const path = keypairPath(this.home);
    const loaded = readKeypairFile(path);
    if (loaded) {
      this.keypair = loaded;
      ensureFileMode0600(path);
      return;
    }
    // First boot only: a file that exists but cannot be used throws above instead of being replaced.
    const kp = generateKeyPairSync("ed25519");
    const der = kp.publicKey.export({ type: "spki", format: "der" }) as Buffer;
    this.keypair = {
      fingerprint: `sha256:${createHash("sha256").update(der).digest("hex")}`,
      publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" }) as string,
      privateKeyPem: kp.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    };
    writeAtomic(path, JSON.stringify(this.keypair, null, 2));
  }

  status(): PairingStatus {
    const base: PairingStatus = {
      state: this.pending ? "pairing" : this.revokedNotice ? "revoked" : this.paired ? "paired" : "unpaired",
      deviceUid: this.store.uid,
      deviceName: this.deviceName,
      fingerprint: this.keypair!.fingerprint,
      ...(this.paired
        ? {
            hubOrigin: this.paired.hubOrigin,
            deviceId: this.paired.deviceId,
            pairingEpoch: this.paired.pairingEpoch,
            generation: this.paired.generation,
          }
        : {}),
      ...(this.pending
        ? { pending: { hubOrigin: this.pending.hubOrigin, startedAt: this.pending.startedAt, note: "polling for approval; cancel stops the local operation only" } }
        : {}),
      ...(this.lastFailure ? { lastError: this.lastFailure } : {}),
    };
    return base;
  }

  /** Resolve the target origin per 03 §4.1 — BEFORE any network call. */
  private resolveOrigin(input: PairingStartInput): { origin: string; code: string } {
    let pairUrlOrigin: string | undefined;
    let code = input.code ?? "";
    if (input.pairUrl) {
      const parsed = this.codeFromPairUrl(input.pairUrl);
      if (!parsed) throw err("invalid", "pairUrl must look like https://<hub>/pair?code=<CODE>&v=1");
      code = parsed;
      const o = this.originOf(input.pairUrl);
      if (!o.ok) throw err("invalid", o.error);
      pairUrlOrigin = o.origin;
    }
    // Precedence: pair URL → explicit --hub → DPI_HUB_URL → saved origin. Every
    // EXPLICIT source must be a valid HTTPS origin (fail on the bad one), then
    // differing explicit origins are a conflict.
    const explicitSources = [pairUrlOrigin, input.hub, this.envHubUrl].filter((x): x is string => !!x);
    const explicitOrigins = explicitSources.map((raw) => {
      const o = this.originOf(raw);
      if (!o.ok) throw err("invalid", o.error);
      return o.origin;
    });
    if (new Set(explicitOrigins).size > 1)
      throw err("invalid", `Multiple explicit hub origins conflict: ${[...new Set(explicitOrigins)].join(", ")}; pass exactly one`);
    const origin = explicitOrigins[0] ?? this.paired?.hubOrigin;
    if (!origin)
      throw err("hub_required", "A pairing code alone is not enough: provide --hub, DPI_HUB_URL, a pair URL, or a prior saved hub");
    const o = this.originOf(origin);
    if (!o.ok) throw err("invalid", o.error);
    if (!/^[A-Z2-7]{8}$/.test(code)) throw err("invalid", "Pairing code must be 8 base32 characters (A-Z2-7)");
    return { origin: o.origin, code };
  }

  private codeFromPairUrl(url: string): string | undefined {
    try {
      const u = new URL(url);
      const code = u.searchParams.get("code");
      if (!/^\/pair\/?$/.test(u.pathname) || u.username || u.password || u.hash
        || u.searchParams.getAll("code").length !== 1
        || u.searchParams.getAll("v").length !== 1 || u.searchParams.get("v") !== "1") return undefined;
      if (u.searchParams.has("origin")) {
        const origin = new URL(u.searchParams.get("origin")!);
        if (u.searchParams.getAll("origin").length !== 1 || origin.origin !== u.origin || origin.pathname !== "/"
          || origin.username || origin.password || origin.search || origin.hash) return undefined;
      }
      return code && /^[A-Z2-7]{8}$/.test(code) ? code : undefined;
    } catch {
      return undefined;
    }
  }

  private originOf(raw: string): { ok: true; origin: string } | { ok: false; error: string } {
    // Accept bare origins and full pair URLs; canonicalize via the shared validator.
    const candidate = raw.includes("/pair?") || raw.includes("/pair/") ? new URL(raw).origin : raw;
    const parsed = parseHubOrigin(candidate);
    return parsed.ok ? { ok: true, origin: parsed.origin } : { ok: false, error: parsed.error };
  }

  /** POST /v1/pairing/start — kick off (or restart) pairing. */
  async start(input: PairingStartInput): Promise<PairingStatus> {
    const { origin, code } = this.resolveOrigin(input);

    if (this.pending) throw err("busy", "A pairing operation is already running; cancel it first");
    // A revoked pairing no longer binds the device to its hub.
    const incumbent = this.revokedNotice ? undefined : this.paired;
    if (incumbent && incumbent.hubOrigin !== origin && !input.force)
      throw err(
        "invalid",
        `Already paired with ${incumbent.hubOrigin}; re-pairing another hub needs force (and revokes this pairing only after the new one succeeds)`,
      );

    const operationId = randomUUID();
    this.lastFailure = undefined;
    const keypair = this.keypair!;
    const requestId = randomUUID();
    const deviceUid = this.store.uid;

    const challenge = (await this.hubFetch(origin, "/api/pair/start", {
      type: "pair.request",
      v: 1,
      requestId,
      code,
      deviceUid,
      deviceName: this.deviceName,
      publicKey: keypair.publicKeyPem,
      keyFingerprint: keypair.fingerprint,
      clientTime: this.now(),
    })) as { type: string; enrollmentId: string; nonce: string; issuedAt: number; hubId: string };
    if (challenge.type !== "pair.challenge") throw err("invalid", `Unexpected hub response: ${JSON.stringify(challenge).slice(0, 200)}`);
    if (typeof challenge.issuedAt !== "number" || !Number.isFinite(challenge.issuedAt)) throw err("invalid", "Challenge issuedAt is not a finite number");
    if (!nonEmpty(challenge.hubId, 64) || !nonEmpty(challenge.enrollmentId, 64)) throw err("invalid", "Challenge is missing hubId or enrollmentId");
    // P-4: device rejects a challenge skewed more than ±60s from its clock.
    if (Math.abs(this.now() - challenge.issuedAt) > CLOCK_SKEW_MS)
      throw err("clock_skew", `Hub clock differs by more than ${CLOCK_SKEW_MS / 1000}s; fix NTP and retry`);

    const payload = pairingSigningPayload({
      hubOrigin: origin,
      hubId: challenge.hubId,
      enrollmentId: challenge.enrollmentId,
      nonce: challenge.nonce,
      issuedAt: challenge.issuedAt,
      deviceUid,
      keyFingerprint: keypair.fingerprint,
    });
    const signature = edSign(null, Buffer.from(payload), createPrivateKey(keypair.privateKeyPem)).toString("base64url");
    const proof = { type: "pair.response" as const, v: 1 as const, enrollmentId: challenge.enrollmentId, nonce: challenge.nonce, signature };

    const pending: PendingOp = {
      operationId,
      hubOrigin: origin,
      code,
      requestId,
      deviceUid,
      deviceName: this.deviceName,
      keyFingerprint: keypair.fingerprint,
      proof,
      hubId: challenge.hubId,
      expiresAt: this.now() + 300_000,
      startedAt: this.now(),
      abort: new AbortController(),
    };
    this.pending = pending;
    void this.pollLoop(pending).catch(() => undefined);
    return this.status();
  }

  /** Poll the same signed proof until approval issues a TokenIssue (or expiry). */
  private async pollLoop(pending: PendingOp): Promise<void> {
    const pollMs = this.hooks.pollMs ?? PAIR_POLL_MS;
    while (!pending.abort.signal.aborted && this.now() < pending.expiresAt && this.pending?.operationId === pending.operationId) {
      const outcome = await this.hubFetchRaw(pending.hubOrigin, "/api/pair/verify", pending.proof, pending.abort.signal).catch(() => null);
      if (this.pending?.operationId !== pending.operationId) return; // superseded
      if (!outcome) {
        await sleep(pollMs * 2, pending.abort.signal);
        continue;
      }
      if (outcome.status === 200 && outcome.body && (outcome.body as TokenIssue).type === "pair.token") {
        const issue = outcome.body as TokenIssue;
        const refusal = refuseIssue(issue, { origin: pending.hubOrigin, hubId: pending.hubId, enrollmentId: pending.proof.enrollmentId, deviceUid: pending.deviceUid, now: this.now() });
        if (refusal) {
          this.pending = undefined;
          this.lastFailure = `invalid_token_issue: ${refusal}; the credential was not saved`;
          return;
        }
        await this.commitTokenIssue(pending, issue);
        return;
      }
      if (outcome.status === 202) {
        await sleep(pollMs, pending.abort.signal);
        continue;
      }
      const code = (outcome.body as { error?: { code?: string; message?: string } })?.error?.code ?? "invalid";
      const message = (outcome.body as { error?: { message?: string } })?.error?.message ?? "pairing failed";
      if (["code_expired", "enrollment_cancelled", "enrollment_lost", "challenge_expired"].includes(code)) {
        this.pending = undefined;
        this.lastFailure = `${code}: ${message}`;
        return;
      }
      await sleep(pollMs * 2, pending.abort.signal);
    }
    if (this.pending?.operationId === pending.operationId) {
      this.pending = undefined;
      this.lastFailure = "code_expired: Pairing timed out; mint a fresh code and retry";
    }
  }

  private lastFailure: string | undefined;

  /**
   * Persist pairing.json atomically, then flip to paired. The credential is
   * never used or ACKed before the fsync chain completes, and a late response
   * re-checks the operation ID + generation right before committing.
   */
  private async commitTokenIssue(pending: PendingOp, issue: TokenIssue): Promise<void> {
    const file: PairingFile = {
      version: 1,
      deviceUid: issue.deviceUid,
      deviceId: issue.deviceId,
      pairingEpoch: issue.pairingEpoch,
      credentialId: issue.credentialId,
      generation: issue.generation,
      hubOrigin: issue.hubOrigin,
      hubUrl: issue.hubUrl,
      hubId: issue.hubId,
      tunnelToken: issue.tunnelToken,
      updatedAt: this.now(),
      operationId: pending.operationId,
    };
    writeAtomic(pairingPath(this.home), JSON.stringify(file, null, 2));
    // Re-check: a newer operation/pairing must not be clobbered by this commit.
    if (this.pending?.operationId !== pending.operationId) return;
    if (this.paired && this.paired.updatedAt > file.updatedAt) return; // never happens with sync writes, belt-and-braces
    const previous = this.revokedNotice ? undefined : this.paired;
    this.paired = file;
    this.pending = undefined;
    this.lastFailure = undefined;
    this.revokedNotice = false;
    // The old hub keeps its tunnel and its pairing right up to here: only a persisted replacement ends them.
    if (previous && previous.hubOrigin !== file.hubOrigin) {
      try {
        this.hooks.stopOldConnector?.(previous.hubOrigin);
      } catch {
        /* hook errors never fail the pairing commit */
      }
      void this.bestEffortUnpair(previous).catch(() => undefined);
    }
    // Credential file is durable: the same-daemon connector may start now.
    try {
      this.hooks.onPaired?.();
    } catch {
      /* hook errors never fail the pairing commit */
    }
  }

  /** POST /v1/pairing/cancel — local abort only; never claims a remote cancel. */
  cancel(): PairingStatus {
    if (!this.pending) throw err("invalid", "No pairing operation running");
    const target = this.pending.hubOrigin;
    this.pending.abort.abort();
    this.pending = undefined;
    this.lastFailure = `cancelled locally against ${target}; the code may still be live on the hub until it expires — if issuance may have happened, check/revoke on the hub`;
    return this.status();
  }

  /** The connector learned the hub revoked this pairing (and removed the file). A notice for another epoch is about a pairing we no longer hold. */
  markRevoked(reason: string, pairingEpoch?: string): void {
    if (pairingEpoch !== undefined && this.paired && this.paired.pairingEpoch !== pairingEpoch) return;
    this.revokedNotice = true;
    this.lastFailure = reason;
  }

  /** The connector persisted a rotated credential for this pairing; only a strictly newer generation of the same epoch counts. */
  markRotated(file: PairingFile): void {
    if (!this.paired || this.revokedNotice) return;
    if (file.pairingEpoch !== this.paired.pairingEpoch || file.generation <= this.paired.generation) return;
    this.paired = file;
  }

  private async bestEffortUnpair(paired: PairingFile): Promise<void> {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 2_000).unref?.();
    await this.hubFetchRaw(paired.hubOrigin, "/api/tunnel", { type: "control", action: "unpair", pairingEpoch: paired.pairingEpoch, reason: "hub_migrated" }, ctl.signal).catch(() => undefined);
  }

  private async hubFetch<T = unknown>(origin: string, path: string, body: unknown): Promise<T> {
    for (let attempt = 0; attempt < PAIR_HTTP_MAX_RETRIES; attempt++) {
      const outcome = await this.hubFetchRaw(origin, path, body).catch(() => null);
      if (outcome && outcome.status < 500 && outcome.status !== 429) {
        if (outcome.status >= 400) throw err("invalid", `Hub rejected ${path}: ${JSON.stringify(outcome.body).slice(0, 200)}`);
        return outcome.body as T;
      }
      await sleep(500 * (attempt + 1));
    }
    throw err("offline", `Hub unreachable after ${PAIR_HTTP_MAX_RETRIES} attempts`);
  }

  private async hubFetchRaw(origin: string, path: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
    const fetchImpl = this.hooks.fetchImpl ?? fetch;
    const timeout = AbortSignal.timeout(PAIR_HTTP_TIMEOUT_MS);
    const effective = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const res = await fetchImpl(origin + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: effective,
      redirect: "error", // cross-origin redirects are never followed (03 §4.1)
    });
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = undefined;
    }
    return { status: res.status, body: parsed };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
}
