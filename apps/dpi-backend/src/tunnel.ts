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
  assertDirection,
  checkTunnelMessage,
  validateRestRequest,
  type TunnelFrame,
} from "../../dpi-sdk/src/protocol/tunnel.js";
import {
  CONNECTOR_BACKOFF_S,
  IDLE_TIMEOUT_MS,
  PING_INTERVAL_MS,
  PING_MISS_LIMIT,
  WS_MAX_MESSAGE_BYTES,
} from "../../dpi-sdk/src/protocol/limits.js";
import { loadJson, pairingPath, keypairPath, writeAtomic, type PairingFile, type DeviceKeypair } from "./pairing-files.js";
import { sendChunked } from "../../dpi-sdk/src/node/chunk.js";
import { REST_BODY_MAX_BYTES as LOCAL_BODY_CAP } from "../../dpi-sdk/src/protocol/limits.js";

/** F07: the ONLY loopback endpoints a tunnel subscription may read (the
 * three SSE scopes). Anything else the hub asks for is refused silently. */
const SUBSCRIBE_PATH_OK =
  /^\/v1\/(?:events|sessions\/[^/?#]{1,128}\/events|sessions\/[^/?#]{1,128}\/agents\/[^/?#]{1,128}\/events)(?:\?[^\s?]{0,256})?$/;

/** Bounded clamp for server-advised 429 delays (04 §6: never trust raw body). */
const RETRY_AFTER_MIN_MS = 1_000;
const RETRY_AFTER_MAX_MS = 60_000;
/** TCP/TLS+upgrade completion timeout (not a CANON protocol number). */
const HANDSHAKE_TCP_TIMEOUT_MS = 10_000;
const AUTH_BODY_MAX_BYTES = 4_096;
/** Loopback REST deadline on the device (matches hub REST_TIMEOUT budget). */
const REST_LOCAL_TIMEOUT_MS = 320_000;

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
  /** Resolves when the connect loop fully exits (reload chains start() on it). */
  private loopIdle: Promise<void> = Promise.resolve();
  private backoffIdx = 0;
  private ws: WebSocket | null = null;
  private wsGeneration = 0;
  private cancelAttempt: (() => void) | undefined;
  private pingTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private pongMisses = 0;
  private lastByte = 0;
  private readonly agent: HttpsAgent | undefined;

  private readonly readers = new Map<string, AbortController>();

  constructor(
    private readonly home: string,
    caPem?: string,
    private readonly hooks: ConnectorHooks = {},
    private readonly localApi?: { baseUrl: string; token: string },
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
    if (this.loopRunning) {
      const generation = this.wsGeneration;
      void this.loopIdle.then(() => {
        if (this.wsGeneration === generation) this.start();
      });
      return;
    }
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

  /**
   * Re-pair transition (F05): adopt a pairing file that changed on disk.
   * A running connector must NOT keep the old credential/epoch in RAM — the
   * old loop is stopped to completion, then a fresh loop starts from disk.
   */
  reload(reason = "pairing file changed"): void {
    if (this.stopped) {
      this.start();
      return;
    }
    const onDisk = loadJson<PairingFile>(pairingPath(this.home));
    if (!onDisk) {
      this.stop(reason);
      return;
    }
    const sameTuple =
      this.file &&
      onDisk.pairingEpoch === this.file.pairingEpoch &&
      onDisk.credentialId === this.file.credentialId &&
      onDisk.generation === this.file.generation;
    if (sameTuple) {
      this.file = onDisk; // same credential, newer timestamp — nothing to swap
      return;
    }
    this.stop(`${reason}: swapping pairing`);
    this.start(); // waits for the cancelled loop to exit before taking ownership
  }

  /** Operator/shutdown stop: clear every timer, drop the socket, no retries. */
  stop(reason = "stopped"): void {
    this.stopped = true;
    this.cancelAttempt?.();
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
    let releaseIdle: () => void;
    this.loopIdle = new Promise<void>((r) => (releaseIdle = r));
    try {
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
    } finally {
      this.loopRunning = false;
      releaseIdle!();
    }
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
    | { kind: "stopped" }
  > {
    return new Promise((resolve) => {
      const generation = ++this.wsGeneration;
      let settled = false;
      // F06: settle on ANY terminal event, including cancellation. The old
      // generation gate left the promise pending forever after dropSocket(),
      // pinning loopRunning and making the connector un-restartable. Stale
      // events after settle are already blocked by `settled`.
      const finish = (v: Parameters<typeof resolve>[0]) => {
        if (settled) return;
        settled = true;
        if (this.cancelAttempt === cancel) {
          this.cancelAttempt = undefined;
          this.clearTimers();
        }
        resolve(v);
      };
      const cancel = () => finish({ kind: "stopped" });
      this.cancelAttempt = cancel;
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
      ws.on("close", (code, reason) => finish({ kind: "closed", code, reason: Buffer.from(reason).toString("utf8") }));

      ws.on("open", () => {
        if (settled || this.wsGeneration !== generation) return;
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
        let helloDone = false;
        const helloTimer = setTimeout(() => finish({ kind: "hello-timeout" }), this.helloMs);
        this.idleTimer = helloTimer as NodeJS.Timeout;
        ws.on("message", (data: Buffer) => {
          if (settled || this.wsGeneration !== generation) return;
          this.lastByte = this.now();
          let msg: unknown;
          try {
            msg = JSON.parse(data.toString("utf8"));
          } catch {
            finish({ kind: "error", message: helloDone ? "frame: malformed JSON" : "hello: malformed JSON" });
            return;
          }
          if (!checkTunnelMessage(msg)) {
            finish({ kind: "error", message: helloDone ? "frame: schema violation" : "hello: schema violation" });
            return;
          }
          const frame = msg as TunnelFrame;
          if (!helloDone) {
            if (frame.type !== "hello") {
              finish({ kind: "error", message: "hello: expected hello first" });
              return;
            }
            if (frame.hubId !== file.hubId) {
              finish({ kind: "hub-id-mismatch", sawHubId: frame.hubId });
              return;
            }
            // Connected: heartbeat + idle safety net from here (04 §5).
            helloDone = true;
            clearTimeout(helloTimer);
            this.hellos++;
            this.backoffIdx = 0;
            this.lastConnectedAt = this.now();
            this.setState("connected", `connectionId ${frame.connectionId}`);
            this.lastByte = this.now();
            this.startHeartbeat(ws, generation);
            return;
          }
          // Open phase: only hub→device frames; dispatch to REST/SSE readers.
          try {
            assertDirection(frame, "hub->device");
          } catch (e) {
            this.setState("connecting", `protocol violation: ${(e as Error).message}`);
            try {
              ws.close(1008, "direction violation");
            } catch {}
            finish({ kind: "error", message: (e as Error).message });
            return;
          }
          this.dispatch(ws, generation, frame);
        });
        ws.on("pong", () => {
          if (settled || this.wsGeneration !== generation) return;
          this.lastByte = this.now();
          this.pongMisses = 0;
        });
      });
    });
  }

  /**
   * Hub→device dispatch: rest-request → loopback API; control:subscribe →
   * loopback SSE reader tagged with the hub's subscriptionId. The connector
   * injects the LOCAL device token; the hub's caller identity never reaches
   * the device API (P2-16 hardens ownership/caps).
   */
  private dispatch(ws: WebSocket, generation: number, frame: TunnelFrame): void {
    const send = (payload: TunnelFrame) => {
      if (this.wsGeneration !== generation || ws.readyState !== ws.OPEN) return false;
      try {
        ws.send(JSON.stringify(payload));
        return true;
      } catch {
        return false;
      }
    };
    const api = this.localApi;
    if (!api) return; // no local API wired (unit contexts)
    if (frame.type === "rest-request") {
      void (async () => {
        const check = validateRestRequest({ method: frame.method, path: frame.path });
        if (!check.ok) {
          send({ type: "rest-response", reqId: frame.reqId, status: 404, body: { error: { code: "invalid", message: check.error } } });
          return;
        }
        const bodyBytes = frame.body === undefined ? 0 : Buffer.byteLength(JSON.stringify(frame.body), "utf8");
        if (bodyBytes > LOCAL_BODY_CAP) {
          send({ type: "rest-response", reqId: frame.reqId, status: 413, body: { error: { code: "invalid", message: `Request body exceeds ${LOCAL_BODY_CAP} bytes` } } });
          return;
        }
        try {
          const hasBody = !["GET", "HEAD", "DELETE"].includes(frame.method);
          const res = await fetch(api.baseUrl + frame.path, {
            method: frame.method,
            headers: {
              authorization: `Bearer ${api.token}`,
              "x-dpi-token": api.token,
              ...(hasBody && frame.body !== undefined ? { "content-type": "application/json" } : {}),
              ...(frame.idempotencyKey ? { "idempotency-key": frame.idempotencyKey } : {}),
            },
            body: hasBody && frame.body !== undefined ? JSON.stringify(frame.body) : undefined,
            signal: AbortSignal.timeout(REST_LOCAL_TIMEOUT_MS),
          });
          const text = await res.text();
          // Small responses ride one frame; large ones chunk (hub reassembles).
          const envelope = { type: "rest-response", reqId: frame.reqId, status: res.status, contentType: res.headers.get("content-type") ?? undefined, body: text } as const;
          const serialized = JSON.stringify(envelope);
          if (Buffer.byteLength(serialized, "utf8") > 512 * 1024) {
            sendChunked(envelope, { kind: "rest-response", reqId: frame.reqId }, (chunk) => send(chunk as unknown as TunnelFrame));
          } else {
            send(envelope as unknown as TunnelFrame);
          }
        } catch (e) {
          send({ type: "rest-response", reqId: frame.reqId, status: 502, body: { error: { code: "offline", message: (e as Error).message } } });
        }
      })();
      return;
    }
    if (frame.type === "control" && frame.action === "subscribe") {
      const existing = this.readers.get(frame.subscriptionId);
      if (existing) return; // idempotent repeat
      // F07: the hub names the STREAM PATH; scope must reach the device API.
      // Allow-list the three SSE endpoints — a hub can never aim the reader
      // at REST-only or pairing routes.
      if (!SUBSCRIBE_PATH_OK.test(frame.sub)) return;
      const ctl = new AbortController();
      this.readers.set(frame.subscriptionId, ctl);
      void (async () => {
        try {
          const res = await fetch(api.baseUrl + frame.sub, {
            headers: { authorization: `Bearer ${api.token}`, "x-dpi-token": api.token, accept: "text/event-stream" },
            signal: ctl.signal,
          });
          if (!res.ok || !res.body) throw new Error(`${frame.sub} answered ${res.status}`);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            this.lastByte = this.now();
            buffer += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buffer.indexOf("\n\n")) >= 0) {
              const block = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              for (const line of block.split("\n")) {
                if (!line.startsWith("data:")) continue;
                const data = line.slice(5).trimStart();
                if (!data) continue;
                let parsed: unknown;
                try {
                  parsed = JSON.parse(data);
                } catch {
                  continue;
                }
                const dataFrame = { type: "tunnel-data", frame: parsed as never, subscriptionId: frame.subscriptionId, sub: frame.sub } as TunnelFrame;
                const wire = JSON.stringify(dataFrame);
                if (Buffer.byteLength(wire, "utf8") > 512 * 1024) {
                  // One WS message ≤1 MiB: large frames (big trees) chunk.
                    if (!sendChunked(parsed, { kind: "tunnel-data", subscriptionId: frame.subscriptionId, sub: frame.sub }, (chunk) => send(chunk as unknown as TunnelFrame))) return;
                } else if (!send(dataFrame)) return;
              }
            }
          }
        } catch {
          /* aborted or connection lost: the hub will resubscribe on the new connection */
        } finally {
          this.readers.delete(frame.subscriptionId);
        }
      })();
      return;
    }
    if (frame.type === "control" && frame.action === "unsubscribe") {
      this.readers.get(frame.subscriptionId)?.abort();
      this.readers.delete(frame.subscriptionId);
      return;
    }
    if (frame.type === "control" && frame.action === "token-rotate") {
      // Rotation (03 §8.2): accept only a STRICTLY NEWER generation of the
      // active pairing (after a hub cache-loss recovery the jump can be >1);
      // persist atomically (fsync chain) BEFORE acking, then live-swap.
      const file = this.file;
      if (
        !file ||
        frame.pairingEpoch !== file.pairingEpoch ||
        frame.generation <= file.generation
      ) {
        // Stale/duplicate/foreign rotation: ignore entirely — no ack, no write.
        return;
      }
      const next: PairingFile = {
        ...file,
        credentialId: frame.credentialId,
        generation: frame.generation,
        tunnelToken: frame.tunnelToken,
        updatedAt: this.now(),
      };
      try {
        writeAtomic(pairingPath(this.home), JSON.stringify(next, null, 2));
      } catch {
        // Persist failed: keep using the old credential; the hub will resend
        // or regenerate on the next reconnect (previous stays previous).
        return;
      }
      this.file = next;
      this.backoffIdx = 0;
      send({
        type: "control",
        action: "token-rotate-ack",
        rotationId: frame.rotationId,
        credentialId: frame.credentialId,
        generation: frame.generation,
        pairingEpoch: frame.pairingEpoch,
      });
      return;
    }
    if (frame.type === "control" && frame.action === "revoked") {
      // Terminal ONLY when the notice matches the CURRENT pairing epoch; a
      // stale notice for a superseded pairing must not touch the new one.
      const file = this.file;
      if (!file || frame.notice.pairingEpoch !== file.pairingEpoch) return;
      // F05 disk-truth: the RAM tuple may be stale — a re-pair may already
      // have replaced the file. Only delete what the notice is actually for.
      const onDisk = loadJson<PairingFile>(pairingPath(this.home));
      if (!onDisk || onDisk.pairingEpoch !== frame.notice.pairingEpoch) {
        // A NEWER pairing is on disk: adopt it and keep serving, never die on
        // a stale-epoch notice and never delete the newer file.
        this.reload("re-pair raced a revoke notice");
        return;
      }
      this.stopped = true;
      this.cancelAttempt?.();
      this.clearTimers();
      this.dropSocket("revoked");
      try {
        rmSync(pairingPath(this.home), { force: true }); // matching epoch: drop, keep keypair
      } catch {
        /* best effort */
      }
      this.setState("revoked", "hub revoked this pairing; pairing removed — re-pair to continue");
      // Cancellation settles immediately, even if the peer never completes close.
      return;
    }
    // unpair control frames land with the forced-hub-change flow (P2-21).
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
    if (outcome.kind === "stopped") return { kind: "stopped", detail: "attempt cancelled" };
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
        // F05 disk-truth: a re-pair may have replaced the file mid-flight.
        const onDisk = loadJson<PairingFile>(pairingPath(this.home));
        if (onDisk && (onDisk.credentialId !== attemptTuple.credentialId || onDisk.pairingEpoch !== attemptTuple.pairingEpoch)) {
          this.file = onDisk; // adopt the newer pairing and keep going
          this.backoffIdx = 0;
          return { kind: "retry", delayMs: 0, detail: "revoked for an old credential; a newer pairing file is on disk" };
        }
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
    for (const ctl of this.readers.values()) ctl.abort();
    this.readers.clear();
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
