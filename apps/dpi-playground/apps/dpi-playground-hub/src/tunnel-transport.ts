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
 */
import { randomUUID } from "node:crypto";
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
  /** reqId → connectionId of recently settled requests (late-response grace). */
  private readonly settled = new Map<string, string>();
  /** The same grace for ABANDONED requests (timeout/abort/connection loss): the device may still be
   *  writing their response right now, and normal traffic must never churn these correlations away. */
  private readonly abandoned = new Map<string, string>();
  /** subscriptionId → connectionId of recently closed subscriptions (in-flight frames after an unsubscribe are benign). */
  private readonly closedSubs = new Map<string, string>();
  private readonly deadlineMs: number;
  private readonly audit?: Audit;

  constructor(
    private readonly server: TunnelServer,
    options: DispatcherOptions = {},
  ) {
    this.audit = options.audit;
    this.deadlineMs = options.deadlineMs ?? REST_TIMEOUT_MS;
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
    // Remember recently-settled reqIds (bounded): a late response for an
    // aborted/timed-out OWN request on the SAME connection is benign and must
    // not kill the connection; foreign reqIds still do (below). Abandoned
    // correlations get their own FIFO so busy normal traffic cannot evict the
    // correlation of a response that is still legitimately in flight.
    const map = outcome === "abandoned" ? this.abandoned : this.settled;
    map.set(reqId, p.connectionId);
    if (map.size > 256) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    return p;
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
        // Late response for an OWN settled request on the same connection:
        // ignore silently (the caller already moved on).
        if (
          p === undefined &&
          (this.settled.get(reqId) === conn.connectionId ||
            this.abandoned.get(reqId) === conn.connectionId)
        )
          return;
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
      });
      return;
    }
    if (type === "tunnel-chunk") {
      const chunk = frame as unknown as TunnelChunk;
      if (chunk.kind === "rest-response") {
        const pending = this.pending.get(chunk.reqId);
        // Match the plain-response grace before allocating any assembly.
        if (
          !pending &&
          (this.settled.get(chunk.reqId) === conn.connectionId ||
            this.abandoned.get(chunk.reqId) === conn.connectionId)
        )
          return;
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
   * subscription it just closed is benign (the device had it in flight) and is dropped; anything
   * else (never issued, or owned by another connection) is a protocol violation: deny, audit, cut (T-7).
   */
  private ownSubscription(
    conn: TunnelConnection,
    subscriptionId: string,
  ): Subscription | undefined {
    const sub = this.subs.get(subscriptionId);
    if (sub && sub.connectionId === conn.connectionId) return sub;
    if (!sub && this.closedSubs.get(subscriptionId) === conn.connectionId) return undefined;
    this.denyDevice(
      conn,
      "foreign_subscription",
      { endpoint: "tunnel.subscription", subscriptionId },
      "tunnel-data for a subscription this connection does not own",
    );
    return undefined;
  }

  private rememberClosedSubscription(subscriptionId: string, connectionId: string): void {
    this.closedSubs.set(subscriptionId, connectionId);
    if (this.closedSubs.size > 4_096) {
      const oldest = this.closedSubs.keys().next().value;
      if (oldest !== undefined) this.closedSubs.delete(oldest);
    }
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
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
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
