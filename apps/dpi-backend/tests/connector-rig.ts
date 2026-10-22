/**
 * Shared rig for connector tests: a fake hub (real WebSocket server, scripted by the test), a loopback
 * "device API" the test controls, and a DeviceConnector wired to both through the real pairing files.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { DeviceConnector, type ConnectorStatus } from "../src/tunnel.js";
import { pairingPath, keypairPath, writeAtomic } from "../src/pairing-files.js";

export const UID = "9f8e7d6c-5b4a-4c3d-2e1f-0a9b8c7d6e5f";
export const HUB_ID = "1a2b3c4d-5e6f-4a5b-8c9d-0e1f2a3b4c5d";
export const TOKEN = "dpt_" + "T".repeat(43);
export const SUB_ID = "11111111-1111-1111-1111-111111111111";
export const REQ_ID = "22222222-2222-2222-2222-222222222222";
export const MIB = 1024 * 1024;

export const until = async (fn: () => boolean, timeout = 6000, what = "condition") => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timeout waiting for ${what}`);
};
export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Hub {
  url: string;
  handshakes: unknown[];
  frames: any[];
  closes: { code: number; reason: string }[];
  send(frame: unknown): boolean;
  stopReading(): void;
  resumeReading(): void;
  close(): Promise<void>;
}

export async function hubServer(): Promise<Hub> {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });
  const handshakes: unknown[] = [];
  const frames: any[] = [];
  const closes: { code: number; reason: string }[] = [];
  let live: WebSocket | null = null;
  const server = createServer((_q, r) => r.writeHead(404).end());
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      live = ws;
      ws.on("error", () => {});
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "pair-handshake") {
          handshakes.push(msg);
          ws.send(JSON.stringify({ type: "hello", apiVersion: 1, tunnelProto: 1, hubId: HUB_ID, connectionId: "00000000-1111-2222-3333-444444444444", serverTime: Date.now() }));
        } else frames.push(msg);
      });
      ws.on("close", (code, reason) => {
        closes.push({ code, reason: reason.toString() });
        if (live === ws) live = null;
      });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const socketOf = () => (live as unknown as { _socket?: import("node:net").Socket } | null)?._socket;
  return {
    url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/tunnel`,
    handshakes,
    frames,
    closes,
    send(frame) {
      if (live?.readyState !== WebSocket.OPEN) return false;
      live.send(JSON.stringify(frame));
      return true;
    },
    // A hub whose application stopped reading: TCP backpressure builds toward the connector.
    stopReading: () => socketOf()?.pause(),
    resumeReading: () => socketOf()?.resume(),
    async close() {
      socketOf()?.resume();
      for (const c of wss.clients) c.terminate();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

export interface LocalApi {
  baseUrl: string;
  /** Bytes the loopback API managed to write before the connector hung up on it. */
  written: number;
  hungUp: boolean;
  close(): Promise<void>;
}

export async function localApi(handler: (req: IncomingMessage, res: ServerResponse, api: LocalApi) => void): Promise<LocalApi> {
  let server!: Server;
  const api: LocalApi = {
    baseUrl: "",
    written: 0,
    hungUp: false,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
  server = createServer((req, res) => {
    res.on("close", () => {
      api.hungUp = true;
    });
    handler(req, res, api);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  api.baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return api;
}

export interface Rig {
  connector: DeviceConnector;
  hub: Hub;
  api: LocalApi;
  statuses: ConnectorStatus[];
  /** Highest `bufferedAmount` observed right after any send on the current socket. */
  peak(): number;
  cleanup(): Promise<void>;
}

/** A temp DPI home holding the pairing.json and device keypair a paired device would have. */
export async function pairedHome(hubUrl: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "dpi-ga08-"));
  writeAtomic(
    pairingPath(home),
    JSON.stringify({
      version: 1, deviceUid: UID, deviceId: "dev-1", pairingEpoch: "3c3c3c3c-1111-2222-3333-444444444444",
      credentialId: "5d5d5d5d-6666-7777-8888-999999999999", generation: 1, hubOrigin: new URL(hubUrl).origin,
      hubUrl, hubId: HUB_ID, tunnelToken: TOKEN, updatedAt: Date.now(),
      operationId: "11111111-2222-3333-4444-555555555555",
    }),
  );
  writeAtomic(keypairPath(home), JSON.stringify({ fingerprint: `sha256:${"c".repeat(64)}`, publicKeyPem: "pub", privateKeyPem: "priv" }));
  return home;
}

export async function rig(
  handler: Parameters<typeof localApi>[0],
  intervals: { drainMs?: number } = {},
): Promise<Rig> {
  const hub = await hubServer();
  const home = await pairedHome(hub.url);
  const api = await localApi(handler);
  const statuses: ConnectorStatus[] = [];
  const connector = new DeviceConnector(
    home,
    undefined,
    {
      // Long heartbeat/idle so only the behaviour under test can end the connection.
      intervals: { pingMs: 60_000, idleMs: 60_000, helloMs: 2_000, ...intervals } as never,
      sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, Math.min(ms, 40))),
      onStatus: (s) => statuses.push(s),
    },
    { baseUrl: api.baseUrl, token: "local-token" },
  );
  connector.start();
  await until(() => connector.status().state === "connected", 5000, "connector connected");
  let max = 0;
  const watched = new WeakSet<object>();
  const watch = () => {
    const ws = (connector as unknown as { ws: WebSocket | null }).ws;
    if (!ws || watched.has(ws)) return;
    watched.add(ws);
    const original = ws.send.bind(ws) as (...a: unknown[]) => void;
    (ws as unknown as { send: (...a: unknown[]) => void }).send = (...args) => {
      original(...args);
      max = Math.max(max, ws.bufferedAmount);
    };
  };
  watch();
  return {
    connector,
    hub,
    api,
    statuses,
    peak: () => (watch(), max),
    async cleanup() {
      connector.stop("test done");
      await hub.close();
      await api.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
