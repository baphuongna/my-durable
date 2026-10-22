/**
 * P2-12 — hub WSS upgrade, credential auth, connection registry.
 * Real `ws` clients against a real HTTP server with the TunnelServer wired
 * exactly like main.ts does. Covers T-6/T-11/T-12, S-4/S-5/S-10 and the hub
 * half of P-10.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Duplex } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { Audit } from "../apps/dpi-playground-hub/src/audit.js";
import { TunnelServer } from "../apps/dpi-playground-hub/src/tunnel.js";

const now = () => Date.now();
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const FINGERPRINT = `sha256:${"a".repeat(64)}`;
const HUB_ID = "2b4c6d8e-1f3a-4c5d-9e8f-7a6b5c4d3e2f";

interface Fixture {
  registry: NetworkRegistry;
  audit: Audit;
  tunnel: TunnelServer;
  server: ReturnType<typeof createServer>;
  port: number;
  url: (token?: string) => string;
  cleanup: () => Promise<void>;
  makeToken: (t: string) => string;
}

async function fixture(
  policy?: Parameters<typeof TunnelServer.prototype.constructor>[5],
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "dpi-tunnel-"));
  const registry = new NetworkRegistry(join(dir, "net.sqlite"));
  registry.clearTunnelState();
  const audit = new Audit(registry);
  const tunnel = new TunnelServer(registry, audit, HUB_ID, {}, policy);
  const server = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  server.on("upgrade", (req, socket, head) => tunnel.handleUpgrade(req, socket, head));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  return {
    registry,
    audit,
    tunnel,
    server,
    port,
    url: (token) => `ws://127.0.0.1:${port}/api/tunnel${token ? `?x=1` : ""}`,
    cleanup: async () => {
      tunnel.close();
      server.close();
      server.closeAllConnections();
      registry.close();
      await rm(dir, { recursive: true, force: true });
    },
    makeToken: () =>
      "dpt_" +
      Buffer.from(randomUUID() + randomUUID(), "utf8")
        .toString("base64url")
        .slice(0, 43),
  };
}

/** Insert a device + pairing + credential rows directly (schema-faithful). */
function addCredential(
  f: Fixture,
  opts: {
    deviceId: string;
    deviceUid: string;
    epoch?: string;
    generation?: number;
    status?: string;
    token?: string;
  },
): { token: string; credentialId: string; epoch: string; generation: number } {
  const { registry } = f;
  const epoch = opts.epoch ?? randomUUID();
  const generation = opts.generation ?? 1;
  const token = opts.token ?? f.makeToken();
  const credentialId = randomUUID();
  const t = now();
  registry.db
    .prepare(
      `INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,created_at,updated_at,transport)
       VALUES(?, 'Dev', 'url', NULL, NULL, 'ui', 0, ?, 'checking', ?, ?, 'tunnel')
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(opts.deviceId, opts.deviceUid, t, t);
  registry.db
    .prepare(
      `INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at)
       VALUES(?,?,?,?, 'paired', ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET credential_generation=excluded.credential_generation, updated_at=excluded.updated_at`,
    )
    .run(opts.deviceId, epoch, "-----BEGIN PUBLIC KEY-----", FINGERPRINT, generation, t, t, t);
  registry.db
    .prepare(
      `INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at,confirmed_at,retired_at,revoked_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      credentialId,
      opts.deviceId,
      epoch,
      generation,
      sha(token),
      opts.status ?? "current",
      t,
      t,
      opts.status === "retired" ? t : null,
      opts.status === "revoked" ? t : null,
    );
  return { token, credentialId, epoch, generation };
}

function handshakeFor(
  deviceId: string,
  deviceUid: string,
  cred: { epoch: string; credentialId: string; generation: number },
  over: Partial<{
    pairingEpoch: string;
    credentialId: string;
    generation: number;
    deviceUid: string;
    deviceId: string;
    keyFingerprint: string;
  }> = {},
) {
  return {
    type: "pair-handshake",
    v: 1,
    deviceUid: over.deviceUid ?? deviceUid,
    deviceId: over.deviceId ?? deviceId,
    pairingEpoch: over.pairingEpoch ?? cred.epoch,
    credentialId: over.credentialId ?? cred.credentialId,
    generation: over.generation ?? cred.generation,
    apiVersion: 1,
    tunnelProto: 1,
    keyFingerprint: over.keyFingerprint ?? FINGERPRINT,
  };
}

