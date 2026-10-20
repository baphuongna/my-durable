/**
 * Chunk codec + shared byte admission — Durable Agent Network P2-14
 * (spec 04 §3.3).
 *
 * One logical JSON message larger than the WS maxPayload travels as
 * `tunnel-chunk` frames: serialize ONCE to UTF-8 bytes, slice the BUFFER
 * (never the string — Unicode codepoints must not be split), base64 each raw
 * 64 KiB slice, and reassemble by correlation (subscriptionId / reqId).
 *
 * Memory is admitted BEFORE allocation: a chunk whose correlation has no
 * live reader/request reserves nothing. Every reservation is a ticket that is
 * released exactly once on success/failure/abort/timeout — double release is
 * a no-op, leak is detectable via `used`.
 *
 * Node-only (Buffer); browser bundles never import this module.
 */
import { validateChunkEnvelope } from "../protocol/tunnel.js";
import type { TunnelChunk } from "../protocol/tunnel.js";
import {
  CHUNK_RAW_BYTES,
  CONNECTION_BUFFER_BUDGET_BYTES,
  HUB_BUFFER_BUDGET_BYTES,
  LOGICAL_MESSAGE_MAX_BYTES,
  MAX_CHUNKS_PER_MESSAGE,
  REASSEMBLY_CONCURRENT_PER_CONNECTION,
  REASSEMBLY_TIMEOUT_MS,
} from "../protocol/limits.js";

/** Worst-case envelope overhead per chunk reserved against the logical cap. */
const ENVELOPE_OVERHEAD_BYTES = 256;

export type ChunkCorrelation =
  | { kind: "tunnel-data"; subscriptionId: string; sub: string }
  | { kind: "rest-request" | "rest-response"; reqId: string };

const correlationKey = (c: ChunkCorrelation) =>
  c.kind === "tunnel-data" ? `data:${c.subscriptionId}` : `${c.kind}:${c.reqId}`;

// ---------------------------------------------------------------------------
// Byte admission — ticketed reserve/release, exactly once.

export interface Reservation {
  readonly bytes: number;
  release(): void;
  /** True while this reservation still counts against the budget. */
  readonly live: boolean;
}

export class ByteBudget {
  private usedBytes = 0;
  private live = new Set<Reservation>();

  constructor(
    readonly name: string,
    readonly capacity: number,
  ) {}

  get used(): number {
    return this.usedBytes;
  }

  get liveCount(): number {
    return this.live.size;
  }

  /** Try to admit `bytes`; returns a ticket or null when over capacity. */
  reserve(bytes: number): Reservation | null {
    if (!Number.isFinite(bytes) || bytes < 0) return null;
    if (this.usedBytes + bytes > this.capacity) return null;
    this.usedBytes += bytes;
    const ticket: Reservation = {
      bytes,
      get live() {
        return ticketState;
      },
      release: () => {
        if (!ticketState) return; // exactly once
        ticketState = false;
        this.live.delete(ticket);
        this.usedBytes -= bytes;
      },
    };
    let ticketState = true;
    this.live.add(ticket);
    return ticket;
  }
}

/** The standard per-connection / hub-wide budgets (04 §3.3). */
export const standardBudgets = () => ({
  connection: new ByteBudget("connection", CONNECTION_BUFFER_BUDGET_BYTES),
  hub: new ByteBudget("hub", HUB_BUFFER_BUDGET_BYTES),
});

// ---------------------------------------------------------------------------
// Sender side.

export type ChunkSendFn = (chunk: TunnelChunk) => void;

export interface ChunkOptions {
  /** Test/deployment policy only — never per-message overridable in prod paths. */
  chunkRawBytes?: number;
  maxLogicalBytes?: number;
}

/**
 * Serialize `msg` once and emit chunk frames via `send`. Returns the wire
 * metrics (raw + overhead recorded SEPARATELY from byte accounting, per
 * W-2: parser/string overhead is not a hard heap limit).
 */
