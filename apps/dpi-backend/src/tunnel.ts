/**
 * Device tunnel connector — Durable Agent Network P2-13 (spec 04 §4–§6).
 *
 * One connector per daemon, started from the persisted pairing.json written
 * by DevicePairing (P2-11). The connector is the ONLY holder of the outbound
 * WSS connection: readers/subscriptions never open their own tunnel loop.
 *
 * Order of trust: TLS certificate + hostname are verified BEFORE the bearer
 * leaves the device (Node rejects the handshake otherwise — the HTTP upgrade
 * with the token is never transmitted). One exact origin, redirects rejected.
 *
 * Terminal states are narrow on purpose: only `revoked` for the credential
 * tuple that still matches the CURRENT pairing file stops retries (and drops
 * that file); a late 401 for an already-replaced credential is ignored.
 * `token_unknown` and bare 401s stay non-terminal with an actionable re-pair
 * status instead of an invisible infinite retry.
 */
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { Agent as HttpsAgent } from "node:https";
import WebSocket from "ws";
import {
  checkTunnelMessage,
  type TunnelFrame,
} from "../../dpi-sdk/src/protocol/tunnel.js";
import {
  CONNECTOR_BACKOFF_S,
  IDLE_TIMEOUT_MS,
  PING_INTERVAL_MS,
  PING_MISS_LIMIT,
  WS_MAX_MESSAGE_BYTES,
} from "../../dpi-sdk/src/protocol/limits.js";
import { loadJson, pairingPath, keypairPath, type PairingFile, type DeviceKeypair } from "./pairing-files.js";

/** Bounded clamp for server-advised 429 delays (04 §6: never trust raw body). */
const RETRY_AFTER_MIN_MS = 1_000;
const RETRY_AFTER_MAX_MS = 60_000;
/** TCP/TLS+upgrade completion timeout (not a CANON protocol number). */
const HANDSHAKE_TCP_TIMEOUT_MS = 10_000;
const AUTH_BODY_MAX_BYTES = 4_096;

export type ConnectorState =
  | "stopped" // not started / stopped by operator or shutdown
  | "file-error" // pairing.json unreadable at startup; no network attempts
  | "connecting" // trying (with backoff between attempts)
  | "connected" // valid hello received; transport up
  | "reauth" // non-terminal auth trouble: token_unknown / bare 401 — re-pair is the actionable fix
  | "revoked" // terminal: hub rejected the CURRENT credential tuple; pairing file removed
  | "hub-mismatch"; // terminal: TLS-trusted endpoint answered with a different hubId

export interface ConnectorStatus {
  state: ConnectorState;
  detail: string;
  attempts: number;
  hellos: number;
  lastConnectedAt: number | null;
  nextAttemptInMs: number | null;
  hubOrigin: string | null;
}

export interface ConnectorHooks {
  now?(): number;
  sleep?(ms: number): Promise<void>;
  /** Interval overrides are test-only deployment policy, never per-request. */
  intervals?: { pingMs?: number; idleMs?: number; helloMs?: number };
  onStatus?(status: ConnectorStatus): void;
}

interface Classified {
  kind: "retry" | "reauth" | "revoked-terminal" | "hub-mismatch" | "stopped";
  delayMs?: number;
  detail: string;
}

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

export class DeviceConnector {
  private file: PairingFile | undefined;
  private keypair: DeviceKeypair | undefined;
  private state: ConnectorState = "stopped";
  private detail = "";
  private attempts = 0;
  private hellos = 0;
  private lastConnectedAt: number | null = null;
  private stopped = true;
  private loopRunning = false;
  private backoffIdx = 0;
  private ws: WebSocket | null = null;
  private wsGeneration = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private pongMisses = 0;
  private lastByte = 0;
  private readonly agent: HttpsAgent | undefined;

  constructor(
    private readonly home: string,
    caPem?: string,
    private readonly hooks: ConnectorHooks = {},
  ) {
    // rejectUnauthorized stays true; a CA bundle narrows trust, it never
    // disables verification.
    if (caPem) this.agent = new HttpsAgent({ ca: caPem, rejectUnauthorized: true });
  }

