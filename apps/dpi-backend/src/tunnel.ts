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
import { createHash, createPublicKey, randomBytes, verify as edVerify } from "node:crypto";
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
  CONNECTION_BUFFER_BUDGET_BYTES,
  IDLE_TIMEOUT_MS,
  LOGICAL_MESSAGE_MAX_BYTES,
  PING_INTERVAL_MS,
  PING_MISS_LIMIT,
  RECONNECT_BACKOFF_S,
  WS_BACKPRESSURE_BYTES,
  WS_MAX_MESSAGE_BYTES,
  WS_PACE_LOW_WATER_BYTES,
} from "../../dpi-sdk/src/protocol/limits.js";
import { Backoff } from "../../dpi-sdk/src/protocol/backoff.js";
import {
  loadJson,
  pairingPath,
  keypairPath,
  writeAtomic,
  type PairingFile,
  type DeviceKeypair,
} from "./pairing-files.js";
import { hubProofSigningPayload } from "../../dpi-sdk/src/protocol/pairing.js";
import { ByteBudget, SseReader, chunkMessage } from "../../dpi-sdk/src/node/chunk.js";
import { REST_BODY_MAX_BYTES as LOCAL_BODY_CAP } from "../../dpi-sdk/src/protocol/limits.js";

/** F07: the ONLY loopback endpoints a tunnel subscription may read (the
 * three SSE scopes). Anything else the hub asks for is refused silently. */
const SUBSCRIBE_PATH_OK =
  /^\/v1\/(?:events|sessions\/[^/?#]{1,128}\/events|sessions\/[^/?#]{1,128}\/agents\/[^/?#]{1,128}\/events)(?:\?[^\s?]{0,256})?$/;

/** The hub names the stream path, so it is judged by what the loopback server will resolve, not by the regex alone. */
function isSubscribePathOk(sub: string): boolean {
  if (!SUBSCRIBE_PATH_OK.test(sub) || sub.includes("\\")) return false;
  const path = sub.split("?", 1)[0]!;
  return path
    .split("/")
    .slice(1)
    .every((segment) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return false;
      }
      return (
        segment !== "" &&
        decoded !== "." &&
        decoded !== ".." &&
        !decoded.includes("/") &&
        !decoded.includes("\\")
      );
    });
}

/** Bounded clamp for server-advised 429 delays (04 §6: never trust raw body). */
const RETRY_AFTER_MIN_MS = 1_000;
const RETRY_AFTER_MAX_MS = 60_000;
/** TCP/TLS+upgrade completion timeout (not a CANON protocol number). */
const HANDSHAKE_TCP_TIMEOUT_MS = 10_000;
const AUTH_BODY_MAX_BYTES = 4_096;
/** Loopback REST deadline on the device (matches hub REST_TIMEOUT budget). */
const REST_LOCAL_TIMEOUT_MS = 320_000;
/** One WS message above this serialized size travels as chunks (the hub reassembles). */
const INLINE_FRAME_MAX_BYTES = 512 * 1024;
/** How often a paced sender re-checks the socket's outbound queue. */
const DRAIN_POLL_MS = 20;
/** After close(1011) a hub that is not reading never answers; the socket is torn down after this. */
const BACKPRESSURE_CLOSE_GRACE_MS = 1_000;

/**
 * Read a loopback response as text without ever holding more than `cap` bytes: a declared length over the
 * cap is refused on the headers, an undeclared one is cut off as soon as the bytes read pass it, and in both
 * cases the loopback connection is abandoned.
 */
async function readBodyCapped(
  res: Response,
  cap: number,
): Promise<{ ok: true; bytes: Buffer } | { ok: false }> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => {});
    return { ok: false };
  }
  if (!res.body) return { ok: true, bytes: Buffer.alloc(0) };
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return { ok: false };
    }
    parts.push(value);
  }
  return { ok: true, bytes: Buffer.concat(parts, total) };
}

/** Wire-textual content types ride the rest-response envelope as plain UTF-8 (as they always have);
 *  anything else (zip, octet-stream, images...) is base64-flagged so the hub can pass bytes through
 *  byte-exact. R8 binary passthrough — the envelope gains optional bodyEncoding/contentDisposition,
 *  absent for textual responses so older hubs see an unchanged frame. */
