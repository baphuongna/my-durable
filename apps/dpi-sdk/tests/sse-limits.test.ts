/**
 * Gate A GA-08: SSE ingress is bounded in BYTES before framing or parsing.
 * `readSse` (LAN device streams, browser-safe) and `SseReader` (connector loopback ingress) must
 * refuse an event that outgrows the logical cap instead of buffering it, must count bytes (not
 * UTF-16 units), and must not penalise many small events. `chunkMessage` is the lazy encoder the
 * connector paces against the WebSocket queue.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSse } from "../src/sse.js";
import { DpiError } from "../src/errors.js";
import { ByteBudget, SseReader, chunkMessage, sendChunked } from "../src/node/chunk.js";
import { CHUNK_RAW_BYTES, LOGICAL_MESSAGE_MAX_BYTES } from "../src/protocol/limits.js";

const enc = new TextEncoder();

/** A pull-driven source that counts every byte the consumer actually asked for. */
function endlessSource(head: string, totalBytes: number, pieceBytes = 65_536) {
  const state = { pulled: 0, cancelled: false };
  const headBytes = enc.encode(head);
  const piece = new Uint8Array(pieceBytes).fill(0x78);
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controller.enqueue(headBytes);
        state.pulled += headBytes.byteLength;
      },
      pull(controller) {
        if (state.pulled >= totalBytes) return controller.close();
        controller.enqueue(piece);
        state.pulled += piece.byteLength;
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, state };
}

test("GA-08: an unterminated event past the logical cap is rejected as bytes, the source is cancelled and reading stops near the cap", async () => {
  const { body, state } = endlessSource("data: ", 24 * 1024 * 1024);
  await assert.rejects(
    (async () => {
      for await (const _ of readSse(body)) {
        /* nothing may be delivered */
      }
    })(),
    (e: unknown) => e instanceof DpiError && e.code === "invalid" && /exceeds/.test(e.message),
  );
  assert.equal(state.cancelled, true, "the oversized source is released");
  assert.ok(
    state.pulled <= LOGICAL_MESSAGE_MAX_BYTES + 2 * 65_536,
    `read ${state.pulled} B, expected to stop within two reads of the ${LOGICAL_MESSAGE_MAX_BYTES} B cap`,
  );
});

test("GA-08: the cap counts UTF-8 bytes and is inclusive at the boundary", async () => {
  const run = async (event: string, maxEventBytes: number) => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(event));
        c.close();
      },
    });
    const out: string[] = [];
    for await (const m of readSse(body, 1_000, maxEventBytes)) out.push(m.data);
    return out;
  };
  // "data: " + 10 bytes = a 16-byte event block: allowed at exactly 16, refused at 15.
  assert.deepEqual(await run("data: " + "a".repeat(10) + "\n\n", 16), ["a".repeat(10)]);
  await assert.rejects(run("data: " + "a".repeat(10) + "\n\n", 15), (e: unknown) => e instanceof DpiError && e.code === "invalid");
  // 9 euro signs are 9 UTF-16 units but 27 bytes: 6 + 27 = 33 bytes must trip a 32-byte cap.
  await assert.rejects(run("data: " + "€".repeat(9) + "\n\n", 32), (e: unknown) => e instanceof DpiError && e.code === "invalid");
  assert.deepEqual(await run("data: " + "€".repeat(9) + "\n\n", 33), ["€".repeat(9)]);
});

test("GA-08: the cap applies per event, not per stream: many small events in one read are all delivered", async () => {
  const events = Array.from({ length: 200 }, (_, i) => `data: {"n":${i}}\n\n`).join("");
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(events));
      c.close();
    },
  });
  const seen: string[] = [];
  for await (const m of readSse(body, 1_000, 64)) seen.push(m.data);
  assert.equal(seen.length, 200);
});

test("GA-08: an event split mid-character across reads is reassembled and still counted in bytes", async () => {
  const bytes = enc.encode("data: 🚀🚀🚀\n\n");
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3));
      c.close();
    },
  });
  const seen: string[] = [];
  for await (const m of readSse(body, 1_000, bytes.length - 2)) seen.push(m.data);
  assert.deepEqual(seen, ["🚀🚀🚀"]);
});

