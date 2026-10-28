/**
 * TunnelTransport + hub-side tunnel dispatcher — P2-15 (spec 04 §1/§4/§8).
 *
 * The ONLY transport for tunnel devices: monitor probes and watches flow over
 * the live authenticated connection. No URL/token is read for tunnel rows and
 * there is never a LAN fallback. Requests carry a connection generation so a
 * swap (old socket superseded) fails them fast instead of resolving stale
 * results onto a new connection's status.
 *
 * REST hardening (pending caps, path allowlist enforcement on the hub side,
 * chunked responses, mutation safety) lands in P2-16; this file owns routing.
 *
 * R9 (audit 4.1/4.3): the late-frame grace sets evict by TTL as well as by
 * capacity — an entry older than REST_GRACE_TTL_MS is unmatchable by any
 * in-flight caller — and every eviction (age or capacity) is remembered in a
 * bounded `dropped` ring so the late frame that eventually arrives for it is
 * recognized as inert instead of foreign: reconnect churn must never cut a
 * healthy connection. Un-keyed tunnel mutations get a deterministic
 * idempotency key so a hub retry after a connection swap deduplicates
 * device-side instead of double-applying.
 */
import { createHash, randomUUID } from "node:crypto";
import { DpiError } from "../../../../dpi-sdk/src/errors.js";
import type { Frame } from "../../../../dpi-sdk/src/api.js";
import {
  checkDeviceFrame,
  validateRestRequest,
  type TunnelChunk,
} from "../../../../dpi-sdk/src/protocol/tunnel.js";
import {
  CONNECTION_BUFFER_BUDGET_BYTES,
  REST_BODY_MAX_BYTES,
  REST_GRACE_TTL_MS,
  REST_PENDING_PER_DEVICE,
  REST_PENDING_PER_HUB,
  REST_TIMEOUT_MS,
} from "../../../../dpi-sdk/src/protocol/limits.js";
import { ByteBudget, ChunkReassembler } from "../../../../dpi-sdk/src/node/chunk.js";
import type { DeviceTransport, TransportRequest, TransportResponse } from "./transport.js";

/** Device frames are untrusted at the ADMIN origin: printable ASCII only, bounded length
 *  (defense in depth — the device already sanitizes before putting it on the wire). */
const safeHeaderValue = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[^\x20-\x7E]/g, "").slice(0, 200).trim();
  return clean.length > 0 ? clean : undefined;
};
import type { TunnelConnection, TunnelServer } from "./tunnel.js";
import type { Audit } from "./audit.js";

interface PendingRest {
  resolve: (r: TransportResponse) => void;
  reject: (e: unknown) => void;
  timer: NodeJS.Timeout;
  connectionId: string;
  deviceId: string;
  signal: AbortSignal;
  onAbort: () => void;
  reservation?: { release(): void };
}

