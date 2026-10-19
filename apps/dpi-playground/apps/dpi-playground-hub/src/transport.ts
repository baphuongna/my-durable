// SPIKE P2-01 — THROWAWAY. DeviceTransport seam + a loopback stand-in for the device↔hub WSS tunnel.
// This file exists to prove four invariants (tokenless tunnel through monitor/mux/proxy, multi-consumer
// mux, large payload pacing, rotation reconnect) BEFORE the production implementation (P2-08..P2-19).
// It is NOT production code: no auth, no rate limits, no chunk accounting beyond what the invariants
// need. The mock is recorded: the WSS leg is a real loopback TCP socket pair with length-prefixed JSON
// frames, 64 KiB paced writes awaiting drain, and a 1 MiB per-frame read cap (standing in for ws
// maxPayload). P2-03/P2-12/P2-14 replace all of this.
import { createServer, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import { DpiClient } from "../../../../dpi-sdk/src/client.js";
import type { DeviceInfo, Frame } from "../../../../dpi-sdk/src/api.js";
import type { DeviceRow } from "../../../../dpi-sdk/src/node/registry.js";

export interface DeviceTransport {
  readonly deviceId: string;
  /** A tunnel row with a live authenticated connection is available without any stored token. */
  available(): boolean;
  device(opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<DeviceInfo>;
  stream(path: string, signal: AbortSignal): AsyncIterable<Frame>;
  request(path: string, init: { method: string; headers?: Record<string, string>; body?: string }, signal?: AbortSignal): Promise<{ status: number; contentType: string; text: string }>;
}

// ---------------------------------------------------------------- LAN (today's behavior, unchanged)

export class LanTransport implements DeviceTransport {
  readonly deviceId: string;
  private readonly client: DpiClient;
  private readonly url: string;
  private readonly token: string;
  constructor(device: DeviceRow) {
    this.deviceId = device.id;
    this.url = device.url;
    this.token = device.token ?? "";
    this.client = new DpiClient(this.url, this.token);
  }
  available() {
    return !!this.token;
  }
  device(opts?: { timeoutMs?: number; signal?: AbortSignal }) {
    return this.client.device(opts);
  }
  stream(path: string, signal: AbortSignal) {
    return this.client.stream(path, signal);
  }
  async request(path: string, init: { method: string; headers?: Record<string, string>; body?: string }) {
    const upstream = await fetch(this.url + path, {
      method: init.method,
      headers: { ...init.headers, authorization: `Bearer ${this.token}`, "x-dpi-token": this.token },
      body: init.body,
    });
    return { status: upstream.status, contentType: upstream.headers.get("content-type") ?? "application/json", text: await upstream.text() };
  }
}

// ---------------------------------------------------------------- tunnel channel (loopback stand-in for WSS)

const MAX_FRAME_BYTES = 1_048_576; // ws maxPayload stand-in
const CHUNK = 64 * 1024; // paced write size (plan §2.2)

/** Writes one length-prefixed JSON message in ≤64 KiB chunks, awaiting drain; returns bytes written. */
export const pacingStats = { chunkWrites: 0, drainWaits: 0, bytes: 0 };
export async function writeFramePaced(socket: Socket, message: unknown): Promise<number> {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(8); // 4-byte BE length + 4 reserved
  header.writeUInt32BE(payload.length, 0);
  const full = Buffer.concat([header, payload]);
  for (let off = 0; off < full.length; off += CHUNK) {
    const chunk = full.subarray(off, Math.min(off + CHUNK, full.length));
    pacingStats.chunkWrites++;
    pacingStats.bytes += chunk.length;
    if (!socket.write(chunk)) {
      pacingStats.drainWaits++;
      await EventEmitter.once(socket, "drain");
    }
  }
  return full.length;
}

let messageIds = 0;

/**
 * Writes one JSON message over the wire. Payloads above CHUNK_MAX are split into `chunk` envelopes and
 * reassembled by the reader (the spike's stand-in for P2-14's TunnelFrame/TunnelChunk: ≤1 MiB wire
 * frames, byte-exact reassembly).
 */
export async function writeMessage(socket: Socket, value: unknown): Promise<number> {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) <= CHUNK_MAX) return writeFramePaced(socket, { t: "m", text });
  const cid = ++messageIds;
  const buf = Buffer.from(text, "utf8");
  const total = Math.ceil(buf.length / CHUNK_MAX);
  let written = 0;
  for (let seq = 0; seq < total; seq++) {
    const part = buf.subarray(seq * CHUNK_MAX, Math.min((seq + 1) * CHUNK_MAX, buf.length));
    written += await writeFramePaced(socket, { t: "c", cid, seq, total, b64: part.toString("base64") });
  }
  return written;
}