export function sendChunked(
  msg: unknown,
  correlation: ChunkCorrelation,
  send: ChunkSendFn,
  opts: ChunkOptions = {},
): { ok: true; rawBytes: number; overheadBytes: number } | { ok: false; error: string } {
  const chunkRaw = opts.chunkRawBytes ?? CHUNK_RAW_BYTES;
  const maxLogical = opts.maxLogicalBytes ?? LOGICAL_MESSAGE_MAX_BYTES;
  let buf: Buffer;
  try {
    buf = Buffer.from(JSON.stringify(msg), "utf8");
  } catch (e) {
    return { ok: false, error: `chunk: serialize failed: ${(e as Error).message}` };
  }
  if (buf.length === 0) return { ok: false, error: "chunk: empty message" };
  const count = Math.ceil(buf.length / chunkRaw);
  if (count > MAX_CHUNKS_PER_MESSAGE)
    return { ok: false, error: `chunk: message needs ${count} chunks (max ${MAX_CHUNKS_PER_MESSAGE})` };
  // Cap includes the envelope (04 §3.3): raw + per-chunk envelope estimate.
  const overhead = count * ENVELOPE_OVERHEAD_BYTES;
  if (buf.length + overhead > maxLogical)
    return { ok: false, error: `chunk: message ${buf.length}B + envelope ${overhead}B exceeds logical cap ${maxLogical}B` };
  for (let index = 0; index < count; index++) {
    // Slice the BUFFER: a multi-byte UTF-8 sequence split across the boundary
    // is re-joined byte-identically on decode (never split the string).
    const slice = buf.subarray(index * chunkRaw, Math.min((index + 1) * chunkRaw, buf.length));
    const chunk: TunnelChunk =
      correlation.kind === "tunnel-data"
        ? {
            type: "tunnel-chunk", v: 1, messageId: correlation.subscriptionId, index, count,
            totalBytes: buf.length, data: slice.toString("base64"), kind: "tunnel-data",
            subscriptionId: correlation.subscriptionId, sub: correlation.sub,
          }
        : {
            type: "tunnel-chunk", v: 1, messageId: correlation.reqId, index, count,
            totalBytes: buf.length, data: slice.toString("base64"), kind: correlation.kind,
            reqId: correlation.reqId,
          };
    send(chunk);
  }
  return { ok: true, rawBytes: buf.length, overheadBytes: overhead };
}

// ---------------------------------------------------------------------------
// Receiver side.

export interface AssemblyOutcome {
  ok: boolean;
  done?: true;
  value?: unknown; // parsed JSON of the full logical message
  rawBytes?: number;
  error?: string;
}

interface Assembly {
  key: string;
  correlation: ChunkCorrelation;
  count: number;
  totalBytes: number;
  messageId: string;
  parts: Buffer[];
  receivedBytes: number;
  lastIndex: number;
  createdAt: number;
  ticket: Reservation;
  timer?: NodeJS.Timeout;
}

export interface ReassemblerHooks {
  now?(): number;
  /** Assembly timeout override (test policy). */
  timeoutMs?: number;
  maxConcurrent?: number;
}

/**
 * Per-connection chunk reassembler. Validates envelope math (via
 * validateChunkEnvelope), strict index0-then-+1 ordering, immutable metadata,
 * and full-envelope correlation BEFORE any budget is spent on a foreign
 * correlation: `owns` decides whether the reader/reqId is live.
 */
export class ChunkReassembler {
  private assemblies = new Map<string, Assembly>();
  private readonly now: () => number;

  constructor(
    private readonly budget: ByteBudget,
    private readonly hooks: ReassemblerHooks = {},
  ) {
    this.now = hooks.now ?? Date.now;
  }

  get active(): number {
    return this.assemblies.size;
  }

  /**
   * Feed one validated TunnelChunk. `owns(correlation)` is the ownership gate:
   * returning false rejects the chunk without ANY allocation.
   */
  feed(chunk: TunnelChunk, owns: (correlation: ChunkCorrelation) => boolean): AssemblyOutcome {
    if (chunk.type !== "tunnel-chunk") return { ok: false, error: "chunk: not a chunk frame" };
    const correlation: ChunkCorrelation =
      chunk.kind === "tunnel-data"
        ? { kind: "tunnel-data", subscriptionId: chunk.subscriptionId, sub: chunk.sub }
        : { kind: chunk.kind, reqId: chunk.reqId };
    const key = correlationKey(correlation);
    const envelope = validateChunkEnvelope(chunk);
    if (!envelope.ok) return { ok: false, error: envelope.error };
    // Ownership/correlation FIRST: no live reader/reqId → no allocation.
    if (!owns(correlation)) return { ok: false, error: "chunk: no live reader for this correlation" };

    const existing = this.assemblies.get(key);
    if (existing) {
      // Immutable metadata across the assembly.
      if (existing.count !== chunk.count || existing.totalBytes !== chunk.totalBytes || existing.messageId !== chunk.messageId)
        return this.fail(existing, { ok: false, error: "chunk: metadata changed mid-assembly" });
      if (chunk.index !== existing.lastIndex + 1)
        return this.fail(existing, { ok: false, error: `chunk: expected index ${existing.lastIndex + 1}, got ${chunk.index}` });
    } else {
      if (chunk.index !== 0) return { ok: false, error: `chunk: first chunk must have index 0, got ${chunk.index}` };
      const maxConcurrent = this.hooks.maxConcurrent ?? REASSEMBLY_CONCURRENT_PER_CONNECTION;
      if (this.assemblies.size >= maxConcurrent)
        return { ok: false, error: `chunk: ${this.assemblies.size} assemblies in flight (max ${maxConcurrent})` };
      const ticket = this.budget.reserve(chunk.totalBytes);
      if (!ticket) return { ok: false, error: `chunk: budget ${this.budget.name} cannot admit ${chunk.totalBytes}B` };
      const timeoutMs = this.hooks.timeoutMs ?? REASSEMBLY_TIMEOUT_MS;
      const assembly: Assembly = {
        key,
        correlation,
        count: chunk.count,
        totalBytes: chunk.totalBytes,
        messageId: chunk.messageId,
        parts: [],
        receivedBytes: 0,
        lastIndex: -1,
        createdAt: this.now(),
        ticket,
      };
      const timer = setTimeout(() => {
        const a = this.assemblies.get(key);
        if (a === assembly) this.fail(a, { ok: false, error: "chunk: reassembly timeout" });
      }, timeoutMs);
      if (timer.unref) timer.unref();
      assembly.timer = timer;
      this.assemblies.set(key, assembly);
      return this.append(this.assemblies.get(key)!, chunk, envelope.remainder);
    }
    return this.append(existing, chunk, envelope.remainder);
  }

