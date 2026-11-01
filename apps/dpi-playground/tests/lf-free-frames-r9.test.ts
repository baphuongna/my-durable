/**
 * Run-9 unit D (u6): the frame-level LF-free invariant — owned HERE.
 *
 * Line-delimited hub outputs (the framing an embedded LF/CR would corrupt):
 * every device-authored string (device.name, session/agent names, paths,
 * device response header values) must reach the wire ESCAPED (JSON) or
 * STRIPPED (header scrubbers), never raw.
 *
 * Compose-site enumeration (apps/dpi-playground-hub/src/):
 *  1. mux.ts stream.send + follow relay  → SSE `data: ${JSON.stringify(frame)}\n\n`
 *     (relay frames, network frames, faults, disconnected) — pinned by tests
 *     1 and 2 below: single LF-free data lines with hostile device strings.
 *  2. mux.ts ping                       → literal `: ping\n\n` (no device data).
 *  3. tunnel.ts httpJson                → pre-auth refusal on the RAW socket:
 *     fixed reason literals + JSON.stringify body — pinned by test 5.
 *  4. tunnel.ts send / tunnel-transport → hub→device ws frames are
 *     JSON.stringify documents — pinned by test 3 (every hub→device frame is
 *     a single line).
 *  5. tunnel-transport.ts safeHeaderValue → device rest-response header
 *     values (plain rest-response frame AND the chunked envelope) — pinned by
 *     test 3 (direct transport + chunked + proxy e2e).
 *  6. transport.ts safeHeaderValue        → LAN device response header values
 *     — pinned by test 4 (raw-socket upstream smuggling LF/CRLF).
 *  7. proxy.ts                            → Content-Disposition is RE-ISSUED
 *     from a [^A-Za-z0-9._-]-scrubbed stem, Content-Type hub-fixed,
 *     Idempotent-Replay a literal; bodies ride length-framed HTTP — pinned by
 *     test 3 (the smuggled header never reaches the operator's client).
 *  8. shares.ts renderSharePage           → HTML, not line-delimited: C0 is
 *     stripped except \t\n\r which are inert HTML whitespace, and HTML
 *     metacharacters are entity-escaped (shares.test.ts owns that contract);
 *     deliberately OUTSIDE the frame-level LF-free invariant.
 *  9. main.ts REST responses             → res.json / length-framed HTTP
 *     bodies; device strings live inside JSON strings (escaped by Express).
 *
 * Client-side sink (dpi-tui): pickers.ts composes single-row chrome (Picker
 * titles, row labels) from device-authored names — sanitizeTerminal KEEPS
 * \n by design (multi-line content is legitimate elsewhere), so every
 * single-row compose site must go through oneLine. Test 6 pins the titles
 * and labels against a hostile device.name / session name / agent name.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import express from "express";
import WebSocket from "ws";
import { StreamMux } from "../apps/dpi-playground-hub/src/mux.js";
import { DeviceMonitor } from "../apps/dpi-playground-hub/src/monitor.js";
import { LanTransport } from "../apps/dpi-playground-hub/src/transport.js";
import { TunnelServer } from "../apps/dpi-playground-hub/src/tunnel.js";
import {
  TunnelDispatcher,
  TunnelTransport,
} from "../apps/dpi-playground-hub/src/tunnel-transport.js";
import { proxy } from "../apps/dpi-playground-hub/src/proxy.js";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { Audit } from "../apps/dpi-playground-hub/src/audit.js";
import { sendChunked } from "../../dpi-sdk/src/node/chunk.js";
import { until } from "../../dpi-backend/tests/helpers.js";
import type { MuxFrame } from "../../dpi-sdk/src/api.js";

// The hostile payload: if any hub compose site emits it raw into a
// line-delimited output, it forges whole SSE events / chrome rows.
const HOSTILE_NAME = 'box\r\ndata: {"sub":"forged","frame":{"type":"fault","error":{"code":"offline","message":"hub pwned"}}}\n\n: ping\n\n';

const assertSingleLine = (text: string, what: string) => {
  assert.ok(!text.includes("\n"), `${what}: raw LF leaked into framed output: ${JSON.stringify(text.slice(0, 120))}`);
  assert.ok(!text.includes("\r"), `${what}: raw CR leaked into framed output: ${JSON.stringify(text.slice(0, 120))}`);
};

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

/** Every complete SSE data line the mux emitted, as raw text (pre-parse). */
const dataLines = (res: FakeRes) =>
  Buffer.concat(res.chunks)
    .toString("utf8")
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => block.slice(6));

