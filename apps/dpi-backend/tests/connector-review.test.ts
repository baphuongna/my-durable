/**
 * Review 2026-10-20 regressions — backend connector (Cluster B).
 * F05 re-pair transitions a RUNNING connector; stale-epoch revoke never deletes the new file.
 * F06 stop() during an in-flight attempt settles; the connector restarts.
 * F07 tunnel subscriptions read the SUB-named loopback scope (allow-listed).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { DeviceConnector } from "../src/tunnel.js";
import { pairingPath, keypairPath, writeAtomic } from "../src/pairing-files.js";

const UID = "9f8e7d6c-5b4a-4c3d-2e1f-0a9b8c7d6e5f";
const HUB_ID = "1a2b3c4d-5e6f-4a5b-8c9d-0e1f2a3b4c5d";
const FINGERPRINT = `sha256:${"c".repeat(64)}`;
const TOKEN = "dpt_" + "T".repeat(43);
const EPOCH = "3c3c3c3c-1111-2222-3333-444444444444";
const CRED = "5d5d5d5d-6666-7777-8888-999999999999";
const EPOCH2 = "7e7e7e7e-8888-9999-aaaa-bbbbbbbbbbbb";
const CRED2 = "8f8f8f8f-9999-0000-1111-222222222222";

const until = async (fn: () => boolean | Promise<boolean>, timeout = 6000, what = "cond") => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error(`timeout waiting for ${what}`);
};

async function writeFiles(home: string, url: string, over: Record<string, unknown> = {}) {
  const p = {
    deviceUid: UID, deviceId: "dev-1", pairingEpoch: EPOCH, credentialId: CRED, generation: 1,
    hubOrigin: new URL(url).origin, hubUrl: url, hubId: HUB_ID, tunnelToken: TOKEN, ...over,
  };
  writeAtomic(pairingPath(home), JSON.stringify({ version: 1, ...p, updatedAt: Date.now(), operationId: "11111111-2222-3333-4444-555555555555" }));
  writeAtomic(keypairPath(home), JSON.stringify({ fingerprint: FINGERPRINT, publicKeyPem: "pub", privateKeyPem: "priv" }));
}

const fastHooks = () => ({
  intervals: { pingMs: 60, idleMs: 400, helloMs: 800 },
  sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, Math.min(ms, 40))),
});

interface ScriptedHub {
  url: string;
  handshakes: any[];
  send: (frame: unknown) => boolean;
  close: () => Promise<void>;
}

async function scriptedHub(hello = () => true, rateLimited = () => false): Promise<ScriptedHub> {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });
  const handshakes: any[] = [];
  let live: WebSocket | null = null;
  const server = createServer((_q, r) => r.writeHead(404).end());
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (rateLimited()) {
      const body = JSON.stringify({ type: "tunnel.auth-error", code: "rate_limited", retryAfterMs: 60_000 });
      socket.end(`HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      live = ws;
      ws.on("message", (d) => {
        const msg = JSON.parse(d.toString());
        if (msg.type === "pair-handshake") {
          handshakes.push(msg);
          if (hello())
            ws.send(JSON.stringify({ type: "hello", apiVersion: 1, tunnelProto: 1, hubId: HUB_ID, connectionId: "00000000-1111-2222-3333-444444444444", serverTime: Date.now() }));
        }
      });
      ws.on("close", () => {
        if (live === ws) live = null;
      });
    });
  });
  await new Promise<void>((d) => server.listen(0, "127.0.0.1", d));
  const port = (server.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}/api/tunnel`,
    handshakes,
    send: (frame) => {
      if (live?.readyState === WebSocket.OPEN) {
        live.send(JSON.stringify(frame));
        return true;
      }
      return false;
    },
    close: async () => {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((done) => server.close(() => done()));
      server.closeAllConnections();
    },
  };
}

test("F05 regression: re-pair while CONNECTED → connector adopts the new tuple; stale-epoch revoke notice keeps the new file", async () => {
  const home = await mkdtemp(join(tmpdir(), "dpi-f05-"));
  const hub = await scriptedHub();
  let c: DeviceConnector | undefined;
  try {
    await writeFiles(home, hub.url);
    // dispatch() requires a local API (production always wires one);
    // revoked-notice handling lives behind it.
    c = new DeviceConnector(home, undefined, fastHooks(), { baseUrl: "http://127.0.0.1:9", token: "unused" });
    c.start();
    await until(() => c!.status().state === "connected", 5000, "first connect");
    assert.equal(hub.handshakes.length, 1);

    // Re-pair: a NEW pairing file lands on disk while the connector runs.
    await writeFiles(home, hub.url, { pairingEpoch: EPOCH2, credentialId: CRED2, generation: 1, tunnelToken: "dpt_" + "N".repeat(43) });
    // The hub still fires the revoke notice for the OLD epoch on the live socket.
    const noticed = hub.send({
      type: "control", action: "revoked",
      notice: { type: "pair.revoke", v: 1, deviceId: "dev-1", pairingEpoch: EPOCH, reason: "user", revokedAt: Date.now() },
    });
    assert.ok(noticed, "notice delivered on the live socket");

    await until(() => hub.handshakes.length >= 2, 8000, "re-paired handshake with the NEW tuple");
    assert.equal(hub.handshakes[1].pairingEpoch, EPOCH2, "RAM tuple is the NEW epoch");
    assert.equal(hub.handshakes[1].credentialId, CRED2);
    await until(() => c!.status().state === "connected", 8000, "connected on the new pairing");
    // The NEW pairing file survived the stale-epoch notice.
    const disk = JSON.parse(await readFile(pairingPath(home), "utf8")) as { pairingEpoch: string };
    assert.equal(disk.pairingEpoch, EPOCH2, "stale-epoch revoke must NOT delete the newer pairing file");
    c!.stop("done");
  } finally {
    c?.stop("cleanup");
    await hub.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("F06 regression: stop() during an in-flight attempt settles; start() reconnects (no frozen loop)", async () => {
  const home = await mkdtemp(join(tmpdir(), "dpi-f06-"));
  const hub = await scriptedHub();
  let c: DeviceConnector | undefined;
  try {
    await writeFiles(home, hub.url);
    c = new DeviceConnector(home, undefined, fastHooks());
    c.start();
    await until(() => c!.status().state === "connected", 5000, "connect");
    const attemptsBefore = c!.status().attempts;
    assert.ok(attemptsBefore >= 1);
    // Stop while the attempt is IN FLIGHT (connected socket) — the case that
    // used to leave the attempt promise pending and loopRunning pinned.
    c.stop("operator stop");
    await until(() => c!.status().state === "stopped", 3000, "stopped");
    c.start();
    await until(() => c!.status().state === "connected", 8000, "reconnected after stop+start");
    assert.ok(c!.status().attempts > attemptsBefore, `attempts must grow after restart (before=${attemptsBefore}, after=${c.status().attempts})`);
    assert.ok(hub.handshakes.length >= 2, "a fresh handshake happened on the new attempt");
    c!.stop("done");
  } finally {
    c?.stop("cleanup");
    await hub.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("F06 follow-up: cancellation before hello permits immediate restart or re-pair", async (t) => {
  for (const transition of ["restart", "re-pair"] as const) {
    await t.test(transition, async () => {
      const home = await mkdtemp(join(tmpdir(), "dpi-f06-hello-"));
      let answerHello = false;
      const hub = await scriptedHub(() => answerHello);
      const c = new DeviceConnector(home, undefined, fastHooks());
      try {
        await writeFiles(home, hub.url);
        c.start();
        await until(() => hub.handshakes.length === 1, 3000, "handshake awaiting hello");
        answerHello = true;
        if (transition === "restart") {
          c.stop("cancel before hello");
          c.start(); // same tick: the cancelled loop still has to unwind
        } else {
          await writeFiles(home, hub.url, { pairingEpoch: EPOCH2, credentialId: CRED2 });
          c.reload("re-pair before hello");
        }
        await until(() => c.status().state === "connected", 3000, "fresh handshake after cancellation");
        assert.equal(hub.handshakes.length, 2);
        assert.equal(hub.handshakes[1].pairingEpoch, transition === "restart" ? EPOCH : EPOCH2);
        assert.equal(c.status().hellos, 1, "only the replacement attempt received hello");
      } finally {
        c.stop("cleanup");
        await hub.close();
        await rm(home, { recursive: true, force: true });
      }
    });
  }
});

test("R10: stop/re-pair cancels an old 60-second backoff without waiting for its clock", async (t) => {
  for (const transition of ["restart", "cross-hub re-pair"] as const) {
    await t.test(transition, async () => {
      const home = await mkdtemp(join(tmpdir(), "dpi-r10-"));
      let limited = true;
      const oldHub = await scriptedHub(() => true, () => limited);
      const nextHub = transition === "restart" ? oldHub : await scriptedHub();
      const delays: number[] = [];
      const releaseClocks: Array<() => void> = [];
      const connector = new DeviceConnector(home, undefined, {
        sleep: (ms) => {
          delays.push(ms);
          return new Promise<void>((resolve) => releaseClocks.push(resolve));
        },
      });
      try {
        await writeFiles(home, oldHub.url);
        connector.start();
        await until(() => delays.length === 1, 2000, "real 429 backoff");
        assert.deepEqual(delays, [60_000]);
        if (transition === "restart") {
          limited = false;
          connector.stop("operator restart during backoff");
          connector.start();
        } else {
          await writeFiles(home, nextHub.url, { pairingEpoch: EPOCH2, credentialId: CRED2 });
          connector.reload("approved cross-hub pairing");
        }
        await until(() => connector.status().state === "connected", 1500, "replacement connection before old sleep resolves");
        assert.equal(nextHub.handshakes.length, 1);
        assert.equal(nextHub.handshakes[0].pairingEpoch, transition === "restart" ? EPOCH : EPOCH2);
        assert.equal(connector.status().attempts, 2);
        for (const release of releaseClocks) release();
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(connector.status().state, "connected", "late old clock completion cannot restart or overwrite the replacement loop");
        assert.equal(connector.status().attempts, 2);
        assert.equal(nextHub.handshakes.length, 1);
      } finally {
        connector.stop("cleanup");
        for (const release of releaseClocks) release();
        await oldHub.close();
        if (nextHub !== oldHub) await nextHub.close();
        await rm(home, { recursive: true, force: true });
      }
    });
  }
});

test("F07 regression: subscription reads the SUB-named scope; off-allowlist paths are refused", async () => {
  const home = await mkdtemp(join(tmpdir(), "dpi-f07-"));
  const hub = await scriptedHub();
  const seen: string[] = [];
  const local = createServer((req, res) => {
    seen.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(": ok\n\n");
    // keep the stream open; the connector aborts it on teardown
  });
  await new Promise<void>((d) => local.listen(0, "127.0.0.1", d));
  const localPort = (local.address() as { port: number }).port;
  let c: DeviceConnector | undefined;
  try {
    await writeFiles(home, hub.url);
    c = new DeviceConnector(home, undefined, fastHooks(), { baseUrl: `http://127.0.0.1:${localPort}`, token: "local-token" });
    c.start();
    await until(() => c!.status().state === "connected", 5000, "connect");

    assert.ok(hub.send({ type: "control", action: "subscribe", subscriptionId: "11111111-1111-1111-1111-111111111111", sub: "/v1/sessions/s1/agents/a1/events?docs=state" }));
    await until(() => seen.some((s) => s.startsWith("/v1/sessions/s1/agents/a1/events")), 5000, "agent-scoped SSE fetched");
    assert.equal(seen[seen.length - 1], "/v1/sessions/s1/agents/a1/events?docs=state", "exact scope + query, not /v1/events");

    // Off-allowlist: a hub asking for a REST/pairing path gets NO reader.
    const before = seen.length;
    assert.ok(hub.send({ type: "control", action: "subscribe", subscriptionId: "22222222-2222-2222-2222-222222222222", sub: "/v1/pairing" }));
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(seen.length, before, "deny-listed sub path must not be fetched");
    c!.stop("done");
  } finally {
    c?.stop("cleanup");
    await hub.close();
    local.close();
    local.closeAllConnections();
    await rm(home, { recursive: true, force: true });
  }
});
