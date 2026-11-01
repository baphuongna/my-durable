// One SSE connection per browser tab. The tab names the streams it wants (subscription keys);
// the hub opens one authenticated upstream per key and tags every frame with its key.
//   network                                  registry + live status of every device
//   <device>/device[?docs=a,b]               device stream
//   <device>/session/<sessionId>             session stream
//   <device>/agent/<sessionId>/<agentId>[?docs=a,b]
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { DpiError } from "../../../../dpi-sdk/src/errors.js";
import { transportFor } from "./transport.js";
import { reassembledFrameBytes } from "./tunnel-transport.js";
import type { MuxFrame } from "../../../../dpi-sdk/src/api.js";
import type { NetworkRegistry } from "../../../../dpi-sdk/src/node/registry.js";
import type { DeviceMonitor, TunnelTransportSource } from "./monitor.js";
import { ByteBudget } from "../../../../dpi-sdk/src/node/chunk.js";
import {
  createPacedSseWriter,
  type PacedSseWriter,
} from "../../../../dpi-sdk/src/node/sse-writer.js";
import { checkDeviceFrame } from "../../../../dpi-sdk/src/protocol/tunnel.js";
import { Backoff } from "../../../../dpi-sdk/src/protocol/backoff.js";
import {
  HUB_BUFFER_BUDGET_BYTES,
  LOGICAL_MESSAGE_MAX_BYTES,
  READERS_PER_DEVICE,
  READERS_PER_HUB,
  RECONNECT_BACKOFF_S,
  SSE_HUB_VIEWER_BYTES,
} from "../../../../dpi-sdk/src/protocol/limits.js";

interface BrowserStream {
  /** run-8 U5: `preSerialized` lets the relay seam (follow) admit on and send
   *  the SAME serialization — one stringify per inbound frame, not one per tab. */
  send(frame: MuxFrame, preSerialized?: string): void;
  upstreams: Map<string, AbortController>;
}

/** run-8 U5: relay admission cap for device->browser frames — the B4
 *  discipline (TREE_MAX_BYTES at the monitor seam) applied to EVERY frame the
 *  mux forwards, so a hostile device cannot push ~16MiB agent-event frames
 *  into per-tab stringify/copy work below the transport ceiling. */
const RELAY_FRAME_CAP_BYTES = 1024 * 1024;
/** Trees are legitimately larger than per-event frames — still far below the
 *  16MiB transport ceiling so a hostile device cannot drive ~16MiB parse/copy
 *  work per frame. This is the WRAPPER backstop only: device-authored `tree`
 *  frames must ALSO clear the monitor seam's own bounds below. */
const RELAY_TREE_CAP_BYTES = 4 * 1024 * 1024;
/** Run-9 U5/U8: `follow()` opens its OWN /v1/events subscription, so the
 *  monitor's B4 admission bound (TREE_MAX_BYTES/TREE_MAX_SESSIONS in
 *  monitor.ts) never sees the tree frames the relay forwards — a device tree
 *  the hub's own view degrades used to ride this 4MiB wrapper cap verbatim
 *  into every tab. Mirror the monitor seam's constants (monitor.ts owns the
 *  canonical ones) and measure the tree payload exactly as it does, so every
 *  tree the monitor admits also passes here and nothing it rejects does. */
const TREE_RELAY_MAX_SESSIONS = 2000;
/** Run-11 h1-1 (Unit A; cold-review r11 f1): the relay wrapper's EXACT byte
 *  overhead over the frame's own serialization —
 *  `{"sub":` (7) + JSON-escaped key + `,"frame":` (9) + `}` (1) = 17 + key
 *  bytes. Used by the raw-bytes pre-check in follow() so it faults only
 *  frames the authoritative stringify check would also reject. A CONSTANT
 *  allowance ≥ the real overhead inverted that direction and faulted LEGAL
 *  near-cap chunked frames (the ~480 B band under the cap). Exact math keeps
 *  the pre-check admission-identical to the authoritative check for every
 *  canonical (device-JSON.stringify'd) frame; only non-canonical raw bytes
 *  (hand-crafted whitespace) can diverge — and then the belt-and-braces
 *  byteLength(text) check after the single stringify still gates admission. */
