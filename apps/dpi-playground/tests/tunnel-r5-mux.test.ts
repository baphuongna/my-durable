/**
 * Round-5 tunnel/mux fixes — hub side, against a REAL stack: real TunnelServer +
 * TunnelDispatcher + DeviceMonitor + StreamMux, and a REAL backend DeviceConnector
 * (dpi-backend/src/tunnel.ts) as the device, so a device refusal is the genuine one.
 *
 * 1b. parseSubKey mirrors the device's 256-char query budget: a docs list that the
 *     device would refuse is now a 400 to the PUT caller at parse time (it used to
 *     open a subscription the device silently dropped).
 * 1.  End-to-end: a subscription the DEVICE refuses (over-length session id) comes
 *     back through the tunnel as a fault frame and reaches the browser SSE stream
 *     keyed by its subscription key.
 * 3.  subscribe() is all-or-nothing on registry misses: a PUT naming an unknown
 *     device among known keys answers 404 BEFORE any upstream opens and before any
 *     reader slot is acquired.
 * 2.  The hub's tunnelled-REST refusal is pinned on this side too: 400 invalid with
 *     the validator's message — exactly what the device now answers (backend test:
 *     dpi-backend/tests/tunnel-r5-fixes.test.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Request, type Response } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { parseSubKey, StreamMux } from "../apps/dpi-playground-hub/src/mux.js";
import { DeviceMonitor } from "../apps/dpi-playground-hub/src/monitor.js";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { DpiError } from "../../dpi-sdk/src/errors.js";
import { Audit } from "../apps/dpi-playground-hub/src/audit.js";
import { TunnelServer } from "../apps/dpi-playground-hub/src/tunnel.js";
import {
  TunnelDispatcher,
  TunnelTransport,
} from "../apps/dpi-playground-hub/src/tunnel-transport.js";
import { DeviceConnector } from "../../dpi-backend/src/tunnel.js";
import { pairedHome, HUB_ID, TOKEN, UID } from "../../dpi-backend/tests/connector-rig.js";
import { until } from "../../dpi-backend/tests/helpers.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const DEVICE_ID = "dev-1";
/** The exact tuple connector-rig's pairedHome() writes into the pairing files. */
const EPOCH = "3c3c3c3c-1111-2222-3333-444444444444";
const CREDENTIAL_ID = "5d5d5d5d-6666-7777-8888-999999999999";
const FINGERPRINT = `sha256:${"c".repeat(64)}`;

interface Fixture {
  base: string;
  mux: StreamMux;
  dispatcher: TunnelDispatcher;
  connector: DeviceConnector;
  /** Every URL the loopback device API saw. */
  deviceHits(): string[];
  /** Stream fetches only (the monitor's /v1/device probes excluded). */
  streamFetches(): string[];
  /** The mux's per-device reader-slot counters (private, but this is a test). */
  readersByDevice(): [string, number][];
  cleanup(): Promise<void>;
}