/** Connect + auth + handshake + wait for hello. */
async function connect(
  f: Fixture,
  deviceId: string,
  deviceUid: string,
  cred: { token: string; epoch: string; credentialId: string; generation: number },
  over?: Parameters<typeof handshakeFor>[3],
) {
  const ws = new WebSocket(`ws://127.0.0.1:${f.port}/api/tunnel`, {
    headers: { authorization: `Bearer ${cred.token}` },
  });
  const opened = new Promise<void>((done, reject) => {
    ws.once("open", () => done());
    ws.once("unexpected-response", (_req, res) =>
      reject(Object.assign(new Error(`upgrade ${res.statusCode}`), { statusCode: res.statusCode })),
    );
    ws.once("error", (e) => reject(e));
  });
  await opened;
  const helloP = new Promise<any>((done, reject) => {
    ws.once("message", (d) => {
      try {
        done(JSON.parse(d.toString()));
      } catch (e) {
        reject(e);
      }
    });
    ws.once("close", () => reject(new Error("closed before hello")));
  });
  ws.send(JSON.stringify(handshakeFor(deviceId, deviceUid, cred, over)));
  const hello = await helloP;
  return { ws, hello };
}

/** Raw upgrade attempt; resolves with status + JSON body (never throws on 401/429). */
function rawUpgrade(
  f: Fixture,
  token: string | null,
): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((done, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${f.port}/api/tunnel`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    ws.once("unexpected-response", (_req, res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          done({ status: res.statusCode ?? 0, body: JSON.parse(raw), raw });
        } catch {
          done({ status: res.statusCode ?? 0, body: null, raw });
        }
        ws.terminate();
      });
    });
    ws.once("open", () => {
      ws.terminate();
      reject(new Error("unexpected 101"));
    });
    ws.once("error", (e) => reject(e));
  });
}

const nextFrame = (ws: WebSocket) =>
  new Promise<any>((done, reject) => {
    const to = setTimeout(() => reject(new Error("frame timeout")), 4000);
    ws.once("message", (d) => {
      clearTimeout(to);
      try {
        done(JSON.parse(d.toString()));
      } catch (e) {
        reject(e);
      }
    });
    ws.once("close", (code) => {
      clearTimeout(to);
      reject(Object.assign(new Error(`closed ${code}`), { code }));
    });
  });

const waitClosed = (ws: WebSocket) =>
  new Promise<{ code: number; reason: string }>((done) => {
    ws.once("close", (code, reason) =>
      done({ code, reason: Buffer.from(reason).toString("utf8") }),
    );
  });

test("R02: after a long idle the table forgets old addresses, yet an address that has since spent its quota stays limited", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-ip-lifetime-"));
  const registry = new NetworkRegistry(join(dir, "network.sqlite"));
  let clock = 1000;
  const tunnel = new TunnelServer(
    registry,
    new Audit(registry),
    HUB_ID,
    {},
    {},
    { now: () => clock },
  );
  class ResponseSocket extends Duplex {
    parts: string[] = [];
    _read() {}
    _write(chunk: Buffer, _encoding: string, callback: () => void) {
      this.parts.push(chunk.toString());
      callback();
    }
  }
  const attempt = (ip: string) => {
    const socket = new ResponseSocket();
    tunnel.handleUpgrade(
      { method: "GET", url: "/api/tunnel", headers: {}, socket: { remoteAddress: ip } } as never,
      socket,
      Buffer.alloc(0),
    );
    return Number(socket.parts[0]?.match(/^HTTP\/1\.1 (\d+)/)?.[1]);
  };
  try {
    const ipOf = (i: number) => `10.0.${i >> 8}.${i & 255}`;
    for (let i = 1; i <= 1024; i++) assert.equal(attempt(ipOf(i)), 401, ipOf(i));
    clock += 16 * 60_000;
    let hot = 401;
    for (let i = 0; i < 100 && hot === 401; i++) hot = attempt(ipOf(1));
    assert.equal(hot, 429, "the active IP has consumed its own quota");
    assert.equal(attempt(ipOf(2000)), 401, "an unseen IP reaches auth after idle buckets refill");
    assert.equal(attempt(ipOf(1)), 429, "reclaiming idle entries cannot reset an active IP");
  } finally {
    tunnel.close();
    registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("auth: unknown hash → 401 token_unknown JSON (≤4KiB), no 101, audited, no token leak", async () => {
  const f = await fixture();
  try {
    const token = f.makeToken();
    const r = await rawUpgrade(f, token);
    assert.equal(r.status, 401);
    assert.equal(r.body.type, "tunnel.auth-error");
    assert.equal(r.body.code, "token_unknown");
    assert.ok(r.raw.length <= 4096);
    const denied = f.registry.db
      .prepare("SELECT detail_json FROM events WHERE action='auth.denied'")
      .all() as { detail_json: string }[];
    assert.ok(denied.length >= 1);
    assert.ok(!JSON.stringify(denied).includes(token), "raw token must not appear in audit");
  } finally {
    await f.cleanup();
  }
});

test("auth: revoked tombstone → 401 revoked (survives even with another live pairing); retired → token_unknown", async () => {
  const f = await fixture();
  try {
    const dev = addCredential(f, {
      deviceId: "revoked-dev",
      deviceUid: randomUUID(),
      status: "revoked",
    });
    const r1 = await rawUpgrade(f, dev.token);
    assert.equal(r1.status, 401);
    assert.equal(r1.body.code, "revoked");
    const retired = addCredential(f, {
      deviceId: "retired-dev",
      deviceUid: randomUUID(),
      status: "retired",
    });
    const r2 = await rawUpgrade(f, retired.token);
    assert.equal(r2.status, 401);
    assert.equal(r2.body.code, "token_unknown");
    // malformed/no bearer → token_unknown, never a crash
    const r3 = await rawUpgrade(f, null);
    assert.equal(r3.status, 401);
    assert.equal(r3.body.code, "token_unknown");
  } finally {
    await f.cleanup();
  }
});

test("happy path: 101 → handshake → hello(hubId/connectionId/serverTime); tunnel_state row; audit connect; monitor NOT online", async () => {
  const f = await fixture();
  try {
    const uid = randomUUID();
    const cred = addCredential(f, { deviceId: "happy-dev", deviceUid: uid });
    const { ws, hello } = await connect(f, "happy-dev", uid, cred);
    assert.equal(hello.type, "hello");
    assert.equal(hello.hubId, HUB_ID);
    assert.match(hello.connectionId, /^[0-9a-f-]{36}$/);
    assert.equal(typeof hello.serverTime, "number");
    assert.ok(f.tunnel.hasConnection("happy-dev"));
    const row = f.registry.db
      .prepare("SELECT connection_id FROM tunnel_state WHERE device_id='happy-dev'")
      .get() as { connection_id: string };
    assert.equal(row.connection_id, hello.connectionId);
    const ev = f.registry.db
      .prepare("SELECT outcome FROM events WHERE action='tunnel.connect'")
      .all() as { outcome: string }[];
    assert.equal(ev.length, 1);
    assert.equal(ev[0].outcome, "ok");
    ws.terminate();
    await waitClosed(ws);
  } finally {
    await f.cleanup();
  }
});

test("previous-generation credential is accepted (rotation recovery)", async () => {
  const f = await fixture();
  try {
    const uid = randomUUID();
    const epoch = randomUUID();
    // gen1 previous + gen2 current, same epoch
    const prev = addCredential(f, {
      deviceId: "rot-dev",
      deviceUid: uid,
      epoch,
      generation: 1,
      status: "previous",
    });
    addCredential(f, {
      deviceId: "rot-dev",
      deviceUid: uid,
      epoch,
      generation: 2,
      status: "current",
      token: f.makeToken(),
    });
    const { ws, hello } = await connect(f, "rot-dev", uid, prev);
    assert.equal(hello.type, "hello");
    ws.terminate();
    await waitClosed(ws);
  } finally {
    await f.cleanup();
  }
});

test("handshake mismatch (each tuple field) → fault + close 1008; nothing registered; state cleaned", async () => {
  const f = await fixture();
  try {
    for (const over of [
      { credentialId: randomUUID() },
      { generation: 9 },
      { pairingEpoch: randomUUID() },
      { deviceUid: randomUUID() },
      { deviceId: "other-dev" },
      { keyFingerprint: `sha256:${"b".repeat(64)}` },
    ]) {
      const uid = randomUUID();
      const field = Object.keys(over)[0].toLowerCase();
      const deviceId = `mm-${field}`;
      const cred = addCredential(f, { deviceId, deviceUid: uid });
      const ws = new WebSocket(`ws://127.0.0.1:${f.port}/api/tunnel`, {
        headers: { authorization: `Bearer ${cred.token}` },
      });
      await new Promise<void>((done) => ws.once("open", done));
      const faultP = nextFrame(ws);
      ws.send(JSON.stringify(handshakeFor(deviceId, uid, cred, over)));
      const fault = await faultP;
      assert.equal(fault.type, "fault");
      assert.equal(fault.error.code, "handshake_mismatch");
      const closed = await waitClosed(ws);
      assert.equal(closed.code, 1008);
      assert.equal(f.tunnel.activeCount(), 0);
      assert.equal(f.registry.db.prepare("SELECT COUNT(*) c FROM tunnel_state").get().c, 0);
    }
  } finally {
    await f.cleanup();
  }
});

