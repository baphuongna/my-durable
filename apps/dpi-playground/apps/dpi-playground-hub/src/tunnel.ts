/**
 * Hub WSS tunnel endpoint — Durable Agent Network P2-12 (spec 04 §4).
 *
 * Upgrade path `/api/tunnel` on the hub's HTTP server, behind the TLS reverse
 * proxy. Auth is hash-first: the bearer token is hashed exactly once and
 * looked up through the unique `tunnel_credentials.token_hash` index; every
 * decision after that (revoked tombstone, retired, pairing epoch) reads the
 * row that the hash resolved to. Auth errors are raw HTTP JSON responses —
 * there is no WebSocket, no WS close and no control frame before 101.
 *
 * After 101 the connection is in `awaiting-handshake` for HANDSHAKE_DEADLINE_MS
 * and only a tuple-correct `pair-handshake` (checked against the AUTHED row,
 * including a previous-generation credential) flips it to `open`, swaps out
 * any prior authenticated connection for that device, and answers `hello`.
 * Hello makes the transport available; it does NOT mark the device online —
 * monitor online is a REST-probe decision that lands with P2-16.
 *
 * All numbers come from protocol limits (CANON); the rate/connection policy
 * below is hub-side constructor-injected deployment policy, never overridable
 * per request.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { NetworkRegistry } from "../../../../dpi-sdk/src/node/registry.js";
import {
  checkTunnelMessage,
  allowedInPhase,
  assertDirection,
  type TunnelFrame,
  type TunnelWireMessage,
} from "../../../../dpi-sdk/src/protocol/tunnel.js";
import {
  HANDSHAKE_DEADLINE_MS,
  IDLE_TIMEOUT_MS,
  PING_INTERVAL_MS,
  PING_MISS_LIMIT,
  WS_MAX_MESSAGE_BYTES,
} from "../../../../dpi-sdk/src/protocol/limits.js";
import { Audit } from "./audit.js";

export interface TunnelPolicy {
  /** Upgrade attempts per client IP per minute (token bucket). */
  ipPerMinute: number;
  /** Hub-wide upgrade attempts per minute. */
  globalPerMinute: number;
  /** Concurrent authenticated connections hub-wide. */
  maxAuthenticated: number;
  /** Concurrent sockets between 101 and a valid handshake. */
  maxPendingHandshakes: number;
  /** Upper bound for retryAfterMs in 429 bodies (bounded per 04 §6). */
  retryAfterMaxMs: number;
}

const DEFAULT_POLICY: TunnelPolicy = {
  ipPerMinute: 30,
  globalPerMinute: 120,
  maxAuthenticated: 256,
  maxPendingHandshakes: 64,
  retryAfterMaxMs: 60_000,
};

export interface TunnelHandlers {
  /** A connection completed handshake and received hello (transport available, NOT monitor online). */
  onOpen?(conn: TunnelConnection): void;
  /** A schema/direction/phase-valid device→hub frame on an open connection. */
  onMessage?(conn: TunnelConnection, frame: TunnelWireMessage): void;
  /** An authenticated connection went away (swap, close, error). */
  onClose?(deviceId: string, connectionId: string): void;
}

export interface TunnelConnection {
  readonly deviceId: string;
  readonly deviceUid: string;
  readonly connectionId: string;
  readonly pairingEpoch: string;
  readonly credentialId: string;
  readonly generation: number;
  /** Direction/phase-checked outbound send; false when the socket is gone. */
  send(frame: TunnelFrame): boolean;
  close(code: number, reason: string): void;
}

export interface TunnelTestHooks {
  now?(): number;
}

interface AuthedRow {
  credential_id: string;
  device_id: string;
  pairing_epoch: string;
  generation: number;
  status: string;
}

interface Conn {
  ws: WebSocket;
  auth: AuthedRow;
  deviceUid: string;
  connectionId: string;
  phase: "awaiting-handshake" | "open" | "closed";
  handshakeTimer?: NodeJS.Timeout;
  pingTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  pongMisses: number;
  lastByte: number;
}