const CHUNK_MAX = 700 * 1024; // base64 of this stays under the 1 MiB wire cap

type Wire =
  | { t: "req"; id: number; method: string; path: string; body?: string }
  | { t: "res"; id: number; status: number; contentType: string; text: string }
  | { t: "sse-open"; id: number; path: string }
  | { t: "sse-data"; id: number; text: string }
  | { t: "sse-end"; id: number; reason: string }
  | { t: "hello"; deviceId: string; uid: string }
  | { t: "m"; text: string }
  | { t: "c"; cid: number; seq: number; total: number; b64: string };

/** Reads length-prefixed frames from a socket; rejects frames above the 1 MiB cap; reassembles chunked messages. */
export const reassemblyLog: string[] = [];

export function frameReader(socket: Socket, onFrame: (wire: Wire) => void, onBad: (err: Error) => void) {
  let buffer = Buffer.alloc(0);
  const parts = new Map<number, { total: number; got: string[] }>();
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 8) return;
      const len = buffer.readUInt32BE(0);
      if (len > MAX_FRAME_BYTES) {
        onBad(new Error(`frame of ${len} bytes exceeds the 1 MiB tunnel cap`));
        return;
      }
      if (buffer.length < 8 + len) return;
      const payload = buffer.subarray(8, 8 + len);
      buffer = buffer.subarray(8 + len);
      try {
        const wire = JSON.parse(payload.toString("utf8")) as Wire;
        if (wire.t === "m") {
          onFrame(JSON.parse(wire.text) as Wire);
        } else if (wire.t === "c") {
          const acc = parts.get(wire.cid) ?? { total: wire.total, got: [] };
          acc.got[wire.seq] = wire.b64;
          parts.set(wire.cid, acc);
          reassemblyLog.push(`c cid=${wire.cid} seq=${wire.seq}/${wire.total}`);
          if (acc.got.filter(Boolean).length === acc.total) {
            parts.delete(wire.cid);
            const text = Buffer.concat(acc.got.map((b64) => Buffer.from(b64, "base64"))).toString("utf8");
            reassemblyLog.push(`c-done cid=${wire.cid} textBytes=${text.length}`);
            onFrame(JSON.parse(text) as Wire);
          }
        } else {
          onFrame(wire);
        }
      } catch (e) {
        onBad(e as Error);
      }
    }
  });
}

/**
 * Hub-side stand-in for the WSS endpoint: devices connect (outbound, like WSS), say hello with their
 * UID, and then serve requests/streams that the hub sends. One authenticated connection per device.
 */
export class TunnelServer {
  private connections = new Map<string, { socket: Socket; uid: string }>();
  private server = createServer();
  private nextId = 1;
  private pending = new Map<number, { resolve: (w: Wire) => void }>();
  private streams = new Map<number, { push: (frame: Frame) => void; end: (reason: string) => void }>();
  private readonly events = new EventEmitter();
  readonly debugLog: string[] = [];