interface Subscription {
  connectionId: string;
  deviceId: string;
  push: (frame: Frame) => void;
  close: (reason: string) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

/** A grace-set entry: which connection owned the correlation, and when it left the pending maps. */
interface GraceEntry {
  connectionId: string;
  at: number;
}

/** settled/abandoned reqId grace cap (hard memory backstop; TTL is the primary bound). */
const REST_GRACE_MAP_CAP = 256;
/** closed-subscription grace cap. */
const CLOSED_SUBS_GRACE_CAP = 4_096;
/** Hard cap for the evicted-correlation ring (same order as the grace caps). */
const GRACE_RING_CAP = 4_096;

/**
 * Routes inbound device→hub frames: rest-response resolves the matching
 * pending request, tunnel-data feeds the matching subscription. A frame for a
 * correlation the sending connection does not own is denied, audited and cuts
 * that connection (T-7); a late frame for its OWN just-settled request or
 * just-closed subscription is dropped silently.
 */
export interface DispatcherOptions {
  audit?: Audit;
  /** Test-only deadline policy (production: CANON REST_TIMEOUT_MS). */
  deadlineMs?: number;
  /** Test-only late-frame grace TTL (production: CANON REST_GRACE_TTL_MS). */
  graceTtlMs?: number;
  /** Test-only clock for the grace sets (production: Date.now). */
  now?: () => number;
  /** Shared admission for REST payloads, reassembly and SSE output. */
  budget?: ByteBudget;
  /** Per-connection share of `budget` (production: CANON 32 MiB). */
  connectionBudgetBytes?: number;
}

export class TunnelDispatcher {
  private pending = new Map<string, PendingRest>();
  private pendingByDevice = new Map<string, Set<string>>();
  private subs = new Map<string, Subscription>();
  private readonly budget: ByteBudget;
  private readonly connectionBudgetBytes: number;
  /** connectionId → that connection's share of the hub budget (reassembly + pending REST payloads). */
  private readonly connectionBudgets = new Map<string, ByteBudget>();
  private readonly reassemblers = new Map<string, ChunkReassembler>(); // connectionId → reassembler
  /** reqId → recently settled requests (late-response grace, TTL + capped). */
  private readonly settled = new Map<string, GraceEntry>();
  /** The same grace for ABANDONED requests (timeout/abort/connection loss): the device may still be
   *  writing their response right now, and normal traffic must never churn these correlations away. */
  private readonly abandoned = new Map<string, GraceEntry>();
  /** subscriptionId → recently closed subscriptions (in-flight frames after an unsubscribe are benign). */
  private readonly closedSubs = new Map<string, GraceEntry>();
  /** Correlations that left a grace set (TTL-expired or capacity-evicted) → removal time. Their
   *  late frames resolve nothing and are dropped, never cut — cutting them is what turned reconnect
   *  churn into connection storms (R9 4.1). Bounded like the grace sets themselves. */
  private readonly dropped = new Map<string, number>();
  private readonly deadlineMs: number;
  private readonly graceTtlMs: number;
  private readonly now: () => number;
  private readonly audit?: Audit;

  constructor(
    private readonly server: TunnelServer,
    options: DispatcherOptions = {},
  ) {
    this.audit = options.audit;
    this.deadlineMs = options.deadlineMs ?? REST_TIMEOUT_MS;
    this.graceTtlMs = options.graceTtlMs ?? REST_GRACE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.budget = options.budget ?? new ByteBudget("rest", 64 * 1024 * 1024);
    this.connectionBudgetBytes = options.connectionBudgetBytes ?? CONNECTION_BUFFER_BUDGET_BYTES;
    server.setHandlers({
      onMessage: (conn, frame) => this.route(conn, frame),
      onClose: (deviceId, connectionId) => this.dropConnection(deviceId, connectionId),
    });
  }

  private settle(
    reqId: string,
    outcome: "answered" | "abandoned" = "answered",
  ): PendingRest | undefined {
    const p = this.pending.get(reqId);
    if (!p) return undefined;
    this.pending.delete(reqId);
    const set = this.pendingByDevice.get(p.deviceId);
    set?.delete(reqId);
    clearTimeout(p.timer);
    p.signal.removeEventListener("abort", p.onAbort);
    p.reservation?.release();
    this.reassemblers.get(p.connectionId)?.abort({ kind: "rest-response", reqId });
    // Remember recently-settled reqIds (bounded + TTL'd): a late response for an
    // aborted/timed-out OWN request on the SAME connection is benign and must
    // not kill the connection; foreign reqIds still do (below). Abandoned
    // correlations get their own map so busy normal traffic cannot evict the
    // correlation of a response that is still legitimately in flight.
    const map = outcome === "abandoned" ? this.abandoned : this.settled;
    this.gracePut(map, reqId, p.connectionId, REST_GRACE_MAP_CAP);
    return p;
  }

