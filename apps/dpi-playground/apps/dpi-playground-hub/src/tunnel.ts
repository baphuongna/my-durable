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
import type { TunnelDiagnostics } from "../../../../dpi-sdk/src/api.js";
import {
  checkTunnelMessage,
  allowedInPhase,
  assertDirection,
  type TunnelFrame,
  type TunnelWireMessage,
} from "../../../../dpi-sdk/src/protocol/tunnel.js";
import { hubProofSigningPayload } from "../../../../dpi-sdk/src/protocol/pairing.js";
import type { HubIdentity } from "./hub-identity.js";
import {
  HANDSHAKE_DEADLINE_MS,
  IDLE_TIMEOUT_MS,
  PING_INTERVAL_MS,
  PING_MISS_LIMIT,
  IP_BUCKET_IDLE_TTL_MS,
  IP_BUCKET_MAX_KEYS,
  WS_BACKPRESSURE_BYTES,
  WS_MAX_MESSAGE_BYTES,
  WS_UPGRADE_LIMITS,
} from "../../../../dpi-sdk/src/protocol/limits.js";
import { Audit, scrubSecrets, type AuditEvent } from "./audit.js";
import { clientIp, ipKey, viaTls } from "./client-ip.js";
import { TokenBuckets } from "./limiter.js";

export interface TunnelPolicy {
  /** Upgrade attempts per client IP per minute (token bucket refill). */
  ipPerMinute: number;
  /** Burst allowance per client IP; defaults to the S-10 burst, never above `ipPerMinute`. */
  ipCapacity: number;
  /** Hub-wide upgrade attempts per minute (deployment safeguard on top of the per-IP policy). */
  globalPerMinute: number;
  /** Concurrent authenticated connections hub-wide. */
  maxAuthenticated: number;
  /** Concurrent sockets between 101 and a valid handshake, hub-wide. */
  maxPendingHandshakes: number;
  /** Pending + live connections per client IP; raise for a NAT that hides many devices. */
  maxConnectionsPerIp: number;
  /** Upper bound for retryAfterMs in 429 bodies (bounded per 04 §6). */
  retryAfterMaxMs: number;
  /** Refuse upgrades that a loopback TLS proxy did not vouch for (spec 05 §4.2). Off for plain local development. */
  requireTls: boolean;
  /** How long a closed connection's peer may take to answer the close handshake before the socket is destroyed. */
  teardownGraceMs: number;
}