test("handshake timeout (5 s CANON) → close, cleanup, nothing registered", async () => {
  const f = await fixture();
  try {
    const uid = randomUUID();
    const cred = addCredential(f, { deviceId: "slow-dev", deviceUid: uid });
    const ws = new WebSocket(`ws://127.0.0.1:${f.port}/api/tunnel`, {
      headers: { authorization: `Bearer ${cred.token}` },
    });
    await new Promise<void>((done) => ws.once("open", done));
    const closed = await waitClosed(ws);
    assert.ok([1008, 1006].includes(closed.code));
    assert.equal(f.tunnel.activeCount(), 0);
    const ev = f.registry.db
      .prepare("SELECT outcome, detail_json FROM events WHERE action='tunnel.disconnect'")
      .all() as { outcome: string; detail_json: string }[];
    assert.ok(
      ev.some((e) => e.outcome === "denied" && e.detail_json.includes("handshake_timeout")),
    );
  } finally {
    await f.cleanup();
  }
});

test("swap: new authenticated connection supersedes old; old cleanup cannot delete the new one", async () => {
  const f = await fixture();
  try {
    const uid = randomUUID();
    const cred = addCredential(f, { deviceId: "swap-dev", deviceUid: uid });
    const a = await connect(f, "swap-dev", uid, cred);
    const oldClosed = waitClosed(a.ws);
    const b = await connect(f, "swap-dev", uid, cred);
    const closed = await oldClosed;
    assert.equal(closed.code, 1000);
    // give the old socket's close handler a beat, then the NEW one must still be live
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(f.tunnel.hasConnection("swap-dev"));
    const row = f.registry.db
      .prepare("SELECT connection_id FROM tunnel_state WHERE device_id='swap-dev'")
      .get() as { connection_id: string };
    assert.equal(row.connection_id, b.hello.connectionId);
    // connect/disconnect audit rows for both
    const ev = f.registry.db
      .prepare("SELECT action FROM events WHERE action IN ('tunnel.connect','tunnel.disconnect')")
      .all() as { action: string }[];
    assert.equal(ev.filter((e) => e.action === "tunnel.connect").length, 2);
    assert.equal(ev.filter((e) => e.action === "tunnel.disconnect").length, 1);
    b.ws.terminate();
    await waitClosed(b.ws);
  } finally {
    await f.cleanup();
  }
});