const TEXTUAL_CT_RE = /^(?:text\/|application\/(?:json|javascript|xml|x-www-form-urlencoded)(?:;|$))/i;
/** base64 inflates by 4/3 and the serialized envelope must still fit the chunk budget
 *  (CHUNK_RAW_BYTES × MAX_CHUNKS_PER_MESSAGE = 16 MiB), so binaries get their own headroom.
 *  R11 3.2 (doc): this 12 MB is the ceiling for EVERY tunnelled binary — an export
 *  larger than this refuses with response_too_large (deflate ≈ 3-5× on transcripts,
 *  so most sessions fit; the LOCAL device ceiling is the 256 MiB streaming one in
 *  zip.ts). The asymmetry is physics: textual frames get 16 MiB logical because
 *  they never carry the 4/3 inflation; binaries pay it, so they get 12 MB pre-base64. */
const BINARY_RESPONSE_MAX_BYTES = 12_000_000;
const safeHeaderValue = (value: string | null | undefined): string | undefined => {
  if (!value) return undefined;
  const clean = value.replace(/[^\x20-\x7E]/g, "").slice(0, 200).trim();
  return clean.length > 0 ? clean : undefined;
};

export type ConnectorState =
  | "stopped" // not started / stopped by operator or shutdown
  | "file-error" // pairing.json unreadable at startup; no network attempts
  | "connecting" // trying (with backoff between attempts)
  | "connected" // valid hello received; transport up
  | "reauth" // non-terminal auth trouble: token_unknown / bare 401 — re-pair is the actionable fix
  | "revoked" // terminal: hub rejected the CURRENT credential tuple; pairing file removed
  | "hub-mismatch" // terminal: TLS-trusted endpoint answered with a different hubId
  | "hub-key-mismatch"; // terminal (pin): the endpoint cannot prove the pinned hub identity key

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
  intervals?: { pingMs?: number; idleMs?: number; helloMs?: number; drainMs?: number };
  onStatus?(status: ConnectorStatus): void;
  /** The hub revoked the pairing of this epoch and the pairing file is gone. */
  onRevoked?(pairingEpoch: string, reason: string): void;
  /** A rotated credential was persisted and is now the live one. */
  onRotated?(file: PairingFile): void;
}

type AttemptOutcome =
  | { kind: "closed"; code: number; reason: string }
  | { kind: "auth"; status: number; body: unknown; raw: string }
  | { kind: "error"; message: string }
  | { kind: "hello"; serverTime: number }
  | { kind: "hub-id-mismatch"; sawHubId: string }
  | { kind: "hub-key-mismatch"; message: string }
  | { kind: "hello-timeout" }
  | { kind: "stopped" };

interface Classified {
  kind: "retry" | "reauth" | "revoked-terminal" | "hub-mismatch" | "hub-key-mismatch" | "stopped";
  delayMs?: number;
  detail: string;
}

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

/**
 * Gap #6 — verify the hub identity proof inside a tunnel `hello` against the
 * pinned fingerprint. Returns undefined (pinned + proven), "adopt" (legacy
 * pairing with NO pin: the proof verifies and the fingerprint may be pinned —
 * safe because this point is only reachable after the hub accepted the dpt_
 * credential, which only the real hub issued), or a refusal string.
 */
