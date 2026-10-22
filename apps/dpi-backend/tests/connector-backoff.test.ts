/**
 * T-1 — the connector's reconnect policy, asserted on the exact delays it asks its clock for.
 * The sleep hook records each requested delay and returns at once, so the real defaults
 * (1 → 2 → 4 → 8 → 15 → 15 s) are checked without waiting through them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { DeviceConnector, type ConnectorStatus } from "../src/tunnel.js";
import { pairingPath } from "../src/pairing-files.js";
import { HUB_ID, pairedHome, pause, until } from "./connector-rig.js";

type Step = "drop" | "bad-gateway" | "silent" | "token-unknown" | "bare-401" | "revoked" | "rate-limited" | "hello-then-close";

const authError = (code: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "tunnel.auth-error", v: 1, code, message: code, ...extra });

/** A hub that answers the Nth upgrade with `steps[N]` (the last step repeats). */
async function scriptedHub(steps: Step[]) {
  const wss = new WebSocketServer({ noServer: true });
  const served: Step[] = [];
  const server = createServer((_q, r) => r.writeHead(404).end());
  const reply = (socket: Duplex, line: string, body = "") =>
    socket.end(`HTTP/1.1 ${line}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  server.on("upgrade", (req, socket, head) => {
    const step = steps[Math.min(served.length, steps.length - 1)];
    served.push(step);
    switch (step) {
      case "drop":
        socket.destroy();
        return;
      case "bad-gateway":
        return reply(socket, "502 Bad Gateway");
      case "bare-401":
        return reply(socket, "401 Unauthorized");
      case "token-unknown":
        return reply(socket, "401 Unauthorized", authError("token_unknown"));
      case "revoked":
        return reply(socket, "401 Unauthorized", authError("revoked"));
      case "rate-limited":
        return reply(socket, "429 Too Many Requests", authError("rate_limited", { retryAfterMs: 5_000 }));
      case "silent":
        wss.handleUpgrade(req, socket, head, (ws) => ws.on("error", () => {}));
        return;
      case "hello-then-close":
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.on("error", () => {});
          ws.on("message", () => {
            ws.send(JSON.stringify({ type: "hello", apiVersion: 1, tunnelProto: 1, hubId: HUB_ID, connectionId: "00000000-1111-2222-3333-444444444444", serverTime: Date.now() }));
            setTimeout(() => ws.close(1011, "hub restarting"), 10);
          });
        });
        return;
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/tunnel`;
  return {
    url,
    served,
    async close() {
      for (const c of wss.clients) c.terminate();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

/** Run a connector against the script until `enough`; returns what it asked its clock for. */
async function scenario(steps: Step[], enough: (delays: number[], c: DeviceConnector) => boolean) {
  const hub = await scriptedHub(steps);
  const home = await pairedHome(hub.url);
  const delays: number[] = [];
  const statuses: ConnectorStatus[] = [];
  const connector = new DeviceConnector(home, undefined, {
    intervals: { helloMs: 250, pingMs: 60_000, idleMs: 60_000 },
    sleep: async (ms) => {
      delays.push(ms);
      await pause(2);
    },
    onStatus: (s) => statuses.push(s),
  });
  connector.start();
  try {
    await until(() => enough(delays, connector), 15_000, "scripted outcome");
    const seen = { delays: delays.slice(), state: connector.status().state, pairingKept: existsSync(pairingPath(home)), attempts: hub.served.length };
    return seen;
  } finally {
    connector.stop("test done");
    await hub.close();
    await rm(home, { recursive: true, force: true });
  }
}

const CHAIN = [1000, 2000, 4000, 8000, 15000, 15000, 15000, 15000];

test("T-1: consecutive transport failures wait 1 → 2 → 4 → 8 → 15 → 15 s", async () => {
  const seen = await scenario(["drop"], (d) => d.length >= CHAIN.length);
  assert.deepEqual(seen.delays.slice(0, CHAIN.length), CHAIN);
});

test("T-1: HTTP 502, a missing hello and a dropped socket all advance the same chain", async () => {
  const seen = await scenario(["bad-gateway", "silent", "drop", "bad-gateway"], (d) => d.length >= 4);
  assert.deepEqual(seen.delays.slice(0, 4), [1000, 2000, 4000, 8000]);
});

test("T-1: a valid hello resets the chain to 1 s", async () => {
  const steps: Step[] = ["drop", "drop", "drop", "drop", "drop", "hello-then-close", "drop"];
  const seen = await scenario(steps, (d) => d.length >= 8);
  assert.deepEqual(seen.delays.slice(0, 8), [1000, 2000, 4000, 8000, 15000, 1000, 2000, 4000]);
});

test("T-1: a hub that keeps answering hello and then closing is retried at 1 s, never slower", async () => {
  const seen = await scenario(["hello-then-close"], (d) => d.length >= 4);
  assert.deepEqual(seen.delays.slice(0, 4), [1000, 1000, 1000, 1000]);
});

test("T-1: token_unknown is not terminal and backs off on the same chain, with the pairing kept", async () => {
  const seen = await scenario(["token-unknown"], (d) => d.length >= CHAIN.length);
  assert.deepEqual(seen.delays.slice(0, CHAIN.length), CHAIN);
  assert.equal(seen.state, "reauth");
  assert.equal(seen.pairingKept, true);
});

test("T-1: a 429 waits the hub's advice and leaves the chain where it was", async () => {
  const seen = await scenario(["drop", "rate-limited", "drop", "drop"], (d) => d.length >= 4);
  assert.deepEqual(seen.delays.slice(0, 4), [1000, 5000, 2000, 4000]);
});

test("T-1: a bare 401 backs off on the same chain", async () => {
  const seen = await scenario(["bare-401"], (d) => d.length >= 5);
  assert.deepEqual(seen.delays.slice(0, 5), [1000, 2000, 4000, 8000, 15000]);
});

test("T-1: revoked for the current credential is terminal: one attempt, no wait, pairing removed", async () => {
  const seen = await scenario(["revoked"], (_d, c) => c.status().state === "revoked");
  assert.deepEqual(seen.delays, []);
  assert.equal(seen.attempts, 1);
  assert.equal(seen.pairingKept, false);
});

test("T-1: after reauth, a hello resets the chain", async () => {
  const seen = await scenario(["token-unknown", "token-unknown", "token-unknown", "hello-then-close", "token-unknown"], (d) => d.length >= 6);
  assert.deepEqual(seen.delays.slice(0, 6), [1000, 2000, 4000, 1000, 2000, 4000]);
});