/** Bounded token bucket (per key) with continuous refill. */
class Buckets {
  private map = new Map<string, { tokens: number; last: number }>();
  constructor(
    private readonly perMinute: number,
    private readonly capacity: number,
    private readonly maxKeys: number,
    private readonly now: () => number,
  ) {}
  take(key: string): { ok: boolean; retryAfterMs: number } {
    const t = this.now();
    let b = this.map.get(key);
    if (!b) {
      if (this.map.size >= this.maxKeys) {
        // Bound memory: evict fully-refilled (idle) buckets first.
        for (const [k, v] of this.map)
          if (v.tokens >= this.capacity) this.map.delete(k);
        if (this.map.size >= this.maxKeys) return { ok: false, retryAfterMs: 60_000 };
      }
      b = { tokens: this.capacity, last: t };
      this.map.set(key, b);
    }
    const refill = ((t - b.last) / 60_000) * this.perMinute;
    if (refill > 0) {
      b.tokens = Math.min(this.capacity, b.tokens + refill);
      b.last = t;
    }
    if (b.tokens < 1) return { ok: false, retryAfterMs: Math.ceil(((1 - b.tokens) / this.perMinute) * 60_000) };
    b.tokens -= 1;
    return { ok: true, retryAfterMs: 0 };
  }
}

export class TunnelServer {
  private readonly wss: WebSocketServer;
  private readonly connections = new Map<string, Conn>(); // deviceId → authenticated
  private readonly ipBuckets: Buckets;
  private readonly globalBuckets: Buckets;
  private pendingHandshakes = 0;