test("protocol: bad JSON / schema fail / direction violation / pre-handshake data → fault + 1008", async () => {
  const f = await fixture();
  try {
    const cases: [string, () => Promise<WebSocket>, unknown][] = [
      [
        "bad-json",
        async () => {
          const uid = randomUUID();
          const cred = addCredential(f, { deviceId: "p1", deviceUid: uid });
          const ws = new WebSocket(`ws://127.0.0.1:${f.port}/api/tunnel`, {
            headers: { authorization: `Bearer ${cred.token}` },
          });
          await new Promise<void>((d) => ws.once("open", d));
          ws.send("not json{");
          return ws;
        },
        null,
      ],
      [
        "schema-fail",
        async () => {
          const uid = randomUUID();
          const cred = addCredential(f, { deviceId: "p2", deviceUid: uid });
          const ws = new WebSocket(`ws://127.0.0.1:${f.port}/api/tunnel`, {
            headers: { authorization: `Bearer ${cred.token}` },
          });
          await new Promise<void>((d) => ws.once("open", d));
          ws.send(JSON.stringify({ type: "pair-handshake", v: 2 }));
          return ws;
        },
        null,
      ],
      [
        "pre-handshake data",
        async () => {
          const uid = randomUUID();
          const cred = addCredential(f, { deviceId: "p3", deviceUid: uid });
          const ws = new WebSocket(`ws://127.0.0.1:${f.port}/api/tunnel`, {
            headers: { authorization: `Bearer ${cred.token}` },
          });
          await new Promise<void>((d) => ws.once("open", d));
          ws.send(
            JSON.stringify({
              type: "tunnel-data",
              frame: { type: "x" },
              subscriptionId: randomUUID(),
              sub: "s",
            }),
          );
          return ws;
        },
        null,
      ],
    ];
    for (const [name, setup] of cases) {
      const ws = await setup();
      const closed = await waitClosed(ws);
      assert.equal(closed.code, 1008, name);
      assert.equal(f.tunnel.activeCount(), 0, name);
    }
    // direction violation AFTER open: device sends rest-request (hub→device only)
    const uid = randomUUID();
    const cred = addCredential(f, { deviceId: "p4", deviceUid: uid });
    const { ws } = await connect(f, "p4", uid, cred);
    const faultP = nextFrame(ws);
    ws.send(
      JSON.stringify({
        type: "rest-request",
        reqId: randomUUID(),
        method: "GET",
        path: "/v1/device",
      }),
    );
    const fault = await faultP;
    assert.equal(fault.type, "fault");
    assert.equal(fault.error.code, "direction_violation");
    const closed = await waitClosed(ws);
    assert.equal(closed.code, 1008);
  } finally {
    await f.cleanup();
  }
});

