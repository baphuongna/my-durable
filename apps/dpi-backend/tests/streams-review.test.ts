/**
 * Review 2026-10-20 regressions — SSE writers (Cluster D, backend).
 * F16 UTF-8 byte segmentation (no mid-codepoint splits) · F11 queued bytes
 * count against the cap · F17 fault flushed before end · F19 ping serialized.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { openSse, onWatchEnd, type Sse } from "../src/streams.js";
import type { Frame } from "../../dpi-sdk/src/api.js";
import { PACE_WRITE_BYTES } from "../../dpi-sdk/src/protocol/limits.js";

class FakeRes extends EventEmitter {
  writableLength = 0;
  chunks: Buffer[] = [];
  order: string[] = [];
  ended = false;
  /** When set, write() returns false (buffer full) — the chain waits for drain. */
  block = false;
  status() {
    return this;
  }
  set() {
    return this;
  }
  flushHeaders() {}
  get socket() {
    return { setNoDelay() {} };
  }
  write(buf: Buffer): boolean {
    this.chunks.push(Buffer.from(buf));
    this.order.push("w");
    return !this.block;
  }
  end() {
    if (this.ended) return;
    this.ended = true;
    this.order.push("e");
    this.emit("close");
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const settleN = (n: number) => Array.from({ length: n }, () => settle()).reduce((a, b) => a.then(() => b), Promise.resolve());
const allBytes = (res: FakeRes) => Buffer.concat(res.chunks);

test("F16 regression: a 4-byte codepoint at a segment boundary survives (UTF-8 byte slicing)", async () => {
  const res = new FakeRes();
  const sse = openSse(res as never, { kind: "device" });
  const emoji = "𝄞"; // U+1D11E, 4 UTF-8 bytes
  // Pad the payload so the emoji lands EXACTLY on a 64 KiB boundary.
  let payload = "";
  for (let pad = 0; pad < 65_900; pad++) {
    payload = "a".repeat(pad) + emoji + "b".repeat(1000);
    const event = `id: 2\nevent: tree\ndata: ${JSON.stringify({ type: "tree", tree: payload })}\n\n`;
    const off = Buffer.from(event, "utf8").indexOf(Buffer.from(emoji, "utf8"));
    if (off % PACE_WRITE_BYTES === 0) break;
  }
  const event = `id: 2\nevent: tree\ndata: ${JSON.stringify({ type: "tree", tree: payload })}\n\n`;
  const off = Buffer.from(event, "utf8").indexOf(Buffer.from(emoji, "utf8"));
  assert.equal(off % PACE_WRITE_BYTES, 0, "emoji positioned at a segment boundary");
  sse.send({ type: "tree", tree: payload } as unknown as Frame);
  await settleN(4);
  const out = allBytes(res).toString("utf8");
  assert.ok(out.includes(payload), "the 4-byte codepoint is intact — no U+FFFD, no split");
  assert.equal(out.includes("\uFFFD"), false);
  res.emit("close"); // release the ping interval
});

test("F11 regression: queued-but-unwritten bytes count against the cap — a never-draining viewer is cut", async () => {
  const res = new FakeRes();
  const sse = openSse(res as never, { kind: "device" });
  // A viewer whose writes BLOCK (never drains): each event parks after its
  // first segment, so bytes pile up in the chain. The OLD cap looked only at
  // writableLength (0 here) and never cut; the queued budget must enforce
  // the 2 MB cap.
  res.block = true;
  const blob = "x".repeat(200_000);
  let sent = 0;
  let cutAt = -1;
  for (let i = 0; i < 30; i++) {
    sse.send({ type: "tree", tree: blob } as unknown as Frame);
    sent++;
    await settle();
    if (cutAt < 0 && sse.closed) cutAt = i;
  }
  assert.ok(cutAt >= 0, `viewer must be cut once queued bytes exceed the cap (cut at frame #${cutAt})`);
  assert.ok(cutAt <= 12, `cut early, not after queueing everything (cut=${cutAt}, sent=${sent})`);
  assert.ok(allBytes(res).length <= 2_000_000 + 220_000, "bytes actually on the wire stay under the cap + one frame");
});

test("F17 regression: session_failed fault is WRITTEN before the response ends", async () => {
  const res = new FakeRes();
  const sse = openSse(res as never, { kind: "session", sessionId: "s1" });
  // One event mid-flight (waiting for drain) so the fault must queue behind it.
  res.block = true;
  sse.send({ type: "tasks", tasks: [] } as unknown as Frame);
  await settle();
  onWatchEnd(sse as Sse, { reason: "session_failed" } as never);
  await settle();
  assert.equal(res.ended, false, "end() must not fire while the fault is still queued");
  res.block = false;
  res.emit("drain");
  await settleN(6);
  assert.equal(res.ended, true, "flushed, then ended");
  const out = allBytes(res).toString("utf8");
  assert.ok(out.includes('"type":"fault"'), "the fault reached the wire");
  assert.equal(res.order.lastIndexOf("w") < res.order.lastIndexOf("e"), true, "last write happens before end");
});

test("F19 regression: the heartbeat is serialized — a ping can never land inside a half-written event", async () => {
  {
    const res = new FakeRes();
    const sse = openSse(res as never, { kind: "device" }, { pingMs: 25 });
    // A big event whose FIRST segment blocks on drain: the event is half-written.
    const blob = "y".repeat(300_000);
    res.block = true;
    sse.send({ type: "tree", tree: blob } as unknown as Frame);
    await settle();
    // Heartbeat fires while the event is mid-flight (real short interval).
    await new Promise((r) => setTimeout(r, 80));
    const midFlight = allBytes(res).toString("utf8");
    assert.equal(midFlight.includes(": ping"), false, "no ping while an event is half-written (it is queued, not written)");
    // Drain: the event completes and ONLY THEN the ping goes out.
    res.block = false;
    res.emit("drain");
    await settleN(40);
    const out = allBytes(res).toString("utf8");
    const pingAt = out.indexOf(": ping");
    const dataEnd = out.indexOf(`"tree":"${"y".repeat(300_000)}`) + `"tree":"${"y".repeat(300_000)}`.length;
    assert.ok(pingAt > dataEnd, "ping lands strictly AFTER the complete event");
    // And the JSON is parseable — no interleaving corruption.
    const dataLine = out.slice(out.lastIndexOf("data: ", pingAt), pingAt).replace(/^data: /, "").trim();
    assert.ok(JSON.parse(dataLine), "event JSON intact up to the ping");
    res.emit("close"); // release the short ping interval
  }
});
