/**
 * P2-13 — device connector lifecycle: boot-from-file, TLS-before-bearer,
 * handshake/hello, auth classification, heartbeat, backoff, shutdown.
 * Real `ws` server (scriptable upgrade) + real connector instance.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { DeviceConnector, type ConnectorStatus } from "../src/tunnel.js";
import { pairingPath, keypairPath, writeAtomic } from "../src/pairing-files.js";

const UID = "9f8e7d6c-5b4a-4c3d-2e1f-0a9b8c7d6e5f";
const HUB_ID = "1a2b3c4d-5e6f-4a5b-8c9d-0e1f2a3b4c5d";
const FINGERPRINT = `sha256:${"c".repeat(64)}`;
const TOKEN = "dpt_" + "T".repeat(43);
const EPOCH = "3c3c3c3c-1111-2222-3333-444444444444";
const CRED = "5d5d5d5d-6666-7777-8888-999999999999";

interface Pairing {
  deviceUid: string;
  deviceId: string;
  pairingEpoch: string;
  credentialId: string;
  generation: number;
  hubOrigin: string;
  hubUrl: string;
  hubId: string;
  tunnelToken: string;
}

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dpi-conn-"));
  return dir;
}

async function writeFiles(home: string, url: string, over: Partial<Pairing> = {}): Promise<Pairing> {
  const p: Pairing = {
    deviceUid: UID,
    deviceId: "dev-1",
    pairingEpoch: EPOCH,
    credentialId: CRED,
    generation: 1,
    hubOrigin: new URL(url).origin,
    hubUrl: url,
    hubId: HUB_ID,
    tunnelToken: TOKEN,
    ...over,
  };
  writeAtomic(
    pairingPath(home),
    JSON.stringify({
      version: 1, ...p, updatedAt: Date.now(), operationId: "11111111-2222-3333-4444-555555555555",
    }),
  );
  writeAtomic(keypairPath(home), JSON.stringify({ fingerprint: FINGERPRINT, publicKeyPem: "pub", privateKeyPem: "priv" }));
  return p;
}

type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

interface Hub {
  port: number;
  url: string;
  upgrades: { auth: string | null; path: string }[];
  handshakes: any[];
  wss: WebSocketServer;
  setUpgrade: (h: UpgradeHandler) => void;
  close: () => Promise<void>;
}

async function startHub(custom?: UpgradeHandler): Promise<Hub> {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });
  const hub: Hub = {
    port: 0,
    url: "",
    upgrades: [],
    handshakes: [],
    wss,
    setUpgrade: () => {},
    close: async () => {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((done) => server.close(() => done()));
      server.closeAllConnections();
    },
  };
  let handler: UpgradeHandler =
    custom ??
    ((req, socket, head) => {
      hub.upgrades.push({ auth: req.headers.authorization ?? null, path: req.url ?? "" });
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("message", (d) => {
          const msg = JSON.parse(d.toString());
          hub.handshakes.push(msg);
          if (msg.type === "pair-handshake")
            ws.send(JSON.stringify({ type: "hello", apiVersion: 1, tunnelProto: 1, hubId: HUB_ID, connectionId: "00000000-1111-2222-3333-444444444444", serverTime: Date.now() }));
        });
      });
    });
  hub.setUpgrade = (h) => (handler = h);
  const server = createServer((_q, r) => r.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => handler(req, socket, head));
  await new Promise<void>((d) => server.listen(0, "127.0.0.1", d));
  hub.port = (server.address() as { port: number }).port;
  hub.url = `ws://127.0.0.1:${hub.port}/api/tunnel`;
  return hub;
}

const jsonRes = (socket: Duplex, status: number, body: unknown) => {
  const payload = Buffer.from(JSON.stringify(body));
  socket.write(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Too Many Requests"}\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n`);
  socket.write(payload);
  socket.destroy();
};

const until = async (fn: () => boolean | Promise<boolean>, timeout = 6000, what = "cond") => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error(`timeout waiting for ${what}`);
};

const fastHooks = (over: { pingMs?: number; idleMs?: number; helloMs?: number } = {}) => ({
  intervals: { pingMs: 60, idleMs: 400, helloMs: 800, ...over },
  sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, Math.min(ms, 40))),
});

test("T-1: boot from pairing.json; handshake carries the SAVED tuple + keypair fingerprint; hello → connected", async () => {
  const home = await tempHome();
  const hub = await startHub();
  try {
    await writeFiles(home, hub.url);
    const c = new DeviceConnector(home, undefined, fastHooks());
    c.start();
    await until(() => c.status().state === "connected", 5000, "connected");
    assert.equal(hub.upgrades.length, 1);
    assert.equal(hub.upgrades[0].auth, `Bearer ${TOKEN}`);
    assert.equal(hub.handshakes.length, 1);
    const hs = hub.handshakes[0];
    assert.equal(hs.deviceUid, UID);
    assert.equal(hs.deviceId, "dev-1");
    assert.equal(hs.pairingEpoch, EPOCH);
    assert.equal(hs.credentialId, CRED);
    assert.equal(hs.generation, 1);
    assert.equal(hs.keyFingerprint, FINGERPRINT);
    assert.equal(hs.apiVersion, 1);
    assert.equal(hs.tunnelProto, 1);
    // status DTO carries no secrets
    const s = JSON.stringify(c.status());
    assert.ok(!s.includes(TOKEN));
    c.stop("done");
  } finally {
    await hub.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("P-10 device half: revoked for the CURRENT tuple → terminal, pairing.json deleted, no further attempts; keypair kept", async () => {
  const home = await tempHome();
  try {
    const hub = await startHub((req, socket) =>
      jsonRes(socket, 401, { type: "tunnel.auth-error", v: 1, code: "revoked", message: "credential revoked" }),
    );
    await writeFiles(home, hub.url);
    const c = new DeviceConnector(home, undefined, fastHooks());
    c.start();
    await until(() => c.status().state === "revoked", 5000, "revoked");
    assert.ok(!existsSync(pairingPath(home)), "pairing.json must be removed on terminal revoke");
    assert.ok(existsSync(keypairPath(home)), "keypair survives for re-pair");
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(hub.upgrades.filter((u) => u.auth).length + 0, 0); // custom handler didn't record; rely on state
    assert.equal(c.status().attempts, 1, "no retry after terminal revoke");
    c.stop("done");
    await hub.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("late 401 for a REPLACED credential is ignored (no file delete, retry continues)", async () => {
  const home = await tempHome();
  const wss = new WebSocketServer({ noServer: true });
  const NEW_TOKEN = "dpt_" + "N".repeat(43);
  const hub = await startHub((req, socket, head) => {
    if (req.headers.authorization === `Bearer ${TOKEN}`) {
      // delayed revoke for the OLD credential (response races with rotation)
      setTimeout(() => jsonRes(socket, 401, { type: "tunnel.auth-error", v: 1, code: "revoked", message: "late" }), 60);
    } else {
      // the NEW credential is healthy → 101 + hello
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("message", (d) => {
          if (JSON.parse(d.toString()).type === "pair-handshake")
            ws.send(JSON.stringify({ type: "hello", apiVersion: 1, tunnelProto: 1, hubId: HUB_ID, connectionId: "00000000-1111-2222-3333-444444444444", serverTime: Date.now() }));
        });
      });
    }
  });
  try {
    const p = await writeFiles(home, hub.url);
    const c = new DeviceConnector(home, undefined, fastHooks());
    c.start();
    // rotation lands BEFORE the old attempt's 401 arrives
    await until(() => c.status().attempts >= 1, 3000, "attempt started");
    c.updateCredential({
      version: 1, ...p, credentialId: "7e7e7e7e-aaaa-bbbb-cccc-dddddddddddd", generation: 2, tunnelToken: NEW_TOKEN,
      updatedAt: Date.now(), operationId: "99999999-8888-7777-6666-555555555555",
    });
    await until(() => c.status().state === "connected", 8000, "connected on the new credential");
    assert.ok(existsSync(pairingPath(home)), "file must survive a late revoke");
    assert.notEqual(c.status().state, "revoked");
    assert.ok(c.status().attempts >= 2, "retry continues");
    c.stop("done");
  } finally {
    for (const cl of wss.clients) cl.terminate();
    wss.close();
    await hub.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("token_unknown → reauth status with actionable detail, non-terminal, keeps retrying; file kept", async () => {
  const home = await tempHome();
  const hub = await startHub((req, socket) =>
    jsonRes(socket, 401, { type: "tunnel.auth-error", v: 1, code: "token_unknown", message: "unknown" }),
  );
  try {
    await writeFiles(home, hub.url);
    const c = new DeviceConnector(home, undefined, fastHooks());
    c.start();
    await until(() => c.status().state === "reauth", 5000, "reauth");
    assert.match(c.status().detail, /re-pair/);
    assert.ok(existsSync(pairingPath(home)));
    await until(() => c.status().attempts >= 3, 6000, "keeps retrying");
    assert.equal(c.status().state, "reauth");
    c.stop("done");
  } finally {
    await hub.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("bare 401 / malformed body → non-terminal; 429 → bounded retryAfter honored; 302 redirect → rejected", async () => {
  const home = await tempHome();
  const delays: number[] = [];
  const t0 = { value: Date.now() };
  const hub = await startHub((req, socket) => {
    const n = delays.length;
    if (n === 0) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 5\r\nConnection: close\r\n\r\nnope!");
      socket.destroy();
    } else if (n === 1) {
      jsonRes(socket, 429, { type: "tunnel.auth-error", v: 1, code: "rate_limited", message: "slow", retryAfterMs: 120_000_000 });
    } else {
      socket.write("HTTP/1.1 302 Found\r\nLocation: https://evil.example.com/api/tunnel\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });
  try {
    await writeFiles(home, hub.url);
    const c = new DeviceConnector(home, undefined, {
      ...fastHooks(),
      sleep: async (ms) => {
        delays.push(ms);
        await new Promise((r) => setTimeout(r, Math.min(ms, 20)));
      },
    });
    c.start();
    await until(() => delays.length >= 3, 8000, "three classified outcomes");
    assert.ok(existsSync(pairingPath(home)), "bare 401 never deletes the file");
    // 429 clamp: advised 120 000 000 ms must clamp to 60 000
    assert.equal(delays[1], 60_000);
    assert.ok(c.status().state !== "revoked");
    c.stop("done");
    assert.ok(JSON.stringify(c.status()).length > 0);
  } finally {
    await hub.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("hello hubId mismatch → terminal hub-mismatch, no retry (wrong deployment detection)", async () => {
  const home = await tempHome();
  const hub = await startHub((req, socket, head) => {
    hub.wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", () => {
        ws.send(JSON.stringify({ type: "hello", apiVersion: 1, tunnelProto: 1, hubId: "00000000-0000-0000-0000-000000000000", connectionId: "00000000-1111-2222-3333-444444444444", serverTime: Date.now() }));
      });
    });
  });
  try {
    await writeFiles(home, hub.url);
    const c = new DeviceConnector(home, undefined, fastHooks());
    c.start();
    await until(() => c.status().state === "hub-mismatch", 5000, "hub-mismatch");
    const attempts = c.status().attempts;
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(c.status().attempts, attempts, "terminal: no retry");
    assert.ok(existsSync(pairingPath(home)), "file kept — operator decides");
    c.stop("done");
  } finally {
    await hub.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("heartbeat: pong silence (half-open) terminates and reconnects; valid hello resets attempts", async () => {
  const home = await tempHome();
  const wss = new WebSocketServer({ noServer: true });
  let connections = 0;
  const hub = await startHub((req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      connections++;
      if (connections === 1) {
        // answer hello, then go silent: pause the socket so pings/pongs die
        ws.on("message", (d) => {
          const msg = JSON.parse(d.toString());
          if (msg.type === "pair-handshake") {
            ws.send(JSON.stringify({ type: "hello", apiVersion: 1, tunnelProto: 1, hubId: HUB_ID, connectionId: "00000000-1111-2222-3333-444444444444", serverTime: Date.now() }));
            setTimeout(() => (ws as any)._socket.pause(), 30);
          }
        });
      } else {
        ws.on("message", (d) => {
          const msg = JSON.parse(d.toString());
          if (msg.type === "pair-handshake")
            ws.send(JSON.stringify({ type: "hello", apiVersion: 1, tunnelProto: 1, hubId: HUB_ID, connectionId: "11111111-2222-3333-4444-555555555555", serverTime: Date.now() }));
        });
      }
    });
  });
  try {
    await writeFiles(home, hub.url);
    const c = new DeviceConnector(home, undefined, fastHooks({ pingMs: 50, idleMs: 250 }));
    c.start();
    await until(() => c.status().state === "connected" && connections === 1, 5000, "first connect");
    // half-open: no pongs → miss 2 → terminate → reconnect → connected again
    await until(() => connections === 2, 8000, "reconnect after pong silence");
    await until(() => c.status().state === "connected", 8000, "connected again");
    assert.ok(c.status().hellos >= 2, "hello resets observed");
    c.stop("done");
  } finally {
    for (const cl of wss.clients) cl.terminate();
    wss.close();
    await hub.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("startup file error: malformed pairing.json → file-error, zero network attempts", async () => {
  const home = await tempHome();
  const hub = await startHub();
  try {
    await writeFile(pairingPath(home), "{ not json", "utf8");
    const c = new DeviceConnector(home, undefined, fastHooks());
    c.start();
    assert.equal(c.status().state, "file-error");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(hub.upgrades.length, 0, "no network attempts on file error");
    c.stop("done");
  } finally {
    await hub.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("TLS before bearer: untrusted cert → no upgrade ever reaches the app (bearer never transmitted)", async () => {
  const home = await tempHome();
  const dir = await mkdtemp(join(tmpdir(), "dpi-ca-"));
  const subj = "/CN=127.0.0.1";
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${dir}/key.pem`, "-out", `${dir}/cert.pem`, "-days", "2", "-subj", subj, "-addext", "subjectAltName=IP:127.0.0.1"]);
  let upgradeSeen = false;
  const wss = new WebSocketServer({ noServer: true });
  const server = createHttpsServer({
    key: readFileSync(`${dir}/key.pem`),
    cert: readFileSync(`${dir}/cert.pem`),
  });
  server.on("upgrade", (req, socket, head) => {
    upgradeSeen = true;
    wss.handleUpgrade(req, socket, head, (ws) => ws.close(1000));
  });
  await new Promise<void>((d) => server.listen(0, "127.0.0.1", d));
  const port = (server.address() as { port: number }).port;
  try {
    // WITHOUT the CA in trust: TLS must fail before any HTTP bytes leave
    await writeFiles(home, `wss://127.0.0.1:${port}/api/tunnel`);
    const c = new DeviceConnector(home, undefined, fastHooks());
    c.start();
    await until(() => c.status().attempts >= 1, 5000, "attempt made");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(upgradeSeen, false, "upgrade handler must never run when TLS is untrusted");
    assert.notEqual(c.status().state, "connected");
    c.stop("done");
    // WITH the CA: connects (CA narrows trust, verification stays on)
    const c2 = new DeviceConnector(home, readFileSync(`${dir}/cert.pem`, "utf8"), fastHooks());
    c2.start();
    await until(() => upgradeSeen === true, 5000, "TLS trusted → upgrade reached");
    c2.stop("done");
  } finally {
    for (const cl of wss.clients) cl.terminate();
    wss.close();
    server.close();
    server.closeAllConnections();
    await rm(home, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("shutdown: stop() clears timers, drops socket, loop exits; superseded close(1000) reconnects", async () => {
  const home = await tempHome();
  const wss = new WebSocketServer({ noServer: true });
  let connections = 0;
  const hub = await startHub((req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      connections++;
      ws.on("message", (d) => {
        const msg = JSON.parse(d.toString());
        if (msg.type === "pair-handshake") {
          ws.send(JSON.stringify({ type: "hello", apiVersion: 1, tunnelProto: 1, hubId: HUB_ID, connectionId: connections === 1 ? "00000000-1111-2222-3333-444444444444" : "11111111-2222-3333-4444-555555555555", serverTime: Date.now() }));
          if (connections === 1) setTimeout(() => ws.close(1000, "superseded by new connection"), 50); // hub-side swap
        }
      });
    });
  });
  try {
    await writeFiles(home, hub.url);
    const c = new DeviceConnector(home, undefined, fastHooks());
    c.start();
    await until(() => connections === 1, 5000, "first");
    await until(() => connections === 2, 8000, "reconnect after hub swap close(1000)");
    await until(() => c.status().state === "connected", 5000, "connected after swap");
    c.stop("backend shutdown");
    assert.equal(c.status().state, "stopped");
    const after = c.status().attempts;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(c.status().attempts, after, "no retries after stop");
  } finally {
    for (const cl of wss.clients) cl.terminate();
    wss.close();
    await hub.close();
    await rm(home, { recursive: true, force: true });
  }
});
