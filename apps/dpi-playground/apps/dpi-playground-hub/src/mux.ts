// One SSE connection per browser tab. The tab names the streams it wants (subscription keys);
// the hub opens one authenticated upstream per key and tags every frame with its key.
//   network                                  registry + live status of every device
//   <device>/device[?docs=a,b]               device stream
//   <device>/session/<sessionId>             session stream
//   <device>/agent/<sessionId>/<agentId>[?docs=a,b]
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { EventEmitter } from "node:events";
import { DpiClient } from "../../../../dpi-sdk/src/client.js";
import { transportFor, type TunnelServer } from "./transport.js";
import { DpiError } from "../../../../dpi-sdk/src/errors.js";
import type { MuxFrame } from "../../../../dpi-sdk/src/api.js";
import type { NetworkRegistry } from "../../../../dpi-sdk/src/node/registry.js";
import type { DeviceMonitor } from "./monitor.js";

interface BrowserStream {
  send(frame: MuxFrame): void;
  upstreams: Map<string, AbortController>;
}

const KEY =
  /^([a-z0-9][a-z0-9-]{0,31})\/(device|session|agent|spike)(?:\/([^/?]+))?(?:\/([^/?]+))?(?:\?docs=([a-z0-9.,-]*))?$/; // SPIKE: "spike" scope for P2-01 large-payload tests

export function parseSubKey(key: string) {
  const m = key.match(KEY);
  if (!m) throw Error(`Invalid subscription key: ${key}`);
  const [, deviceId, scope, a, b, docs] = m;
  const q = docs ? `?docs=${docs}` : "";
  const enc = encodeURIComponent;
  if (scope === "device") return { key, deviceId, path: `/v1/events${q}` };
  if (scope === "spike" && a && !b) return { key, deviceId, path: `/v1/spike/events?bytes=${encodeURIComponent(a)}` }; // SPIKE P2-01
  if (scope === "session" && a && !b)
    return { key, deviceId, path: `/v1/sessions/${enc(decodeURIComponent(a))}/events` };
  if (scope === "agent" && a && b)
    return {
      key,
      deviceId,
      path: `/v1/sessions/${enc(decodeURIComponent(a))}/agents/${enc(decodeURIComponent(b))}/events${q}`,
    };
  throw Error(`Invalid subscription key: ${key}`);
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

// SPIKE P2-01 debug log (module-level so tests can read it)
export const muxDebugLog: string[] = [];

export class StreamMux {
  private streams = new Map<string, BrowserStream>();
  /** SPIKE P2-01: peak output-buffer bytes per stream, for the pacing invariant's traces. */
  private peaks = new Map<string, number>();
  debugPeaks() {
    return Object.fromEntries(this.peaks);
  }
  /** SPIKE P2-01 debug */
  readonly debugLog: string[] = [];

  constructor(
    private readonly registry: NetworkRegistry,
    private readonly monitor: DeviceMonitor,
    private readonly tunnels?: TunnelServer, // SPIKE P2-01
  ) {}

  get size() {
    return this.streams.size;
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
    // SPIKE P2-01 (I3): paced SSE writes — serialize frames, write in 64 KiB segments, await drain,
    // and only drop a viewer past the 4 MB output cap once draining cannot keep up. A large frame no
    // longer trips the cap by itself (plan §2.2: hub SSE 4.000.000 B, write ≤64 KiB awaiting drain).
    let writing = Promise.resolve();
    let peakBuffered = 0;
    const pacedWrite = async (text: string) => {
      const payload = Buffer.from(text, "utf8");
      let drains = 0;
      for (let off = 0; off < payload.length; off += 64 * 1024) {
        if (closed) {
          muxDebugLog.push(`paced ABORT closed off=${off}/${payload.length}`);
          return;
        }
        peakBuffered = Math.max(peakBuffered, res.writableLength);
        if (res.writableLength > 4_000_000 && off > 0) {
          muxDebugLog.push(`paced DROP off=${off}/${payload.length} buffered=${res.writableLength}`);
          return void res.end();
        }
        const ok = res.write(payload.subarray(off, Math.min(off + 64 * 1024, payload.length)));
        if (!ok) {
          drains++;
          await EventEmitter.once(res, "drain").catch(() => {});
        }
      }
      muxDebugLog.push(`paced DONE bytes=${payload.length} drains=${drains} peak=${peakBuffered} closed=${closed}`);
    };
    const stream: BrowserStream = {
      upstreams: new Map(),
      send: (frame) => {
        if (closed) return;
        muxDebugLog.push(`send sub=${frame.sub} type=${frame.frame?.type}`);
        writing = writing.then(() => pacedWrite(`data: ${JSON.stringify(frame)}\n\n`));
      },
    };
    (stream as BrowserStream & { peakBuffered: () => number }).peakBuffered = () => peakBuffered;
    this.streams.set(streamId, stream);
    this.peaks.set(streamId, 0);
    const trackPeak = setInterval(() => this.peaks.set(streamId, Math.max(this.peaks.get(streamId) ?? 0, res.writableLength)), 5);
    stream.send({ sub: "hello", frame: { type: "stream", streamId } });
    const pushNetwork = () =>
      stream.send({ sub: "network", frame: { type: "network", devices: this.monitor.network() } });
    pushNetwork();
    const off = this.monitor.onChange(pushNetwork);
    // SPIKE P2-01 (I3): with paced multi-chunk writes, a direct res.write here can land INSIDE a
    // half-written JSON frame and silently corrupt it (reproduced: a 6 MiB snapshot lost this way).
    // Pings must join the same serialized write chain as frames (plan P2-18).
    const ping = setInterval(() => !closed && (writing = writing.then(() => pacedWrite(": ping\n\n"))), 15_000);
    res.on("close", () => {
      closed = true;
      clearInterval(ping);
      clearInterval(trackPeak);
      off();
      for (const ctl of stream.upstreams.values()) ctl.abort();
      this.streams.delete(streamId);
    });
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
      }
    for (const [key, sub] of wanted)
      if (!stream.upstreams.has(key)) {
        if (!this.registry.get(sub.deviceId))
          throw Object.assign(Error(`No device ${sub.deviceId}`), { status: 404 });
        const ctl = new AbortController();
        stream.upstreams.set(key, ctl);
        void this.follow(stream, sub, ctl.signal);
      }
    return { subs: ["network", ...wanted.keys()] };
  }

  private async follow(
    stream: BrowserStream,
    sub: ReturnType<typeof parseSubKey>,
    signal: AbortSignal,
  ) {
    let backoff = 1_000;
    while (!signal.aborted) {
      await this.monitor.whenOnline(sub.deviceId, signal);
      if (signal.aborted) return;
      const device = this.registry.get(sub.deviceId);
      if (!device) return;
      // SPIKE P2-01: the upstream comes from the transport seam (tunnel rows carry no token).
      const upstream = this.tunnels
        ? transportFor(device, this.tunnels)
        : new DpiClient(device.url, device.token!);
      if (!("available" in upstream) || !(upstream as { available(): boolean }).available()) {
        if (!device.token) return;
      }
      try {
        for await (const frame of upstream.stream(sub.path, signal)) {
          this.debugLog.push(`follow ${sub.key} -> ${(frame as { type?: string }).type}`);
          stream.send({ sub: sub.key, frame });
          if (frame.type === "hello") backoff = 1_000;
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
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, 15_000);
    }
  }
}
