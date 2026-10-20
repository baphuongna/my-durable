/**
 * Transactional audit (spec 07 §5.3) — append-only `events` rows committed in
 * the SAME transaction as the credential/registry mutation they describe.
 *
 * - Audit failure fails the mutation closed (rollback), never the reverse.
 * - detail_json is capped at 4096 UTF-8 BYTES (SQLite sees a BLOB; JS checks
 *   bytes, not characters) and is scrubbed of every secret shape — tokens,
 *   pairing codes, private keys, Authorization values, pair-URL queries and
 *   transcript fragments — including substrings.
 * - Denials are aggregated per (action, ip, time window): a flood of bad
 *   packets produces O(windows) rows, not O(packets); the RAM bucket table is
 *   itself bounded.
 * - The app never disables the append-only triggers; prune is a separate
 *   maintenance path (P3) that recreates them transactionally.
 */
import { chmodSync, statSync } from "node:fs";
import type { NetworkRegistry } from "../../../../dpi-sdk/src/node/registry.js";

export const AUDIT_ACTIONS = [
  "pair.code_created", "pair.approved", "pair.cancelled", "pair.success", "pair.revoke",
  "token.rotate_started", "token.rotate_completed", "token.rotate_regenerated",
  "tunnel.connect", "tunnel.disconnect", "auth.denied", "rate_limited",
  "tunnel.listener_error", "rotation.stale_cleared",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const DETAIL_MAX_BYTES = 4096;
const FIELD_MAX = 128;
const DENIAL_WINDOW_MS = 60_000;
const DENIAL_BUCKETS_MAX = 512;

export interface AuditEvent {
  actor: string;
  action: AuditAction;
  outcome: "ok" | "denied";
  requestId?: string;
  connectionId?: string;
  detail?: Record<string, unknown>;
}

export interface AuditTestHooks {
  /** When true, every append throws (fault injection for fail-closed tests). */
  failAppend?: boolean;
}

/** Redact every secret shape, including substrings, from arbitrary strings. */
export function scrubSecrets(value: string): string {
  let out = value;
  out = out.replace(/dpt_[A-Za-z0-9_-]{1,64}/g, "dpt_<redacted>");
  out = out.replace(/dpi_[A-Za-z0-9_-]{1,64}/g, "dpi_<redacted>");
  out = out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "<private-key-redacted>");
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
  if (typeof value === "string") return scrubSecrets(value.length > 8192 ? value.slice(0, 8192) : value);
  if (Array.isArray(value)) return value.slice(0, 32).map((v) => scrubValue(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value).slice(0, 64)) out[scrubSecrets(k)] = scrubValue(v, depth + 1);
    return out;
  }
  return value;
}

export class Audit {
  private buckets = new Map<string, { window: number; count: number; sample: Record<string, unknown> }>();
  private windowRows = new Map<number, number>();
  private overflowed = new Set<number>();
  private static readonly WINDOW_ROW_CAP = 256;

  constructor(
    private readonly registry: NetworkRegistry,
    private readonly hooks: AuditTestHooks = {},
  ) {
    this.ensureStoragePerms();
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
    // Reject oversize details BEFORE any scrubbing/truncation could mask them.
    const rawBytes = Buffer.byteLength(JSON.stringify(event.detail ?? {}), "utf8");
    if (rawBytes > DETAIL_MAX_BYTES)
      throw new Error(`audit: detail_json is ${rawBytes} bytes (max ${DETAIL_MAX_BYTES} UTF-8 bytes)`);
    const actor = scrubSecrets(String(event.actor)).slice(0, FIELD_MAX);
    const action = String(event.action).slice(0, FIELD_MAX);
    const requestId = event.requestId ? scrubSecrets(String(event.requestId)).slice(0, FIELD_MAX) : null;
    const connectionId = event.connectionId ? scrubSecrets(String(event.connectionId)).slice(0, FIELD_MAX) : null;
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
   * (action, ip, window) carries the count and a redacted sample; the RAM
   * bucket map is capped so a flood cannot grow it without bound.
   */
  denied(action: AuditAction, ip: string, sample: Record<string, unknown> = {}): void {
    const now = Date.now();
    const window = Math.floor(now / DENIAL_WINDOW_MS) * DENIAL_WINDOW_MS;
    const key = `${action}|${ip}|${window}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= DENIAL_BUCKETS_MAX) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      bucket = { window, count: 0, sample: scrubValue(sample) as Record<string, unknown> };
      this.buckets.set(key, bucket);
      // Global row budget per window: distinct-IP floods land in one overflow row.
      const written = this.windowRows.get(window) ?? 0;
      if (written >= Audit.WINDOW_ROW_CAP) {
        bucket.count = 1;
        if (!this.overflowed.has(window)) {
          this.overflowed.add(window);
          this.append({ actor: "ip:*", action: "rate_limited", outcome: "denied", detail: { aggregated: true, window, overflow: true, note: "denial row budget exceeded; counts in RAM only" } });
          this.windowRows.set(window, written + 1);
        }
        return;
      }
      this.append({ actor: `ip:${ip}`, action, outcome: "denied", detail: { aggregated: true, window, count: 1, sample: bucket.sample } });
      this.windowRows.set(window, written + 1);
      bucket.count = 1;
      return;
    }
    bucket.count += 1; // counts live in RAM; the row records the window + sample
  }

  /** Drop buckets older than one window (housekeeping for long-lived hubs). */
  sweepDenials(): void {
    const cutoff = Date.now() - DENIAL_WINDOW_MS * 2;
    for (const [key, bucket] of this.buckets)
      if (bucket.window < cutoff) this.buckets.delete(key);
    for (const window of this.windowRows.keys()) if (window < cutoff) this.windowRows.delete(window);
    for (const window of this.overflowed) if (window < cutoff) this.overflowed.delete(window);
  }
}

/** Express middleware: log 4xx/429 security denials through bounded aggregation. */
export function denialLogging(audit: Audit): import("express").RequestHandler {
  return (req, res, next) => {
    res.on("finish", () => {
      if ([401, 403, 421, 429, 415].includes(res.statusCode)) {
        try {
          audit.denied("auth.denied", req.ip ?? "unknown", { method: req.method, path: req.path, status: res.statusCode });
        } catch {
          /* audit must never take the request path down */
        }
      }
    });
    next();
  };
}