test("GA-08: SseReader bounds the UNTERMINATED remainder, so one read carrying several complete events is not an overflow", () => {
  const reader = new SseReader(new ByteBudget("sse", 1024 * 1024), 64);
  const burst = Array.from({ length: 10 }, (_, i) => `data: ${i}\n\n`).join(""); // 10 x 9 B, far over 64 B in total
  const out = reader.feed(burst);
  assert.equal(out.error, null);
  assert.equal(out.events.length, 10);
  // ...while a lone event that outgrows the cap is still refused, even when it arrives in pieces
  const lone = new SseReader(new ByteBudget("sse", 1024 * 1024), 64);
  assert.equal(lone.feed("data: " + "a".repeat(40)).error, null);
  assert.match(lone.feed("a".repeat(40)).error ?? "", /exceeds/);
});

test("GA-08: SseReader charges the retained remainder to the shared budget and gives it back when the event completes or the reader closes", () => {
  const budget = new ByteBudget("ingress", 1_000);
  const a = new SseReader(budget, 10_000);
  const b = new SseReader(budget, 10_000);
  assert.equal(a.feed("data: " + "a".repeat(594)).error, null);
  assert.equal(budget.used, 600, "the unterminated 600 B is accounted, not just the read in flight");
  assert.match(b.feed("data: " + "b".repeat(594)).error ?? "", /budget/, "a second reader cannot exceed the shared budget");
  assert.equal(budget.used, 600, "the refused read reserved nothing");
  const done = a.feed("\n\n");
  assert.equal(done.events.length, 1);
  assert.equal(budget.used, 0, "a completed event releases its bytes");
  assert.equal(a.feed("data: " + "a".repeat(100)).error, null);
  assert.equal(budget.used, 106);
  a.close();
  assert.equal(budget.used, 0, "close() releases the remainder of an abandoned event");
  b.close();
});

test("GA-08: SseReader finds a delimiter split across two reads of a 4 MiB event", () => {
  const reader = new SseReader(new ByteBudget("sse", 64 * 1024 * 1024), LOGICAL_MESSAGE_MAX_BYTES);
  const piece = Buffer.alloc(CHUNK_RAW_BYTES, 0x61);
  assert.equal(reader.feed("data: ").error, null);
  for (let i = 0; i < 64; i++) assert.equal(reader.feed(piece).error, null);
  assert.equal(reader.feed("\n").events.length, 0, "one newline is not a delimiter");
  const out = reader.feed("\n");
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].data.length, 64 * CHUNK_RAW_BYTES);
});

test("GA-08: \\r\\n behaves exactly like \\n: one CRLF-delimited event, same as the LF spelling, no trailing CR in values", () => {
  const budget = new ByteBudget("sse", 1024 * 1024);
  const body = 'event: tick\r\nid: 7\r\ndata: {"a":1}\r\ndata: line2\r\n\r\ndata: next\r\n\r\n';
  const lf = new SseReader(new ByteBudget("sse", 1024 * 1024), 10_000);
  const crlf = new SseReader(budget, 10_000);
  const lfOut = lf.feed(body.replaceAll("\r\n", "\n"));
  const crlfOut = crlf.feed(body);
  assert.equal(crlfOut.error, null);
  assert.equal(crlfOut.events.length, 2, "\\r\\n\\r\\n ends ONE event (not per-line, not none)");
  assert.deepEqual(crlfOut.events, lfOut.events, "CRLF events are byte-for-byte the LF spelling's events");
  assert.deepEqual(crlfOut.events, [
    { event: "tick", id: "7", data: '{"a":1}\nline2' },
    { event: "message", id: null, data: "next" },
  ]);
});

test("GA-08: a CRLF split across two feeds still coalesces — no CR leaks into field values", () => {
  const reader = new SseReader(new ByteBudget("sse", 1024 * 1024), 10_000);
  assert.equal(reader.feed('event: tick\r').error, null);
  assert.equal(reader.feed('\ndata: {"a":1}\r\n').events.length, 0, "still unterminated");
  const out = reader.feed("\r\n");
  assert.equal(out.error, null);
  assert.equal(out.events.length, 1, "the split \\r | \\n pair ends the event");
  assert.deepEqual(out.events[0], { event: "tick", id: null, data: '{"a":1}' }, "no trailing CR in event or data");
});