  /**
   * Insert into a grace set: TTL-evict first (an entry older than the grace TTL is unmatchable by
   * any in-flight caller — the device's own send tail is inside the TTL, see REST_GRACE_TTL_MS),
   * then the capacity cap as the hard memory backstop. Everything removed lands in the `dropped`
   * ring so the late frame that eventually arrives for it is inert, not foreign (R9 4.1).
   */
  private gracePut(
    map: Map<string, GraceEntry>,
    id: string,
    connectionId: string,
    cap: number,
  ): void {
    const ts = this.now();
    for (const [key, entry] of map) {
      if (ts - entry.at <= this.graceTtlMs) break; // insertion order == age order
      map.delete(key);
      this.rememberDropped(key, ts);
    }
    map.set(id, { connectionId, at: ts });
    while (map.size > cap) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
      this.rememberDropped(oldest, ts);
    }
  }

  /** Grace-set lookup: an entry past its TTL retires to the ring on first touch. */
  private graceOwns(map: Map<string, GraceEntry>, id: string, connectionId: string): boolean {
    const entry = map.get(id);
    if (!entry) return false;
    if (this.now() - entry.at > this.graceTtlMs) {
      map.delete(id);
      this.rememberDropped(id, this.now());
    }
    return entry.connectionId === connectionId;
  }

  /** True while a removed correlation is recent enough that its late frames are inert, not foreign. */
  private wasDropped(id: string): boolean {
    const at = this.dropped.get(id);
    if (at === undefined) return false;
    if (this.now() - at > this.graceTtlMs) {
      this.dropped.delete(id);
      return false;
    }
    return true;
  }

  private rememberDropped(id: string, at: number): void {
    this.dropped.set(id, at);
    for (const [key, t] of this.dropped) {
      if (at - t <= this.graceTtlMs) break; // front is the oldest removal
      this.dropped.delete(key);
    }
    while (this.dropped.size > GRACE_RING_CAP) {
      const oldest = this.dropped.keys().next().value;
      if (oldest === undefined) break;
      this.dropped.delete(oldest);
    }
  }

  /**
   * A late rest frame for a correlation this hub recently issued: still inside a grace set, or
   * recently expired/evicted from one (the `dropped` ring). Such a frame can resolve nothing — its
   * pending is gone — so it is dropped silently; cutting the sender here is what turned reconnect
   * churn into connection storms (R9 4.1). A correlation that is pending on ANOTHER connection or
   * was never issued is still foreign and still cuts (T-7).
   */
  private lateFrameIsBenign(id: string, connectionId: string): boolean {
    if (this.graceOwns(this.settled, id, connectionId)) return true;
    if (this.graceOwns(this.abandoned, id, connectionId)) return true;
    return this.wasDropped(id);
  }

  /**
   * A device addressed a correlation it does not own: audit it (a storage
   * fault must not decide whether the sender is cut) and close the connection.
   */
  private denyDevice(
    conn: TunnelConnection,
    code: string,
    detail: Record<string, unknown>,
    closeReason: string,
  ): void {
    try {
      this.audit?.append({
        actor: `device:${conn.deviceId}`,
        action: "auth.denied",
        outcome: "denied",
        connectionId: conn.connectionId,
        detail: { endpoint: "tunnel.rest", code, ...detail },
      });
    } catch {
      /* the close below is the enforcement; the row is evidence only */
    }
    this.server.closeConnection(conn.deviceId, 1008, closeReason);
  }

