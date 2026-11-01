/**
 * Run-9 U5/U8 (unit A): device-authored `tree` frames BYPASS the monitor's
 * TREE_MAX_BYTES seam — mux.follow() opens its OWN /v1/events subscription,
 * so the monitor-side cap never sees the frames the relay forwards. The relay
 * seam must drop tree frames the monitor seam would degrade (256 KiB / 2000
 * sessions, monitor.ts TREE_MAX_BYTES/TREE_MAX_SESSIONS), count the drops,
 * and keep monitor-bounded trees flowing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamMux } from "../apps/dpi-playground-hub/src/mux.js";
import { DeviceMonitor } from "../apps/dpi-playground-hub/src/monitor.js";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { until } from "../../dpi-backend/tests/helpers.js";
import type { MuxFrame } from "../../dpi-sdk/src/api.js";

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
  write(buf: Buffer): boolean {
    this.chunks.push(Buffer.from(buf));
    return true;
  }
  end() {
    this.ended = true;
    this.emit("close");
  }
}

test(
  "run-9 U5/U8: oversized device tree frames are dropped+counted at the relay seam; bounded trees pass",
  { timeout: 30_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "dpi-mux-treecap-"));
    const uid = randomUUID();
    // monitor.ts seam bounds (run-7 B4): a tree payload over 256 KiB (or over
    // 2000 sessions) is degraded at the monitor seam — the relay must mirror.
    const TREE_MAX_BYTES = 256 * 1024;
    const pad = "x".repeat(TREE_MAX_BYTES + 32 * 1024); // byte-oversized, 1 session
    const smallTree = (id: string) => ({
      uid,
      name: "fixture",
      sessions: [{ id, title: "bounded" }],
      at: Date.now(),
    });
    // Every /v1/events connection (the monitor's AND each mux follow()) sees
    // ONLY the bounded `alpha` tree on connect; the oversized and trailing
    // trees are pushed to every live connection on demand, so each step below
    // is causal: the mux subscribes while the monitor still reports `online`
    // (follow() gates on whenOnline), and the monitor's degraded (faulted)
    // state is deterministic when sampled.
    const live = new Set<{ write(chunk: string): unknown }>();
    const push = (frame: string) => {
      for (const r of live) r.write(`data: ${frame}\n\n`);
    };
    const upstream = createServer((req, res) => {
      if (req.url === "/v1/device") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ apiVersion: 1, uid, name: "fixture" }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      live.add(res);
      res.on("close", () => live.delete(res));
      res.write(`data: ${JSON.stringify({ type: "tree", tree: smallTree("alpha") })}\n\n`);
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
      if (hello.frame.type !== "stream") throw Error("Missing stream ID");
      mux.subscribe(hello.frame.streamId, ["lan-box/device"]);

      // Bounded tree frames pass the relay seam.
      await until(
        async () =>
          frames().some(
            (f) =>
              f.sub === "lan-box/device" &&
              f.frame.type === "tree" &&
              f.frame.tree.sessions.some((s) => s.id === "alpha"),
          ),
        10_000,
        "bounded tree relayed",
      );
      assert.equal(monitor.state("lan-box")?.status, "online");

      push(
        JSON.stringify({
          type: "tree",
          tree: { ...smallTree("big"), sessions: [{ id: "big", title: pad }] },
        }),
      );

      // R9 contract revision: the relay is a PIPE — a byte-heavy single-session
      // tree relays intact (the tunnel chunk path delivers exactly these; see
      // tunnel-pacing). The relay's mirrored drop is the SESSION-COUNT policy.
      await until(
        async () =>
          frames().some(
            (f) =>
              f.sub === "lan-box/device" &&
              f.frame.type === "tree" &&
              f.frame.tree.sessions.some((s) => s.id === "big"),
          ),
        10_000,
        "byte-heavy single-session tree relayed intact",
      );
      // The divergence is deliberate and documented: the monitor seam (state
      // owner) degrades the SAME oversized tree for its own view, while the
      // pipe delivered it to the subscribed tab.
      await until(async () => monitor.state("lan-box")?.status === "faulted", 10_000, "monitor seam degraded the oversized tree");

      // 2001 sessions (tiny titles) is the mirrored drop: counted, faulted,
      // subscription survives.
      push(
        JSON.stringify({
          type: "tree",
          tree: {
            ...smallTree("many"),
            sessions: Array.from({ length: 2001 }, (_, i) => ({ id: `m${i}`, title: "x" })),
          },
        }),
      );
      await until(
        async () =>
          frames().some(
            (f) =>
              f.sub === "lan-box/device" &&
              f.frame.type === "fault" &&
              f.frame.error.code === "invalid",
          ),
        10_000,
        "2001-session tree faulted at the relay",
      );
      const relayedTreeIds = frames()
        .filter((f) => f.sub === "lan-box/device" && f.frame.type === "tree")
        .flatMap((f) => (f.frame.type === "tree" ? f.frame.tree.sessions.map((s) => s.id) : []));
      assert.ok(!relayedTreeIds.some((id) => id.startsWith("m")), "the 2001-session tree must NOT be relayed");
      const relayDrops = () =>
        typeof (mux as { relayStats?: () => { droppedTreeFrames: number } }).relayStats === "function"
          ? mux.relayStats().droppedTreeFrames
          : 0;
      assert.equal(relayDrops(), 1, "exactly one session-count drop counted at the relay seam");

      // The subscription survives the drop (skip, not cut): the tree AFTER the
      // oversized one still flows.
      push(JSON.stringify({ type: "tree", tree: smallTree("omega") }));
      await until(
        async () =>
          frames().some(
            (f) =>
              f.sub === "lan-box/device" &&
              f.frame.type === "tree" &&
              f.frame.tree.sessions.some((s) => s.id === "omega"),
          ),
        10_000,
        "subscription alive after the tree drop",
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
  "run-9 contract: the relay is a pipe — a 1.5MB chunked-style tree RELAYS; 2001 sessions drops; >4MiB wrapper faults",
  { timeout: 30_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "dpi-mux-treecap2-"));
    const uid = randomUUID();
    const smallTree = (id: string) => ({ uid, name: "fixture", sessions: [{ id, title: "ok" }], at: Date.now() });
    const live = new Set<{ write(chunk: string): unknown }>();
    const push = (frame: string) => {
      for (const r of live) r.write(`data: ${frame}\n\n`);
    };
    const upstream = createServer((req, res) => {
      if (req.url === "/v1/device") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ apiVersion: 1, uid, name: "fixture" }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      live.add(res);
      res.on("close", () => live.delete(res));
      res.write(`data: ${JSON.stringify({ type: "tree", tree: smallTree("alpha") })}\n\n`);
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
    const relayedTreeWith = (needle: string) =>
      frames().some(
        (f) => f.sub === "lan-box/device" && f.frame.type === "tree" && JSON.stringify(f.frame.tree).includes(needle),
      );
    const faulted = () => frames().some((f) => f.frame.type === "fault");
    try {
      monitor.start();
      await monitor.settled("lan-box");
      const mux = new StreamMux(registry, monitor);
      mux.open({} as never, res as never);
      await until(async () => frames().some((f) => f.frame.type === "stream"), 5000, "mux hello");
      const hello = frames().find((f) => f.frame.type === "stream")!;
      mux.subscribe(hello.frame.type === "stream" ? hello.frame.streamId : "", ["lan-box/device"]);
      await until(
        async () =>
          frames().some((f) => f.sub === "lan-box/device" && f.frame.type === "tree" && f.frame.tree.sessions.some((s) => s.id === "alpha")),
        10_000,
        "bounded tree relayed",
      );

      // The tunnel-pacing contract: a legitimately LARGE single-session tree
      // (chunked delivery exists for exactly this) must RELAY, not drop.
      push(
        JSON.stringify({
          type: "tree",
          tree: { ...smallTree("big"), sessions: [{ id: "big", title: "y".repeat(1_500_000) }] },
        }),
      );
      await until(async () => relayedTreeWith("big"), 10_000, "1.5MB tree relayed intact");
      assert.ok(!faulted(), "a large legit tree must NOT fault the subscription");

      // Session-count policy stays mirrored with the monitor seam.
      push(
        JSON.stringify({
          type: "tree",
          tree: {
            ...smallTree("many"),
            sessions: Array.from({ length: 2001 }, (_, i) => ({ id: `s${i}`, title: "x" })),
          },
        }),
      );
      await until(async () => faulted(), 10_000, "2001-session tree faulted");
      assert.ok(!relayedTreeWith("many"), "2001-session tree must NOT relay");

      // The pipe's own byte ceiling (RELAY_TREE_CAP_BYTES = 4MiB wrapper) faults.
      push(
        JSON.stringify({
          type: "tree",
          tree: { ...smallTree("huge"), sessions: [{ id: "huge", title: "z".repeat(5 * 1024 * 1024) }] },
        }),
      );
      await until(
        async () => frames().some((f) => f.frame.type === "fault" && JSON.stringify(f).includes("relay cap")),
        10_000,
        "5MB tree hits the wrapper cap",
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
