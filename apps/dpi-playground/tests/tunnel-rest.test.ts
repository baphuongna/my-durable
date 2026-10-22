/**
 * P2-16 — REST multiplexing + mutation safety over the tunnel, through the
 * real proxy route. A scripted fake device (real ws client answering
 * rest-requests) plays the device leg; assertions cover T-4/T-8/T-12/S-4/S-11.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import express from "express";
import WebSocket from "ws";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { Audit } from "../apps/dpi-playground-hub/src/audit.js";
import { TunnelServer } from "../apps/dpi-playground-hub/src/tunnel.js";
import { TunnelDispatcher, TunnelTransport } from "../apps/dpi-playground-hub/src/tunnel-transport.js";
import { DeviceMonitor } from "../apps/dpi-playground-hub/src/monitor.js";
import { proxy } from "../apps/dpi-playground-hub/src/proxy.js";
import { sendChunked } from "../../dpi-sdk/src/node/chunk.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const HUB_ID = "6f707172-8394-4a5b-9c0d-1e2f3a4b5c6d";
const FINGERPRINT = `sha256:${"e".repeat(64)}`;
const UID = randomUUID();

interface DeviceScript {
  /** Non-probe REST requests the device actually received. */
  requests: { reqId: string; method: string; path: string; body: unknown; idempotencyKey?: string }[];
  /** Monitor /v1/device probes, counted separately from app traffic. */
  probes: number;
  respond: (req: { reqId: string }, res: unknown) => void;
  silent: Set<string>;
  ws: WebSocket;
}

async function setup(deadlineMs?: number) {
  const dir = await mkdtemp(join(tmpdir(), "dpi-p216-"));
  const registry = new NetworkRegistry(join(dir, "net.sqlite"));
  registry.clearTunnelState();
  const audit = new Audit(registry);
  const tunnel = new TunnelServer(registry, audit, HUB_ID);
  const dispatcher = new TunnelDispatcher(tunnel, { audit, ...(deadlineMs ? { deadlineMs } : {}) });
  const deviceId = "rest-dev";
  const token = "dpt_" + Buffer.from(randomUUID() + randomUUID()).toString("base64url").slice(0, 43);
  const t0 = Date.now();
  const epoch = randomUUID();
  registry.db
    .prepare(
      `INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,created_at,updated_at,transport)
       VALUES(?, 'R Dev', 'url', NULL, NULL, 'ui', 0, ?, 'checking', ?, ?, 'tunnel')`,
    )
    .run(deviceId, UID, t0, t0);
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

  // Fake device: real ws client that completes handshake and scripts answers.
  const script: DeviceScript = {
    requests: [],
    probes: 0,
    respond: () => {},
    silent: new Set(),
    ws: undefined as unknown as WebSocket,
  };
  const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/api/tunnel`, { headers: { authorization: `Bearer ${token}` } });
  script.ws = ws;
  await new Promise<void>((d) => ws.once("open", d));
  ws.on("message", (d) => {
    const msg = JSON.parse(d.toString());
    if (msg.type === "rest-request") {
      if (msg.path === "/v1/device") {
        // monitor probe: always answer so the device is genuinely online
        script.probes++;
        ws.send(JSON.stringify({ type: "rest-response", reqId: msg.reqId, status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, uid: UID, name: "R Dev" }) }));
        return;
      }
      script.requests.push(msg);
      if (!script.silent.has(msg.reqId))
        script.respond(msg, (res: unknown) => ws.send(JSON.stringify({ type: "rest-response", reqId: msg.reqId, ...(res as object) })));
    }
  });
  ws.send(JSON.stringify({
    type: "pair-handshake", v: 1, deviceUid: UID, deviceId, pairingEpoch: epoch,
    credentialId: (registry.db.prepare("SELECT credential_id FROM tunnel_credentials WHERE device_id=?").get(deviceId) as { credential_id: string }).credential_id,
    generation: 1, apiVersion: 1, tunnelProto: 1, keyFingerprint: FINGERPRINT,
  }));
  await new Promise<void>((d) => ws.once("message", () => d())); // hello

  const monitor = new DeviceMonitor(registry);
  const source = {
    dispatcherFor: (row: { id: string; transport: string }) => new TunnelTransport(row, dispatcher),
    hasLiveConnection: (id: string) => tunnel.hasConnection(id),
  };
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.all("/api/devices/:id/v1/{*rest}", proxy(registry, monitor, source));
  const apiServer = createServer(app);
  await new Promise<void>((d) => apiServer.listen(0, "127.0.0.1", d));
  const apiPort = (apiServer.address() as { port: number }).port;
  const base = `http://127.0.0.1:${apiPort}`;

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
  // Monitor must see the device online for the proxy to forward; the fake
  // device answers the probe above, so this is a genuine online state.
  // (setTunnelSource alone re-watches tunnel devices; start() would double it.)
  monitor.setTunnelSource(source);
  const onlineBy = Date.now() + 10_000;
  while (Date.now() < onlineBy && monitor.state(deviceId)?.status !== "online") await new Promise((r) => setTimeout(r, 50));
  if (monitor.state(deviceId)?.status !== "online") throw new Error("fake device never came online: " + JSON.stringify(monitor.state(deviceId)) + " reqs=" + JSON.stringify(script.requests.map((r) => r.path)));
  return { base, deviceId, script, registry, cleanup, tunnel, dispatcher };
}

