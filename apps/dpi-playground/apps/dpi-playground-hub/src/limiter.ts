/**
 * Bounded per-key limiters (spec 05 §4.3): at most `maxKeys` keys, an idle TTL, and a full table
 * refuses NEW keys. A live counter is never evicted to make room — doing so would hand an attacker
 * who can mint many keys (IPv6 sources) a free quota reset for any key they want to attack.
 *
 * The only entries reclaimed early are the ones whose loss is invisible: a token bucket that has
 * refilled to capacity is indistinguishable from a brand-new one.
 */

const FULL_RETRY_MS = 60_000;
/** A full table is scanned at most this often, so a flood of new keys cannot turn each request into an O(n) walk. */
const RECLAIM_MIN_INTERVAL_MS = 1_000;
const WINDOW_ENTRIES_PER_KEY = 1_024;

export interface BucketPolicy {
  capacity: number;
  perMinute: number;
  maxKeys: number;
  /** A key untouched this long is forgotten. */
  idleTtlMs: number;
}

export type Take = { ok: true } | { ok: false; reason: "limited" | "full"; retryAfterMs: number };

interface Bucket {
  /** Tokens held right after the last ACCEPTED request. */
  tokens: number;
  /** Time of the last accepted request; refill is measured from here, never from a refusal. */
  last: number;
  touched: number;
}

export class TokenBuckets {
  private readonly map = new Map<string, Bucket>();
  private lastReclaim = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly policy: BucketPolicy,
    private readonly now: () => number = Date.now,
  ) {}

  size(): number {
    return this.map.size;
  }

  take(key: string): Take {
    const t = this.now();
    let b = this.map.get(key);
    if (b && t - b.touched >= this.policy.idleTtlMs) {
      this.map.delete(key);
      b = undefined;
    }
    if (!b) {
      if (this.map.size >= this.policy.maxKeys) this.reclaim(t);
      if (this.map.size >= this.policy.maxKeys)
        return { ok: false, reason: "full", retryAfterMs: FULL_RETRY_MS };
      b = { tokens: this.policy.capacity, last: t, touched: t };
      this.map.set(key, b);
    }
    const have = this.available(b, t);
    b.touched = t;
    if (have < 1) {
      const retryAfterMs = Math.ceil(((1 - have) / this.policy.perMinute) * 60_000);
      return { ok: false, reason: "limited", retryAfterMs: Math.max(1, retryAfterMs) };
    }
    b.tokens = have - 1;
    b.last = t;
    return { ok: true };
  }

  /** Forget keys idle for the TTL (housekeeping timer; lookups also honour the TTL). */
  sweep(): void {
    const t = this.now();
    for (const [key, b] of this.map)
      if (t - b.touched >= this.policy.idleTtlMs) this.map.delete(key);
  }

  /**
   * Tokens `b` holds at `t`. Pure: a refused request must not move `last`, or a client that keeps
   * knocking would shave a rounding crumb off its own refill each time. Multiply before dividing so
   * a whole refill interval comes out as exactly 1.
   */
  private available(b: Bucket, t: number): number {
    const elapsed = Math.max(0, t - b.last);
    return Math.min(this.policy.capacity, b.tokens + (elapsed * this.policy.perMinute) / 60_000);
  }

  private reclaim(t: number): void {
    if (t - this.lastReclaim < RECLAIM_MIN_INTERVAL_MS) return;
    this.lastReclaim = t;
    for (const [key, b] of this.map) {
      const idle = t - b.touched >= this.policy.idleTtlMs;
      const refilled = this.available(b, t) >= this.policy.capacity;
      if (idle || refilled) this.map.delete(key);
    }
  }
}

export interface WindowPolicy {
  windowMs: number;
  maxKeys: number;
}

/** Sliding-window event counter per key, with the same bounds and the same full-table rule. */
export class SlidingWindows {
  private readonly map = new Map<string, number[]>();
  private lastReclaim = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly policy: WindowPolicy,
    private readonly now: () => number = Date.now,
    /** Audit run-1: per-key live count at/above this floor ENFORCES a block for
     * the caller (GA-06 — never forgotten while anything weaker could go). A
     * sub-threshold entry blocks nobody, so when the table is full it is
     * evicted to admit a fresh key instead of refusing it. 0 = every entry is
     * evictable. */
    private readonly enforcingFloor = 0,
  ) {}

  size(): number {
    return this.map.size;
  }

  /** Events for `key` inside the window. */
  count(key: string): number {
    const list = this.map.get(key);
    if (!list) return 0;
    const live = this.prune(key, list, this.now());
    return live.length;
  }

  /** False when `key` is new and the table is full: the event could not be tracked. */
  record(key: string): boolean {
    const t = this.now();
    const known = this.map.get(key);
    const list = known ? this.prune(key, known, t) : [];
    if (!this.map.has(key)) {
      if (this.map.size >= this.policy.maxKeys) this.reclaim(t);
      if (this.map.size >= this.policy.maxKeys) this.evictNonEnforcing(t);
      if (this.map.size >= this.policy.maxKeys) return false;
    }
    // Past the cap the oldest entries are kept: the key stays over any sane threshold until they expire.
    if (list.length < WINDOW_ENTRIES_PER_KEY) list.push(t);
    this.map.set(key, list);
    return true;
  }

  /** A key the table has no room to track (callers fail closed for it). */
  saturatedFor(key: string): boolean {
    if (this.map.has(key) || this.map.size < this.policy.maxKeys) return false;
    this.reclaim(this.now());
    if (this.map.size >= this.policy.maxKeys) this.evictNonEnforcing(this.now());
    return this.map.size >= this.policy.maxKeys;
  }

  sweep(): void {
    const t = this.now();
    for (const [key, list] of this.map) this.prune(key, list, t);
  }

  private prune(key: string, list: number[], t: number): number[] {
    const live = list.filter((ts) => t - ts < this.policy.windowMs);
    if (live.length === 0) this.map.delete(key);
    else if (live.length !== list.length) this.map.set(key, live);
    return live;
  }

  private reclaim(t: number): void {
    if (t - this.lastReclaim < RECLAIM_MIN_INTERVAL_MS) return;
    this.lastReclaim = t;
    for (const [key, list] of this.map) this.prune(key, list, t);
  }

  /** Audit run-1: make room for a fresh key by dropping the OLDEST-inserted
   * entry whose live count is below the enforcing floor (Map iterates in
   * insertion order). GA-06 intact: an enforced counter is only ever evicted
   * when nothing weaker remains. */
  private evictNonEnforcing(t: number): void {
    for (const [key, list] of this.map) {
      const live = list.filter((ts) => t - ts < this.policy.windowMs);
      if (live.length < this.enforcingFloor) {
        this.map.delete(key);
        return;
      }
    }
  }
}