  constructor(
    private readonly registry: NetworkRegistry,
    private readonly audit: Audit,
    private readonly hubId: string,
    handlers: TunnelHandlers = {},
    policy: Partial<TunnelPolicy> = {},
    hooks: TunnelTestHooks = {},
  ) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.handlers = handlers;
    this.now = hooks.now ?? Date.now;
    this.ipBuckets = new Buckets(this.policy.ipPerMinute, this.policy.ipPerMinute, 1024, this.now);
    this.globalBuckets = new Buckets(this.policy.globalPerMinute, this.policy.globalPerMinute, 1, this.now);
    this.wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_MESSAGE_BYTES, perMessageDeflate: false });
  }

  private readonly policy: TunnelPolicy;
  private handlers: TunnelHandlers;
  private readonly now: () => number;

  /** Authenticated connection count (diagnostics/tests). */
  activeCount(): number {
    return this.connections.size;
  }

  /** True when the device has an open, handshake-complete tunnel connection. */
  hasConnection(deviceId: string): boolean {
    return this.connections.get(deviceId)?.phase === "open";
  }

  /** Current authenticated connectionId, or undefined when offline. */
  connectionIdOf(deviceId: string): string | undefined {
    const c = this.connections.get(deviceId);
    return c && c.phase === "open" ? c.connectionId : undefined;
  }

  /**
   * Replace the handlers (the dispatcher installs itself after construction).
   * Per-connection frame validation (schema/direction/phase) has already run
   * by the time onMessage fires.
   */
  setHandlers(handlers: TunnelHandlers): void {
    this.handlers = handlers;
  }

  /** Send a frame to the device's current connection (no-op when offline). */
  send(deviceId: string, frame: TunnelFrame): boolean {
    const c = this.connections.get(deviceId);
    if (!c || c.phase !== "open" || c.ws.readyState !== c.ws.OPEN) return false;
    try {
      c.ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  /** Server 'upgrade' listener: exact path/method, then rate caps, then auth. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let path = "/";
    try {
      path = new URL(req.url ?? "/", "http://hub.local").pathname;
    } catch {
      /* fall through to reject */
    }
    if (req.method !== "GET" || path !== "/api/tunnel") {
      this.httpJson(socket, 404, { type: "tunnel.auth-error", v: 1, code: "token_unknown", message: "tunnel: wrong endpoint" });
      return;
    }
    const ip = req.socket.remoteAddress ?? "unknown";
    const ipCheck = this.ipBuckets.take(ip);
    const globalCheck = this.globalBuckets.take("*");
    const check = ipCheck.ok ? globalCheck : ipCheck;
    if (!check.ok) {
      this.audit.append({
        actor: `ip:${ip}`,
        action: "rate_limited",
        outcome: "denied",
        detail: { endpoint: "tunnel.upgrade", scope: ipCheck.ok ? "global" : "ip" },
      });
      this.httpJson(socket, 429, {
        type: "tunnel.auth-error",
        v: 1,
        code: "rate_limited",
        message: "tunnel: too many upgrade attempts",
        retryAfterMs: Math.max(1, Math.min(this.policy.retryAfterMaxMs, check.retryAfterMs)),
      });
      return;
    }
    if (this.pendingHandshakes >= this.policy.maxPendingHandshakes || this.connections.size >= this.policy.maxAuthenticated) {
      this.httpJson(socket, 429, {
        type: "tunnel.auth-error",
        v: 1,
        code: "rate_limited",
        message: "tunnel: hub at connection capacity",
        retryAfterMs: Math.min(this.policy.retryAfterMaxMs, 5_000),
      });
      return;
    }

    const m = /^Bearer (dpt_[A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization ?? "").trim());
    if (!m) {
      this.deny(socket, ip, "token_unknown", "tunnel: missing or malformed bearer credential");
      return;
    }
    // Hash exactly once; the unique token_hash index does the lookup.
    const hash = createHash("sha256").update(m[1], "utf8").digest("hex");
    const row = this.registry.db
      .prepare(
        "SELECT credential_id, device_id, pairing_epoch, generation, status FROM tunnel_credentials WHERE token_hash=?",
      )
      .get(hash) as AuthedRow | undefined;
    if (!row || row.status === "retired") {
      this.deny(socket, ip, "token_unknown", "tunnel: credential not recognized");
      return;
    }
    if (row.status === "revoked") {
      this.deny(socket, ip, "revoked", "tunnel: credential revoked; re-pair required");
      return;
    }
    // Pairing must still be live and be THE epoch this credential belongs to.
    const pairing = this.registry.db
      .prepare("SELECT pairing_epoch, status, key_fingerprint FROM pairings WHERE device_id=?")
      .get(row.device_id) as { pairing_epoch: string; status: string; key_fingerprint: string } | undefined;
    if (!pairing || pairing.status !== "paired" || pairing.pairing_epoch !== row.pairing_epoch) {
      this.deny(socket, ip, "revoked", "tunnel: pairing no longer active for this credential");
      return;
    }
    const device = this.registry.db
      .prepare("SELECT device_uid FROM devices WHERE id=?")
      .get(row.device_id) as { device_uid: string | null } | undefined;
    if (!device?.device_uid) {
      this.deny(socket, ip, "token_unknown", "tunnel: device record incomplete");
      return;
    }

    this.pendingHandshakes++;
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.pendingHandshakes--;
      this.onConnection(ws, row, device.device_uid as string, pairing.key_fingerprint, ip);
    });
  }

  /** Stop everything (hub shutdown). */
  close(): void {
    for (const c of this.connections.values()) this.teardown(c, 1001, "hub shutdown");
    this.wss.close();
  }

  // -- internals ----------------------------------------------------------

  private deny(socket: Duplex, ip: string, code: "revoked" | "token_unknown", message: string): void {
    this.audit.append({
      actor: `ip:${ip}`,
      action: "auth.denied",
      outcome: "denied",
      detail: { endpoint: "tunnel.upgrade", code },
    });
    this.httpJson(socket, 401, { type: "tunnel.auth-error", v: 1, code, message });
  }

  /** Raw HTTP JSON response on the upgrade socket (≤4 KiB by construction). */
  private httpJson(socket: Duplex, status: number, body: Record<string, unknown>): void {
    const reason = status === 401 ? "Unauthorized" : status === 404 ? "Not Found" : "Too Many Requests";
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n`,
    );
    socket.write(payload);
    socket.destroy();
  }

  private onConnection(
    ws: WebSocket,
    auth: AuthedRow,
    deviceUid: string,
    keyFingerprint: string,
    ip: string,
  ): void {
    const conn: Conn = {
      ws,
      auth,
      deviceUid,
      connectionId: randomUUID(),
      phase: "awaiting-handshake",
      pongMisses: 0,
      lastByte: this.now(),
    };
    // 5 s to produce a valid handshake (04 §4).
    conn.handshakeTimer = setTimeout(() => {
      this.failHandshake(conn, "handshake_timeout", "tunnel: no valid handshake within deadline", ip);
    }, HANDSHAKE_DEADLINE_MS);

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      conn.lastByte = this.now();
      void isBinary;
      this.onFrame(conn, data, ip);
    });
    ws.on("pong", () => {
      conn.lastByte = this.now();
      conn.pongMisses = 0;
    });
    ws.on("error", () => this.teardown(conn, 1011, "socket error"));
    ws.on("close", () => this.teardown(conn, 1006, "closed"));
  }

  private onFrame(conn: Conn, data: Buffer, ip: string): void {
    if (conn.phase === "closed") return;
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      this.failProtocol(conn, "malformed_json", "tunnel: frame is not valid JSON");
      return;
    }
    if (!checkTunnelMessage(msg)) {
      this.failProtocol(conn, "schema_violation", "tunnel: frame failed schema check");
      return;
    }
    const frame = msg as TunnelWireMessage;
    try {
      assertDirection(frame, "device->hub");
    } catch (e) {
      this.failProtocol(conn, "direction_violation", (e as Error).message);
      return;
    }
    if (!allowedInPhase(frame, conn.phase)) {
      this.failProtocol(conn, "phase_violation", `tunnel: message not allowed in phase ${conn.phase}`);
      return;
    }
    if (conn.phase === "awaiting-handshake") {
      this.completeHandshake(conn, frame as Extract<TunnelFrame, { type: "pair-handshake" }>, ip);
      return;
    }
    this.handlers.onMessage?.(this.asConnection(conn), frame);
  }

  private completeHandshake(
    conn: Conn,
    hs: Extract<TunnelFrame, { type: "pair-handshake" }>,
    ip: string,
  ): void {
    // Tuple must match the row the TOKEN authenticated — never caller-declared
    // identity. A previous-generation credential is fine: it is the row that
    // was looked up, and the pairing epoch must still be the live one.
    const pairing = this.registry.db
      .prepare("SELECT pairing_epoch, status, key_fingerprint FROM pairings WHERE device_id=?")
      .get(conn.auth.device_id) as { pairing_epoch: string; status: string; key_fingerprint: string } | undefined;
    const problems: string[] = [];
    if (!pairing || pairing.status !== "paired") problems.push("pairing not active");
    else if (hs.pairingEpoch !== pairing.pairing_epoch) problems.push("pairing epoch mismatch");
    if (hs.deviceId !== conn.auth.device_id) problems.push("deviceId mismatch");
    if (hs.pairingEpoch !== conn.auth.pairing_epoch) problems.push("credential epoch mismatch");
    if (hs.credentialId !== conn.auth.credential_id) problems.push("credentialId mismatch");
    if (hs.generation !== conn.auth.generation) problems.push("generation mismatch");
    if (hs.deviceUid !== conn.deviceUid) problems.push("deviceUid mismatch");
    if (pairing && hs.keyFingerprint !== pairing.key_fingerprint) problems.push("key fingerprint mismatch");
    if (problems.length > 0) {
      this.failHandshake(conn, "handshake_mismatch", `tunnel: ${problems.join("; ")}`, ip);
      return;
    }

    // Swap: the new connection replaces the old one ONLY now. The old socket's
    // teardown must not delete this new registration (identity check below).
    const previous = this.connections.get(conn.auth.device_id);
    if (previous && previous !== conn) this.teardown(previous, 1000, "superseded by new connection");

    clearTimeout(conn.handshakeTimer);
    conn.handshakeTimer = undefined;
    conn.phase = "open";
    this.connections.set(conn.auth.device_id, conn);
    this.registry.recordTunnelState(conn.auth.device_id, { connectionId: conn.connectionId, connectedAt: this.now() });
    this.audit.append({
      actor: `device:${conn.auth.device_id}`,
      action: "tunnel.connect",
      outcome: "ok",
      connectionId: conn.connectionId,
      detail: { credentialId: conn.auth.credential_id, generation: conn.auth.generation, ip },
    });

    // Heartbeat: ping every 15 s; 2 unanswered pings close; 45 s byte-idle closes.
    conn.pingTimer = setInterval(() => {
      if (conn.ws.readyState !== conn.ws.OPEN) return;
      if (conn.pongMisses >= PING_MISS_LIMIT) {
        this.teardown(conn, 1001, "ping timeout");
        return;
      }
      conn.pongMisses++;
      try {
        conn.ws.ping();
      } catch {
        this.teardown(conn, 1011, "ping failed");
      }
    }, PING_INTERVAL_MS);
    conn.idleTimer = setInterval(() => {
      if (this.now() - conn.lastByte > IDLE_TIMEOUT_MS) this.teardown(conn, 1001, "idle timeout");
    }, Math.min(IDLE_TIMEOUT_MS, 5_000));

    conn.ws.send(
      JSON.stringify({
        type: "hello",
        apiVersion: 1,
        tunnelProto: 1,
        hubId: this.hubId,
        connectionId: conn.connectionId,
        serverTime: this.now(),
      } satisfies TunnelFrame),
    );
    this.handlers.onOpen?.(this.asConnection(conn));
  }

  /** Handshake-phase failure: fault + close(1008), nothing registered. */
  private failHandshake(conn: Conn, code: string, message: string, ip: string): void {
    this.audit.append({
      actor: `device:${conn.auth.device_id}`,
      action: "tunnel.disconnect",
      outcome: "denied",
      connectionId: conn.connectionId,
      detail: { stage: "handshake", code, ip },
    });
    this.failProtocol(conn, code, message);
  }

  /** Protocol violation on any phase: fault frame (if writable) + close 1008. */
  private failProtocol(conn: Conn, code: string, message: string): void {
    if (conn.ws.readyState === conn.ws.OPEN) {
      try {
        conn.ws.send(JSON.stringify({ type: "fault", error: { code, message } } satisfies TunnelFrame));
        conn.ws.close(1008, message.slice(0, 120));
      } catch {
        /* socket already gone */
      }
    }
    this.teardown(conn, 1008, message);
  }

  private teardown(conn: Conn, code: number, reason: string): void {
    if (conn.phase === "closed") return;
    conn.phase = "closed";
    if (conn.handshakeTimer) clearTimeout(conn.handshakeTimer);
    if (conn.pingTimer) clearInterval(conn.pingTimer);
    if (conn.idleTimer) clearInterval(conn.idleTimer);
    conn.handshakeTimer = conn.pingTimer = conn.idleTimer = undefined;
    // Identity check: an OLD socket must never remove a NEW connection.
    if (this.connections.get(conn.auth.device_id) === conn) {
      this.connections.delete(conn.auth.device_id);
      this.registry.clearTunnelStateFor(conn.auth.device_id, conn.connectionId);
      this.audit.append({
        actor: `device:${conn.auth.device_id}`,
        action: "tunnel.disconnect",
        outcome: "ok",
        connectionId: conn.connectionId,
        detail: { code, reason: reason.slice(0, 128) },
      });
      this.handlers.onClose?.(conn.auth.device_id, conn.connectionId);
    }
    if (conn.ws.readyState === conn.ws.OPEN || conn.ws.readyState === conn.ws.CLOSING) {
      try {
        conn.ws.close(code, reason.slice(0, 120));
      } catch {
        /* already closing */
      }
    }
  }

  private asConnection(conn: Conn): TunnelConnection {
    return {
      deviceId: conn.auth.device_id,
      deviceUid: conn.deviceUid,
      connectionId: conn.connectionId,
      pairingEpoch: conn.auth.pairing_epoch,
      credentialId: conn.auth.credential_id,
      generation: conn.auth.generation,
      send: (frame) => this.send(conn.auth.device_id, frame),
      close: (code, reason) => this.teardown(conn, code, reason),
    };
  }
}