  async listen(): Promise<number> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    const port = (this.server.address() as { port: number }).port;
    this.server.on("connection", (socket: Socket) => {
      frameReader(
        socket,
        (wire) => void this.onWire(socket, wire),
        () => socket.destroy(),
      );
      socket.on("close", () => {
        for (const [uid, c] of this.connections) if (c.socket === socket) this.connections.delete(uid);
        this.events.emit("disconnect");
      });
    });
    return port;
  }

  private async onWire(socket: Socket, wire: Wire) {
    if (wire.t === "hello") {
      this.connections.set(wire.uid, { socket, uid: wire.uid });
      this.events.emit("connect", wire.uid);
      return;
    }
    if (wire.t === "res") this.pending.get(wire.id)?.resolve(wire);
    if (wire.t === "sse-data") {
      const frame = parseSseFrame(wire.text);
      this.debugLog.push(`sse-data id=${wire.id} type=${(frame as { type?: string }).type} bytes=${wire.text.length}`);
      this.streams.get(wire.id)?.push(frame);
    }
    if (wire.t === "sse-end") this.streams.get(wire.id)?.end(wire.reason);
  }

  has(uid: string) {
    return this.connections.has(uid);
  }
  on(event: "connect" | "disconnect", fn: (...a: unknown[]) => void) {
    this.events.on(event, fn);
    return () => this.events.off(event, fn);
  }

  /** A DeviceTransport bound to one device UID's live connection. */
  transportFor(deviceId: string, uid: string): DeviceTransport {
    return {
      deviceId,
      available: () => this.connections.has(uid),
      device: async (opts) => {
        const res = await this.request("/v1/device", { method: "GET" }, opts?.signal);
        if (res.status !== 200) throw Object.assign(new Error(`device probe failed: ${res.status}`), { code: "offline" });
        return JSON.parse(res.text) as DeviceInfo;
      },
      stream: (path, signal) => {
        const id = this.nextId++;
        const conn = this.connections.get(uid)!;
        void writeMessage(conn.socket, { t: "sse-open", id, path });
        signal.addEventListener("abort", () => void this.streams.delete(id), { once: true });
        const queue: Frame[] = [];
        let notify: (() => void) | undefined;
        let done: ((reason: string) => void) | undefined;
        this.streams.set(id, {
          push: (frame) => {
            queue.push(frame);
            notify?.();
          },
          end: (reason) => {
            queue.push({ type: "disconnected", reason } as Frame);
            notify?.();
          },
        });
        const cleanup = () => this.streams.delete(id);
        return (async function* () {
          try {
            for (;;) {
              while (queue.length) {
                const frame = queue.shift()!;
                if ((frame as { type: string }).type === "disconnected") return;
                yield frame;
              }
              await new Promise<void>((resolve) => {
                notify = resolve;
                setTimeout(resolve, 10_000); // idle guard; the plan's keepalive lives in P2-13
              });
              notify = undefined;
              if (signal.aborted) return;
            }
          } finally {
            cleanup();
            done?.("");
          }
        })();
      },
      request: (path, init, signal) => this.requestFor(uid, path, init, signal),
    };
  }

  private async requestFor(uid: string, path: string, init: { method: string; headers?: Record<string, string>; body?: string }, signal?: AbortSignal): Promise<{ status: number; contentType: string; text: string }> {
    const conn = this.connections.get(uid);
    if (!conn) throw Object.assign(new Error("no tunnel connection"), { code: "offline" });
    const id = this.nextId++;
    const waiter = new Promise<{ status: number; contentType: string; text: string }>((resolve) => {
      this.pending.set(id, { resolve: (w) => resolve({ status: (w as { status: number }).status, contentType: (w as { contentType: string }).contentType, text: (w as { text: string }).text }) });
      if (signal)
        signal.addEventListener("abort", () => resolve({ status: 503, contentType: "application/json", text: '{"error":{"code":"offline"}}' }), { once: true });
    });
    await writeMessage(conn.socket, { t: "req", id, method: init.method, path, body: init.body });
    const res = await waiter;
    this.pending.delete(id);
    return res;
  }

  private async request(path: string, init: { method: string; headers?: Record<string, string>; body?: string }, signal?: AbortSignal): Promise<{ status: number; contentType: string; text: string }> {
    const conn = [...this.connections.values()][0];
    if (!conn) throw Object.assign(new Error("no tunnel connection"), { code: "offline" });
    const id = this.nextId++;
    const waiter = new Promise<{ t: "res"; id: number; status: number; contentType: string; text: string }>((resolve) => {
      this.pending.set(id, { resolve: resolve as (w: Wire) => void });
      if (signal)
        signal.addEventListener(
          "abort",
          () => resolve({ t: "res", id, status: 503, contentType: "application/json", text: '{"error":{"code":"offline"}}' } as never),
          { once: true },
        );
    });
    await writeMessage(conn.socket, { t: "req", id, method: init.method, path, body: init.body });
    const res = await waiter;
    this.pending.delete(id);
    return { status: res.status, contentType: res.contentType, text: res.text };
  }
}

function parseSseFrame(text: string): Frame {
  // The connector forwards complete "data: {...}\n\n" blocks; parse the JSON payload.
  const match = /^data: (.+)$/m.exec(text);
  return (match ? JSON.parse(match[1]) : { type: "disconnected", reason: "unparsable" }) as Frame;
}

/** Pick the transport for a device row: tunnel rows carry `transport: "tunnel"` (spike rows only). */
export function transportFor(device: DeviceRow, tunnels: TunnelServer): DeviceTransport {
  if ((device as DeviceRow & { transport?: string }).transport === "tunnel")
    return tunnels.transportFor(device.id, device.deviceUid!);
  return new LanTransport(device);
}