function relayWrapperOverhead(key: string): number {
  return 17 + Buffer.byteLength(JSON.stringify(key));
}
/** Run-11 h4-5 (Unit A): per-subscription token bucket for `tree` frames —
 *  capacity 4, refill 2/s, reset to full at every (re)connect (see
 *  follow()). Trees are whole-document snapshots that supersede each other,
 *  so a device pushing a back-to-back burst costs one multi-MiB
 *  stringify+copy per frame per tab for a view the next tree replaces
 *  anyway. Coalesced frames are counted (relayStats().coalescedTreeFrames →
 *  GET /api/network, next to droppedTreeFrames) and the next tree (a healthy
 *  device re-pushes on state change within ~500 ms) delivers the fresh view.
 *  Only `tree` is gated — snapshot/agents are handshake payloads and every
 *  other frame type stays unlimited (scope = h4-5 trees). */
const TREE_BUCKET_CAPACITY = 4;
const TREE_BUCKET_REFILL_PER_SEC = 2;

const sseBudget = new ByteBudget("hub-sse", HUB_BUFFER_BUDGET_BYTES);

/**
 * Serialized paced writer (04 §10): complete SSE events only, split into
 * ≤64 KiB segments, waiting for drain between segments. The chain guarantees
 * a `: ping` can never land inside a half-written event, and a slow viewer is
 * cut at the CANON hub cap instead of buffering without bound.
 */
export function pacedSseWriter(
  res: Response,
  opts: { budget?: ByteBudget; onClose?: () => void } = {},
): PacedSseWriter {
  return createPacedSseWriter(res, {
    maxBufferedBytes: SSE_HUB_VIEWER_BYTES,
    budget: opts.budget ?? sseBudget,
    onClose: opts.onClose,
  });
}

const KEY =
  /^([a-z0-9][a-z0-9-]{0,31})\/(device|session|agent)(?:\/([^/?]+))?(?:\/([^/?]+))?(?:\?docs=([a-z0-9.,-]*))?$/;

const invalidKey = () => Object.assign(Error("Invalid subscription key"), { status: 400 });

/** R5 cap mirror: the device's SUBSCRIBE_PATH_OK (dpi-backend/src/tunnel.ts) accepts at most 256
 *  characters after `?`. A docs list longer than that would open a subscription the device refuses —
 *  refuse it HERE (400 to the PUT caller) instead of signing the browser up for a silent starvation. */
const SUB_QUERY_MAX_CHARS = 256;

