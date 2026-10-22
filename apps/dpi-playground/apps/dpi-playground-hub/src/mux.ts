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
import type { MuxFrame } from "../../../../dpi-sdk/src/api.js";
import type { NetworkRegistry } from "../../../../dpi-sdk/src/node/registry.js";
import type { DeviceMonitor, TunnelTransportSource } from "./monitor.js";
import { ByteBudget } from "../../../../dpi-sdk/src/node/chunk.js";
import { createPacedSseWriter, type PacedSseWriter } from "../../../../dpi-sdk/src/node/sse-writer.js";
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
  send(frame: MuxFrame): void;
  upstreams: Map<string, AbortController>;
}

const sseBudget = new ByteBudget("hub-sse", HUB_BUFFER_BUDGET_BYTES);

/**
 * Serialized paced writer (04 §10): complete SSE events only, split into
 * ≤64 KiB segments, waiting for drain between segments. The chain guarantees
 * a `: ping` can never land inside a half-written event, and a slow viewer is
 * cut at the CANON hub cap instead of buffering without bound.
 */
export function pacedSseWriter(res: Response, opts: { budget?: ByteBudget; onClose?: () => void } = {}): PacedSseWriter {
  return createPacedSseWriter(res, {
    maxBufferedBytes: SSE_HUB_VIEWER_BYTES,
    budget: opts.budget ?? sseBudget,
    onClose: opts.onClose,
  });
}

const KEY =
  /^([a-z0-9][a-z0-9-]{0,31})\/(device|session|agent)(?:\/([^/?]+))?(?:\/([^/?]+))?(?:\?docs=([a-z0-9.,-]*))?$/;

const invalidKey = () => Object.assign(Error("Invalid subscription key"), { status: 400 });

export function parseSubKey(key: string) {
  const m = key.match(KEY);
  if (!m) throw invalidKey();
  const [, deviceId, scope, a, b, docs] = m;
  const q = docs ? `?docs=${docs}` : "";
  const enc = (part: string) => {
    try {
      return encodeURIComponent(decodeURIComponent(part));
    } catch {
      throw invalidKey();
    }
  };
  if (scope === "device") return { key, deviceId, path: `/v1/events${q}` };
  if (scope === "session" && a && !b) return { key, deviceId, path: `/v1/sessions/${enc(a)}/events` };
  if (scope === "agent" && a && b) return { key, deviceId, path: `/v1/sessions/${enc(a)}/agents/${enc(b)}/events${q}` };
  throw invalidKey();
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

export class StreamMux {
  private streams = new Map<string, BrowserStream>();
  private tunnel?: TunnelTransportSource;
  /** Live reader count per deviceId across all tabs (monitor adds its own). */
  private readersByDevice = new Map<string, number>();

  constructor(
    private readonly registry: NetworkRegistry,
    private readonly monitor: DeviceMonitor,
    private readonly options: { budget?: ByteBudget } = {},
  ) {}

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
      send: (frame) => {
        if (writer.write(`data: ${JSON.stringify(frame)}\n\n`) === "too-large") {
          stream.send({
            sub: frame.sub,
            frame: { type: "fault", error: { code: "invalid", message: `Stream event exceeds ${LOGICAL_MESSAGE_MAX_BYTES} bytes; reduce the scope or payload` } },
          });
        }
      },
    };
    this.streams.set(streamId, stream);
    stream.send({ sub: "hello", frame: { type: "stream", streamId } });
    if (closed) return;
    const pushNetwork = () =>
      stream.send({ sub: "network", frame: { type: "network", devices: this.monitor.network() } });
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
    for (const [key, ctl] of stream.upstreams)
      if (!wanted.has(key)) {
        ctl.abort();
        stream.upstreams.delete(key);
        this.releaseReader(key);
      }
    for (const [key, sub] of wanted)
      if (!stream.upstreams.has(key)) {
        if (!this.registry.get(sub.deviceId))
          throw Object.assign(Error(`No device ${sub.deviceId}`), { status: 404 });
        // Reader caps (04 §8): 128/device incl. the monitor's reader, 1024
        // hub-wide. A rejected NEW reader must not disturb existing readers.
        if (this.readerCount(sub.deviceId) >= READERS_PER_DEVICE || this.hubReaderCount() >= READERS_PER_HUB) {
          stream.send({
            sub: key,
            frame: { type: "fault", error: { code: "unavailable", message: `Reader cap reached for ${sub.deviceId}; close other tabs or retry` } },
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
    while (!signal.aborted) {
      await this.monitor.whenOnline(sub.deviceId, signal);
      if (signal.aborted) return;
      const device = this.registry.get(sub.deviceId);
      const transport = device ? transportFor(device, this.tunnel) : undefined;
      if (!transport?.available) return;
      try {
        for await (const frame of transport.watch(
          { path: sub.path, consumerId: `mux:${sub.key}` },
          signal,
        )) {
          if (!checkDeviceFrame(frame)) throw new DpiError("invalid", "Invalid device stream frame");
          stream.send({ sub: sub.key, frame });
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