  private route(conn: TunnelConnection, frame: Record<string, unknown>): void {
    const type = frame.type as string;
    if (type === "rest-response") {
      const reqId = frame.reqId as string;
      const p = this.pending.get(reqId);
      // Foreign or already-settled responses never resolve someone else's
      // request; matching requires the SAME connection that owns the pending.
      if (!p || p.connectionId !== conn.connectionId) {
        // Late response for an OWN settled/abandoned request — or one whose grace
        // entry just expired/was evicted — on the same connection: ignore silently
        // (the caller already moved on; the frame resolves nothing).
        if (p === undefined && this.lateFrameIsBenign(reqId, conn.connectionId)) return;
        if (p !== undefined && p.connectionId !== conn.connectionId) {
          // A response claiming a reqId owned by ANOTHER connection: attack.
        }
        // A response for a request this connection never owned is a protocol
        // violation: deny, audit, and stop trusting the sender (04 §9).
        this.denyDevice(conn, "foreign_response", { reqId }, "rest-response for a foreign reqId");
        return;
      }
      this.settle(reqId)!.resolve({
        status: frame.status as number,
        contentType: frame.contentType as string | undefined,
        body: frame.body,
        ...(frame.bodyEncoding === "base64" ? { bodyEncoding: "base64" as const } : {}),
        ...(frame.bodyEncoding === "base64"
          ? { contentDisposition: safeHeaderValue(frame.contentDisposition) }
          : {}),
        ...(frame.idempotentReplay === true ? { idempotentReplay: true as const } : {}),
      });
      return;
    }
    if (type === "tunnel-chunk") {
      const chunk = frame as unknown as TunnelChunk;
      if (chunk.kind === "rest-response") {
        const pending = this.pending.get(chunk.reqId);
        // Match the plain-response grace before allocating any assembly.
        if (!pending && this.lateFrameIsBenign(chunk.reqId, conn.connectionId)) return;
        if (!pending || pending.connectionId !== conn.connectionId) {
          this.denyDevice(
            conn,
            "foreign_chunk",
            { reqId: chunk.reqId },
            "tunnel-chunk for a foreign reqId",
          );
          return;
        }
        const out = this.reassemblerFor(conn).feed(chunk, (c) => {
          if (c.kind !== "rest-response") return false;
          return this.pending.get(c.reqId)?.connectionId === conn.connectionId;
        });
        if (!out.ok) {
          const p = this.settle(chunk.reqId, "abandoned");
          p?.resolve({
            status: 502,
            body: { error: { code: "response_too_large", message: out.error } },
          });
          return;
        }
        if (out.done) {
          const p = this.settle(chunk.reqId);
          // The chunked logical message IS the rest-response envelope — and it travelled
          // inside chunk data with no schema. A missing or non-numeric status is the device
          // breaking contract: answer a bad gateway, never a silently defaulted 200.
          const env = out.value as
            | {
                status?: unknown;
                contentType?: unknown;
                body?: unknown;
                bodyEncoding?: unknown;
                contentDisposition?: unknown;
                idempotentReplay?: unknown;
              }
            | undefined;
          if (typeof env?.status !== "number" || !Number.isFinite(env.status)) {
            p?.resolve({
              status: 502,
              body: {
                error: { code: "invalid", message: "Device envelope out of contract (status)" },
              },
            });
            return;
          }
          p?.resolve({
            status: env.status,
            contentType: typeof env.contentType === "string" ? env.contentType : undefined,
            body: env.body,
            ...(env.bodyEncoding === "base64" ? { bodyEncoding: "base64" as const } : {}),
            ...(env.bodyEncoding === "base64"
              ? { contentDisposition: safeHeaderValue(env.contentDisposition) }
              : {}),
            ...(env.idempotentReplay === true ? { idempotentReplay: true as const } : {}),
            rawBytes: out.rawBytes,
          });
        }
        return;
      }
      if (chunk.kind === "tunnel-data") {
        // Large reader frames (big trees) arrive chunked; reassemble BEFORE
        // routing so consumers never see chunk plumbing. An oversize/invalid
        // assembly faults THIS reader only — the tunnel stays up.
        const sub = this.ownSubscription(conn, chunk.subscriptionId);
        if (!sub) return;
        const out = this.reassemblerFor(conn).feed(chunk, (c) => {
          if (c.kind !== "tunnel-data") return false;
          const s = this.subs.get(c.subscriptionId);
          return !!s && s.connectionId === conn.connectionId;
        });
        if (!out.ok) {
          // Clear reader-level fault (bad chunk math/metadata/cap); the
          // tunnel stays up and the device may start a fresh assembly.
          sub.push({
            type: "fault",
            error: { code: "invalid", message: out.error ?? "chunk assembly failed" },
          } as unknown as Frame);
          return;
        }
        if (out.done)
          sub.push(
            checkDeviceFrame(out.value)
              ? out.value
              : {
                  type: "fault",
                  error: { code: "invalid", message: "Invalid device stream frame" },
                },
          );
        return;
      }
      return;
    }
    if (type === "tunnel-data") {
      const sub = this.ownSubscription(conn, frame.subscriptionId as string);
      if (!sub) return;
      sub.push(
        checkDeviceFrame(frame.frame)
          ? frame.frame
          : {
              type: "fault",
              error: { code: "invalid", message: "Invalid device stream frame" },
            },
      );
    }
  }

