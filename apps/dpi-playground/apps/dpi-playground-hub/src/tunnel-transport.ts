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
import { validateRestRequest } from "../../../../dpi-sdk/src/protocol/tunnel.js";
import { REST_TIMEOUT_MS } from "../../../../dpi-sdk/src/protocol/limits.js";
import type { DeviceTransport, TransportRequest, TransportResponse } from "./transport.js";
import type { TunnelConnection, TunnelServer } from "./tunnel.js";

interface PendingRest {
  resolve: (r: TransportResponse) => void;
  reject: (e: unknown) => void;
  timer: NodeJS.Timeout;
  connectionId: string;
  signal: AbortSignal;
  onAbort: () => void;
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
 * pending request, tunnel-data feeds the matching subscription. Frames for
 * foreign/dead correlations are dropped (P2-16 adds deny/audit for spoofed
 * owners).
 */
export class TunnelDispatcher {
  private pending = new Map<string, PendingRest>();
  private subs = new Map<string, Subscription>();

  constructor(private readonly server: TunnelServer) {
    server.setHandlers({
      onMessage: (conn, frame) => this.route(conn, frame),
      onClose: (deviceId, connectionId) => this.dropConnection(deviceId, connectionId),
    });
  }

  private route(conn: TunnelConnection, frame: Record<string, unknown>): void {
    const type = frame.type as string;
    if (type === "rest-response") {
      const reqId = frame.reqId as string;
      const p = this.pending.get(reqId);
      // Foreign or already-settled responses never resolve someone else's
      // request; matching requires the SAME connection that owns the pending.
      if (!p || p.connectionId !== conn.connectionId) return;
      this.pending.delete(reqId);
      clearTimeout(p.timer);
      p.signal.removeEventListener("abort", p.onAbort);
      p.resolve({
        status: frame.status as number,
        contentType: frame.contentType as string | undefined,
        body: frame.body,
      });
      return;
    }
    if (type === "tunnel-data") {
      const sub = this.subs.get(frame.subscriptionId as string);
      if (!sub || sub.connectionId !== conn.connectionId) return;
      sub.push(frame.frame as Frame);
    }
    // tunnel-chunk routing lands with P2-16/17 (reassembler wiring).
  }

  private dropConnection(_deviceId: string, connectionId: string): void {
    for (const [reqId, p] of this.pending)
      if (p.connectionId === connectionId) {
        this.pending.delete(reqId);
        clearTimeout(p.timer);
        p.signal.removeEventListener("abort", p.onAbort);
        p.reject(new DpiError("offline", "Tunnel connection closed before the response", 0));
      }
    for (const [id, s] of this.subs)
      if (s.connectionId === connectionId) {
        this.subs.delete(id);
        s.signal.removeEventListener("abort", s.onAbort);
        s.close("tunnel connection closed");
      }
  }

  /** Reject/complete everything (hub shutdown). */
  close(): void {
    for (const [reqId, p] of this.pending) {
      this.pending.delete(reqId);
      clearTimeout(p.timer);
      p.signal.removeEventListener("abort", p.onAbort);
      p.reject(new DpiError("offline", "Hub shutting down", 0));
    }
    for (const [id, s] of this.subs) {
      this.subs.delete(id);
      s.signal.removeEventListener("abort", s.onAbort);
      s.close("hub shutting down");
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }
  subscriptionCount(): number {
    return this.subs.size;
  }

  /** Request over the device's CURRENT connection; swap/timeout/offline reject. */
  request(deviceId: string, input: TransportRequest, signal: AbortSignal): Promise<TransportResponse> {
    const check = validateRestRequest({ method: input.method, path: input.path });
    if (!check.ok) return Promise.reject(new DpiError("invalid", check.error));
    if (!this.server.hasConnection(deviceId))
      return Promise.reject(new DpiError("offline", "No tunnel connection is live", 0));
    const connectionId = this.server.connectionIdOf(deviceId)!;
    const reqId = randomUUID();
    return new Promise<TransportResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        signal.removeEventListener("abort", onAbort);
        reject(new DpiError("offline", `Tunnel REST timeout (${input.path})`, 0));
      }, REST_TIMEOUT_MS);
      const onAbort = () => {
        const p = this.pending.get(reqId);
        this.pending.delete(reqId);
        clearTimeout(timer);
        reject(new DpiError("offline", "Aborted", 0));
        void p;
      };
      this.pending.set(reqId, {
        resolve, reject, timer, connectionId, signal, onAbort,
      });
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
        this.pending.delete(reqId);
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(new DpiError("offline", "Tunnel connection closed while sending", 0));
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
      signal.removeEventListener("abort", sub.onAbort);
      // Best-effort unsubscribe so the device stops the reader it opened.
      if (this.server.hasConnection(deviceId))
        this.server.send(deviceId, { type: "control", action: "unsubscribe", subscriptionId, sub: input.path });
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

  async *watch(input: { path: string; consumerId: string }, signal: AbortSignal): AsyncIterable<Frame> {
    yield* this.dispatcher.watch(this.deviceId, input, signal);
  }
}