async function setup(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "dpi-r5mux-"));
  const registry = new NetworkRegistry(join(dir, "net.sqlite"));
  registry.clearTunnelState();
  const audit = new Audit(registry);
  const tunnel = new TunnelServer(registry, audit, HUB_ID);
  const dispatcher = new TunnelDispatcher(tunnel, { audit });
  const t0 = Date.now();
  registry.db
    .prepare(
      `INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,created_at,updated_at,transport)
       VALUES(?, 'R5 Dev', 'url', NULL, NULL, 'ui', 0, ?, 'checking', ?, ?, 'tunnel')`,
    )
    .run(DEVICE_ID, UID, t0, t0);
  registry.db
    .prepare(
      `INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at)
       VALUES(?,?,?,?,'paired',1,?,?,?)`,
    )
    .run(DEVICE_ID, EPOCH, "pub", FINGERPRINT, t0, t0, t0);
  registry.db
    .prepare(
      `INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at,confirmed_at)
       VALUES(?,?,?,?,?,'current',?,?)`,
    )
    .run(CREDENTIAL_ID, DEVICE_ID, EPOCH, 1, sha(TOKEN), t0, t0);

  const tunnelServer = createServer();
  tunnelServer.on("upgrade", (req, socket, head) => tunnel.handleUpgrade(req, socket, head));
  await new Promise<void>((d) => tunnelServer.listen(0, "127.0.0.1", d));
  const hubUrl = `ws://127.0.0.1:${(tunnelServer.address() as { port: number }).port}/api/tunnel`;

  // The device's loopback API: device info for probes, a live SSE stream for /v1/events*.
  const deviceHits: string[] = [];
  const deviceApi = createServer((req: Request, res: Response) => {
    deviceHits.push(req.url ?? "");
    if (req.url === "/v1/device") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ apiVersion: 1, uid: UID, name: "R5 Dev" }));
      return;
    }
    if (req.url?.startsWith("/v1/events")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "tree", tree: { v: 1 } })}\n\n`);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((d) => deviceApi.listen(0, "127.0.0.1", d));
  const apiBaseUrl = `http://127.0.0.1:${(deviceApi.address() as { port: number }).port}`;

  const home = await pairedHome(hubUrl);
  const connector = new DeviceConnector(
    home,
    undefined,
    {
      intervals: { pingMs: 60_000, idleMs: 60_000, helloMs: 2_000 } as never,
      sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, Math.min(ms, 40))),
    },
    { baseUrl: apiBaseUrl, token: "local-token" },
  );
  connector.start();
  await until(() => connector.status().state === "connected", 15_000, "connector connected");

  const monitor = new DeviceMonitor(registry);
  const mux = new StreamMux(registry, monitor);
  const source = {
    dispatcherFor: (row: { id: string; transport: string }) => new TunnelTransport(row, dispatcher),
    hasLiveConnection: (id: string) => tunnel.hasConnection(id),
  };
  monitor.setTunnelSource(source);
  mux.setTunnelSource(source);
  monitor.start();

  const app = express();
  app.use(express.json());
  app.get("/api/stream", (req: Request, res: Response) => mux.open(req, res));
  app.put("/api/stream/:streamId", (req: Request, res: Response) => {
    try {
      res.json(mux.subscribe(String(req.params.streamId), req.body?.subs));
    } catch (e) {
      res
        .status((e as { status?: number }).status ?? 400)
        .json({ error: { code: "invalid", message: (e as Error).message } });
    }
  });
  const apiServer = createServer(app);
  await new Promise<void>((d) => apiServer.listen(0, "127.0.0.1", d));
  const base = `http://127.0.0.1:${(apiServer.address() as { port: number }).port}`;

  await until(() => monitor.state(DEVICE_ID)?.status === "online", 15_000, "monitor online");

  const close = (s: import("node:http").Server) =>
    new Promise<void>((d) => {
      s.closeAllConnections();
      s.close(() => d());
    });

  return {
    base,
    mux,
    dispatcher,
    connector,
    deviceHits: () => [...deviceHits],
    streamFetches: () => deviceHits.filter((h) => h.startsWith("/v1/events")),
    readersByDevice: () =>
      [...(mux as unknown as { readersByDevice: Map<string, number> }).readersByDevice],
    cleanup: async () => {
      connector.stop("test done");
      dispatcher.close();
      tunnel.close();
      monitor.stop();
      await close(apiServer);
      await close(deviceApi);
      await close(tunnelServer);
      registry.close();
      await rm(dir, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    },
  };
}