  /**
   * The live subscription a device frame addresses, if this connection owns it. A frame for a
   * subscription it just closed (or whose closed-subscription grace entry just expired) is benign
   * (the device had it in flight) and is dropped; anything else (never issued, or owned by another
   * connection) is a protocol violation: deny, audit, cut (T-7).
   */
  private ownSubscription(
    conn: TunnelConnection,
    subscriptionId: string,
  ): Subscription | undefined {
    const sub = this.subs.get(subscriptionId);
    if (sub && sub.connectionId === conn.connectionId) return sub;
    if (!sub && this.graceOwns(this.closedSubs, subscriptionId, conn.connectionId))
      return undefined;
    if (!sub && this.wasDropped(subscriptionId)) return undefined;
    this.denyDevice(
      conn,
      "foreign_subscription",
      { endpoint: "tunnel.subscription", subscriptionId },
      "tunnel-data for a subscription this connection does not own",
    );
    return undefined;
  }

  private rememberClosedSubscription(subscriptionId: string, connectionId: string): void {
    this.gracePut(this.closedSubs, subscriptionId, connectionId, CLOSED_SUBS_GRACE_CAP);
  }

  /**
   * One device connection may hold at most its own 32 MiB inside the hub-wide
   * 64 MiB (04 §3.3): a device that declares large messages exhausts its own
   * share, never the whole hub's.
   */
  private budgetFor(connectionId: string): ByteBudget {
    let budget = this.connectionBudgets.get(connectionId);
    if (!budget) {
      budget = new ByteBudget("connection", this.connectionBudgetBytes, this.budget);
      this.connectionBudgets.set(connectionId, budget);
    }
    return budget;
  }

  private reassemblerFor(conn: TunnelConnection): ChunkReassembler {
    let re = this.reassemblers.get(conn.connectionId);
    if (!re) {
      re = new ChunkReassembler(this.budgetFor(conn.connectionId));
      this.reassemblers.set(conn.connectionId, re);
    }
    return re;
  }

  private dropConnection(deviceId: string, connectionId: string): void {
    this.reassemblers.get(connectionId)?.abortAll();
    this.reassemblers.delete(connectionId);
    for (const [reqId, p] of this.pending)
      if (p.connectionId === connectionId) {
        this.settle(reqId, "abandoned");
        p.reject(
          new DpiError("offline", "Tunnel connection closed before the outcome is known", 503),
        );
      }
    this.connectionBudgets.delete(connectionId);
    for (const [id, s] of this.subs)
      if (s.connectionId === connectionId) {
        this.subs.delete(id);
        s.signal.removeEventListener("abort", s.onAbort);
        s.close("tunnel connection closed");
      }
  }