test("GA-08: a lone CR is DATA, not a line ending — only \\r\\n coalesces", () => {
  const reader = new SseReader(new ByteBudget("sse", 1024 * 1024), 10_000);
  const out = reader.feed("data: a\rb\n\n");
  assert.equal(out.error, null);
  assert.deepEqual(out.events, [{ event: "message", id: null, data: "a\rb" }]);
});

test("GA-08: CRLF events obey the same byte budget — charged while pending, released on completion", () => {
  const budget = new ByteBudget("ingress", 1_000);
  const reader = new SseReader(budget, 10_000);
  assert.equal(reader.feed("data: " + "a".repeat(593) + "\r\n").error, null);
  assert.equal(budget.used, 600, "the pending CRLF event is charged as its 600 retained (coalesced) bytes");
  const done = reader.feed("\r\n");
  assert.equal(done.events.length, 1);
  assert.equal(done.events[0].data.length, 593);
  assert.equal(budget.used, 0, "a completed CRLF event releases its bytes");
});

test("GA-08: chunkMessage defers per-frame encoding to next() — serialize once, slice+encode one frame per pull, identical frames to sendChunked", () => {
  const correlation = { kind: "rest-response" as const, reqId: "11111111-2222-3333-4444-555555555555" };
  const message = { body: "q".repeat(300_000) };
  const eager: unknown[] = [];
  assert.ok(sendChunked(message, correlation, (c) => eager.push(c)).ok);
  assert.ok(eager.length > 2, "the fixture spans several frames");
  const plan = chunkMessage(message, correlation);
  assert.ok(plan.ok, "plan");
  if (!plan.ok) return;

  // Probe (spy installed AFTER the plan exists, so only the iterator's work is counted):
  // the generator slices `buf` — and base64-encodes that slice — exactly once per next().
  // An implementation that pre-materializes its frames (at call time or at the first
  // next()) encodes them all at once and fails these counters; the eager comparison
  // below still pins the CONTENT. Note what is deliberately NOT claimed: serialization
  // itself is eager by design ("serialize ONCE", see chunk.ts) — the plan needs
  // buf.length for the chunk-count/cap math before any frame exists.
  const desc = Object.getOwnPropertyDescriptor(Buffer.prototype, "subarray");
  let sliced = 0;
  const real = desc?.value as (...args: unknown[]) => Buffer;
  const spy = function (this: Buffer, ...args: unknown[]) {
    sliced += 1;
    return real.apply(this, args);
  };
  Object.defineProperty(Buffer.prototype, "subarray", { value: spy, writable: true, configurable: true });
  try {
    const iterator = plan.chunks[Symbol.iterator]();
    assert.equal(sliced, 0, "chunkMessage() itself encodes no frame");
    const first = iterator.next();
    assert.equal(first.done, false);
    assert.deepEqual(first.value, eager[0], "the first frame is available before the rest are encoded");
    assert.equal(sliced, 1, "pulling one frame encodes exactly one frame");
    const rest: unknown[] = [first.value];
    while (rest.length < eager.length) {
      rest.push(iterator.next().value);
      assert.equal(sliced, rest.length, `after pull #${rest.length}, exactly ${rest.length} frames have been encoded`);
    }
    assert.deepEqual(rest, eager, "the lazily pulled frames equal sendChunked's eager frames");
    assert.equal(iterator.next().done, true);
    assert.equal(sliced, eager.length, "the exhausted iterator encodes no extra frame");
  } finally {
    if (desc) Object.defineProperty(Buffer.prototype, "subarray", desc);
    else delete (Buffer.prototype as { subarray?: unknown }).subarray;
  }
  const tooBig = chunkMessage({ body: "z".repeat(LOGICAL_MESSAGE_MAX_BYTES) }, correlation);
  assert.equal(tooBig.ok, false);
});