  private get now() {
    return this.hooks.now ?? Date.now;
  }
  private get pingMs() {
    return this.hooks.intervals?.pingMs ?? PING_INTERVAL_MS;
  }
  private get idleMs() {
    return this.hooks.intervals?.idleMs ?? IDLE_TIMEOUT_MS;
  }
  private get helloMs() {
    return this.hooks.intervals?.helloMs ?? 10_000;
  }
  private sleep(ms: number) {
    return this.hooks.sleep ? this.hooks.sleep(ms) : new Promise<void>((done) => setTimeout(done, ms));
  }

  status(): ConnectorStatus {
    return {
      state: this.state,
      detail: this.detail,
      attempts: this.attempts,
      hellos: this.hellos,
      lastConnectedAt: this.lastConnectedAt,
      nextAttemptInMs: null,
      hubOrigin: this.file?.hubOrigin ?? null,
    };
  }

  /**
   * Load pairing/keypair from disk and run the connect loop. Safe to call at
   * daemon boot; a bad file parks in `file-error` without any network attempt.
   */
  start(): void {
    if (!this.stopped) return;
    const pairing = loadJson<PairingFile>(pairingPath(this.home));
    const keypair = loadJson<DeviceKeypair>(keypairPath(this.home));
    if (!pairing?.tunnelToken || !pairing?.hubUrl || !pairing?.deviceUid || !pairing?.deviceId || !pairing?.pairingEpoch || !pairing?.credentialId || typeof pairing?.generation !== "number") {
      this.setState("file-error", "pairing.json missing or malformed; run pairing again");
      return;
    }
    if (!keypair?.fingerprint || !keypair?.privateKeyPem) {
      this.setState("file-error", "device keypair unreadable; re-pair required");
      return;
    }
    this.file = pairing;
    this.keypair = keypair;
    this.stopped = false;
    this.setState("connecting", "starting");
    void this.loop();
  }

  /** Operator/shutdown stop: clear every timer, drop the socket, no retries. */
  stop(reason = "stopped"): void {
    this.stopped = true;
    this.clearTimers();
    this.dropSocket("stop");
    this.setState("stopped", reason);
  }

  /**
   * Rotation (P2-19) swaps the live credential without restarting the daemon.
   * A 401 for the OLD tuple arriving after this point is a late response and
   * must never be treated as terminal.
   */
  updateCredential(file: PairingFile): void {
    this.file = file;
    this.backoffIdx = 0;
  }

  // -- connect loop --------------------------------------------------------

  private async loop(): Promise<void> {
    if (this.loopRunning) return;
    this.loopRunning = true;
    while (!this.stopped) {
      const file = this.file;
      if (!file) {
        this.setState("file-error", "pairing.json vanished; run pairing again");
        break;
      }
      this.attempts++;
      const attemptTuple = { credentialId: file.credentialId, pairingEpoch: file.pairingEpoch };
      const outcome = await this.attemptOnce(file);
      if (this.stopped) break;
      const verdict = this.classify(outcome, attemptTuple);
      if (verdict.kind === "stopped") break;
      if (verdict.kind === "revoked-terminal") {
        this.stopped = true;
        this.setState("revoked", verdict.detail);
        break;
      }
      if (verdict.kind === "hub-mismatch") {
        this.stopped = true;
        this.setState("hub-mismatch", verdict.detail);
        break;
      }
      if (verdict.kind === "reauth") this.setState("reauth", verdict.detail);
      else this.setState("connecting", verdict.detail);
      const delay = verdict.delayMs ?? this.backoffMs();
      if (verdict.kind === "retry" && verdict.delayMs === undefined) this.backoffIdx = Math.min(this.backoffIdx + 1, CONNECTOR_BACKOFF_S.length - 1);
      await this.sleep(delay);
    }
    this.loopRunning = false;
  }

  private backoffMs(): number {
    return CONNECTOR_BACKOFF_S[this.backoffIdx] * 1000;
  }

