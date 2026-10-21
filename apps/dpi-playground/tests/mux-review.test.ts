/**
 * Review 2026-10-20 regressions — hub mux writer (Cluster D, hub side).
 * F16 UTF-8 byte segmentation · F11 queued bytes count against the viewer cap.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import express from "express";
import { pacedSseWriter } from "../apps/dpi-playground-hub/src/mux.js";
import { LOGICAL_MESSAGE_MAX_BYTES, PACE_WRITE_BYTES, SSE_HUB_VIEWER_BYTES } from "../../dpi-sdk/src/protocol/limits.js";
import { ByteBudget } from "../../dpi-sdk/src/node/chunk.js";

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

test("hub F11 follow-up: fast HTTP clients receive large MuxFrames without reconnect", { timeout: 20_000 }, async () => {
  let event = "";
  const app = express();
  app.get("/", (_req, res) => {
    res.set("content-type", "text/event-stream");
    res.flushHeaders();
    const writer = pacedSseWriter(res);
    res.on("close", writer.close);
    writer.write(event);
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    for (const bytes of [5_000_000, LOGICAL_MESSAGE_MAX_BYTES - 512]) {
      const payload = "x".repeat(bytes - 7) + "𝄞漢";
      event = `data: ${JSON.stringify({ sub: "d1/device", frame: { type: "doc", kind: "large-test", value: payload } })}\n\n`;
      const expected = Buffer.byteLength(event, "utf8");
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) });
      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      try {
        while (received < expected) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.byteLength;
        }
        assert.equal(received, expected, "the full event must reach the reader, not trigger the 4 MB socket cap");
        const frame = JSON.parse(Buffer.concat(chunks).toString("utf8").slice(6));
        assert.ok(frame.frame.value === payload, "the complete UTF-8 MuxFrame is intact");
      } finally {
        await reader.cancel();
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

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
  const budget = new ByteBudget("queued-mux-test", SSE_HUB_VIEWER_BYTES);
  const w = pacedSseWriter(res as never, { budget });
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