export const DEFAULT_TUNNEL_POLICY: TunnelPolicy = {
  ipPerMinute: WS_UPGRADE_LIMITS.perMinutePerIp,
  ipCapacity: WS_UPGRADE_LIMITS.burstPerIp,
  globalPerMinute: 120,
  maxAuthenticated: WS_UPGRADE_LIMITS.livePerHub,
  maxPendingHandshakes: WS_UPGRADE_LIMITS.pendingPerHub,
  maxConnectionsPerIp: WS_UPGRADE_LIMITS.connectionsPerIp,
  retryAfterMaxMs: 60_000,
  requireTls: false,
  teardownGraceMs: 3_000,
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

/** An upgrade that passed path, rate, capacity and credential checks. */
interface Admission {
  row: AuthedRow;
  deviceUid: string;
  keyFingerprint: string;
  ip: string;
}

const FAULT_LOG_INTERVAL_MS = 10_000;

interface Conn {
  ws: WebSocket;
  auth: AuthedRow;
  deviceUid: string;
  connectionId: string;
  ip: string;
  /** True while this connection counts against its address's pending+live cap. */
  ipCounted: boolean;
  phase: "awaiting-handshake" | "open" | "closed";
  handshakeTimer?: NodeJS.Timeout;
  pingTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  pongMisses: number;
  lastByte: number;
  /** F13: frees the pending-handshake reservation exactly once. */
  releasePending?: () => void;
}

export class TunnelServer {
  private readonly wss: WebSocketServer;
  private readonly openListeners: Array<(conn: TunnelConnection) => void> = [];
  private readonly frameListeners: Array<
    (conn: TunnelConnection, frame: TunnelWireMessage) => void
  > = [];
  private readonly connections = new Map<string, Conn>(); // deviceId → authenticated
  private readonly ipBuckets: TokenBuckets;
  private readonly globalBuckets: TokenBuckets;
  /** Pending + live connections per client address (entries are removed at zero). */
  private readonly ipConnections = new Map<string, number>();
  private pendingHandshakes = 0;
  private faultLoggedAt = 0;

  constructor(
    private readonly registry: NetworkRegistry,
    private readonly audit: Audit,
    private readonly hubId: string,
    handlers: TunnelHandlers = {},
    policy: Partial<TunnelPolicy> = {},
    hooks: TunnelTestHooks = {},
    /** Offer-v3 pinning: signs hello proofs for proofNonce-carrying handshakes. */
    private readonly hubOrigin: string = "",
    private readonly identity?: HubIdentity,
  ) {
    this.policy = { ...DEFAULT_TUNNEL_POLICY, ...policy };
    if (policy.ipCapacity === undefined)
      this.policy.ipCapacity = Math.min(DEFAULT_TUNNEL_POLICY.ipCapacity, this.policy.ipPerMinute);
    this.handlers = handlers;
    this.now = hooks.now ?? Date.now;
    this.ipBuckets = new TokenBuckets(
      {
        capacity: this.policy.ipCapacity,
        perMinute: this.policy.ipPerMinute,
        maxKeys: IP_BUCKET_MAX_KEYS,
        idleTtlMs: IP_BUCKET_IDLE_TTL_MS,
      },
      this.now,
    );
    this.globalBuckets = new TokenBuckets(
      {
        capacity: this.policy.globalPerMinute,
        perMinute: this.policy.globalPerMinute,
        maxKeys: 1,
        idleTtlMs: IP_BUCKET_IDLE_TTL_MS,
      },
      this.now,
    );
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: WS_MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
  }

  private readonly policy: TunnelPolicy;
  private handlers: TunnelHandlers;
  private readonly now: () => number;

  /** Authenticated connection count (diagnostics/tests). */
  activeCount(): number {
    return this.connections.size;
  }

  /** Sockets between 101 and a valid handshake (diagnostics/tests: release on failure). */
  pendingHandshakeCount(): number {
    return this.pendingHandshakes;
  }

  /** True when the device has an open, handshake-complete tunnel connection. */
  hasConnection(deviceId: string): boolean {
    return this.connections.get(deviceId)?.phase === "open";
  }

  diagnostics(deviceId: string): Omit<TunnelDiagnostics, "readerCount"> {
    const conn = this.connections.get(deviceId);
    return conn?.phase === "open"
      ? { state: "connected", lastSeenAt: conn.lastByte }
      : { state: "disconnected" };
  }

  /** Current authenticated connectionId, or undefined when offline. */
  connectionIdOf(deviceId: string): string | undefined {
    const c = this.connections.get(deviceId);
    return c && c.phase === "open" ? c.connectionId : undefined;
  }

  /** Protocol-violation close of the device's current connection. */
  closeConnection(deviceId: string, code: number, reason: string): void {
    const c = this.connections.get(deviceId);
    if (c) this.teardown(c, code, reason);
  }

  /**
   * Replace the handlers (the dispatcher installs itself after construction).
   * Per-connection frame validation (schema/direction/phase) has already run
   * by the time onMessage fires.
   */
  setHandlers(handlers: TunnelHandlers): void {
    this.handlers = handlers;
  }

  /** Additional post-handshake listeners (rotation recovery, implicit ack). */
  addOpenListener(fn: (conn: TunnelConnection) => void): void {
    this.openListeners.push(fn);
  }

  /** Additional validated open-phase device→hub frame listeners. */
  addDeviceFrameListener(fn: (conn: TunnelConnection, frame: TunnelWireMessage) => void): void {
    this.frameListeners.push(fn);
  }

  /** Send a frame to the device's current connection (no-op when offline). */
  send(deviceId: string, frame: TunnelFrame): boolean {
    const c = this.connections.get(deviceId);
    if (!c || c.phase !== "open" || c.ws.readyState !== c.ws.OPEN) return false;
    // Slow-consumer isolation (04 §10): a device that stops reading fills the
    // kernel+ws buffer; past the CANON cap we cut THIS connection only.
    if (c.ws.bufferedAmount > WS_BACKPRESSURE_BYTES) {
      this.teardown(c, 1011, "slow consumer: outbound buffer over cap");
      return false;
    }
    try {
      c.ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  /** Server 'upgrade' listener: exact path/method, then rate caps, then auth. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let admitted: Admission | undefined;
    try {
      admitted = this.admit(req, socket);
    } catch (e) {
      // Any fault before the 101 (registry read, audit storage, anything unexpected) fails THIS
      // request closed with a plain 503; it must never escape into the server's 'upgrade' emitter.
      this.reportFault("upgrade", e);
      this.httpJson(socket, 503, {
        error: { code: "unavailable", message: "tunnel: temporarily unavailable" },
      });
      return;
    }
    if (!admitted) return;
    const { row, deviceUid, keyFingerprint, ip } = admitted;

    this.pendingHandshakes++;
    let released = false;
    const releasePending = () => {
      if (released) return;
      released = true;
      this.pendingHandshakes--;
      socket.off("close", releasePending);
      socket.off("error", releasePending);
    };
    socket.once("close", releasePending);
    socket.once("error", releasePending);
    let upgraded = false;
    try {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        upgraded = true;
        // Transfer the reservation to the APPLICATION handshake, not the 101.
        this.onConnection(ws, row, deviceUid, keyFingerprint, ip, releasePending);
      });
    } catch {
      releasePending();
      socket.destroy();
    } finally {
      // No async verifyClient hook is configured: rejection never calls back.
      if (!upgraded) releasePending();
    }
  }

  /**
   * Everything that happens before the 101: path/method, rate caps, capacity,
   * credential lookup. Writes the refusal itself and returns undefined when
   * the request is not admitted. May throw; the caller fails closed.
   */
  private admit(req: IncomingMessage, socket: Duplex): Admission | undefined {
    let path = "/";
    try {
      path = new URL(req.url ?? "/", "http://hub.local").pathname;
    } catch {
      /* fall through to reject */
    }
    if (req.method !== "GET" || path !== "/api/tunnel") {
      this.httpJson(socket, 404, {
        type: "tunnel.auth-error",
        v: 1,
        code: "token_unknown",
        message: "tunnel: wrong endpoint",
      });
      return undefined;
    }
    const ip = ipKey(clientIp(req));
    // Before any bucket: a request that cannot show TLS must not be able to spend (or probe) a client's budget.
    if (this.policy.requireTls && !viaTls(req)) {
      this.audit.denied(
        "auth.denied",
        ip,
        { endpoint: "tunnel.upgrade", code: "tls_required" },
        "tunnel.upgrade:tls_required",
      );
      this.httpJson(socket, 403, {
        error: { code: "tls_required", message: "tunnel: this hub is only served over HTTPS" },
      });
      return undefined;
    }
    // The only legitimate client is the device connector, which sends no Origin; browsers always do.
    // Refused before any bucket is touched so such requests can neither drain nor probe the limits.
    if (req.headers.origin !== undefined) {
      this.audit.denied(
        "auth.denied",
        ip,
        { endpoint: "tunnel.upgrade", code: "origin_forbidden" },
        "tunnel.upgrade:origin_forbidden",
      );
      this.httpJson(socket, 403, {
        error: { code: "origin_forbidden", message: "tunnel: browser origins are not allowed" },
      });
      return undefined;
    }
    // What an address can spend before it shows a credential is its OWN budget. The hub-wide bucket
    // and the capacity caps are only charged below, once the credential resolves to a live pairing:
    // otherwise a handful of addresses sending garbage would starve every real device (GA-03).
    const ipCheck = this.ipBuckets.take(ip);
    if (!ipCheck.ok) {
      this.refuseRate(socket, ip, "ip", ipCheck.retryAfterMs);
      return undefined;
    }
    if ((this.ipConnections.get(ip) ?? 0) >= this.policy.maxConnectionsPerIp) {
      this.audit.denied(
        "rate_limited",
        ip,
        { endpoint: "tunnel.upgrade", scope: "ip_connections" },
        "tunnel.upgrade:ip_connections",
      );
      this.httpJson(socket, 429, {
        type: "tunnel.auth-error",
        v: 1,
        code: "rate_limited",
        message: "tunnel: too many connections from this address",
        retryAfterMs: Math.min(this.policy.retryAfterMaxMs, 5_000),
      });
      return undefined;
    }

    const m = /^Bearer (dpt_[A-Za-z0-9_-]{43})$/.exec(
      String(req.headers.authorization ?? "").trim(),
    );
    if (!m) {
      this.deny(socket, ip, "token_unknown", "tunnel: missing or malformed bearer credential");
      return undefined;
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
      return undefined;
    }
    if (row.status === "revoked") {
      this.deny(socket, ip, "revoked", "tunnel: credential revoked; re-pair required");
      return undefined;
    }
    // Pairing must still be live and be THE epoch this credential belongs to.
    const pairing = this.registry.db
      .prepare("SELECT pairing_epoch, status, key_fingerprint FROM pairings WHERE device_id=?")
      .get(row.device_id) as
      | { pairing_epoch: string; status: string; key_fingerprint: string }
      | undefined;
    if (!pairing || pairing.status !== "paired" || pairing.pairing_epoch !== row.pairing_epoch) {
      this.deny(socket, ip, "revoked", "tunnel: pairing no longer active for this credential");
      return undefined;
    }
    const device = this.registry.db
      .prepare("SELECT device_uid FROM devices WHERE id=?")
      .get(row.device_id) as { device_uid: string | null } | undefined;
    if (!device?.device_uid) {
      this.deny(socket, ip, "token_unknown", "tunnel: device record incomplete");
      return undefined;
    }

    // A live credential: from here the request is a real device's, and the shared budgets apply.
    const globalCheck = this.globalBuckets.take("*");
    if (!globalCheck.ok) {
      this.refuseRate(socket, ip, "global", globalCheck.retryAfterMs);
      return undefined;
    }
    // A device that already holds the live slot is replaced, not added.
    const replacing = this.connections.has(row.device_id);
    if (
      this.pendingHandshakes >= this.policy.maxPendingHandshakes ||
      (!replacing && this.connections.size >= this.policy.maxAuthenticated)
    ) {
      this.audit.denied(
        "rate_limited",
        ip,
        { endpoint: "tunnel.upgrade", scope: "capacity" },
        "tunnel.upgrade:capacity",
      );
      this.httpJson(socket, 429, {
        type: "tunnel.auth-error",
        v: 1,
        code: "rate_limited",
        message: "tunnel: hub at connection capacity",
        retryAfterMs: Math.min(this.policy.retryAfterMaxMs, 5_000),
      });
      return undefined;
    }
    return { row, deviceUid: device.device_uid, keyFingerprint: pairing.key_fingerprint, ip };
  }

  private refuseRate(
    socket: Duplex,
    ip: string,
    scope: "ip" | "global",
    retryAfterMs: number,
  ): void {
    this.audit.denied(
      "rate_limited",
      ip,
      { endpoint: "tunnel.upgrade", scope },
      `tunnel.upgrade:${scope}`,
    );
    this.httpJson(socket, 429, {
      type: "tunnel.auth-error",
      v: 1,
      code: "rate_limited",
      message: "tunnel: too many upgrade attempts",
      retryAfterMs: Math.max(1, Math.min(this.policy.retryAfterMaxMs, retryAfterMs)),
    });
  }

  /** Stop everything (hub shutdown). */
  close(): void {
    for (const c of this.connections.values()) this.teardown(c, 1001, "hub shutdown");
    this.wss.close();
  }

  // -- internals ----------------------------------------------------------

  /** Pre-auth refusals are coalesced per (ip, reason, minute): a flood never costs a database write per request. */
  private deny(
    socket: Duplex,
    ip: string,
    code: "revoked" | "token_unknown",
    message: string,
  ): void {
    this.audit.denied(
      "auth.denied",
      ip,
      { endpoint: "tunnel.upgrade", code },
      `tunnel.upgrade:${code}`,
    );
    this.httpJson(socket, 401, { type: "tunnel.auth-error", v: 1, code, message });
  }

  /** Raw HTTP JSON response on the upgrade socket (≤4 KiB by construction). */
  private httpJson(socket: Duplex, status: number, body: Record<string, unknown>): void {
    const reason =
      status === 401
        ? "Unauthorized"
        : status === 403
          ? "Forbidden"
          : status === 404
            ? "Not Found"
            : status === 503
              ? "Service Unavailable"
              : "Too Many Requests";
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    try {
      socket.write(
        `HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n`,
      );
      socket.write(payload);
    } catch {
      /* the peer is already gone */
    } finally {
      socket.destroy();
    }
  }

  /** Log a contained fault (rate-limited, secret-scrubbed). The caller has already failed closed. */
  private reportFault(where: string, e: unknown): void {
    const now = Date.now();
    if (now - this.faultLoggedAt < FAULT_LOG_INTERVAL_MS) return;
    this.faultLoggedAt = now;
    console.error(
      `tunnel: ${where} failed closed: ${scrubSecrets(String((e as Error)?.message ?? e)).slice(0, 200)}`,
    );
  }

  /** For events that describe something that already happened: a storage fault is logged, never thrown into a socket/timer callback. */
  private auditBestEffort(event: AuditEvent): void {
    try {
      this.audit.append(event);
    } catch (e) {
      this.reportFault(`audit ${event.action}`, e);
    }
  }

  /** Run connection-scoped work so an unexpected fault drops only this connection, never the process. */
  private contain(conn: Conn, where: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.reportFault(where, e);
      this.teardown(conn, 1011, "tunnel: internal error");
    }
  }

  private onConnection(
    ws: WebSocket,
    auth: AuthedRow,
    deviceUid: string,
    keyFingerprint: string,
    ip: string,
    releasePending: () => void,
  ): void {
    const conn: Conn = {
      ws,
      auth,
      deviceUid,
      connectionId: randomUUID(),
      ip,
      ipCounted: true,
      phase: "awaiting-handshake",
      pongMisses: 0,
      lastByte: this.now(),
      releasePending,
    };
    this.ipConnections.set(ip, (this.ipConnections.get(ip) ?? 0) + 1);
    // 5 s to produce a valid handshake (04 §4).
    conn.handshakeTimer = setTimeout(() => {
      this.contain(conn, "handshake deadline", () =>
        this.failHandshake(
          conn,
          "handshake_timeout",
          "tunnel: no valid handshake within deadline",
          ip,
        ),
      );
    }, HANDSHAKE_DEADLINE_MS);

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      conn.lastByte = this.now();
      void isBinary;
      this.contain(conn, "frame", () => this.onFrame(conn, data, ip));
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
      this.failProtocol(
        conn,
        "phase_violation",
        `tunnel: message not allowed in phase ${conn.phase}`,
      );
      return;
    }
    if (conn.phase === "awaiting-handshake") {
      this.completeHandshake(conn, frame as Extract<TunnelFrame, { type: "pair-handshake" }>, ip);
      return;
    }
    this.handlers.onMessage?.(this.asConnection(conn), frame);
    const asConn2 = this.asConnection(conn);
    for (const fn of this.frameListeners) {
      try {
        fn(asConn2, frame);
      } catch (e) {
        this.auditBestEffort({
          actor: "hub",
          action: "tunnel.listener_error",
          outcome: "denied",
          connectionId: conn.connectionId,
          detail: { stage: "frame", error: String((e as Error).message).slice(0, 200) },
        });
      }
    }
  }

  private completeHandshake(
    conn: Conn,
    hs: Extract<TunnelFrame, { type: "pair-handshake" }>,
    ip: string,
  ): void {
    // Tuple must match the row the TOKEN authenticated — never caller-declared
    // identity. A previous-generation credential is fine: it is the row that
    // was looked up, and the pairing epoch must still be the live one.
    // The auth snapshot was taken at the 101: a rotation completing or a revoke
    // racing the upgrade may have ended this credential since, so its status is
    // re-read here. 'current'→'previous' (a rotation in flight) stays admittable.
    const credential = this.registry.db
      .prepare("SELECT status FROM tunnel_credentials WHERE credential_id=?")
      .get(conn.auth.credential_id) as { status: string } | undefined;
    const pairing = this.registry.db
      .prepare("SELECT pairing_epoch, status, key_fingerprint FROM pairings WHERE device_id=?")
      .get(conn.auth.device_id) as
      | { pairing_epoch: string; status: string; key_fingerprint: string }
      | undefined;
    const problems: string[] = [];
    if (!credential || credential.status === "retired" || credential.status === "revoked")
      problems.push("credential no longer active");
    if (!pairing || pairing.status !== "paired") problems.push("pairing not active");
    else if (hs.pairingEpoch !== pairing.pairing_epoch) problems.push("pairing epoch mismatch");
    if (hs.deviceId !== conn.auth.device_id) problems.push("deviceId mismatch");
    if (hs.pairingEpoch !== conn.auth.pairing_epoch) problems.push("credential epoch mismatch");
    if (hs.credentialId !== conn.auth.credential_id) problems.push("credentialId mismatch");
    if (hs.generation !== conn.auth.generation) problems.push("generation mismatch");
    if (hs.deviceUid !== conn.deviceUid) problems.push("deviceUid mismatch");
    if (pairing && hs.keyFingerprint !== pairing.key_fingerprint)
      problems.push("key fingerprint mismatch");
    if (problems.length > 0) {
      this.failHandshake(conn, "handshake_mismatch", `tunnel: ${problems.join("; ")}`, ip);
      return;
    }

    // The connect is recorded BEFORE the device is admitted: when audit storage cannot take the
    // row the new connection is refused (fail closed) and the device's current one is left alone.
    try {
      this.audit.append({
        actor: `device:${conn.auth.device_id}`,
        action: "tunnel.connect",
        outcome: "ok",
        connectionId: conn.connectionId,
        detail: { credentialId: conn.auth.credential_id, generation: conn.auth.generation, ip },
      });
    } catch (e) {
      this.reportFault("tunnel.connect audit", e);
      this.failProtocol(
        conn,
        "unavailable",
        "tunnel: hub cannot record this connection; retry later",
        1011,
      );
      return;
    }

    // Swap: the new connection replaces the old one ONLY now. The old socket's
    // teardown must not delete this new registration (identity check below).
    const previous = this.connections.get(conn.auth.device_id);
    if (previous && previous !== conn)
      this.teardown(previous, 1000, "superseded by new connection");

    clearTimeout(conn.handshakeTimer);
    conn.handshakeTimer = undefined;
    conn.phase = "open";
    conn.releasePending?.(); // F13: handshake done — the authed connection now counts under maxAuthenticated
    conn.releasePending = undefined;
    this.connections.set(conn.auth.device_id, conn);
    this.registry.recordTunnelState(conn.auth.device_id, {
      connectionId: conn.connectionId,
      connectedAt: this.now(),
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
    conn.idleTimer = setInterval(
      () => {
        if (this.now() - conn.lastByte > IDLE_TIMEOUT_MS) this.teardown(conn, 1001, "idle timeout");
      },
      Math.min(IDLE_TIMEOUT_MS, 5_000),
    );

    conn.ws.send(
      JSON.stringify({
        type: "hello",
        apiVersion: 1,
        tunnelProto: 1,
        hubId: this.hubId,
        connectionId: conn.connectionId,
        serverTime: this.now(),
        // Offer-v3 pinning: a device that sent proofNonce gets the hub identity
        // proof bound to ITS device+epoch, so a captured proof cannot replay.
        ...(hs.proofNonce && this.identity && pairing
          ? (() => {
              const i = this.identity!;
              return {
                hubPublicKey: i.publicKeyPem,
                hubKeyFingerprint: i.fingerprint,
                hubSignature: i.signPayload(
                  hubProofSigningPayload({
                    hubOrigin: this.hubOrigin,
                    hubId: this.hubId,
                    subject: `tunnel:${conn.auth.device_id}:${pairing.pairing_epoch}`,
                    nonce: hs.proofNonce,
                  }),
                ),
              };
            })()
          : {}),
      } satisfies TunnelFrame),
    );
    this.handlers.onOpen?.(this.asConnection(conn));
    const asConn = this.asConnection(conn);
    // F08: a listener throwing must never take the hub down; the exception
    // is audited and the connection stays up.
    for (const fn of this.openListeners) {
      try {
        fn(asConn);
      } catch (e) {
        this.auditBestEffort({
          actor: "hub",
          action: "tunnel.listener_error",
          outcome: "denied",
          connectionId: conn.connectionId,
          detail: { stage: "open", error: String((e as Error).message).slice(0, 200) },
        });
      }
    }
  }

  /** Handshake-phase failure: fault + close(1008), nothing registered. */
  private failHandshake(conn: Conn, code: string, message: string, ip: string): void {
    this.auditBestEffort({
      actor: `device:${conn.auth.device_id}`,
      action: "tunnel.disconnect",
      outcome: "denied",
      connectionId: conn.connectionId,
      detail: { stage: "handshake", code, ip },
    });
    this.failProtocol(conn, code, message);
  }

  /** Protocol violation on any phase: fault frame (if writable) + close (1008 policy violation unless the hub itself is at fault). */
  private failProtocol(conn: Conn, code: string, message: string, closeCode = 1008): void {
    if (conn.ws.readyState === conn.ws.OPEN) {
      try {
        conn.ws.send(
          JSON.stringify({ type: "fault", error: { code, message } } satisfies TunnelFrame),
        );
        conn.ws.close(closeCode, message.slice(0, 120));
      } catch {
        /* socket already gone */
      }
    }
    this.teardown(conn, closeCode, message);
  }

  private teardown(conn: Conn, code: number, reason: string): void {
    conn.releasePending?.(); // F13: free the handshake reservation on ANY exit
    if (conn.ipCounted) {
      conn.ipCounted = false;
      const left = (this.ipConnections.get(conn.ip) ?? 1) - 1;
      if (left > 0) this.ipConnections.set(conn.ip, left);
      else this.ipConnections.delete(conn.ip);
    }
    if (conn.phase === "closed") return;
    conn.phase = "closed";
    if (conn.handshakeTimer) clearTimeout(conn.handshakeTimer);
    if (conn.pingTimer) clearInterval(conn.pingTimer);
    if (conn.idleTimer) clearInterval(conn.idleTimer);
    conn.handshakeTimer = conn.pingTimer = conn.idleTimer = undefined;
    // Identity check: an OLD socket must never remove a NEW connection.
    // Cleanup is fault-tolerant: a storage or handler fault is logged but can neither
    // skip the remaining steps nor escape into a socket/timer callback.
    if (this.connections.get(conn.auth.device_id) === conn) {
      this.connections.delete(conn.auth.device_id);
      try {
        this.registry.clearTunnelStateFor(conn.auth.device_id, conn.connectionId);
      } catch (e) {
        this.reportFault("clear tunnel state", e);
      }
      this.auditBestEffort({
        actor: `device:${conn.auth.device_id}`,
        action: "tunnel.disconnect",
        outcome: "ok",
        connectionId: conn.connectionId,
        detail: { code, reason: reason.slice(0, 128) },
      });
      try {
        this.handlers.onClose?.(conn.auth.device_id, conn.connectionId);
      } catch (e) {
        this.reportFault("close handler", e);
      }
    }
    if (conn.ws.readyState === conn.ws.OPEN || conn.ws.readyState === conn.ws.CLOSING) {
      try {
        conn.ws.close(code, reason.slice(0, 120));
      } catch {
        /* already closing */
      }
      // The ping/idle/handshake timers are cleared above: a peer that never answers the close
      // handshake would otherwise keep this dead socket (and its fd) open forever.
      const force = setTimeout(() => {
        try {
          conn.ws.terminate();
        } catch {
          /* already gone */
        }
      }, this.policy.teardownGraceMs);
      force.unref();
      conn.ws.once("close", () => clearTimeout(force));
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