  private attemptOnce(file: PairingFile): Promise<
    | { kind: "closed"; code: number; reason: string }
    | { kind: "auth"; status: number; body: unknown; raw: string }
    | { kind: "error"; message: string }
    | { kind: "hello"; serverTime: number }
    | { kind: "hub-id-mismatch"; sawHubId: string }
    | { kind: "hello-timeout" }
  > {
    return new Promise((resolve) => {
      const generation = ++this.wsGeneration;
      let settled = false;
      const finish = (v: Parameters<typeof resolve>[0]) => {
        if (settled || this.wsGeneration !== generation) return;
        settled = true;
        this.clearTimers();
        resolve(v);
      };
      let ws: WebSocket;
      try {
        ws = new WebSocket(file.hubUrl, {
          headers: { authorization: `Bearer ${file.tunnelToken}` },
          maxPayload: WS_MAX_MESSAGE_BYTES,
          perMessageDeflate: false,
          handshakeTimeout: HANDSHAKE_TCP_TIMEOUT_MS,
          ...(this.agent ? { agent: this.agent } : {}),
        });
      } catch (e) {
        finish({ kind: "error", message: (e as Error).message });
        return;
      }
      this.ws = ws;
      this.lastByte = this.now();
      this.pongMisses = 0;

      ws.on("unexpected-response", (_req, res) => {
        // Redirects are never followed (one exact origin).
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size <= AUTH_BODY_MAX_BYTES) chunks.push(c);
        });
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let body: unknown = null;
          try {
            body = JSON.parse(raw);
          } catch {
            body = null;
          }
          finish({ kind: "auth", status: res.statusCode ?? 0, body, raw });
        });
        res.on("error", () => finish({ kind: "auth", status: res.statusCode ?? 0, body: null, raw: "" }));
      });

      ws.on("error", (e) => finish({ kind: "error", message: e.message }));

      ws.on("open", () => {
        // Identity handshake with the SAVED tuple; retry counter resets only
        // after a schema-valid hello below.
        const hs: TunnelFrame = {
          type: "pair-handshake",
          v: 1,
          deviceUid: file.deviceUid,
          deviceId: file.deviceId,
          pairingEpoch: file.pairingEpoch,
          credentialId: file.credentialId,
          generation: file.generation,
          apiVersion: 1,
          tunnelProto: 1,
          keyFingerprint: this.keypair?.fingerprint ?? "",
        };
        try {
          ws.send(JSON.stringify(hs));
        } catch (e) {
          finish({ kind: "error", message: (e as Error).message });
          return;
        }
        const helloTimer = setTimeout(() => finish({ kind: "hello-timeout" }), this.helloMs);
        this.idleTimer = helloTimer as NodeJS.Timeout;
        ws.on("message", (data: Buffer) => {
          this.lastByte = this.now();
          let msg: unknown;
          try {
            msg = JSON.parse(data.toString("utf8"));
          } catch {
            finish({ kind: "error", message: "hello: malformed JSON" });
            return;
          }
          if (!checkTunnelMessage(msg) || (msg as { type: string }).type !== "hello") {
            finish({ kind: "error", message: "hello: schema violation" });
            return;
          }
          const hello = msg as Extract<TunnelFrame, { type: "hello" }>;
          if (hello.hubId !== file.hubId) {
            finish({ kind: "hub-id-mismatch", sawHubId: hello.hubId });
            return;
          }
          // Connected: heartbeat + idle safety net from here (04 §5).
          clearTimeout(helloTimer);
          this.hellos++;
          this.backoffIdx = 0;
          this.lastConnectedAt = this.now();
          this.setState("connected", `connectionId ${hello.connectionId}`);
          this.lastByte = this.now();
          this.startHeartbeat(ws, generation);
          // Subsequent frames flow to consumers via P2-14/16 seams; the
          // connector itself only tracks liveness here.
          ws.on("close", (code, reason) => finish({ kind: "closed", code, reason: Buffer.from(reason).toString("utf8") }));
        });
        ws.on("pong", () => {
          this.lastByte = this.now();
          this.pongMisses = 0;
        });
      });
    });
  }

  private startHeartbeat(ws: WebSocket, generation: number): void {
    this.pingTimer = setInterval(() => {
      if (this.wsGeneration !== generation || ws.readyState !== ws.OPEN) return;
      if (this.pongMisses >= PING_MISS_LIMIT) {
        try {
          ws.terminate(); // half-open: no (p)ong for ~2 intervals
        } catch {
          /* already gone */
        }
        return;
      }
      this.pongMisses++;
      try {
        ws.ping();
      } catch {
        /* close event will settle */
      }
    }, this.pingMs);
    this.idleTimer = setInterval(() => {
      if (this.now() - this.lastByte > this.idleMs) {
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
      }
    }, Math.min(this.idleMs, Math.max(200, Math.floor(this.idleMs / 4))));
  }

  private classify(
    outcome: Awaited<ReturnType<DeviceConnector["attemptOnce"]>>,
    attemptTuple: { credentialId: string; pairingEpoch: string },
  ): Classified {
    if (outcome.kind === "hello") return { kind: "retry", delayMs: 0, detail: "hello" };
    if (outcome.kind === "closed") {
      // 1000 "superseded" is the hub's connection swap: reconnect normally.
      return { kind: "retry", detail: `closed ${outcome.code} ${outcome.reason}`.trim() };
    }
    if (outcome.kind === "error") return { kind: "retry", detail: outcome.message };
    if (outcome.kind === "hello-timeout") return { kind: "retry", detail: "no hello within deadline" };
    if (outcome.kind === "hub-id-mismatch")
      return { kind: "hub-mismatch", detail: `hub answered with a different hubId (${outcome.sawHubId}); check the pair URL — this is not the hub you paired with` };
    // auth-shaped outcomes
    const body = outcome.body as { type?: string; code?: string; retryAfterMs?: number } | null;
    const parsed = body?.type === "tunnel.auth-error" ? body : null;
    if (outcome.status === 429 || parsed?.code === "rate_limited") {
      const advised = Number(parsed?.retryAfterMs ?? 0);
      const delay = Number.isFinite(advised) && advised > 0
        ? Math.max(RETRY_AFTER_MIN_MS, Math.min(RETRY_AFTER_MAX_MS, advised))
        : RETRY_AFTER_MAX_MS;
      return { kind: "retry", delayMs: delay, detail: "rate limited; honoring bounded retryAfter" };
    }
    if (outcome.status >= 300 && outcome.status < 400)
      return { kind: "retry", detail: `redirect (${outcome.status}) rejected: connector uses one exact origin` };
    if (parsed?.code === "revoked") {
      // Terminal ONLY when this attempt's tuple still matches the CURRENT file.
      const current = this.file;
      if (current && current.credentialId === attemptTuple.credentialId && current.pairingEpoch === attemptTuple.pairingEpoch) {
        this.removePairingFile();
        return { kind: "revoked-terminal", detail: "hub revoked this credential; pairing removed — re-pair to continue" };
      }
      return { kind: "retry", delayMs: this.backoffMs(), detail: "late revoked response for a replaced credential; ignored" };
    }
    if (parsed?.code === "token_unknown" || outcome.status === 401) {
      // Non-terminal, actionable: the operator can re-pair any time; the
      // connector keeps trying with backoff and never hides that fact.
      return { kind: "reauth", detail: parsed?.code === "token_unknown" ? "hub does not recognize this credential anymore; re-pair when convenient (still retrying)" : "bare 401 without a parsable auth-error body; still retrying" };
    }
    return { kind: "retry", detail: `upgrade failed with HTTP ${outcome.status}` };
  }

  private removePairingFile(): void {
    try {
      rmSync(pairingPath(this.home), { force: true });
    } catch {
      /* best effort; status already says revoked */
    }
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.pingTimer = null;
    this.idleTimer = null;
  }

  private dropSocket(reason: string): void {
    const ws = this.ws;
    this.ws = null;
    this.wsGeneration++;
    if (ws && (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING)) {
      try {
        if (ws.readyState === ws.OPEN) ws.close(1000, reason.slice(0, 120));
        else ws.terminate();
      } catch {
        /* already gone */
      }
    }
  }

  private setState(state: ConnectorState, detail: string): void {
    this.state = state;
    this.detail = detail;
    this.hooks.onStatus?.(this.status());
  }
}

/** sha256 hex of a token — pairing parity helper (used by tests/tools). */
export const tokenHash = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

export { err as connectorError };
export const readCaPem = (path: string | undefined): string | undefined => {
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};
