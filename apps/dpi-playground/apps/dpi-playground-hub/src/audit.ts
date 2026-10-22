/**
 * Transactional audit (spec 07 §5.3) — append-only `events` rows committed in
 * the SAME transaction as the credential/registry mutation they describe.
 *
 * - Audit failure fails the mutation closed (rollback), never the reverse.
 * - detail_json is capped at 4096 UTF-8 BYTES (SQLite sees a BLOB; JS checks
 *   bytes, not characters) and is scrubbed of every secret shape — tokens,
 *   pairing codes, private keys, Authorization values, pair-URL queries and
 *   transcript fragments — including substrings.
 * - Denials are aggregated per (action, source, kind, time window): a flood of bad
 *   packets produces O(windows) rows, not O(packets); the RAM bucket table is
 *   itself bounded. A source is an IPv4 address or an IPv6 /64. The first denial
 *   of a window writes an opening row; when the window has closed (sweep or
 *   shutdown) a second row carries the window's total. Rows are append-only, so
 *   the total cannot be written into the opening row. Denial accounting is
 *   best-effort and never throws: a
 *   storage fault loses the denial row (counted in `droppedDenials`), it must
 *   not take a request path or the process down.
 * - Disk-space guard: audited work (every append, every transaction) is
 *   refused with AuditUnavailableError (503) below a free-space floor on the
 *   registry volume, before any state is touched.
 * - The app never disables the append-only triggers; prune is a separate
 *   maintenance path (P3) that recreates them transactionally.
 */
import { chmodSync, statSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import type { NetworkRegistry } from "../../../../dpi-sdk/src/node/registry.js";
import { ipKey } from "./client-ip.js";

export const AUDIT_ACTIONS = [
  "pair.code_created",
  "pair.approved",
  "pair.cancelled",
  "pair.success",
  "pair.revoke",
  "token.rotate_started",
  "token.rotate_completed",
  "token.rotate_regenerated",
  "tunnel.connect",
  "tunnel.disconnect",
  "auth.denied",
  "rate_limited",
  "tunnel.listener_error",
  "rotation.stale_cleared",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const DETAIL_MAX_BYTES = 4096;
const FIELD_MAX = 128;
/** A denial sample is a hint for the operator, not a copy of the request. */
const SAMPLE_FIELD_MAX = 200;
const SAMPLE_FIELDS_MAX = 16;
const DENIAL_WINDOW_MS = 60_000;
const DENIAL_BUCKETS_MAX = 512;
/** Free space that must remain on the registry volume for audited work (05 §4.4 disk-space guard). */
const MIN_FREE_BYTES = 32 * 1024 * 1024;
const DISK_CHECK_TTL_MS = 1_000;
const DROP_WARN_INTERVAL_MS = 60_000;

export interface AuditEvent {
  actor: string;
  action: AuditAction;
  outcome: "ok" | "denied";
  requestId?: string;
  connectionId?: string;
  detail?: Record<string, unknown>;
}

export interface AuditOptions {
  /** Refuse audited work below this many free bytes on the registry volume (default 32 MiB). */
  minFreeBytes?: number;
  /** Free bytes on the registry volume (default: statfs of its directory, cached for 1 s). Test seam. */
  freeBytes?: () => number;
  /** When true, every append throws (fault injection for fail-closed tests). */
  failAppend?: boolean;
}

/** Audit storage cannot take a write right now; the mutation must not proceed. */
export class AuditUnavailableError extends Error {
  readonly status = 503;
  readonly code = "audit_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "AuditUnavailableError";
  }
}

/** Redact every secret shape, including substrings, from arbitrary strings. */
export function scrubSecrets(value: string): string {
  let out = value;
  out = out.replace(/dpt_[A-Za-z0-9_-]{1,64}/g, "dpt_<redacted>");
  out = out.replace(/dpi_[A-Za-z0-9_-]{1,64}/g, "dpi_<redacted>");
  out = out.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    "<private-key-redacted>",
  );
  out = out.replace(/(authorization\s*[:=]\s*)(\S+)/gi, "$1<redacted>");
  out = out.replace(/(bearer\s+)([A-Za-z0-9._-]{8,})/gi, "$1<redacted>");
  out = out.replace(/([?&]code=)[A-Za-z0-9_-]+/g, "$1<redacted>");
  // Credential material without its prefix (slices, echo): 43-char base64url runs.
  out = out.replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, "<redacted>");
  // Pairing codes as standalone values ("code":"AB2C7DEF") but not ordinary words.
  out = out.replace(/(["'?=:,\s])([A-Z2-7]{8})(?=["'?\s:,}]|$)/g, "$1<code-redacted>");
  return out;
}

function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "<depth-limit>";
  if (typeof value === "string")
    return scrubSecrets(value.length > 8192 ? value.slice(0, 8192) : value);
  if (Array.isArray(value)) return value.slice(0, 32).map((v) => scrubValue(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value).slice(0, 64))
      out[scrubSecrets(k)] = scrubValue(v, depth + 1);
    return out;
  }
  return value;
}

