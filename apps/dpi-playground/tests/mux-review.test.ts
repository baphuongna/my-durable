/**
 * Review 2026-10-20 regressions — hub mux writer (Cluster D, hub side).
 * F16 UTF-8 byte segmentation · F11 queued bytes count against the viewer cap.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { pacedSseWriter } from "../apps/dpi-playground-hub/src/mux.js";
import { PACE_WRITE_BYTES, SSE_HUB_VIEWER_BYTES } from "../../dpi-sdk/src/protocol/limits.js";

class FakeRes extends EventEmitter {
  writableLength = 0;
  chunks: Buffer[] = [];
  ended = false;
  status() {
    return this;
  }
  set() {
    return this;
  }
  flushHeaders() {}
  block = false;
  write(buf: Buffer): boolean {
    this.chunks.push(Buffer.from(buf));
    return !this.block;
  }
  end() {
    this.ended = true;
    this.emit("close");
  }
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const settleN = (n: number) => Array.from({ length: n }, () => settle()).reduce((a, b) => a.then(() => b), Promise.resolve());

test("hub F16: 4-byte codepoint at a segment boundary survives", async () => {
  const res = new FakeRes();
  const w = pacedSseWriter(res as never);
  const emoji = "𝄞";
  let payload = "";
  for (let pad = 0; pad < 65_900; pad++) {
    payload = "a".repeat(pad) + emoji + "b".repeat(1000);
    const event = `data: ${JSON.stringify({ v: payload })}\n\n`;
    const off = Buffer.from(event, "utf8").indexOf(Buffer.from(emoji, "utf8"));
    if (off % PACE_WRITE_BYTES === 0) break;
  }
  w.write(`data: ${JSON.stringify({ v: payload })}\n\n`);
  await settleN(4);
  const out = Buffer.concat(res.chunks).toString("utf8");
  assert.ok(out.includes(payload), "codepoint intact");
  assert.equal(out.includes("\uFFFD"), false);
});

test("hub F11: queued bytes enforce the viewer cap even when writableLength stays 0", async () => {
  const res = new FakeRes();
  res.block = true; // writes park on drain — the queue must carry the cap
  const w = pacedSseWriter(res as never);
  const blob = "z".repeat(100_000);
  let cutAt = -1;
  for (let i = 0; i < 40; i++) {
    w.write(`data: ${JSON.stringify({ v: blob })}\n\n`);
    await settle();
    if (cutAt < 0 && res.ended) cutAt = i;
    if (res.ended) break;
  }
  assert.ok(cutAt >= 0, `viewer cut once queued bytes pass the cap (frame #${cutAt})`);
  assert.ok(Buffer.concat(res.chunks).length <= SSE_HUB_VIEWER_BYTES + 110_000, "wire bytes stay under the cap + one event");
});