  /** Reject/complete everything (hub shutdown). */
  close(): void {
    for (const re of this.reassemblers.values()) re.abortAll();
    this.reassemblers.clear();
    for (const [reqId, p] of this.pending) {
      this.settle(reqId, "abandoned");
      p.reject(new DpiError("offline", "Hub shutting down", 503));
    }
    this.connectionBudgets.clear();
    for (const [id, s] of this.subs) {
      this.subs.delete(id);
      s.signal.removeEventListener("abort", s.onAbort);
      s.close("hub shutting down");
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /** Test visibility into the bounded grace state (R9 4.1). */
  graceSizes(): { settled: number; abandoned: number; closedSubs: number; dropped: number } {
    return {
      settled: this.settled.size,
      abandoned: this.abandoned.size,
      closedSubs: this.closedSubs.size,
      dropped: this.dropped.size,
    };
  }
  subscriptionCount(deviceId?: string): number {
    return deviceId === undefined
      ? this.subs.size
      : [...this.subs.values()].filter((sub) => sub.deviceId === deviceId).length;
  }

  /** Request over the device's CURRENT connection; swap/timeout/offline reject. */
  request(
    deviceId: string,
    input: TransportRequest,
    signal: AbortSignal,
  ): Promise<TransportResponse> {
    const check = validateRestRequest({ method: input.method, path: input.path });
    if (!check.ok) return Promise.reject(new DpiError("invalid", check.error, 400));
    if (!this.server.hasConnection(deviceId))
      return Promise.reject(new DpiError("offline", "No tunnel connection is live", 503));
    // Request body cap BEFORE anything is serialized onto the tunnel (413).
    let serialized: string | undefined;
    if (input.body !== undefined) {
      serialized = JSON.stringify(input.body);
      if (Buffer.byteLength(serialized, "utf8") > REST_BODY_MAX_BYTES)
        return Promise.reject(
          new DpiError("invalid", `Request body exceeds ${REST_BODY_MAX_BYTES} bytes`, 413),
        );
    }
    // R9 (audit 4.3): un-keyed tunnel MUTATIONS get a deterministic idempotency key so a
    // hub retry after a connection swap/abandon (503 to the caller, then a re-send with a
    // fresh reqId) lands on the SAME device-side key: the device's create-route idempotency
    // (requests table + in-flight map) answers the replay instead of double-applying. The
    // key is derived from the content — method + path + serialized body — so it is identical
    // across the retry and independent of the connection that carried the first attempt.
    // Reads (GET/HEAD) stay un-keyed: nothing to deduplicate. Collateral: two DELIBERATE
    // identical mutations inside the device's 24 h requests retention collapse to the first
    // outcome — accepted, because the alternative is a silent at-least-once mutation on every
    // connection swap. The prefix marks hub-derived keys in device logs; 73 chars fits the
    // device's 128-char header cap and the wire schema's 256.
    const idempotencyKey =
      input.idempotencyKey ??
      (input.method === "GET" || input.method === "HEAD"
        ? undefined
        : "dpi-auto-" +
          createHash("sha256")
            .update(`${input.method} ${input.path}\u0000${serialized ?? ""}`, "utf8")
            .digest("hex"));
    // Pending caps: 32/device, 256/hub (429 when full — no silent queueing).
    let deviceSet = this.pendingByDevice.get(deviceId);
    if (!deviceSet) {
      deviceSet = new Set();
      this.pendingByDevice.set(deviceId, deviceSet);
    }
    if (deviceSet.size >= REST_PENDING_PER_DEVICE || this.pending.size >= REST_PENDING_PER_HUB)
      return Promise.reject(
        new DpiError("rate_limited", `Too many pending tunnel requests for ${deviceId}`, 429),
      );
    const connectionId = this.server.connectionIdOf(deviceId)!;
    const reqId = randomUUID();
    // The connection's share (inside the hub budget) covers the outbound request bytes until settled.
    const reservation = this.budgetFor(connectionId).reserve(
      Buffer.byteLength(serialized ?? "", "utf8") + 512,
    );
    if (!reservation)
      return Promise.reject(new DpiError("rate_limited", "Hub REST buffer budget exhausted", 429));
    return new Promise<TransportResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(reqId, "abandoned");
        reject(new DpiError("offline", `Tunnel REST deadline (${input.path})`, 504));
      }, this.deadlineMs);
      const onAbort = () => {
        this.settle(reqId, "abandoned");
        reject(new DpiError("offline", "Aborted", 499));
      };
      this.pending.set(reqId, {
        resolve,
        reject,
        timer,
        connectionId,
        deviceId,
        signal,
        onAbort,
        reservation,
      });
      deviceSet!.add(reqId);
      signal.addEventListener("abort", onAbort, { once: true });
      const sent = this.server.send(deviceId, {
        type: "rest-request",
        reqId,
        method: input.method as "GET",
        path: input.path,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
      });
      if (!sent) {
        this.settle(reqId, "abandoned");
        reject(
          new DpiError("offline", "Tunnel connection closed before the outcome is known", 503),
        );
      }
    });
  }

  /**
   * Watch `path` on the device: subscribe with a fresh subscriptionId, yield
   * frames until the consumer aborts, the connection swaps, or the hub closes.
   * A swap ends THIS generator (monitor reconnect logic decides what next);
   * the new connection gets a new subscriptionId — never a reused identity.
   */
  async *watch(
    deviceId: string,
    input: { path: string; consumerId: string },
    signal: AbortSignal,
  ): AsyncIterable<Frame> {
    if (!this.server.hasConnection(deviceId))
      throw new DpiError("offline", "No tunnel connection is live", 0);
    const connectionId = this.server.connectionIdOf(deviceId)!;
    const subscriptionId = randomUUID();
    const queue: Frame[] = [];
    let wakeup: (() => void) | undefined;
    let closed: string | undefined;
    const sub: Subscription = {
      connectionId,
      deviceId,
      push: (frame) => {
        queue.push(frame);
        wakeup?.();
      },
      close: (reason) => {
        closed = reason;
        wakeup?.();
      },
      signal,
      onAbort: () => sub.close("consumer aborted"),
    };
    this.subs.set(subscriptionId, sub);
    signal.addEventListener("abort", sub.onAbort, { once: true });
    try {
      const sent = this.server.send(deviceId, {
        type: "control",
        action: "subscribe",
        subscriptionId,
        sub: input.path,
      });
      if (!sent) throw new DpiError("offline", "Tunnel connection closed while subscribing", 0);
      while (!closed && !signal.aborted) {
        const frame = queue.shift();
        if (frame) {
          yield frame;
          continue;
        }
        await new Promise<void>((resolve) => {
          wakeup = resolve;
        });
        wakeup = undefined;
      }
      if (closed && closed !== "consumer aborted") throw new DpiError("offline", closed, 0);
    } finally {
      this.subs.delete(subscriptionId);
      this.rememberClosedSubscription(subscriptionId, connectionId);
      this.reassemblers
        .get(connectionId)
        ?.abort({ kind: "tunnel-data", subscriptionId, sub: input.path });
      signal.removeEventListener("abort", sub.onAbort);
      // Best-effort unsubscribe so the device stops the reader it opened.
      if (this.server.hasConnection(deviceId))
        this.server.send(deviceId, {
          type: "control",
          action: "unsubscribe",
          subscriptionId,
          sub: input.path,
        });
    }
  }
}

/** DeviceTransport view over the dispatcher for one tunnel device. */
export class TunnelTransport implements DeviceTransport {
  readonly kind = "tunnel" as const;
  readonly deviceId: string;

  constructor(
    row: { id: string; transport: string },
    private readonly dispatcher: TunnelDispatcher,
  ) {
    this.deviceId = row.id;
  }

  get available(): boolean {
    return true; // liveness is decided per request/watch, not at construction
  }

  request(input: TransportRequest, signal: AbortSignal): Promise<TransportResponse> {
    return this.dispatcher.request(this.deviceId, input, signal);
  }

  async *watch(
    input: { path: string; consumerId: string },
    signal: AbortSignal,
  ): AsyncIterable<Frame> {
    yield* this.dispatcher.watch(this.deviceId, input, signal);
  }
}