interface DenialBucket {
  action: AuditAction;
  source: string;
  window: number;
  count: number;
  sample: Record<string, unknown>;
  /** The opening row reached storage; only such a window may get a closing row. */
  persisted: boolean;
  closed: boolean;
}

/** Bounded copy of a denial sample: at most 16 fields, strings cut at 200 characters. */
function clipSample(sample: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(sample).slice(0, SAMPLE_FIELDS_MAX))
    out[key.slice(0, SAMPLE_FIELD_MAX)] =
      typeof value === "string" ? value.slice(0, SAMPLE_FIELD_MAX) : value;
  return out;
}

export class Audit {
  private buckets = new Map<string, DenialBucket>();
  private windowRows = new Map<number, number>();
  private overflowed = new Set<number>();
  private static readonly WINDOW_ROW_CAP = 256;
  private diskCheckedAt = 0;
  private diskFree = Number.POSITIVE_INFINITY;
  private lastDropWarning = 0;
  /** Denial rows that could not be persisted (storage fault or disk guard); counts stay in RAM only. */
  droppedDenials = 0;

  constructor(
    private readonly registry: NetworkRegistry,
    private readonly hooks: AuditOptions = {},
  ) {
    this.ensureStoragePerms();
  }

  /**
   * Disk-space guard (05 §4.4): refuse audited work when the registry volume
   * is nearly full, before any state changes. An unreadable or unknown volume
   * never blocks (a false refusal would lock the operator out of revoke).
   */
  assertWritable(): void {
    const floor = this.hooks.minFreeBytes ?? MIN_FREE_BYTES;
    const free = this.hooks.freeBytes ? this.hooks.freeBytes() : this.volumeFreeBytes();
    if (free < floor)
      throw new AuditUnavailableError(
        `audit: ${free} bytes free on the registry volume (floor ${floor}); audited changes are refused`,
      );
  }

  private volumeFreeBytes(): number {
    const now = Date.now();
    if (now - this.diskCheckedAt < DISK_CHECK_TTL_MS) return this.diskFree;
    this.diskCheckedAt = now;
    try {
      const fs = statfsSync(dirname(this.registry.path));
      this.diskFree = fs.blocks > 0 ? fs.bavail * fs.bsize : Number.POSITIVE_INFINITY;
    } catch {
      this.diskFree = Number.POSITIVE_INFINITY;
    }
    return this.diskFree;
  }

  /** The registry file must stay 0600 — tighten quietly if a copy restored looser bits. */
  private ensureStoragePerms() {
    try {
      const mode = statSync(this.registry.path).mode & 0o777;
      if (mode !== 0o600) chmodSync(this.registry.path, 0o600);
    } catch {
      /* best effort; SQLite still works */
    }
  }