/** Open a browser SSE tab; returns streamId + an async iterator of subscription frames. */
async function openTab(base: string): Promise<{
  streamId: string;
  frames: () => AsyncGenerator<{
    sub: string;
    frame: { type: string; error?: { code: string; message: string }; tree?: { v: number } };
  }>;
}> {
  const res = await fetch(`${base}/api/stream`);
  assert.equal(res.status, 200);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let doneStreaming = false;
  const queue: { sub: string; frame: Record<string, unknown> }[] = [];
  const waiters: (() => void)[] = [];
  let resolveStreamId!: (s: string) => void;
  const streamIdPromise = new Promise<string>((r) => (resolveStreamId = r));
  const wake = () => waiters.splice(0).forEach((fn) => fn());
  const pump = async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const f = JSON.parse(line.slice(5).trimStart()) as {
              sub: string;
              frame: Record<string, unknown>;
            };
            queue.push(f);
            wake();
            const hello = f.frame as { streamId?: string };
            if (f.sub === "hello" && hello.streamId) resolveStreamId(hello.streamId);
          }
        }
      }
    } catch {
      // tab closed / server shut down while the iterator was parked
    } finally {
      doneStreaming = true;
      wake();
    }
  };
  void pump();
  async function* frames() {
    for (;;) {
      while (queue.length) {
        const f = queue.shift()!;
        if (f.sub === "hello" || f.sub === "network") continue;
        yield f as {
          sub: string;
          frame: { type: string; error?: { code: string; message: string }; tree?: { v: number } };
        };
      }
      if (doneStreaming) return;
      await new Promise<void>((r) => waiters.push(r));
    }
  }
  return { streamId: await streamIdPromise, frames };
}