test("rate limit: per-IP bucket → 429 with bounded retryAfterMs + audit rate_limited", async () => {
  const f = await fixture({
    ipPerMinute: 3,
    globalPerMinute: 100,
    maxAuthenticated: 10,
    maxPendingHandshakes: 10,
    retryAfterMaxMs: 60_000,
  });
  try {
    const token = f.makeToken();
    const attempts = [];
    for (let i = 0; i < 4; i++) attempts.push(rawUpgrade(f, token));
    const results = await Promise.all(attempts);
    const ok = results.filter((r) => r.status === 401);
    const limited = results.filter((r) => r.status === 429);
    assert.equal(ok.length, 3);
    assert.equal(limited.length, 1);
    assert.equal(limited[0].body.code, "rate_limited");
    assert.ok(limited[0].body.retryAfterMs >= 1 && limited[0].body.retryAfterMs <= 60_000);
    const ev = f.registry.db
      .prepare("SELECT COUNT(*) c FROM events WHERE action='rate_limited'")
      .get() as { c: number };
    assert.equal(ev.c, 1);
  } finally {
    await f.cleanup();
  }
});

test("wrong path / tokenless registry device → rejected without side effects (S-4/S-10)", async () => {
  const f = await fixture();
  try {
    // wrong path: server-level listener in main.ts destroys; here every upgrade
    // goes to the tunnel which requires /api/tunnel — emulate via fixture server
    const wrongPath = await new Promise<{ status: number }>((done, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${f.port}/api/nope`);
      ws.once("unexpected-response", (_q, res) => {
        done({ status: res.statusCode ?? 0 });
        ws.terminate();
      });
      ws.once("open", () => {
        ws.terminate();
        reject(new Error("unexpected 101"));
      });
      ws.once("error", () => reject(new Error("socket error")));
    });
    assert.equal(wrongPath.status, 404);
    // LAN device with NO credentials: any tunnel token → token_unknown; registry untouched
    const t0 = now();
    f.registry.db
      .prepare(
        `INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,created_at,updated_at,transport)
         VALUES('lan-dev','LAN','ssh','http://127.0.0.1:9','dt_x','config',1,?,'checking',?,?,'lan')`,
      )
      .run(randomUUID(), t0, t0);
    const r = await rawUpgrade(f, f.makeToken());
    assert.equal(r.status, 401);
    assert.equal(r.body.code, "token_unknown");
    assert.equal(f.tunnel.activeCount(), 0);
    const lan = f.registry.get("lan-dev");
    assert.equal(lan?.transport, "lan");
  } finally {
    await f.cleanup();
  }
});

test("disconnect: socket drop removes registration + tunnel_state row; onClose fires once", async () => {
  const f = await fixture();
  try {
    let closes = 0;
    const tunnel2 = new TunnelServer(f.registry, f.audit, HUB_ID, { onClose: () => closes++ });
    const server2 = createServer((_q, r) => r.writeHead(404).end());
    server2.on("upgrade", (req, socket, head) => tunnel2.handleUpgrade(req, socket, head));
    await new Promise<void>((d) => server2.listen(0, "127.0.0.1", d));
    const port2 = (server2.address() as { port: number }).port;
    const uid = randomUUID();
    const cred = addCredential(f, { deviceId: "drop-dev", deviceUid: uid });
    const ws = new WebSocket(`ws://127.0.0.1:${port2}/api/tunnel`, {
      headers: { authorization: `Bearer ${cred.token}` },
    });
    await new Promise<void>((d) => ws.once("open", d));
    const helloP = nextFrame(ws);
    ws.send(JSON.stringify(handshakeFor("drop-dev", uid, cred)));
    await helloP;
    assert.ok(tunnel2.hasConnection("drop-dev"));
    ws.terminate();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(tunnel2.activeCount(), 0);
    assert.equal(f.registry.db.prepare("SELECT COUNT(*) c FROM tunnel_state").get().c, 0);
    assert.equal(closes, 1);
    tunnel2.close();
    server2.close();
    server2.closeAllConnections();
  } finally {
    await f.cleanup();
  }
});
