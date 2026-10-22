/**
 * P2-23 — typed admin pairing client for the browser.
 *
 * Contract (plan §P2-23):
 * - Every admin pairing/rotation/revoke call is typed with the SDK DTOs.
 * - Wizard enrollment state lives in ISOLATED per-session RAM (created via
 *   createPairingSession()); it never writes into the network/pairings
 *   metadata or the monitor six-status feed.
 * - The browser only ever talks to hub /api endpoints — never to a device
 *   URL directly (the hub proxy injects device tokens; the browser holds none).
 * - A closed dialog/tab aborts its polls; a stale session (superseded by a
 *   newer wizard) can never update anything.
 * - HTTP 401 maps to a typed error (needsAuth) so the UI can ask for
 *   re-authentication without any redirect to a login screen.
 * - No secret (code/token/hash) is ever logged or persisted here.
 */
import { DpiError } from "../../../../../dpi-sdk/src/errors";
import type {
  PairCodeIssue,
  PairCodeState,
  PairApproval,
  PublicPairing,
} from "../../../../../dpi-sdk/src/api";

/** One hub REST call. 401 surfaces as DpiError(status=401) → needsAuth(). */
async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  keepalive?: boolean,
): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
    ...(keepalive ? { keepalive } : {}),
  });
  const data = (await r.json().catch(() => undefined)) as
    | T
    | { error?: { code?: string; message?: string } }
    | undefined;
  if (!r.ok) {
    const error = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new DpiError(
      (error?.code as never) ?? "internal",
      error?.message ?? `${r.status} ${r.statusText}`,
      r.status,
    );
  }
  return data as T;
}

/** The only auth failure the browser treats as "authenticate again". */
export const needsAuth = (e: unknown): boolean => e instanceof DpiError && e.status === 401;

export type RevokeReason = "user" | "compromise";

export const pairingAdmin = {
  pairings: (signal?: AbortSignal) => call<PublicPairing[]>("GET", "/pairings", undefined, signal),
  /** Operator opens the wizard: mint a code (admin-gated upstream by Caddy). */
  createCode: (signal?: AbortSignal) => call<PairCodeIssue>("POST", "/pair/code", {}, signal),
  /** Resolve an existing handoff through a same-origin JSON body, never a code-bearing API URL. */
  resolveCode: (code: string, signal?: AbortSignal) =>
    call<PairCodeIssue>("POST", "/pair/resolve", { code }, signal),
  /** Phase metadata only — the issued token is NEVER in this response. */
  codeState: (codeId: string, signal?: AbortSignal) =>
    call<PairCodeState>("GET", `/pair/codes/${encodeURIComponent(codeId)}`, undefined, signal),
  /** Full-fingerprint approval (P-8/P-14): tuple must match the enrollment exactly. */
  approve: (codeId: string, approval: PairApproval, signal?: AbortSignal) =>
    call<PairCodeState>(
      "POST",
      `/pair/codes/${encodeURIComponent(codeId)}/approve`,
      approval,
      signal,
    ),
  /** `keepalive` lets the request outlive the page; use it only when the wizard is going away. */
  cancel: (codeId: string, signal?: AbortSignal, keepalive?: boolean) =>
    call<PairCodeState>(
      "POST",
      `/pair/codes/${encodeURIComponent(codeId)}/cancel`,
      {},
      signal,
      keepalive,
    ),
  /** Ask the hub to rotate a device credential (202 — async via tunnel). */
  rotate: (deviceId: string, signal?: AbortSignal) =>
    call<{ ok: boolean }>("POST", `/pairings/${encodeURIComponent(deviceId)}/rotate`, {}, signal),
  /** Durable revoke (P2-20): every hash dies at commit; live transport is cut. */
  revoke: (deviceId: string, reason: RevokeReason = "user", signal?: AbortSignal) =>
    call<{ ok: boolean }>(
      "POST",
      `/pairings/${encodeURIComponent(deviceId)}/revoke`,
      { reason },
      signal,
    ),
};

export type PairPhase = PairCodeState["phase"];

/**
 * Isolated wizard session. `gen` increments per session; a poll from an old
 * session (stale closure) sees `closed` and stops without touching anything.
 */
export interface PairingSession {
  readonly gen: number;
  /** Latest codeState snapshot (RAM only — never persisted). */
  state?: PairCodeState;
  readonly close: () => void;
  readonly closed: () => boolean;
}

let sessionGen = 0;

export function createPairingSession(): PairingSession {
  const gen = ++sessionGen;
  let isClosed = false;
  return {
    gen,
    close: () => (isClosed = true),
    closed: () => isClosed,
  };
}

export interface PollOptions {
  signal?: AbortSignal;
  /** Overall budget; the hub's own code TTL (5 min) bounds reality. */
  timeoutMs?: number;
  intervalMs?: number;
  onState?: (state: PairCodeState) => void;
}

export class PollTimeout extends Error {
  constructor(readonly codeId: string) {
    super(`pairing poll timed out for ${codeId}`);
    this.name = "PollTimeout";
  }
}

const terminal = (phase: PairPhase) =>
  phase === "issued" || phase === "cancelled" || phase === "expired";

/**
 * Poll a code until it reaches a terminal phase. Aborting (signal or
 * session.close()) stops cleanly; superseded sessions never write state.
 */
export async function pollCode(
  session: PairingSession,
  codeId: string,
  opts: PollOptions = {},
): Promise<PairCodeState | undefined> {
  const interval = opts.intervalMs ?? 1_000; // PAIR_POLL_MS cadence
  const deadline = Date.now() + (opts.timeoutMs ?? 330_000);
  for (;;) {
    if (session.closed()) return undefined; // dialog/tab closed — stop silently
    if (opts.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    if (Date.now() > deadline) throw new PollTimeout(codeId);
    const state = await pairingAdmin.codeState(codeId, opts.signal);
    if (session.closed()) return undefined; // closed while in flight — discard
    session.state = state;
    opts.onState?.(state);
    if (terminal(state.phase)) return state;
    await new Promise((r) => setTimeout(r, interval));
  }
}