  /** Abort a correlation's assembly (unsubscribe/swap/reader death): release once. */
  abort(correlation: ChunkCorrelation): boolean {
    const a = this.assemblies.get(correlationKey(correlation));
    if (!a) return false;
    this.fail(a, { ok: false, error: "chunk: aborted" });
    return true;
  }

  /** Drop everything (connection close): release all reservations. */
  abortAll(): void {
    for (const a of [...this.assemblies.values()]) this.fail(a, { ok: false, error: "chunk: connection closed" });
  }

  private append(assembly: Assembly, chunk: TunnelChunk, decodedLength: number): AssemblyOutcome {
    let part: Buffer;
    try {
      part = Buffer.from(chunk.data, "base64");
    } catch {
      return this.fail(assembly, { ok: false, error: "chunk: invalid base64" });
    }
    if (part.length !== decodedLength)
      return this.fail(assembly, { ok: false, error: `chunk: size mismatch at index ${chunk.index}` });
    assembly.parts.push(part);
    assembly.receivedBytes += part.length;
    assembly.lastIndex = chunk.index;
    if (assembly.receivedBytes === assembly.totalBytes && assembly.parts.length === assembly.count) {
      const raw = Buffer.concat(assembly.parts, assembly.totalBytes);
      this.finish(assembly);
      let value: unknown;
      try {
        value = JSON.parse(raw.toString("utf8"));
      } catch (e) {
        return { ok: false, done: true, error: `chunk: assembled JSON invalid: ${(e as Error).message}` };
      }
      return { ok: true, done: true, value, rawBytes: raw.length };
    }
    return { ok: true };
  }

  private finish(assembly: Assembly): void {
    if (assembly.timer) clearTimeout(assembly.timer);
    this.assemblies.delete(assembly.key);
    assembly.ticket.release(); // exactly once
  }

  private fail(assembly: Assembly, outcome: AssemblyOutcome): AssemblyOutcome {
    if (assembly.timer) clearTimeout(assembly.timer);
    this.assemblies.delete(assembly.key);
    assembly.ticket.release(); // failure releases too — no leaked reservation
    return outcome;
  }
}

// ---------------------------------------------------------------------------
// Bounded SSE reader (loopback ingress side of the connector, 04 §3.4).
//
// Raw bytes are admitted against `budget` BEFORE any JSON.parse: an oversized
// or unterminated event is rejected as bytes, never buffered unboundedly.

export interface SseEvent {
  event: string;
  id: string | null;
  data: string;
}

export interface SseReadResult {
  events: SseEvent[];
  error: string | null;
}

export class SseReader {
  private buf: Buffer = Buffer.from(new Uint8Array(0));

  constructor(
    private readonly budget: ByteBudget,
    private readonly maxEventBytes = LOGICAL_MESSAGE_MAX_BYTES,
  ) {}

  /** Feed raw UTF-8 bytes; returns complete events and any admission error. */
  feed(chunk: Buffer | string): SseReadResult {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    const ticket = this.budget.reserve(bytes.length);
    if (!ticket) return { events: [], error: `sse: ingress budget ${this.budget.name} exhausted` };
    let out: SseReadResult;
    try {
      this.buf = this.buf.length === 0 ? bytes : Buffer.concat([this.buf, bytes]);
      if (this.buf.length > this.maxEventBytes) {
        out = { events: [], error: `sse: event exceeds ${this.maxEventBytes}B before framing` };
        this.buf = Buffer.from(new Uint8Array(0));
        return out;
      }
      const events: SseEvent[] = [];
      let start = 0;
      while (true) {
        const idx = this.buf.indexOf("\n\n", start);
        if (idx < 0) break;
        const block = this.buf.toString("utf8", start, idx);
        start = idx + 2;
        const ev = this.parseBlock(block);
        if (ev) events.push(ev);
      }
      if (start > 0) this.buf = this.buf.subarray(start);
      out = { events, error: null };
      return out;
    } finally {
      ticket.release();
    }
  }

  private parseBlock(block: string): SseEvent | null {
    let event = "message";
    let id: string | null = null;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue; // comment / heartbeat
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "id") id = value;
      else if (field === "data") dataLines.push(value);
    }
    if (dataLines.length === 0) return null;
    return { event, id, data: dataLines.join("\n") };
  }
}
