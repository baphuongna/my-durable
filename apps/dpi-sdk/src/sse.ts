import { DpiError } from "./errors.js";
import { LOGICAL_MESSAGE_MAX_BYTES } from "./protocol/limits.js";

export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

/** UTF-8 size of a string without allocating its encoding (this module also runs in browsers). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Parse a Server-Sent Events body from fetch. Servers send a `: ping` comment every 15s, so
 * `idleMs` of silence means a half-open socket and ends the stream with an `offline` error.
 *
 * One event may not exceed `maxEventBytes` (default: the 16 MiB logical message cap, 04 §3.3). The
 * check runs on the bytes read so far, before any framing or JSON parsing, so a peer that never
 * terminates an event cannot make this reader buffer without bound; the source stream is cancelled
 * and a non-retryable `invalid` error ends the reader.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  idleMs = 45_000,
  maxEventBytes = LOGICAL_MESSAGE_MAX_BYTES,
): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const tooLarge = () => new DpiError("invalid", `SSE event exceeds ${maxEventBytes} bytes`);
  // Text read since the last delimiter. Pieces are only joined once a delimiter shows up, so a
  // long event costs one copy instead of one per read.
  let pending: string[] = [];
  let pendingBytes = 0;
  let lastChar = "";
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new DpiError("offline", `No data for ${idleMs / 1000}s`)),
          idleMs,
        );
      });
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([reader.read(), idle]);
      } finally {
        clearTimeout(timer);
      }
      if (chunk.done) return;
      const text = decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
      if (!text) continue;
      // A CRLF split across two reads: the previous read ended with the CR of a pair whose LF
      // starts this one — coalesce that too, or the CR leaks into the last field value.
      if (lastChar === "\r" && text.startsWith("\n")) {
        const last = pending.pop();
        if (last !== undefined) {
          const trimmed = last.slice(0, -1); // drop the dangling CR; the LF below completes the pair
          if (trimmed) pending.push(trimmed);
          pendingBytes -= 1;
          lastChar = pending.length > 0 ? pending[pending.length - 1].slice(-1) : "";
        }
      }
      pendingBytes += utf8Length(text);
      if (!(lastChar + text).includes("\n\n")) {
        if (pendingBytes > maxEventBytes) throw tooLarge();
        pending.push(text);
        lastChar = text.slice(-1);
        continue;
      }
      let buffer = pending.join("") + text;
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, cut);
        const blockBytes = utf8Length(block);
        if (blockBytes > maxEventBytes) throw tooLarge();
        buffer = buffer.slice(cut + 2);
        pendingBytes -= blockBytes + 2;
        const message = parseBlock(block);
        if (message) yield message;
      }
      if (pendingBytes > maxEventBytes) throw tooLarge();
      pending = buffer ? [buffer] : [];
      lastChar = buffer.slice(-1);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

export function parseBlock(block: string): SseMessage | undefined {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  return data.length ? { event, data: data.join("\n"), id } : undefined;
}