const subscribePut = (base: string, streamId: string, subs: string[]) =>
  fetch(`${base}/api/stream/${streamId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subs }),
  });

const withTimeout = <T,>(p: Promise<T>, ms = 8000) =>
  Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);

// -- 1b: the docs cap is mirrored at parse time -------------------------------

test("R5: an over-cap docs query is a 400 at parse time; the 251-char boundary still parses", () => {
  const ok = "a".repeat(251);
  assert.equal(
    parseSubKey(`box/device?docs=${ok}`).path,
    `/v1/events?docs=${ok}`,
    "the longest query the device accepts parses here too",
  );
  assert.equal(
    parseSubKey(`box/agent/s1/main?docs=${ok}`).path,
    `/v1/sessions/s1/agents/main/events?docs=${ok}`,
  );
  for (const key of [
    `box/device?docs=${"a".repeat(252)}`,
    `box/agent/s1/main?docs=${"a".repeat(252)}`,
    `box/session/s1?docs=${"a".repeat(252)}`,
  ]) {
    assert.throws(
      () => parseSubKey(key),
      (e: unknown) => (e as { status?: number }).status === 400,
      key,
    );
  }
});

test("R5: a PUT with an over-cap docs key answers 400 and opens nothing on the device", async () => {
  const f = await setup();
  try {
    const tab = await openTab(f.base);
    const before = f.deviceHits().length;
    const res = await subscribePut(f.base, tab.streamId, [`dev-1/device?docs=${"a".repeat(252)}`]);
    assert.equal(res.status, 400, "the PUT caller gets the immediate refusal");
    const body = (await res.json()) as { error: { message: string } };
    assert.match(body.error.message, /Invalid subscription key/);
    assert.equal(f.deviceHits().length, before, "the device API saw nothing");
    assert.deepEqual(f.readersByDevice(), [], "no reader slot was taken");

    // The boundary key (largest the device accepts) still opens and streams.
    const boundary = `dev-1/device?docs=${"a".repeat(251)}`;
    const okRes = await subscribePut(f.base, tab.streamId, [boundary]);
    assert.equal(okRes.status, 200);
    const iter = tab.frames();
    const frame = await withTimeout(iter.next());
    assert.notEqual(frame, "timeout", "frames flow for the in-budget subscription");
    assert.ok(
      f.streamFetches().includes(`/v1/events?docs=${"a".repeat(251)}`),
      "the device fetched the exact requested scope",
    );
  } finally {
    await f.cleanup();
  }
});

// -- 3: a registry miss cannot strand earlier keys ----------------------------

test("R5: a mixed PUT with an unknown device 404s atomically: no upstream, no reader slot", async () => {
  const f = await setup();
  try {
    const tab = await openTab(f.base);
    const streamsBefore = f.streamFetches().length;
    const res = await subscribePut(f.base, tab.streamId, ["dev-1/device", "ghost/device"]);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { message: string } };
    assert.match(body.error.message, /No device ghost/);
    assert.equal(
      f.streamFetches().length,
      streamsBefore,
      "zero upstreams were opened for the known key",
    );
    assert.deepEqual(f.readersByDevice(), [], "zero reader slots were acquired");

    // Nothing leaked: the known key alone still works right after.
    const okRes = await subscribePut(f.base, tab.streamId, ["dev-1/device"]);
    assert.equal(okRes.status, 200);
    assert.deepEqual(f.readersByDevice(), [["dev-1", 1]], "exactly one reader slot");
    const iter = tab.frames();
    const frame = await withTimeout(iter.next());
    assert.notEqual(frame, "timeout");
    assert.equal(
      (frame as { value: { frame: { type: string } } }).value.frame.type,
      "tree",
      "the device SSE snapshot reached the browser",
    );
  } finally {
    await f.cleanup();
  }
});

// -- 1: a device-refused subscription reaches the browser as a fault ----------

test("R5: a subscription the device refuses arrives at the browser as a fault frame", async () => {
  const f = await setup();
  try {
    const tab = await openTab(f.base);
    // The hub accepts any-length session ids; the device caps the segment at 128.
    const refused = `dev-1/session/${"s".repeat(129)}`;
    const res = await subscribePut(f.base, tab.streamId, [refused]);
    assert.equal(res.status, 200, "the hub opened the upstream (parse passed)");
    const iter = tab.frames();
    const next = await withTimeout(iter.next());
    assert.notEqual(next, "timeout", "the browser must not starve: a fault frame arrives");
    const frame = (next as { value: { sub: string; frame: { type: string; error?: { code: string; message: string } } } })
      .value;
    assert.equal(frame.sub, refused);
    assert.equal(frame.frame.type, "fault");
    assert.equal(frame.frame.error?.code, "invalid");
    assert.match(frame.frame.error?.message ?? "", /subscribe refused/);
  } finally {
    await f.cleanup();
  }
});

// -- 2: the hub side of the aligned REST refusal ------------------------------

test("R5: the hub refuses a non-allowlisted tunnelled REST request with 400 and the validator's message", async () => {
  const f = await setup();
  try {
    const signal = new AbortController().signal;
    for (const [path, message] of [
      ["/v1/nope", "rest: route is not allowlisted"],
      ["/v1/pairing", "rest: device-local control route must not be tunneled"],
    ] as const) {
      await assert.rejects(
        f.dispatcher.request(DEVICE_ID, { method: "GET", path }, signal),
        (e: unknown) =>
          e instanceof DpiError &&
          (e as DpiError).status === 400 &&
          (e as DpiError).code === "invalid" &&
          (e as DpiError).message === message,
        `${path}: 400 invalid with the validator's message`,
      );
    }
    // Control: an allowlisted request still goes through the tunnel.
    const ok = await f.dispatcher.request(DEVICE_ID, { method: "GET", path: "/v1/device" }, signal);
    assert.equal(ok.status, 200);
  } finally {
    await f.cleanup();
  }
});

test("R5: a valid subscribe still streams after the refusals above (tunnel sanity)", async () => {
  const f = await setup();
  try {
    const tab = await openTab(f.base);
    const res = await subscribePut(f.base, tab.streamId, ["dev-1/device"]);
    assert.equal(res.status, 200);
    const iter = tab.frames();
    const next = await withTimeout(iter.next());
    assert.notEqual(next, "timeout");
    const frame = (next as { value: { frame: { type: string; tree?: { v: number } } } }).value;
    assert.equal(frame.frame.type, "tree");
    assert.equal(frame.frame.tree?.v, 1);
  } finally {
    await f.cleanup();
  }
});