test("proxy over tunnel: request/response passthrough, method/path/body/idempotency-key only", async () => {
  const f = await setup();
  try {
    f.script.respond = (req, send) => send({ status: 200, contentType: "application/json", body: { ok: true, echo: req.body } });
    const res = await fetch(`${f.base}/api/devices/${f.deviceId}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "abc-123" },
      body: JSON.stringify({ name: "s" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, echo: { name: "s" } });
    const seen = f.script.requests[f.script.requests.length - 1];
    assert.equal(seen.method, "POST");
    assert.equal(seen.path.startsWith("/v1/sessions"), true);
    assert.equal(seen.idempotencyKey, "abc-123");
    assert.deepEqual(seen.body, { name: "s" });
    // caller authorization NEVER forwarded (schema has no such field)
    assert.ok(!("authorization" in seen) && !("headers" in seen));
  } finally {
    await f.cleanup();
  }
});

test("device-local control paths rejected: /v1/pairing, /v1/tunnel never proxied", async () => {
  const f = await setup();
  try {
    for (const p of ["pairing", "tunnel", "pairing/start"]) {
      const res = await fetch(`${f.base}/api/devices/${f.deviceId}/v1/${p}`);
      assert.equal(res.status, 400, p);
      assert.equal((await res.json()).error.code, "invalid");
    }
    assert.equal(f.script.requests.length, 0, "nothing reached the device");
  } finally {
    await f.cleanup();
  }
});

test("GA-07: no spelling of a local-only or streaming route is forwarded; encoded names still are, verbatim", async () => {
  const f = await setup();
  try {
    f.script.respond = (_req, send) => send({ status: 200, contentType: "application/json", body: { ok: true } });
    // Raw HTTP: fetch() would resolve "." segments and drop fragments before the hub ever saw them.
    const send = (method: string, target: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const url = new URL(f.base);
        const req = httpRequest(
          { host: url.hostname, port: url.port, method, path: `/api/devices/${f.deviceId}${target}`, headers: { "content-type": "application/json" } },
          (res) => {
            let body = "";
            res.on("data", (d) => (body += d));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on("error", reject);
        req.end(method === "GET" ? undefined : JSON.stringify({ code: "12345678", hub: "https://elsewhere.invalid" }));
      });
    for (const [method, target] of [
      ["POST", "/v1/Pairing/start"],
      ["POST", "/v1/PAIRING/cancel"],
      ["GET", "/v1/Tunnel"],
      ["GET", "/v1/TUNNEL"],
      ["GET", "/v1/Events"],
      ["GET", "/v1/sessions/x1/Events"],
      ["POST", "/v1/./pairing/start"],
      ["POST", "/v1/%2e/pairing/start"],
      ["POST", "/v1/%2E/pairing/start"],
      ["POST", "/v1/pairing/start#x"],
      ["POST", "/v1/pairing;x=1/start"],
      ["POST", "/v1/%50airing/start"],
      ["POST", "/v1/pa%09iring/start"],
      ["GET", "/v1/events#x"],
      ["GET", "/v1/events/"],
    ] as const) {
      const res = await send(method, target);
      assert.equal(res.status, 400, `${method} ${target}`);
      assert.equal(JSON.parse(res.body).error.code, "invalid", `${method} ${target}`);
    }
    assert.equal(f.script.requests.length, 0, "nothing reached the device");

    const name = "/v1/sessions/My%20Session%20%E2%9C%93/agents/main/messages?waitMs=5";
    assert.equal((await send("POST", name)).status, 200);
    assert.equal(f.script.requests.length, 1);
    assert.equal(f.script.requests[0].path, name, "an allowlisted path travels exactly as the caller wrote it");
  } finally {
    await f.cleanup();
  }
});

test("body cap 256 KiB → 413 before anything is sent", async () => {
  const f = await setup();
  try {
    const res = await fetch(`${f.base}/api/devices/${f.deviceId}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(300_000) }),
    });
    assert.equal(res.status, 413);
    assert.equal(f.script.requests.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("pending caps: 32/device → 33rd concurrent gets 429; no replay of in-flight mutations", async () => {
  const f = await setup(1_500); // short deadline so the 32 stay pending only briefly
  try {
    const shots = Array.from({ length: 33 }, (_, i) =>
      fetch(`${f.base}/api/devices/${f.deviceId}/v1/sessions/${i}/agents/main/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hi" }),
      }),
    );
    const results = await Promise.all(shots);
    const codes = results.map((r) => r.status);
    assert.equal(codes.filter((c) => c === 429).length, 1, "overflow must surface as 429");
    assert.equal(codes.filter((c) => c === 504).length, 32, "the admitted 32 hit the deadline");
    assert.equal(f.script.requests.length, 32, "exactly 32 reached the device");
    assert.equal(new Set(f.script.requests.map((r) => r.reqId)).size, 32, "no duplicate reqIds / replays");
  } finally {
    await f.cleanup();
  }
});

test("deadline → 504 timeout with honest error (client never sees success on unknown outcome)", async () => {
  const f = await setup(150);
  try {
    const res = await fetch(`${f.base}/api/devices/${f.deviceId}/v1/tree`);
    assert.equal(res.status, 504);
    assert.equal((await res.json()).error.code, "timeout");
    // the late response is ignored; no second attempt was made
    assert.equal(f.script.requests.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("foreign rest-response (unknown reqId) → sender closed 1008 + audited; honest pending unaffected", async () => {
  const f = await setup();
  try {
    // start an honest request that stays pending
    const honest = fetch(`${f.base}/api/devices/${f.deviceId}/v1/tree`);
    await new Promise((r) => setTimeout(r, 100));
    const honestReqId = f.script.requests[0].reqId;
    // spoofed response for a reqId that was never issued
    f.script.ws.send(JSON.stringify({ type: "rest-response", reqId: randomUUID(), status: 200, body: { pwned: true } }));
    await new Promise((r) => setTimeout(r, 200));
    const denied = f.registry.db
      .prepare("SELECT detail_json FROM events WHERE action='auth.denied'")
      .all() as { detail_json: string }[];
    assert.ok(denied.some((e) => e.detail_json.includes("foreign_response")));
    // sender got closed
    assert.notEqual(f.script.ws.readyState, f.script.ws.OPEN);
    // the honest request fails with 503 (connection closed), never the spoof body
    const res = await honest;
    assert.equal(res.status, 503);
    assert.notEqual((await res.text()).includes("pwned"), true);
    assert.ok(f.script.requests.some((r) => r.reqId === honestReqId));
  } finally {
    await f.cleanup();
  }
});

test("chunked response reassembles byte-identical; oversized assembly → 502 response_too_large", async () => {
  const f = await setup();
  try {
    // ~1.5 MiB payload must travel as chunks (64 KiB raw each)
    const big = { blob: "z".repeat(1_500_000) };
    f.script.respond = (req, send) => {
      const envelope = { status: 200, contentType: "application/json", body: big };
      sendChunked(envelope, { kind: "rest-response", reqId: req.reqId }, (chunk) =>
        f.script.ws.send(JSON.stringify(chunk)),
      );
    };
    const res = await fetch(`${f.base}/api/devices/${f.deviceId}/v1/tree`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { blob: string };
    assert.equal(body.blob.length, 1_500_000);
    assert.equal(body.blob, big.blob);
  } finally {
    await f.cleanup();
  }
});

test("connection drop mid-request → 503 offline, exactly one request was sent (no replay)", async () => {
  const f = await setup();
  try {
    const pending = fetch(`${f.base}/api/devices/${f.deviceId}/v1/tree`);
    await new Promise((r) => setTimeout(r, 100));
    f.script.ws.terminate();
    const res = await pending;
    assert.equal(res.status, 503);
    assert.equal(f.script.requests.length, 1, "no automatic replay with a new reqId");
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Gate A GA-01: the proxy serves device-controlled bytes from the ADMIN origin.
// A hostile device must not be able to make them an active document there.

const ACTIVE_BODY = "<script>fetch('/api/network').then((r) => r.text())</script>";

test("GA-01: device-declared non-JSON content types are served as inert attachments under a locked-down header set", async () => {
  const f = await setup();
  try {
    const hostile = [
      "text/html",
      "TEXT/HTML; charset=utf-8",
      "text/html;x=application/json",
      "application/xhtml+xml",
      "image/svg+xml",
      "text/xml",
      "application/xml",
      "text/javascript",
      "application/javascript",
      "text/plain",
      "application/pdf",
      "multipart/x-mixed-replace; boundary=x",
      "application/json, text/html",
      "application/jsonp",
    ];
    for (const contentType of hostile) {
      f.script.respond = (_req, send) => send({ status: 404, contentType, body: ACTIVE_BODY });
      const res = await fetch(`${f.base}/api/devices/${f.deviceId}/v1/docs/app.shared-state`);
      assert.equal(res.status, 404, `${contentType}: the device status is preserved`);
      assert.equal(res.headers.get("content-type"), "application/octet-stream", contentType);
      assert.match(res.headers.get("content-disposition") ?? "", /^attachment/, contentType);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff", contentType);
      const csp = res.headers.get("content-security-policy") ?? "";
      assert.match(csp, /default-src 'none'/, contentType);
      assert.match(csp, /(^|;\s*)sandbox(\s|;|$)/, contentType);
      assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin", contentType);
      assert.equal(await res.text(), ACTIVE_BODY, "the bytes are untouched; only their type is neutralised");
    }
  } finally {
    await f.cleanup();
  }
});

test("GA-01: JSON stays JSON for the app, but still carries the locked-down headers", async () => {
  const f = await setup();
  try {
    for (const contentType of ["application/json", "Application/JSON; charset=UTF-8", undefined]) {
      f.script.respond = (_req, send) => send({ status: 200, ...(contentType ? { contentType } : {}), body: { ok: true } });
      const res = await fetch(`${f.base}/api/devices/${f.deviceId}/v1/tree`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^application\/json/i, String(contentType));
      assert.equal(res.headers.get("content-disposition"), null, "JSON is not forced into a download");
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
      assert.deepEqual(await res.json(), { ok: true });
    }
  } finally {
    await f.cleanup();
  }
});

test("GA-01: top-level navigations and subresource loads are refused before they reach the device", async () => {
  const f = await setup();
  try {
    f.script.respond = (_req, send) => send({ status: 200, contentType: "text/html", body: ACTIVE_BODY });
    // fetch() rewrites Sec-Fetch-Mode itself, so send the exact browser headers over raw HTTP.
    const attempt = (headers: Record<string, string>) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const url = new URL(`${f.base}/api/devices/${f.deviceId}/v1/docs/app.shared-state`);
        const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, headers }, (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject);
        req.end();
      });
    for (const headers of [
      { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-site": "same-origin" },
      { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" },
      { "sec-fetch-mode": "navigate" },
      { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" },
      { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" },
      { "sec-fetch-dest": "object" },
    ]) {
      const res = await attempt(headers);
      assert.equal(res.status, 403, JSON.stringify(headers));
      assert.equal(JSON.parse(res.body).error.code, "forbidden");
    }
    assert.equal(f.script.requests.length, 0, "nothing reached the device");
    // fetch()/XHR from the app and header-less API clients keep working.
    assert.equal((await attempt({ "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", "sec-fetch-site": "same-origin" })).status, 200);
    assert.equal((await attempt({})).status, 200);
    assert.equal(f.script.requests.length, 2);
  } finally {
    await f.cleanup();
  }
});

test("RR: a device answer whose status is outside 200-599 is a prompt 502, never the device's own status", async () => {
  const f = await setup();
  try {
    // The plain-frame schema admits 100-599; a 1xx status hangs or kills the client socket if passed on.
    f.script.respond = (_req, send) => send({ status: 150, contentType: "application/json", body: { pwned: true } });
    const interim = await fetch(`${f.base}/api/devices/${f.deviceId}/v1/tree`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(interim.status, 502, "a 1xx device status is not passed through");
    assert.equal((await interim.json()).error.code, "invalid");

    // The chunked envelope carries no schema: a status that is not even a finite number is refused
    // by the transport, and an out-of-range number by the proxy clamp. Either way it is a 502 and
    // never the device's own status line; the message pins which layer refused.
    const chunked = (envelope: Record<string, unknown>) => (req: { reqId: string }, _send: unknown) =>
      sendChunked(envelope, { kind: "rest-response", reqId: req.reqId }, (chunk) => f.script.ws.send(JSON.stringify(chunk)));
    for (const [bad, layer] of [
      ["200", /envelope out of contract/],
      [Number.NaN, /envelope out of contract/],
      [99, /answered out of contract/],
      [600, /answered out of contract/],
      [700, /answered out of contract/],
      [-1, /answered out of contract/],
      [3.5, /answered out of contract/],
      [150, /answered out of contract/],
    ] as const) {
      f.script.respond = chunked({ status: bad, contentType: "application/json", body: { pwned: true } }) as never;
      const res = await fetch(`${f.base}/api/devices/${f.deviceId}/v1/tree`, { signal: AbortSignal.timeout(5_000) });
      assert.equal(res.status, 502, `status ${String(bad)}: never passed through`);
      const body = (await res.json()) as { error: { code: string; message: string } };
      assert.equal(body.error.code, "invalid", `status ${String(bad)}`);
      assert.match(body.error.message, layer, `status ${String(bad)}: refused by ${layer}`);
    }
    // ...while every in-range status keeps passing through untouched.
    for (const good of [200, 201, 204, 301, 404, 418, 500, 599] as const) {
      f.script.respond = (_req, send) => send({ status: good, contentType: "application/json", body: { ok: true } });
      const res = await fetch(`${f.base}/api/devices/${f.deviceId}/v1/tree`);
      assert.equal(res.status, good, `status ${good} preserved`);
      await res.text();
    }
  } finally {
    await f.cleanup();
  }
});

test("RR: a non-string contentType is treated as absent; it can never crash or mistype the answer", async () => {
  const f = await setup();
  try {
    // The plain-frame schema admits only strings; the chunked envelope is unvalidated bytes.
    for (const contentType of [42, null, { toString: () => "text/html" }, ["text/html"]] as const) {
      f.script.respond = ((req: { reqId: string }) =>
        sendChunked(
          { status: 200, contentType, body: { ok: true } },
          { kind: "rest-response", reqId: req.reqId },
          (chunk) => f.script.ws.send(JSON.stringify(chunk)),
        )) as never;
      const res = await fetch(`${f.base}/api/devices/${f.deviceId}/v1/tree`);
      assert.equal(res.status, 200, `contentType ${String(contentType)}`);
      assert.match(res.headers.get("content-type") ?? "", /^application\/json/i, "absent contentType means the JSON default");
      assert.deepEqual(await res.json(), { ok: true });
    }
  } finally {
    await f.cleanup();
  }
});

/**
 * The forwarded path is the URL minus the device prefix. Express decodes the route segment, so a
 * percent-encoded spelling of a real id (`rest%2Ddev` for `rest-dev`) resolves to the same device
 * while the raw URL no longer starts with its prefix; the sliced remainder would be a mangled
 * path, so the request is refused instead of forwarded.
 */
test("RR: a percent-encoded spelling of a device id is refused, never forwarded mangled", async () => {
  const f = await setup();
  try {
    f.script.respond = (_req, send) => send({ status: 200, contentType: "application/json", body: { ok: true } });
    const encoded = f.deviceId.replace("-", "%2D");
    assert.notEqual(encoded, f.deviceId);
    const res = await fetch(`${f.base}/api/devices/${encoded}/v1/tree`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(res.status, 400, "the raw URL is not the device prefix");
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "invalid");
    assert.match(body.error.message, /outside the device prefix/);
    assert.deepEqual(f.script.requests, [], "nothing reached the device");
    // The same device under its plain spelling still forwards normally.
    const plain = await fetch(`${f.base}/api/devices/${f.deviceId}/v1/tree`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(plain.status, 200, "the ordinary spelling is unaffected");
    await plain.text();
  } finally {
    await f.cleanup();
  }
});