  /**
   * Run `fn` inside one IMMEDIATE transaction on the registry connection.
   * Any throw (including audit-append failures) rolls everything back —
   * a mutation is never committed without its audit row.
   */
  withTransaction<T>(fn: () => T): T {
    this.assertWritable();
    const db = this.registry.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* connection-level failure already rolled back */
      }
      throw e;
    }
  }

  /**
   * Append one audit row. Callers that mutate credentials must do it INSIDE
   * withTransaction so the row commits (or rolls back) with the mutation.
   * Throws (fail closed) on: oversize detail bytes, DB write errors, injected
   * faults. Never throws "soft".
   */
  append(event: AuditEvent): void {
    if (this.hooks.failAppend) throw new Error("audit: injected append failure");
    this.assertWritable();
    // Reject oversize details BEFORE any scrubbing/truncation could mask them.
    const rawBytes = Buffer.byteLength(JSON.stringify(event.detail ?? {}), "utf8");
    if (rawBytes > DETAIL_MAX_BYTES)
      throw new Error(
        `audit: detail_json is ${rawBytes} bytes (max ${DETAIL_MAX_BYTES} UTF-8 bytes)`,
      );
    const actor = scrubSecrets(String(event.actor)).slice(0, FIELD_MAX);
    const action = String(event.action).slice(0, FIELD_MAX);
    const requestId = event.requestId
      ? scrubSecrets(String(event.requestId)).slice(0, FIELD_MAX)
      : null;
    const connectionId = event.connectionId
      ? scrubSecrets(String(event.connectionId)).slice(0, FIELD_MAX)
      : null;
    const detail = event.detail ? (scrubValue(event.detail) as Record<string, unknown>) : {};
    const detailJson = JSON.stringify(detail);
    const bytes = Buffer.byteLength(detailJson, "utf8");
    if (bytes > DETAIL_MAX_BYTES)
      throw new Error(`audit: detail_json is ${bytes} bytes (max ${DETAIL_MAX_BYTES} UTF-8 bytes)`);
    this.registry.db
      .prepare(
        "INSERT INTO events(ts,actor,action,request_id,connection_id,outcome,detail_json) VALUES(?,?,?,?,?,?,?)",
      )
      .run(Date.now(), actor, action, requestId, connectionId, event.outcome, detailJson);
  }

  /**
   * Denial/rate-limit accounting with bounded aggregation: one row per
   * (action, ip, kind, window) records the window and a redacted sample; the
   * RAM bucket map is capped so a flood cannot grow it without bound. `kind`
   * separates denials that must stay distinguishable (hub-chosen, bounded
   * values only — never request data).
   *
   * Best-effort by design: a storage fault or the disk guard drops the row
   * (see `droppedDenials`) but never throws into the request path.
   */
  denied(action: AuditAction, ip: string, sample: Record<string, unknown> = {}, kind = ""): void {
    try {
      this.recordDenial(action, ip, sample, kind);
    } catch (e) {
      this.noteDropped(e);
    }
  }

  private recordDenial(
    action: AuditAction,
    address: string,
    sample: Record<string, unknown>,
    kind: string,
  ): void {
    const now = Date.now();
    const window = Math.floor(now / DENIAL_WINDOW_MS) * DENIAL_WINDOW_MS;
    const source = ipKey(address);
    const key = `${action}|${source}|${kind}|${window}`;
    const known = this.buckets.get(key);
    if (known) {
      known.count += 1; // counts live in RAM; the row records the window + sample
      return;
    }
    if (this.buckets.size >= DENIAL_BUCKETS_MAX) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    const bucket: DenialBucket = {
      action,
      source,
      window,
      count: 1,
      persisted: false,
      closed: false,
      sample: scrubValue(clipSample(sample)) as Record<string, unknown>,
    };
    this.buckets.set(key, bucket);
    // Global row budget per window: distinct-IP floods land in one overflow row.
    // A row slot is spent BEFORE the write so a failing disk is not retried per request.
    const written = this.windowRows.get(window) ?? 0;
    if (written >= Audit.WINDOW_ROW_CAP) {
      if (this.overflowed.has(window)) return;
      this.overflowed.add(window);
      this.windowRows.set(window, written + 1);
      this.append({
        actor: "ip:*",
        action: "rate_limited",
        outcome: "denied",
        detail: {
          aggregated: true,
          window,
          overflow: true,
          note: "denial row budget exceeded; counts in RAM only",
        },
      });
      return;
    }
    this.windowRows.set(window, written + 1);
    this.append({
      actor: `ip:${source}`,
      action,
      outcome: "denied",
      detail: { aggregated: true, window, sample: bucket.sample },
    });
    bucket.persisted = true;
  }

  /** The window's total, as a second row (the opening row cannot be updated). Best-effort like every denial record. */
  private closeBucket(bucket: DenialBucket): void {
    bucket.closed = true;
    if (!bucket.persisted || bucket.count < 2) return;
    try {
      this.append({
        actor: `ip:${bucket.source}`,
        action: bucket.action,
        outcome: "denied",
        detail: { aggregated: true, window: bucket.window, closing: true, count: bucket.count },
      });
    } catch (e) {
      this.noteDropped(e);
    }
  }

  private noteDropped(e: unknown): void {
    this.droppedDenials++;
    const now = Date.now();
    if (now - this.lastDropWarning < DROP_WARN_INTERVAL_MS) return;
    this.lastDropWarning = now;
    console.error(
      `audit: denial record dropped (${scrubSecrets(String((e as Error)?.message ?? e)).slice(0, 160)}); ${this.droppedDenials} dropped so far`,
    );
  }

  /** Close the windows that have ended, then drop buckets older than two windows (housekeeping for long-lived hubs). */
  sweepDenials(): void {
    const now = Date.now();
    const cutoff = now - DENIAL_WINDOW_MS * 2;
    for (const [key, bucket] of this.buckets) {
      if (!bucket.closed && bucket.window + DENIAL_WINDOW_MS <= now) this.closeBucket(bucket);
      if (bucket.window < cutoff) this.buckets.delete(key);
    }
    for (const window of this.windowRows.keys())
      if (window < cutoff) this.windowRows.delete(window);
    for (const window of this.overflowed) if (window < cutoff) this.overflowed.delete(window);
  }

  /** Shutdown: give every window that is still open its total, so a stop does not lose the counts held in RAM. */
  flushDenials(): void {
    for (const bucket of this.buckets.values()) if (!bucket.closed) this.closeBucket(bucket);
  }

  /** Run `sweepDenials` on a timer that never keeps the process alive. Returns the stop function. */
  startSweeper(intervalMs = DENIAL_WINDOW_MS): () => void {
    const timer = setInterval(() => this.sweepDenials(), intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** Read-only counters for tests and diagnostics. */
  stats(): { denialBuckets: number; droppedDenials: number } {
    return { denialBuckets: this.buckets.size, droppedDenials: this.droppedDenials };
  }
}

/** Express middleware: log 4xx/429 security denials through bounded aggregation. */
export function denialLogging(audit: Audit): import("express").RequestHandler {
  return (req, res, next) => {
    res.on("finish", () => {
      if ([401, 403, 421, 429, 415].includes(res.statusCode)) {
        try {
          audit.denied("auth.denied", req.ip ?? "unknown", {
            method: req.method,
            path: req.path,
            status: res.statusCode,
          });
        } catch {
          /* audit must never take the request path down */
        }
      }
    });
    next();
  };
}