function verifyHubHelloProof(
  file: PairingFile,
  hello: Extract<TunnelFrame, { type: "hello" }>,
  nonce: string,
): undefined | "adopt" | "skip-legacy-hub" | string {
  if (!hello.hubPublicKey || !hello.hubSignature) {
    // An OLD hub (pre-v3) cannot prove anything. A pinned pairing must refuse;
    // a legacy one just proceeds un-pinned until the hub is upgraded.
    return file.hubKeyFingerprint
      ? "the hub hello carried no identity proof (it may predate offer v3); update the hub or re-pair"
      : "skip-legacy-hub";
  }
  let fingerprint: string;
  let verified: boolean;
  try {
    const pub = createPublicKey(hello.hubPublicKey);
    if (pub.asymmetricKeyType !== "ed25519") return "the hub identity key is not Ed25519";
    const der = pub.export({ format: "der", type: "spki" }) as Buffer;
    fingerprint = `sha256:${createHash("sha256").update(der).digest("hex")}`;
    if (hello.hubKeyFingerprint !== undefined && hello.hubKeyFingerprint !== fingerprint)
      return "the hub's declared fingerprint does not match the key it sent";
    verified = edVerify(
      null,
      Buffer.from(
        hubProofSigningPayload({
          hubOrigin: file.hubOrigin,
          hubId: file.hubId,
          subject: `tunnel:${file.deviceId}:${file.pairingEpoch}`,
          nonce,
        }),
      ),
      pub,
      Buffer.from(hello.hubSignature, "base64url"),
    );
  } catch {
    return "the hub identity proof is malformed";
  }
  if (!verified) return "the hub signature does not verify under the key it sent";
  if (file.hubKeyFingerprint) {
    return file.hubKeyFingerprint === fingerprint
      ? undefined
      : `hub key fingerprint ${fingerprint.slice(0, 19)}… differs from the pinned ${file.hubKeyFingerprint.slice(0, 19)}…`;
  }
  return "adopt";
}

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
  private readonly backoff = new Backoff(RECONNECT_BACKOFF_S);
  private ws: WebSocket | null = null;
  private wsGeneration = 0;
  private cancelAttempt: (() => void) | undefined;
  private cancelBackoff: (() => void) | undefined;
  private pingTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private pongMisses = 0;
  private lastByte = 0;
  private readonly agent: HttpsAgent | undefined;

  private readonly readers = new Map<string, AbortController>();
  /** Loopback REST calls in flight for the current connection; the hub that asked is gone when the connection is. */
  private readonly restCalls = new Set<AbortController>();
  /** Bytes of unfinished loopback SSE events across all readers of this connector (04 §3.3, 32 MiB). */
  private readonly ingress = new ByteBudget("connector-ingress", CONNECTION_BUFFER_BUDGET_BYTES);
  /** Why the connector itself ended the current socket; reported once by `classify`. */
  private closeCause: string | undefined;

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
  /** How long the outbound queue may sit without draining before the hub counts as not reading. */
  private get drainMs() {
    return this.hooks.intervals?.drainMs ?? IDLE_TIMEOUT_MS;
  }
  private sleep(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise<void>((done, fail) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.cancelBackoff === cancel) this.cancelBackoff = undefined;
        if (error === undefined) done();
        else fail(error);
      };
      const cancel = () => finish();
      this.cancelBackoff = cancel;
      if (this.hooks.sleep) {
        // Keep existing clock hooks compatible, but never let their late
        // completion hold (or mutate) a replacement connector loop.
        try {
          void this.hooks.sleep(ms).then(cancel, finish);
        } catch (error) {
          finish(error);
        }
      } else timer = setTimeout(cancel, ms);
    });
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
    if (
      !pairing?.tunnelToken ||
      !pairing?.hubUrl ||
      !pairing?.deviceUid ||
      !pairing?.deviceId ||
      !pairing?.pairingEpoch ||
      !pairing?.credentialId ||
      typeof pairing?.generation !== "number"
    ) {
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
    this.cancelBackoff?.();
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
    this.backoff.reset();
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
          this.notify(() => this.hooks.onRevoked?.(attemptTuple.pairingEpoch, verdict.detail));
          break;
        }
        if (verdict.kind === "hub-mismatch") {
          this.stopped = true;
          this.setState("hub-mismatch", verdict.detail);
          break;
        }
        if (verdict.kind === "hub-key-mismatch") {
          this.stopped = true;
          this.setState("hub-key-mismatch", verdict.detail);
          break;
        }
        if (verdict.kind === "reauth") this.setState("reauth", verdict.detail);
        else this.setState("connecting", verdict.detail);
        // A verdict without its own delay (transport failure, 5xx, re-pair-needed 401) walks the shared curve.
        const delay = verdict.delayMs ?? this.backoff.ms;
        if (verdict.delayMs === undefined) this.backoff.advance();
        await this.sleep(delay);
      }
    } finally {
      this.loopRunning = false;
      releaseIdle!();
    }
  }

  private attemptOnce(file: PairingFile): Promise<AttemptOutcome> {
    return new Promise((resolve) => {
      const generation = ++this.wsGeneration;
      this.closeCause = undefined;
      let settled = false;
      // F06: settle on ANY terminal event, including cancellation. The old
      // generation gate left the promise pending forever after dropSocket(),
      // pinning loopRunning and making the connector un-restartable. Stale
      // events after settle are already blocked by `settled`.
      let socket: WebSocket | undefined;
      const finish = (v: AttemptOutcome) => {
        if (settled) return;
        settled = true;
        if (this.cancelAttempt === cancel) {
          this.cancelAttempt = undefined;
          this.clearTimers();
        }
        // Only a close the peer completed (`closed`) or an operator stop (dropSocket owns that socket) leaves the
        // socket alone; every other verdict means this hub is not one we keep a connection to while backing off.
        if (socket && v.kind !== "closed" && v.kind !== "stopped") this.hangUp(socket);
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
      socket = ws;
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
        res.on("error", () =>
          finish({ kind: "auth", status: res.statusCode ?? 0, body: null, raw: "" }),
        );
      });

      ws.on("error", (e) => finish({ kind: "error", message: e.message }));
      ws.on("close", (code, reason) =>
        finish({ kind: "closed", code, reason: Buffer.from(reason).toString("utf8") }),
      );

      ws.on("open", () => {
        if (settled || this.wsGeneration !== generation) return;
        // Identity handshake with the SAVED tuple; retry counter resets only
        // after a schema-valid hello below. Every connect challenges the hub to
        // prove its identity key: a PINNED pairing must see it match; a legacy
        // pairing (no pin yet) adopts it through this authenticated channel.
        const proofNonce = randomBytes(32).toString("base64url");
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
          ...(proofNonce ? { proofNonce } : {}),
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
            finish({
              kind: "error",
              message: helloDone ? "frame: malformed JSON" : "hello: malformed JSON",
            });
            return;
          }
          if (!checkTunnelMessage(msg)) {
            finish({
              kind: "error",
              message: helloDone ? "frame: schema violation" : "hello: schema violation",
            });
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
            // Gap #6 pin enforcement: a pinned pairing demands a valid identity
            // proof in the very hello; anything else is a WRONG HUB, not a glitch.
            const pinProblem = verifyHubHelloProof(file, frame, proofNonce);
            if (
              pinProblem !== undefined &&
              pinProblem !== "adopt" &&
              pinProblem !== "skip-legacy-hub"
            ) {
              try {
                ws.close(1011, "hub identity proof failed");
              } catch {}
              finish({ kind: "hub-key-mismatch", message: pinProblem });
              return;
            }
            if (pinProblem === "adopt") this.adoptPin(file, frame.hubKeyFingerprint!);
            // Connected: heartbeat + idle safety net from here (04 §5).
            helloDone = true;
            clearTimeout(helloTimer);
            this.hellos++;
            this.backoff.reset();
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
    // Immediate send for small replies and control acks: refused (and the connection cut) when the
    // hub has already left the outbound queue past the cap.
    const send = (payload: unknown) => this.sendNow(ws, generation, payload);
    // Paced send for payload-sized frames: waits, buffering nothing more, while the queue is above the pacing mark.
    const sendPaced = (payload: unknown) => this.sendPaced(ws, generation, payload);
    const api = this.localApi;
    if (!api) return; // no local API wired (unit contexts)
    if (frame.type === "rest-request") {
      void (async () => {
        const check = validateRestRequest({ method: frame.method, path: frame.path });
        if (!check.ok) {
          // Same validator the hub runs first (tunnel-transport request()): the
          // verdict must read the same on both hops — 400 invalid with the
          // validator's message (R5: the device used to answer 404 here).
          send({
            type: "rest-response",
            reqId: frame.reqId,
            status: 400,
            body: { error: { code: "invalid", message: check.error } },
          });
          return;
        }
        const bodyBytes =
          frame.body === undefined ? 0 : Buffer.byteLength(JSON.stringify(frame.body), "utf8");
        if (bodyBytes > LOCAL_BODY_CAP) {
          send({
            type: "rest-response",
            reqId: frame.reqId,
            status: 413,
            body: {
              error: { code: "invalid", message: `Request body exceeds ${LOCAL_BODY_CAP} bytes` },
            },
          });
          return;
        }
        const tooLarge = (message: string) =>
          send({
            type: "rest-response",
            reqId: frame.reqId,
            status: 502,
            body: { error: { code: "response_too_large", message } },
          });
        const call = new AbortController();
        this.restCalls.add(call);
        try {
          const hasBody = !["GET", "HEAD", "DELETE"].includes(frame.method);
          const res = await fetch(api.baseUrl + frame.path, {
            method: frame.method,
            headers: {
              authorization: `Bearer ${api.token}`,
              "x-dpi-token": api.token,
              ...(hasBody && frame.body !== undefined
                ? { "content-type": "application/json" }
                : {}),
              ...(frame.idempotencyKey ? { "idempotency-key": frame.idempotencyKey } : {}),
            },
            body: hasBody && frame.body !== undefined ? JSON.stringify(frame.body) : undefined,
            signal: AbortSignal.any([call.signal, AbortSignal.timeout(REST_LOCAL_TIMEOUT_MS)]),
            redirect: "manual",
          });
          if (res.status >= 300 && res.status < 400) {
            await res.body?.cancel().catch(() => {});
            send({
              type: "rest-response",
              reqId: frame.reqId,
              status: 502,
              body: {
                error: {
                  code: "offline",
                  message: `Device API answered with a redirect (${res.status}); redirects are not followed`,
                },
              },
            });
            return;
          }
          const resCt = res.headers.get("content-type") ?? undefined;
          const textual = resCt === undefined || TEXTUAL_CT_RE.test(resCt);
          const read = await readBodyCapped(res, textual ? LOGICAL_MESSAGE_MAX_BYTES : BINARY_RESPONSE_MAX_BYTES);
          if (!read.ok) {
            tooLarge(
              textual
                ? `Device response exceeds ${LOGICAL_MESSAGE_MAX_BYTES} bytes`
                : `Binary response exceeds the ${BINARY_RESPONSE_MAX_BYTES}-byte tunnel budget` +
                    // R11 1.3: the two export ceilings must tell ONE story — the
                    // tunnel cap is 12 MB compressed, the local one 256 MiB raw;
                    // name the remedies instead of a bare byte count.
                    (frame.path.endsWith("/export")
                      ? " — compact the session (archive old agents), or export it directly from the device"
                      : ""),
            );
            return;
          }
          // Small responses ride one frame; large ones chunk (hub reassembles).
          // Textual bodies keep the legacy UTF-8 string envelope; binaries are
          // base64-flagged so the hub can serve bytes byte-exact (R8 export).
          // R13 (R9-6.3 FE): the device's idempotency replay verdict rides the
          // envelope as an optional literal — old hubs ignore it (rest-response
          // is de-Strict by design), new hubs surface the header so clients can
          // tell a replay from a fresh create.
          const replayed = res.headers.get("idempotent-replay") === "true" ? { idempotentReplay: true } : {};
          const envelope = textual
            ? ({
                type: "rest-response",
                reqId: frame.reqId,
                status: res.status,
                contentType: resCt,
                body: read.bytes.toString("utf8"),
                ...replayed,
              } as const)
            : ({
                type: "rest-response",
                reqId: frame.reqId,
                status: res.status,
                contentType: resCt,
                body: read.bytes.toString("base64"),
                bodyEncoding: "base64",
                contentDisposition: safeHeaderValue(res.headers.get("content-disposition")),
                ...replayed,
              } as const);
          const serialized = JSON.stringify(envelope);
          if (Buffer.byteLength(serialized, "utf8") <= INLINE_FRAME_MAX_BYTES) {
            await sendPaced(serialized);
            return;
          }
          const plan = chunkMessage(envelope, { kind: "rest-response", reqId: frame.reqId });
          if (!plan.ok) {
            tooLarge(plan.error);
            return;
          }
          for (const chunk of plan.chunks) if (!(await sendPaced(chunk))) return;
        } catch (e) {
          send({
            type: "rest-response",
            reqId: frame.reqId,
            status: 502,
            body: { error: { code: "offline", message: (e as Error).message } },
          });
        } finally {
          this.restCalls.delete(call);
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
      if (!isSubscribePathOk(frame.sub)) {
        // R5: a refusal is never silent — the hub (and through it the browser
        // key named in the envelope) gets a fault with its subscriptionId, so
        // the key surfaces an error instead of starving without frames and
        // without a timeout. The path rides the envelope's `sub` field, so the
        // message stays short (the fault schema caps it at 512 chars).
        send({
          type: "tunnel-data",
          frame: {
            type: "fault",
            error: {
              code: "invalid",
              message: "subscribe refused: the device does not serve this stream path",
            },
          },
          subscriptionId: frame.subscriptionId,
          sub: frame.sub,
        });
        return;
      }
      const ctl = new AbortController();
      this.readers.set(frame.subscriptionId, ctl);
      void (async () => {
        // Raw bytes are bounded before they are framed or parsed; what an unfinished event holds is charged
        // to the connector-wide budget and released when this reader ends.
        const sse = new SseReader(this.ingress);
        // This reader failed, the tunnel did not: say so for this subscription only and stop reading.
        const fault = (message: string) => {
          send({
            type: "tunnel-data",
            frame: { type: "fault", error: { code: "invalid", message } },
            subscriptionId: frame.subscriptionId,
            sub: frame.sub,
          });
          ctl.abort();
        };
        try {
          const res = await fetch(api.baseUrl + frame.sub, {
            headers: {
              authorization: `Bearer ${api.token}`,
              "x-dpi-token": api.token,
              accept: "text/event-stream",
            },
            signal: ctl.signal,
          });
          if (!res.ok || !res.body) throw new Error(`${frame.sub} answered ${res.status}`);
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const fed = sse.feed(value);
            if (fed.error) return fault(fed.error);
            for (const event of fed.events) {
              if (!event.data) continue;
              let parsed: unknown;
              try {
                parsed = JSON.parse(event.data);
              } catch {
                continue;
              }
              const wire = JSON.stringify({
                type: "tunnel-data",
                frame: parsed,
                subscriptionId: frame.subscriptionId,
                sub: frame.sub,
              });
              if (Buffer.byteLength(wire, "utf8") <= INLINE_FRAME_MAX_BYTES) {
                if (!(await sendPaced(wire))) return;
                continue;
              }
              // One WS message ≤1 MiB: large frames (big trees) chunk, one paced frame at a time.
              const plan = chunkMessage(parsed, {
                kind: "tunnel-data",
                subscriptionId: frame.subscriptionId,
                sub: frame.sub,
              });
              if (!plan.ok) return fault(plan.error);
              for (const chunk of plan.chunks) if (!(await sendPaced(chunk))) return;
            }
          }
        } catch {
          /* aborted or connection lost: the hub will resubscribe on the new connection */
        } finally {
          sse.close();
          ctl.abort();
          if (this.readers.get(frame.subscriptionId) === ctl)
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
      this.backoff.reset();
      this.notify(() => this.hooks.onRotated?.(next));
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
      this.notify(() => this.hooks.onRevoked?.(file.pairingEpoch, this.detail));
      // Cancellation settles immediately, even if the peer never completes close.
      return;
    }
    // unpair control frames land with the forced-hub-change flow (P2-21).
  }

  /**
   * Send now, if this socket is still the live one. A queue already past the cap means the hub stopped
   * reading: the connection is cut (04 §10) instead of queueing behind it.
   */
  private sendNow(ws: WebSocket, generation: number, payload: unknown): boolean {
    if (this.wsGeneration !== generation || ws.readyState !== ws.OPEN) return false;
    if (ws.bufferedAmount > WS_BACKPRESSURE_BYTES) {
      this.closeForBackpressure(ws, generation, "outbound queue over cap");
      return false;
    }
    try {
      ws.send(typeof payload === "string" ? payload : JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send once the outbound queue is at or below the pacing mark, waiting (and buffering nothing more) until
   * it is. Waiting also stops the caller reading its loopback source, so pressure reaches the local API.
   * False when the connection went away, or the queue stopped draining for `drainMs` (the hub is not reading).
   */
  private async sendPaced(ws: WebSocket, generation: number, payload: unknown): Promise<boolean> {
    let lowest = ws.bufferedAmount;
    let progressAt = this.now();
    while (ws.bufferedAmount > WS_PACE_LOW_WATER_BYTES) {
      if (this.wsGeneration !== generation || ws.readyState !== ws.OPEN) return false;
      if (ws.bufferedAmount < lowest) {
        lowest = ws.bufferedAmount;
        progressAt = this.now();
      } else if (this.now() - progressAt >= this.drainMs) {
        this.closeForBackpressure(
          ws,
          generation,
          `outbound queue did not drain for ${this.drainMs} ms`,
        );
        return false;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    }
    return this.sendNow(ws, generation, payload);
  }

  /** Slow-consumer cut (04 §10): stop the producers, close 1011, and let the connect loop back off and retry. */
  private closeForBackpressure(ws: WebSocket, generation: number, why: string): void {
    if (this.wsGeneration !== generation || ws.readyState !== ws.OPEN) return;
    this.closeCause = "backpressure";
    this.setState("connecting", `backpressure: ${why}`);
    for (const ctl of this.readers.values()) ctl.abort();
    this.readers.clear();
    try {
      ws.close(1011, "backpressure");
    } catch {
      /* already closing */
    }
    // A hub that is not reading never answers the close frame; drop the socket (and its queued bytes) anyway.
    const force = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    }, BACKPRESSURE_CLOSE_GRACE_MS);
    force.unref();
    ws.once("close", () => clearTimeout(force));
  }

  /**
   * Authenticated upgrade (gap #6 migration): a legacy pairing adopted the
   * hub's identity fingerprint through the just-verified, dpt_-authenticated
   * tunnel. Best effort — a failed write just means the pin is adopted on a
   * later connect.
   */
  private adoptPin(file: PairingFile, fingerprint: string): void {
    const next: PairingFile = { ...file, hubKeyFingerprint: fingerprint, updatedAt: this.now() };
    try {
      writeAtomic(pairingPath(this.home), JSON.stringify(next, null, 2));
    } catch {
      return; // pin adopted next connect
    }
    if (this.file?.operationId === file.operationId) this.file = next;
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
    this.idleTimer = setInterval(
      () => {
        if (this.now() - this.lastByte > this.idleMs) {
          try {
            ws.terminate();
          } catch {
            /* already gone */
          }
        }
      },
      Math.min(this.idleMs, Math.max(200, Math.floor(this.idleMs / 4))),
    );
  }

  private classify(
    outcome: AttemptOutcome,
    attemptTuple: { credentialId: string; pairingEpoch: string },
  ): Classified {
    if (outcome.kind === "stopped") return { kind: "stopped", detail: "attempt cancelled" };
    if (outcome.kind === "hello") return { kind: "retry", delayMs: 0, detail: "hello" };
    if (outcome.kind === "closed") {
      // A slow-consumer cut may end as a forced terminate (1006); the cause is ours, so say that.
      const cause = this.closeCause;
      this.closeCause = undefined;
      if (cause) return { kind: "retry", detail: `closed 1011 ${cause}` };
      // 1000 "superseded" is the hub's connection swap: reconnect normally.
      return { kind: "retry", detail: `closed ${outcome.code} ${outcome.reason}`.trim() };
    }
    if (outcome.kind === "error") return { kind: "retry", detail: outcome.message };
    if (outcome.kind === "hello-timeout")
      return { kind: "retry", detail: "no hello within deadline" };
    if (outcome.kind === "hub-id-mismatch")
      return {
        kind: "hub-mismatch",
        detail: `hub answered with a different hubId (${outcome.sawHubId}); check the pair URL — this is not the hub you paired with`,
      };
    if (outcome.kind === "hub-key-mismatch")
      return {
        kind: "hub-key-mismatch",
        detail: `${outcome.message}; REFUSING to continue — the pinned hub identity (hubKeyFingerprint) does not match. Re-pair with a fresh offer link from the hub you trust`,
      };
    // auth-shaped outcomes
    const body = outcome.body as { type?: string; code?: string; retryAfterMs?: number } | null;
    const parsed = body?.type === "tunnel.auth-error" ? body : null;
    if (outcome.status === 429 || parsed?.code === "rate_limited") {
      const advised = Number(parsed?.retryAfterMs ?? 0);
      const delay =
        Number.isFinite(advised) && advised > 0
          ? Math.max(RETRY_AFTER_MIN_MS, Math.min(RETRY_AFTER_MAX_MS, advised))
          : RETRY_AFTER_MAX_MS;
      return { kind: "retry", delayMs: delay, detail: "rate limited; honoring bounded retryAfter" };
    }
    if (outcome.status >= 300 && outcome.status < 400)
      return {
        kind: "retry",
        detail: `redirect (${outcome.status}) rejected: connector uses one exact origin`,
      };
    if (parsed?.code === "revoked") {
      // Terminal ONLY when this attempt's tuple still matches the CURRENT file.
      const current = this.file;
      if (
        current &&
        current.credentialId === attemptTuple.credentialId &&
        current.pairingEpoch === attemptTuple.pairingEpoch
      ) {
        // F05 disk-truth: a re-pair may have replaced the file mid-flight.
        const onDisk = loadJson<PairingFile>(pairingPath(this.home));
        if (
          onDisk &&
          (onDisk.credentialId !== attemptTuple.credentialId ||
            onDisk.pairingEpoch !== attemptTuple.pairingEpoch)
        ) {
          this.file = onDisk; // adopt the newer pairing and keep going
          this.backoff.reset();
          return {
            kind: "retry",
            delayMs: 0,
            detail: "revoked for an old credential; a newer pairing file is on disk",
          };
        }
        this.removePairingFile();
        return {
          kind: "revoked-terminal",
          detail: "hub revoked this credential; pairing removed — re-pair to continue",
        };
      }
      return {
        kind: "retry",
        delayMs: this.backoff.ms,
        detail: "late revoked response for a replaced credential; ignored",
      };
    }
    if (parsed?.code === "token_unknown" || outcome.status === 401) {
      // Non-terminal, actionable: the operator can re-pair any time; the
      // connector keeps trying with backoff and never hides that fact.
      return {
        kind: "reauth",
        detail:
          parsed?.code === "token_unknown"
            ? "hub does not recognize this credential anymore; re-pair when convenient (still retrying)"
            : "bare 401 without a parsable auth-error body; still retrying",
      };
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
    for (const call of this.restCalls) call.abort();
    this.restCalls.clear();
  }

  /** Drop a socket we are done with. One already in a close handshake (we sent the close frame) gets a short grace to finish it. */
  private hangUp(ws: WebSocket): void {
    if (ws.readyState === ws.CLOSED) return;
    try {
      if (ws.readyState !== ws.CLOSING) {
        ws.terminate();
        return;
      }
      const force = setTimeout(() => ws.terminate(), BACKPRESSURE_CLOSE_GRACE_MS);
      force.unref();
      ws.once("close", () => clearTimeout(force));
    } catch {
      /* already gone */
    }
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

  /** Observers never get to fail the connector. */
  private notify(call: () => void): void {
    try {
      call();
    } catch {
      /* best effort */
    }
  }

  private setState(state: ConnectorState, detail: string): void {
    this.state = state;
    this.detail = detail;
    this.hooks.onStatus?.(this.status());
  }
}

/** sha256 hex of a token — pairing parity helper (used by tests/tools). */
export const tokenHash = (token: string) =>
  createHash("sha256").update(token, "utf8").digest("hex");

export { err as connectorError };
export const readCaPem = (path: string | undefined): string | undefined => {
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};