// --------------------------------------------------------------- sites 1+2

/** LAN device whose /v1/device name and pushed frames carry hostile strings. */
async function muxHarness() {
  const dir = await mkdtemp(join(tmpdir(), "dpi-lffree-"));
  const live = new Set<{ write(chunk: string): unknown }>();
  const push = (frame: unknown) => {
    for (const r of live) r.write(`data: ${JSON.stringify(frame)}\n\n`);
  };
  const upstream = createServer((req, res) => {
    if (req.url === "/v1/device") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ apiVersion: 1, uid: randomUUID(), name: HOSTILE_NAME }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    live.add(res);
    res.on("close", () => live.delete(res));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  const registry = new NetworkRegistry(join(dir, "network.sqlite"));
  registry.upsert({ id: "lan-box", url: `http://127.0.0.1:${port}`, token: "x".repeat(43) });
  const monitor = new DeviceMonitor(registry);
  const res = new FakeRes();
  /** Resolve once BOTH /v1/events readers exist (monitor + mux follow) — pushing before the follow's fetch lands silently drops the frame. */
  const waitFollow = () =>
    until(async () => live.size >= 2, 5000, "mux follow connected");
  const cleanup = async () => {
    res.emit("close"); // mux writer close → abort upstreams + ping interval
    monitor.stop();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    registry.close();
    await rm(dir, { recursive: true, force: true });
  };
  return { push, waitFollow, registry, monitor, res, cleanup };
}

test("site 1 (mux relay): hostile device frame strings stay escaped — every SSE data line is one line", { timeout: 30_000 }, async () => {
  const f = await muxHarness();
  try {
    f.monitor.start();
    await f.monitor.settled("lan-box");
    assert.equal(f.monitor.state("lan-box")?.status, "online");
    const mux = new StreamMux(f.registry, f.monitor);
    mux.open({} as never, f.res as never);
    await until(async () => dataLines(f.res).some((l) => l.includes('"stream"')), 5000, "mux hello");
    const hello = JSON.parse(dataLines(f.res).find((l) => l.includes('"stream"'))!) as MuxFrame;
    if (hello.frame.type !== "stream") throw Error("no stream id");
    mux.subscribe(hello.frame.streamId, ["lan-box/device"]);

    // Hostile strings in nested device-authored fields of relayed frames.
    await f.waitFollow();
    f.push({
      type: "agents",
      agents: [{ id: 1, kind: "root", name: HOSTILE_NAME, cwd: "/tmp/" + HOSTILE_NAME }],
    });
    f.push({
      type: "tree",
      tree: { uid: randomUUID(), name: HOSTILE_NAME, sessions: [{ id: "s1", title: HOSTILE_NAME }], at: Date.now() },
    });
    await until(
      async () =>
        dataLines(f.res).some((l) => l.includes("lan-box/device") && l.includes("forged")),
      10_000,
      "hostile relayed frames reached the tab",
    );

    for (const line of dataLines(f.res)) {
      assertSingleLine(line, "mux SSE data line");
      // An escaped payload is still JSON — every line parses.
      JSON.parse(line);
    }
    // The hostile content SURVIVES (escaped, not stripped): round-trip one frame.
    const agents = dataLines(f.res)
      .map((l) => JSON.parse(l) as MuxFrame)
      .find((m) => m.frame.type === "agents") as { frame: { agents: { name: string }[] } } | undefined;
    assert.ok(agents, "agents frame relayed");
    assert.equal(agents.frame.agents[0].name, HOSTILE_NAME, "hostile name round-trips through the relay");
  } finally {
    await f.cleanup();
  }
});

test("site 2 (network frame): device.name with LF/CR reaches the tab escaped, never raw", { timeout: 30_000 }, async () => {
  const f = await muxHarness();
  try {
    f.monitor.start();
    await f.monitor.settled("lan-box");
    assert.equal(f.monitor.state("lan-box")?.status, "online");
    const mux = new StreamMux(f.registry, f.monitor);
    mux.open({} as never, f.res as never);
    await until(async () => dataLines(f.res).some((l) => l.includes('"network"')), 5000, "network frame");

    const line = dataLines(f.res).find((l) => l.includes('"network"'))!;
    assertSingleLine(line, "network frame data line");
    const parsed = JSON.parse(line) as MuxFrame;
    if (parsed.frame.type !== "network") throw Error("not a network frame");
    const device = parsed.frame.devices.find((d) => d.id === "lan-box");
    assert.ok(device, "device row present");
    // Escaped, not stripped: the hostile name round-trips inside the JSON string.
    assert.equal(device.info?.name, HOSTILE_NAME, "hostile device name round-trips");
    assert.ok(line.includes("\\n"), "the LF travelled as the two-char escape, not a raw byte");
  } finally {
    f.monitor.stop();
    await f.cleanup();
  }
});

// ---------------------------------------------------- sites 4+5+7 (tunnel)

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const HUB_ID = "1f2e3d4c-5b6a-4988-8776-655443332211";
const FINGERPRINT = `sha256:${"d".repeat(64)}`;
const TUNNEL_UID = randomUUID();
const HOSTILE_DISPOSITION = 'attachment; filename="evil\r\nSet-Cookie: pwn=1.zip"';

async function tunnelHarness() {
  const dir = await mkdtemp(join(tmpdir(), "dpi-lffree-t-"));
  const registry = new NetworkRegistry(join(dir, "net.sqlite"));
  registry.clearTunnelState();
  const audit = new Audit(registry);
  const tunnel = new TunnelServer(registry, audit, HUB_ID);
  const dispatcher = new TunnelDispatcher(tunnel, { audit });
  const deviceId = "lf-dev";
  const token =
    "dpt_" + Buffer.from(randomUUID() + randomUUID()).toString("base64url").slice(0, 43);
  const t0 = Date.now();
  const epoch = randomUUID();
  registry.db
    .prepare(
      `INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,created_at,updated_at,transport)
       VALUES(?, 'LF Dev', 'url', NULL, NULL, 'ui', 0, ?, 'checking', ?, ?, 'tunnel')`,
    )
    .run(deviceId, TUNNEL_UID, t0, t0);
  registry.db
    .prepare(
      `INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at)
       VALUES(?,?,?,?,'paired',1,?,?,?)`,
    )
    .run(deviceId, epoch, "pub", FINGERPRINT, t0, t0, t0);
  registry.db
    .prepare(
      `INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at,confirmed_at)
       VALUES(?,?,?,?,?,'current',?,?)`,
    )
    .run(randomUUID(), deviceId, epoch, 1, sha(token), t0, t0);

  const server = createServer();
  server.on("upgrade", (req, socket, head) => tunnel.handleUpgrade(req, socket, head));
  await new Promise<void>((d) => server.listen(0, "127.0.0.1", d));
  const hubPort = (server.address() as { port: number }).port;

  /** Raw text of every frame the HUB sent to the device (site 4). */
  const hubToDeviceRaw: string[] = [];
  let reqNo = 0;
  const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/api/tunnel`, {
    headers: { authorization: `Bearer ${token}` },
  });
  await new Promise<void>((d) => ws.once("open", d));
  ws.on("message", (d) => {
    const raw = d.toString();
    hubToDeviceRaw.push(raw);
    const msg = JSON.parse(raw);
    if (msg.type === "rest-request") {
      if (msg.path === "/v1/device") {
        ws.send(
          JSON.stringify({
            type: "rest-response",
            reqId: msg.reqId,
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ apiVersion: 1, uid: TUNNEL_UID, name: "LF Dev" }),
          }),
        );
        return;
      }
      reqNo++;
      if (reqNo === 1) {
        // plain rest-response frame with a hostile header value (site 5, plain path)
        ws.send(
          JSON.stringify({
            type: "rest-response",
            reqId: msg.reqId,
            status: 200,
            contentType: "application/zip",
            bodyEncoding: "base64",
            body: Buffer.from("PK").toString("base64"),
            contentDisposition: HOSTILE_DISPOSITION,
          }),
        );
      } else {
        // the SAME envelope, chunked (site 5, chunked-envelope path)
        sendChunked(
          {
            status: 200,
            contentType: "application/zip",
            bodyEncoding: "base64",
            body: Buffer.from("PK").toString("base64"),
            contentDisposition: HOSTILE_DISPOSITION,
          },
          { kind: "rest-response", reqId: msg.reqId },
          (chunk) => ws.send(JSON.stringify(chunk)),
        );
      }
    }
  });
  ws.send(
    JSON.stringify({
      type: "pair-handshake",
      v: 1,
      deviceUid: TUNNEL_UID,
      deviceId,
      pairingEpoch: epoch,
      credentialId: (
        registry.db
          .prepare("SELECT credential_id FROM tunnel_credentials WHERE device_id=?")
          .get(deviceId) as { credential_id: string }
      ).credential_id,
      generation: 1,
      apiVersion: 1,
      tunnelProto: 1,
      keyFingerprint: FINGERPRINT,
    }),
  );
  await new Promise<void>((d) => ws.once("message", () => d())); // hello

  const monitor = new DeviceMonitor(registry);
  const source = {
    dispatcherFor: (row: { id: string; transport: string }) =>
      new TunnelTransport(row, dispatcher),
    hasLiveConnection: (id: string) => tunnel.hasConnection(id),
  };
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.all("/api/devices/:id/v1/{*rest}", proxy(registry, monitor, source));
  const apiServer = createServer(app);
  await new Promise<void>((d) => apiServer.listen(0, "127.0.0.1", d));
  const apiPort = (apiServer.address() as { port: number }).port;

  const cleanup = async () => {
    ws.terminate();
    dispatcher.close();
    tunnel.close();
    monitor.stop();
    apiServer.close();
    apiServer.closeAllConnections();
    server.close();
    server.closeAllConnections();
    registry.close();
    await rm(dir, { recursive: true, force: true });
  };
  monitor.setTunnelSource(source);
  const onlineBy = Date.now() + 10_000;
  while (Date.now() < onlineBy && monitor.state(deviceId)?.status !== "online")
    await new Promise((r) => setTimeout(r, 50));
  if (monitor.state(deviceId)?.status !== "online") throw new Error("fake device never came online");
  return { base: `http://127.0.0.1:${apiPort}`, deviceId, hubPort, dispatcher, hubToDeviceRaw, cleanup };
}

test("sites 4+5+7 (tunnel): hostile device header values never reach hub output raw; hub→device frames are single-line JSON", { timeout: 60_000 }, async () => {
  const f = await tunnelHarness();
  try {
    // Site 5, plain rest-response frame: the scrubbed value on TransportResponse.
    const transport = new TunnelTransport({ id: f.deviceId, transport: "tunnel" }, f.dispatcher);
    const plain = await transport.request(
      { method: "POST", path: "/v1/sessions", body: { name: "s" } },
      new AbortController().signal,
    );
    assert.ok(plain.contentDisposition, "plain path surfaced a contentDisposition");
    assertSingleLine(plain.contentDisposition, "plain rest-response contentDisposition (safeHeaderValue)");
    assertSingleLine(JSON.stringify(plain), "whole TransportResponse is one line");

    // Site 5, chunked envelope: same scrubber on the reassembled envelope.
    const chunked = await transport.request(
      { method: "POST", path: "/v1/sessions", body: { name: "s2" } },
      new AbortController().signal,
    );
    assert.ok(chunked.contentDisposition, "chunked path surfaced a contentDisposition");
    assertSingleLine(chunked.contentDisposition, "chunked envelope contentDisposition (safeHeaderValue)");

    // Site 7 (proxy): the operator-facing response re-issues the label from a
    // scrubbed stem; the smuggled header never becomes a real header.
    const res = await fetch(`${f.base}/api/devices/${f.deviceId}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "s3" }),
    });
    assert.equal(res.status, 200);
    const disposition = res.headers.get("content-disposition") ?? "";
    assertSingleLine(disposition, "proxy Content-Disposition header");
    assert.match(disposition, /^attachment; filename="[A-Za-z0-9._-]*\.zip"$/, "hub-authored scrubbed label");
    assert.equal(res.headers.get("set-cookie"), null, "the smuggled Set-Cookie never reaches the client");
    assert.equal(Buffer.from(await res.arrayBuffer()).toString("latin1"), "PK", "zip bytes pass through");

    // Site 4: every frame the HUB composed for the device is a single-line JSON doc.
    assert.ok(f.hubToDeviceRaw.length > 0, "hub sent device frames");
    for (const raw of f.hubToDeviceRaw) assertSingleLine(raw, "hub→device ws frame");
  } finally {
    await f.cleanup();
  }
});

test("site 3 (tunnel pre-auth refusal): the raw-socket 401 is a fixed reason + one-line JSON body", { timeout: 30_000 }, async () => {
  const f = await tunnelHarness();
  try {
    const head = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(f.hubPort, "127.0.0.1");
      const parts: Buffer[] = [];
      sock.on("data", (d) => parts.push(Buffer.from(d)));
      sock.on("error", reject);
      sock.on("close", () => resolve(Buffer.concat(parts).toString("latin1")));
      sock.write(
        "GET /api/tunnel HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: Upgrade\r\nupgrade: websocket\r\n" +
          "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\n" +
          "authorization: Bearer dpt_bogus\r\n\r\n",
      );
    });
    assert.ok(head.startsWith("HTTP/1.1 401 Unauthorized\r\n"), `unexpected refusal head: ${head.slice(0, 60)}`);
    const [headBlock, ...rest] = head.split("\r\n\r\n");
    for (const line of headBlock.split("\r\n")) assertSingleLine(line, "refusal head line");
    const body = rest.join("\r\n\r\n");
    assertSingleLine(body, "refusal JSON body");
    assert.equal(JSON.parse(body).type, "tunnel.auth-error");
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------- site 6 (LAN leg)

test("site 6 (LanTransport): LF-smuggled device headers fail closed; CRLF-split values stay LF-free", { timeout: 30_000 }, async () => {
  const servers: ReturnType<typeof net.createServer>[] = []; // r9: keep refs — a leaked Server keeps the test process alive forever
  const serve = (headerBlock: string) =>
    new Promise<number>((resolve) => {
      const srv = net.createServer((sock) => {
        sock.on("data", () => {
          sock.write(
            `HTTP/1.1 200 OK\r\ncontent-type: application/zip\r\n${headerBlock}content-length: 2\r\nconnection: close\r\n\r\nhi`,
          );
          sock.end();
        });
      });
      servers.push(srv);
      srv.listen(0, "127.0.0.1", () => resolve((srv.address() as { port: number }).port));
    });

  // A raw LF inside a header value: undici refuses the response — the
  // transport must fail closed (offline), never surface a tainted value.
  const lfPort = await serve('content-disposition: attachment; filename="ev\nil.zip"\r\n');
  const lfTransport = new LanTransport({
    id: "lan-hostile",
    url: `http://127.0.0.1:${lfPort}`,
    token: "t".repeat(43),
    transport: "lan",
  });
  await assert.rejects(
    () => lfTransport.request({ method: "GET", path: "/v1/sessions" }, new AbortController().signal),
    (e: { code?: string }) => e.code === "offline",
    "a malformed hostile response fails closed as offline",
  );

  // A CRLF-split value becomes a SEPARATE header on the wire: the smuggled
  // header is simply never read, and the disposition value itself is LF-free.
  const crlfPort = await serve(
    'content-disposition: attachment; filename="a.zip"\r\nSet-Cookie: pwn=1\r\n',
  );
  const crlfTransport = new LanTransport({
    id: "lan-hostile2",
    url: `http://127.0.0.1:${crlfPort}`,
    token: "t".repeat(43),
    transport: "lan",
  });
  const resp = await crlfTransport.request(
    { method: "GET", path: "/v1/sessions" },
    new AbortController().signal,
  );
  assert.ok(resp.contentDisposition, "binary response surfaced a contentDisposition");
  assertSingleLine(resp.contentDisposition, "LAN contentDisposition (safeHeaderValue)");
  assertSingleLine(JSON.stringify(resp), "whole LAN TransportResponse is one line");
  for (const srv of servers) srv.close();
});

