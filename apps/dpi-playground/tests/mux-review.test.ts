/**
 * Review 2026-10-20 regressions — hub mux writer (Cluster D, hub side).
 * F16 UTF-8 byte segmentation · F11 queued bytes count against the viewer cap.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { pacedSseWriter, parseSubKey, StreamMux } from "../apps/dpi-playground-hub/src/mux.js";
import { DeviceMonitor } from "../apps/dpi-playground-hub/src/monitor.js";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { until } from "../../dpi-backend/tests/helpers.js";
import type { MuxFrame } from "../../dpi-sdk/src/api.js";
import {
  LOGICAL_MESSAGE_MAX_BYTES,
  PACE_WRITE_BYTES,
  SSE_HUB_VIEWER_BYTES,
} from "../../dpi-sdk/src/protocol/limits.js";
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
const settleN = (n: number) =>
  Array.from({ length: n }, () => settle()).reduce((a, b) => a.then(() => b), Promise.resolve());

test("R01: the mux rejects hub control frames from a real LAN device stream", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-mux-origin-"));
  const uid = randomUUID();
  const upstream = createServer((req, res) => {
    if (req.url === "/v1/device") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ apiVersion: 1, uid, name: "fixture" }));
    } else {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "network", devices: [] })}\n\n`);
    }
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  const registry = new NetworkRegistry(join(dir, "network.sqlite"));
  registry.upsert({ id: "lan-box", url: `http://127.0.0.1:${port}`, token: "x".repeat(43) });
  const monitor = new DeviceMonitor(registry);
  const res = new FakeRes();
  const frames = () =>
    Buffer.concat(res.chunks)
      .toString("utf8")
      .split("\n\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as MuxFrame);
  try {
    monitor.start();
    await monitor.settled("lan-box");
    assert.equal(monitor.state("lan-box")?.status, "online");
    const mux = new StreamMux(registry, monitor);
    mux.open({} as never, res as never);
    await until(async () => frames().some((f) => f.frame.type === "stream"), 5000, "mux hello");
    const hello = frames().find((f) => f.frame.type === "stream")!;
    assert.equal(hello.frame.type, "stream");
    if (hello.frame.type !== "stream") throw Error("Missing stream ID");
    mux.subscribe(hello.frame.streamId, ["lan-box/agent/session/main"]);
    await until(
      async () => frames().some((f) => f.sub === "lan-box/agent/session/main"),
      5000,
      "device outcome",
    );
    assert.equal(frames().find((f) => f.sub === "lan-box/agent/session/main")?.frame.type, "fault");
    assert.equal(
      frames().filter((f) => f.frame.type === "network").length,
      1,
      "only the hub's original network frame is sent",
    );
  } finally {
    res.emit("close");
    monitor.stop();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "GA-08: a LAN device event that outgrows the logical cap faults that subscription only, with no reconnect loop",
  { timeout: 30_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "dpi-mux-oversize-"));
    const uid = randomUUID();
    const writtenPerStream: number[] = [];
    const upstream = createServer((req, res) => {
      if (req.url === "/v1/device") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ apiVersion: 1, uid, name: "fixture" }));
        return;
      }
      const stream = writtenPerStream.push(0) - 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: ");
      const piece = Buffer.alloc(65_536, 0x61);
      const pump = () => {
        while (!res.destroyed && writtenPerStream[stream] < 3 * LOGICAL_MESSAGE_MAX_BYTES) {
          writtenPerStream[stream] += piece.length;
          if (!res.write(piece)) return void res.once("drain", pump);
        }
      };
      pump();
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const port = (upstream.address() as { port: number }).port;
    const registry = new NetworkRegistry(join(dir, "network.sqlite"));
    registry.upsert({ id: "lan-box", url: `http://127.0.0.1:${port}`, token: "x".repeat(43) });
    const monitor = new DeviceMonitor(registry);
    const res = new FakeRes();
    const frames = () =>
      Buffer.concat(res.chunks)
        .toString("utf8")
        .split("\n\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)) as MuxFrame);
    try {
      monitor.start();
      await monitor.settled("lan-box");
      const mux = new StreamMux(registry, monitor);
      mux.open({} as never, res as never);
      await until(async () => frames().some((f) => f.frame.type === "stream"), 5000, "mux hello");
      const hello = frames().find((f) => f.frame.type === "stream")!;
      if (hello.frame.type !== "stream") throw Error("Missing stream ID");
      mux.subscribe(hello.frame.streamId, ["lan-box/device"]);
      await until(
        async () => frames().some((f) => f.sub === "lan-box/device"),
        10_000,
        "device outcome",
      );
      const outcome = frames().find((f) => f.sub === "lan-box/device")!;
      assert.equal(outcome.frame.type, "fault");
      assert.equal(outcome.frame.type === "fault" && outcome.frame.error.code, "invalid");
      const mostWritten = Math.max(...writtenPerStream);
      assert.ok(
        mostWritten < LOGICAL_MESSAGE_MAX_BYTES + 8 * 1024 * 1024,
        `a device stream wrote ${mostWritten} B before the hub stopped reading`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1_500)); // longer than the mux's first retry delay
      assert.deepEqual(
        frames()
          .filter((f) => f.sub === "lan-box/device")
          .map((f) => f.frame.type),
        ["fault"],
        "no disconnected frame and no retry after the fault",
      );
    } finally {
      res.emit("close");
      monitor.stop();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      registry.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "hub F11 follow-up: fast HTTP clients receive large MuxFrames without reconnect",
  { timeout: 20_000 },
  async () => {
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
        const response = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(5000),
        });
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
          assert.equal(
            received,
            expected,
            "the full event must reach the reader, not trigger the 4 MB socket cap",
          );
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
  },
);

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
  assert.ok(
    Buffer.concat(res.chunks).length <= SSE_HUB_VIEWER_BYTES + 110_000,
    "wire bytes stay under the cap + one event",
  );
});

test("RR: every malformed subscription key is the caller's 400, including one that cannot be percent-decoded", () => {
  for (const key of [
    "",
    "nonsense",
    "box/other",
    "box/session",
    "BOX/device",
    "box/device?docs=<script>",
    "box/session/%E0%A4%A",
    "box/agent/ok/%zz",
    "box/agent/%E0%A4%A/main",
  ])
    assert.throws(
      () => parseSubKey(key),
      (e: unknown) =>
        (e as { status?: number }).status === 400 && !/URI malformed/i.test((e as Error).message),
      JSON.stringify(key),
    );
});

test("RR: well-formed keys still parse, and an encoded name is carried over re-encoded", () => {
  assert.deepEqual(parseSubKey("lan-box/device"), {
    key: "lan-box/device",
    deviceId: "lan-box",
    path: "/v1/events",
  });
  assert.equal(
    parseSubKey("lan-box/session/My%20Session").path,
    "/v1/sessions/My%20Session/events",
  );
  assert.equal(
    parseSubKey("lan-box/agent/s1/main?docs=a.b").path,
    "/v1/sessions/s1/agents/main/events?docs=a.b",
  );
});