export function parseSubKey(key: string) {
  const m = key.match(KEY);
  if (!m) throw invalidKey();
  const [, deviceId, scope, a, b, docs] = m;
  const q = docs ? `?docs=${docs}` : "";
  if (q.length - 1 > SUB_QUERY_MAX_CHARS) throw invalidKey();
  const enc = (part: string) => {
    try {
      return encodeURIComponent(decodeURIComponent(part));
    } catch {
      throw invalidKey();
    }
  };
  if (scope === "device") return { key, deviceId, path: `/v1/events${q}` };
  if (scope === "session" && a && !b)
    return { key, deviceId, path: `/v1/sessions/${enc(a)}/events` };
  if (scope === "agent" && a && b)
    return { key, deviceId, path: `/v1/sessions/${enc(a)}/agents/${enc(b)}/events${q}` };
  throw invalidKey();
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    // R18 (run-4 h5): remove the abort listener on the timer path too — a
    // completed sleep used to leave one listener on the long-lived signal,
    // and a flapping device retained closures without bound.
    const onAbort = () => (clearTimeout(timer), resolve());
    const timer = setTimeout(() => (signal.removeEventListener("abort", onAbort), resolve()), ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

export class StreamMux {
  private streams = new Map<string, BrowserStream>();
  private tunnel?: TunnelTransportSource;
  /** Live reader count per deviceId across all tabs (monitor adds its own). */
  private readersByDevice = new Map<string, number>();
  /** Run-9 U5/U8: device-authored tree frames dropped at the relay seam for
   *  exceeding the monitor-mirror bounds — surfaced via relayStats(). */
  private droppedTreeFrames = 0;
  /** Run-11 h4-5 (Unit A): tree frames coalesced away by the per-follow
   *  token bucket (see follow() — the bucket itself is LOCAL to each loop,
   *  cold-review r11 f2, so there is no Map state here to leak or share). */
  private coalescedTreeFrames = 0;

  constructor(
    private readonly registry: NetworkRegistry,
    private readonly monitor: DeviceMonitor,
    private readonly options: { budget?: ByteBudget } = {},
  ) {
    // r10 h1-5: ONE network snapshot + ONE serialization per monitor change,
    // shared by every open tab — the old per-tab listener rebuilt and
    // re-stringified the whole network view (≤32×256KiB trees) once per tab
    // per change. The invalidator fires once; the first tab's send lazily
    // rebuilds the cached text.
    this.monitor.onChange(() => {
      this.networkText = undefined;
    });
  }

  /** Cached `data:` payload for the network fan-out (r10 h1-5). */
  private networkText?: string;

  private readerCount(deviceId: string): number {
    const mux = this.readersByDevice.get(deviceId) ?? 0;
    // The monitor owns one reader per tunnel device (P2-15).
    const monitorReader = this.tunnel?.hasLiveConnection(deviceId) ? 1 : 0;
    return mux + monitorReader;
  }

  private hubReaderCount(): number {
    let total = 0;
    for (const n of this.readersByDevice.values()) total += n;
    return total;
  }

  get size() {
    return this.streams.size;
  }

  /** Read-only relay admission counters for tests and diagnostics. */
  relayStats(): { droppedTreeFrames: number; coalescedTreeFrames: number } {
    return {
      droppedTreeFrames: this.droppedTreeFrames,
      // run-11 h4-5 (Unit A): token-bucket coalescing, surfaced on
      // GET /api/network next to droppedTreeFrames (main.ts spreads this
      // object verbatim into the relay payload — no shape change needed).
      coalescedTreeFrames: this.coalescedTreeFrames,
    };
  }

  /** Wire the tunnel dispatcher source (main.ts, after construction). */
  setTunnelSource(source: TunnelTransportSource): void {
    this.tunnel = source;
  }

  open(_req: Request, res: Response) {
    const streamId = randomUUID();
    res.status(200).set({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();
    let closed = false;
    let ping: NodeJS.Timeout | undefined;
    let off = () => {};
    const cleanup = () => {
      if (closed) return;
      closed = true;
      writer.close();
      clearInterval(ping);
      off();
      for (const [key, ctl] of stream.upstreams) {
        ctl.abort();
        this.releaseReader(key);
      }
      stream.upstreams.clear();
      this.streams.delete(streamId);
    };
    const writer = pacedSseWriter(res, { budget: this.options.budget, onClose: cleanup });
    const stream: BrowserStream = {
      upstreams: new Map(),
      send: (frame, preSerialized) => {
        const text = preSerialized ?? JSON.stringify(frame);
        if (writer.write(`data: ${text}\n\n`) === "too-large") {
          stream.send({
            sub: frame.sub,
            frame: {
              type: "fault",
              error: {
                code: "invalid",
                message: `Stream event exceeds ${LOGICAL_MESSAGE_MAX_BYTES} bytes; reduce the scope or payload`,
              },
            },
          });
        }
      },
    };
    this.streams.set(streamId, stream);
    stream.send({ sub: "hello", frame: { type: "stream", streamId } });
    if (closed) return;
    const pushNetwork = () => {
      const text = (this.networkText ??= JSON.stringify({
        sub: "network",
        frame: { type: "network", devices: this.monitor.network() },
      }));
      stream.send({ sub: "network", frame: { type: "network", devices: [] } }, text);
    };
    pushNetwork();
    if (closed) return;
    off = this.monitor.onChange(pushNetwork);
    // Ping rides the SAME chain as events: it can only land between complete
    // events, never inside a half-written one.
    ping = setInterval(() => !closed && writer.write(": ping\n\n"), 15_000);
  }

  /** Replace a tab's subscription set: open new upstreams, close dropped ones. */
  subscribe(streamId: string, keys: unknown) {
    const stream = this.streams.get(streamId);
    if (!stream) throw Object.assign(Error("Stream closed; reconnect"), { status: 404 });
    if (!Array.isArray(keys) || keys.some((k) => typeof k !== "string") || keys.length > 20)
      throw Object.assign(Error("subs must be a list of up to 20 keys"), { status: 400 });
    const wanted = new Map(
      (keys as string[]).filter((k) => k !== "network").map((k) => [k, parseSubKey(k)]),
    );
    // All-or-nothing like the parse above (R5): every device the PUT names must exist BEFORE
    // anything is closed or opened, so an unknown device cannot leave upstreams opened and
    // reader slots acquired by earlier keys in the same PUT dangling behind a 404.
    for (const [key, sub] of wanted)
      if (!stream.upstreams.has(key) && !this.registry.get(sub.deviceId))
        throw Object.assign(Error(`No device ${sub.deviceId}`), { status: 404 });
    for (const [key, ctl] of stream.upstreams)
      if (!wanted.has(key)) {
        ctl.abort();
        stream.upstreams.delete(key);
        this.releaseReader(key);
      }
    for (const [key, sub] of wanted)
      if (!stream.upstreams.has(key)) {
        // Reader caps (04 §8): 128/device incl. the monitor's reader, 1024
        // hub-wide. A rejected NEW reader must not disturb existing readers.
        // (The registry check ran before any mutation — see above.)
        if (
          this.readerCount(sub.deviceId) >= READERS_PER_DEVICE ||
          this.hubReaderCount() >= READERS_PER_HUB
        ) {
          stream.send({
            sub: key,
            frame: {
              type: "fault",
              error: {
                code: "unavailable",
                message: `Reader cap reached for ${sub.deviceId}; close other tabs or retry`,
              },
            },
          });
          continue;
        }
        this.acquireReader(sub.deviceId);
        const ctl = new AbortController();
        stream.upstreams.set(key, ctl);
        void this.follow(stream, sub, ctl.signal);
      }
    return { subs: ["network", ...wanted.keys()] };
  }

  private acquireReader(deviceId: string): void {
    this.readersByDevice.set(deviceId, (this.readersByDevice.get(deviceId) ?? 0) + 1);
  }

  private releaseReader(key: string): void {
    try {
      const sub = parseSubKey(key);
      const n = this.readersByDevice.get(sub.deviceId) ?? 0;
      if (n <= 1) this.readersByDevice.delete(sub.deviceId);
      else this.readersByDevice.set(sub.deviceId, n - 1);
    } catch {
      /* non-parsable key never acquired a reader */
    }
  }

  private async follow(
    stream: BrowserStream,
    sub: ReturnType<typeof parseSubKey>,
    signal: AbortSignal,
  ) {
    const backoff = new Backoff(RECONNECT_BACKOFF_S);
    // run-11 h4-5 (Unit A; cold-review r11 f2 rework): the tree token bucket
    // is LOCAL to this follow() loop — one budget per (tab × sub) reader. A
    // Map keyed by sub.key shared across follow() loops let a second tab on
    // the same key drain this loop's budget, and the entry's deletion on the
    // OTHER tab's exit lazily re-armed a FULL bucket here — bypassable
    // shaping. Local state has neither seam. Reset to full at every
    // (re)connect: the device's initial tree (a tab's first full view after a
    // flap) always relays.
    let treeTokens = TREE_BUCKET_CAPACITY;
    let treeTokensAt = Date.now();
    /** Consume one tree token (refill TREE_BUCKET_REFILL_PER_SEC, clamped at
     *  capacity; fractional idle credit kept on refuse). False = exhausted —
     *  the caller coalesces (snapshots supersede each other; the next tree
     *  delivers a strictly fresher view). */
    const admitTree = (): boolean => {
      const now = Date.now();
      const tokens = Math.min(
        TREE_BUCKET_CAPACITY,
        treeTokens + ((now - treeTokensAt) / 1000) * TREE_BUCKET_REFILL_PER_SEC,
      );
      treeTokensAt = now;
      if (tokens < 1) {
        treeTokens = tokens;
        return false;
      }
      treeTokens = tokens - 1;
      return true;
    };
    while (!signal.aborted) {
      await this.monitor.whenOnline(sub.deviceId, signal);
      if (signal.aborted) return;
      treeTokens = TREE_BUCKET_CAPACITY;
      treeTokensAt = Date.now();
      const device = this.registry.get(sub.deviceId);
      const transport = device ? transportFor(device, this.tunnel) : undefined;
      if (!transport?.available) return;
      try {
        for await (const frame of transport.watch(
          { path: sub.path, consumerId: `mux:${sub.key}` },
          signal,
        )) {
          if (!checkDeviceFrame(frame))
            throw new DpiError("invalid", "Invalid device stream frame");
          // snapshot/agents/network carry whole-document payloads by design
          // (a session snapshot includes entries + inbox) and legitimately
          // exceed the per-event cap — capping them turned a large session's
          // live view into a fault with no reconnect path.
          const cap =
            frame.type === "tree" || frame.type === "snapshot" || frame.type === "agents"
              ? RELAY_TREE_CAP_BYTES
              : RELAY_FRAME_CAP_BYTES;
          const relayCapFault = () =>
            stream.send({
              sub: sub.key,
              frame: {
                type: "fault",
                error: {
                  code: "invalid",
                  message: `Device stream frame exceeds the relay cap (${cap} bytes)`,
                },
              },
            });
          // Run-9 U5/U8: the monitor seam (state owner) degrades oversized
          // trees — but the RELAY is a pipe, and the tunnel chunk path exists
          // precisely to deliver legitimately large trees (tunnel-pacing
          // contract: a 1.5MB chunked tree arrives intact). The pipe's byte
          // cap is RELAY_TREE_CAP_BYTES; here we mirror only the session-COUNT
          // policy. Byte parity with the monitor was tried and reverted: it
          // dropped the chunked-tree contract. A count violation faults —
          // never silently drops (r9 relay contract), never consumes a token,
          // and the subscription survives (skip, not cut). Checked FIRST so
          // both paths below share it (cold-review r11 f3 ordering).
          if (frame.type === "tree") {
            const sessions = Array.isArray(frame.tree?.sessions) ? frame.tree.sessions : [];
            if (sessions.length > TREE_RELAY_MAX_SESSIONS) {
              this.droppedTreeFrames++;
              stream.send({
                sub: sub.key,
                frame: {
                  type: "fault",
                  error: {
                    code: "invalid",
                    message: `Device tree frame exceeds the relay tree cap (${TREE_RELAY_MAX_SESSIONS} sessions)`,
                  },
                },
              });
              continue;
            }
          }
          // run-11 h1-1 (Unit A; cold-review r11 f1/f3 rework): chunked
          // (tunnel) frames already know their exact serialized size
          // (reassembledFrameBytes, recorded at the reassembly push seam in
          // tunnel-transport). For them EVERY admission decision precedes the
          // one serialization: an oversized multi-MiB frame faults on
          // raw + EXACT wrapper overhead (relayWrapperOverhead — a constant
          // allowance ≥ the real overhead faulted LEGAL near-cap frames), and
          // a burst tree the token bucket coalesces away costs ZERO
          // stringify. For canonical device JSON (the device's own
          // JSON.stringify — the normal case) the pre-check faults exactly
          // what the authoritative check would; hand-crafted non-canonical
          // raw bytes can only diverge into an early fault (self-harm) or a
          // late catch — the belt-and-braces byteLength(text) check below
          // still gates every admission, so nothing over-cap ever relays.
          const rawBytes = reassembledFrameBytes.get(frame);
          if (rawBytes !== undefined) {
            if (rawBytes + relayWrapperOverhead(sub.key) > cap) {
              relayCapFault();
              continue;
            }
            if (frame.type === "tree" && !admitTree()) {
              // run-11 h4-5 (Unit A): bucket exhausted — coalesce (drop) this
              // legal snapshot silently and count it: unlike the faults above
              // (protocol violations worth surfacing), this is rate shaping of
              // frames that supersede each other; the next tree (a healthy
              // device re-pushes on state change within ~500 ms) delivers a
              // strictly fresher view. Runs AFTER every admission check, so
              // violations still fault and never consume a token.
              this.coalescedTreeFrames++;
              continue;
            }
            // run-8 U5 + h1-1: serialize ONCE — the only stringify on this
            // path — admit on its byte size, hand the same string to the
            // writer. Belt-and-braces after the pre-check: non-canonical raw
            // bytes can re-stringify LONGER than raw (exponent-form numbers,
            // e.g. 1e-9 → 0.000000001), so this check is still load-bearing.
            const text = JSON.stringify({ sub: sub.key, frame });
            if (Buffer.byteLength(text) > cap) {
              relayCapFault();
              continue;
            }
            stream.send({ sub: sub.key, frame }, text);
            if (frame.type === "hello") backoff.reset();
            continue;
          }
          // run-8 U5: inline/LAN frames have no raw-bytes side-channel — this
          // stays the authoritative path: serialize ONCE here, admit on its
          // byte size, and hand the same string to every tab.
          const text = JSON.stringify({ sub: sub.key, frame });
          if (Buffer.byteLength(text) > cap) {
            relayCapFault();
            continue;
          }
          if (frame.type === "tree" && !admitTree()) {
            this.coalescedTreeFrames++;
            continue;
          }
          stream.send({ sub: sub.key, frame }, text);
          if (frame.type === "hello") backoff.reset();
        }
        if (signal.aborted) return;
        stream.send({ sub: sub.key, frame: { type: "disconnected", reason: "Stream ended" } });
      } catch (e) {
        if (signal.aborted) return;
        const err =
          e instanceof DpiError ? e : new DpiError("offline", String((e as Error)?.message ?? e));
        if (err.code === "not_found" || err.code === "invalid" || err.code === "ambiguous") {
          stream.send({
            sub: sub.key,
            frame: { type: "fault", error: { code: err.code, message: err.message } },
          });
          return;
        }
        stream.send({ sub: sub.key, frame: { type: "disconnected", reason: err.message } });
      }
      await sleep(backoff.ms, signal);
      backoff.advance();
    }
  }
}
