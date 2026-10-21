import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ByteBudget } from "../src/node/chunk.js";
import { createPacedSseWriter } from "../src/node/sse-writer.js";
import {
  BACKEND_SSE_VIEWER_BYTES,
  CONNECTION_BUFFER_BUDGET_BYTES,
  HUB_BUFFER_BUDGET_BYTES,
  IDLE_TIMEOUT_MS,
  LOGICAL_MESSAGE_MAX_BYTES,
  PACE_WRITE_BYTES,
} from "../src/protocol/limits.js";

class ResponseSink extends EventEmitter {
  writableLength = 0;
  destroyed = false;
  writableEnded = false;
  block = false;
  chunks: Buffer[] = [];
  write(bytes: Buffer, _onWritten?: () => void): boolean {
    this.chunks.push(Buffer.from(bytes));
    return !this.block;
  }
  end() {
    this.writableEnded = true;
    this.emit("close");
  }
  destroy() {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

test("a stalled SSE drain cannot hold shared admission beyond the idle deadline", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const budget = new ByteBudget("stalled-sse", 500_000);
  const res = new ResponseSink();
  res.block = true;
  const writer = createPacedSseWriter(res as never, { maxBufferedBytes: BACKEND_SSE_VIEWER_BYTES, budget });
  try {
    writer.write("x".repeat(100_000));
    assert.equal(budget.used, 100_000);
    t.mock.timers.tick(IDLE_TIMEOUT_MS - 1);
    assert.equal(writer.closed, false);
    t.mock.timers.tick(1);
    assert.equal(writer.closed, true, "an idle drain is cut, not left admitted forever");
    assert.equal(res.destroyed, true);
    assert.equal(budget.used, 0);
    assert.equal(res.listenerCount("drain"), 0);
  } finally {
    writer.close();
  }
});

test("active and queued SSE bytes share admission across viewers and release exactly once", async () => {
  const budget = new ByteBudget("shared-sse", 600_000);
  const a = new ResponseSink();
  const b = new ResponseSink();
  a.block = b.block = true;
  let closedB = 0;
  const first = createPacedSseWriter(a as never, { maxBufferedBytes: BACKEND_SSE_VIEWER_BYTES, budget });
  const second = createPacedSseWriter(b as never, { maxBufferedBytes: BACKEND_SSE_VIEWER_BYTES, budget, onClose: () => { closedB++; } });
  try {
    first.write("a".repeat(200_000));
    first.write("b".repeat(200_000));
    second.write("c".repeat(100_000));
    assert.equal(budget.used, 500_000, "both active events and the unwritten event are admitted");
    assert.equal(second.write("d".repeat(200_000)), "closed");
    assert.equal(second.closed, true);
    assert.equal(b.destroyed, true);
    assert.equal(first.closed, false, "overflow isolates the offending viewer");
    assert.equal(budget.used, 400_000, "the rejected and closed viewer retains no ticket");
    second.close();
    assert.equal(closedB, 1);
    first.close();
    await Promise.resolve();
    assert.equal(budget.used, 0);
    assert.equal(budget.liveCount, 0);
    assert.equal(a.listenerCount("drain"), 0);
    assert.equal(b.listenerCount("drain"), 0);
  } finally {
    first.close();
    second.close();
  }
});

test("one SSE viewer cannot exceed its connection budget even when the shared hub has room", () => {
  const budget = new ByteBudget("hub-sse", HUB_BUFFER_BUDGET_BYTES);
  const res = new ResponseSink();
  res.block = true;
  const writer = createPacedSseWriter(res as never, { maxBufferedBytes: BACKEND_SSE_VIEWER_BYTES, budget });
  try {
    const event = `data: ${"x".repeat(LOGICAL_MESSAGE_MAX_BYTES - 8)}\n\n`;
    assert.equal(writer.write(event), "accepted");
    assert.equal(writer.write(event), "accepted");
    assert.equal(budget.used, CONNECTION_BUFFER_BUDGET_BYTES);
    assert.equal(writer.write(": ping\n\n"), "closed");
    assert.equal(res.destroyed, true);
    assert.equal(budget.used, 0);
    assert.ok(res.chunks.every((chunk) => chunk.length <= PACE_WRITE_BYTES));
  } finally {
    writer.close();
  }
});

test("logical-size rejection does not allocate or close a healthy SSE writer; output overflow does", () => {
  const budget = new ByteBudget("logical-sse", 100_000);
  const res = new ResponseSink();
  const writer = createPacedSseWriter(res as never, { maxBufferedBytes: BACKEND_SSE_VIEWER_BYTES, budget });
  try {
    assert.equal(writer.write("x".repeat(LOGICAL_MESSAGE_MAX_BYTES + 1)), "too-large");
    assert.equal(budget.used, 0);
    assert.equal(res.chunks.length, 0);
    assert.equal(writer.closed, false, "the caller can report a reader-level fault");
    assert.equal(writer.write(": ping\n\n"), "accepted");
    res.writableLength = BACKEND_SSE_VIEWER_BYTES + 1;
    assert.equal(writer.write(": ping\n\n"), "closed");
    assert.equal(writer.overCap(), true);
    assert.equal(res.destroyed, true);
    assert.equal(budget.used, 0);
  } finally {
    writer.close();
  }
});

test("SSE tickets remain live until write callbacks flush; end waits for the queued fault", async () => {
  class BufferedSink extends ResponseSink {
    callbacks: Array<() => void> = [];
    override write(bytes: Buffer, onWritten?: () => void): boolean {
      this.chunks.push(Buffer.from(bytes));
      this.writableLength += bytes.length;
      if (onWritten) this.callbacks.push(onWritten);
      return true;
    }
    flush() {
      this.writableLength = 0;
      this.callbacks.shift()?.();
    }
  }
  const budget = new ByteBudget("flushed-sse", 100_000);
  const res = new BufferedSink();
  const writer = createPacedSseWriter(res as never, { maxBufferedBytes: BACKEND_SSE_VIEWER_BYTES, budget });
  const event = 'data: {"type":"tasks","tasks":[]}\n\n';
  const fault = 'data: {"type":"fault","error":{"code":"invalid"}}\n\n';
  try {
    writer.write(event);
    writer.write(fault);
    writer.end();
    assert.equal(writer.write("ignored"), "closed");
    assert.equal(res.writableEnded, false);
    assert.equal(budget.used, Buffer.byteLength(event + fault));
    res.flush();
    await Promise.resolve();
    assert.equal(budget.used, Buffer.byteLength(fault));
    assert.equal(res.writableEnded, false);
    res.flush();
    await Promise.resolve();
    assert.equal(res.writableEnded, true);
    assert.equal(Buffer.concat(res.chunks).toString("utf8"), event + fault);
    assert.equal(budget.used, 0);
    assert.equal(budget.liveCount, 0);
  } finally {
    writer.close();
  }
});
