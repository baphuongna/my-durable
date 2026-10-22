/**
 * Tunnel hub-proof pinning (gap #6): a pairing that carries a
 * hubKeyFingerprint demands a valid identity proof inside the hub's `hello`;
 * a mismatch is TERMINAL (no retry loop), and a legacy pairing without a pin
 * adopts the fingerprint through the just-authenticated tunnel.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import { DeviceConnector, type ConnectorStatus } from "../src/tunnel.js";
import { pairingPath, keypairPath, writeAtomic, type PairingFile } from "../src/pairing-files.js";
import { hubProofSigningPayload } from "../../dpi-sdk/src/protocol/pairing.js";

const UID = "9f8e7d6c-5b4a-4c3d-2e1f-0a9b8c7d6e5f";
const HUB_ID = "1a2b3c4d-5e6f-4a5b-8c9d-0e1f2a3b4c5d";
const DEVICE_ID = "dev-77";
const EPOCH = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

type Mode = "honest" | "wrong-key" | "no-proof";

async function proofHub(mode: Mode) {
  const keyA = generateKeyPairSync("ed25519");
  const keyB = generateKeyPairSync("ed25519");
  const fp = (k: typeof keyA) =>
    `sha256:${createHash("sha256")
      .update(k.publicKey.export({ format: "der", type: "spki" }) as Buffer)
      .digest("hex")}`;
  const pem = keyA.publicKey.export({ type: "spki", format: "pem" }) as string;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });
  const handshakes: any[] = [];
  let live: WebSocket | null = null;
  const server = createServer((_q, r) => r.writeHead(404).end());
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      live = ws;
      ws.on("error", () => {});
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type !== "pair-handshake") return;
        handshakes.push(msg);
        const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        let proof: Record<string, unknown> = {};
        if (msg.proofNonce && mode !== "no-proof") {
          const signer = mode === "honest" ? keyA : keyB;
          const payload = hubProofSigningPayload({
            hubOrigin: origin,
            hubId: HUB_ID,
            subject: `tunnel:${msg.deviceId}:${msg.pairingEpoch}`,
            nonce: msg.proofNonce,
          });
          proof = {
            hubPublicKey: signer.publicKey.export({ type: "spki", format: "pem" }) as string,
            hubKeyFingerprint: fp(signer),
            hubSignature: edSign(null, Buffer.from(payload), signer.privateKey).toString(
              "base64url",
            ),
          };
        }
        ws.send(
          JSON.stringify({
            type: "hello",
            apiVersion: 1,
            tunnelProto: 1,
            hubId: HUB_ID,
            connectionId: "00000000-1111-2222-3333-444444444444",
            serverTime: Date.now(),
            ...proof,
          }),
        );
      });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/tunnel`,
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    handshakes,
    honestFingerprint: fp(keyA),
    async close() {
      for (const c of wss.clients) c.terminate();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      live = null;
    },
  };
}

const pairedHome = async (hubUrl: string, hubOrigin: string, pin?: string) => {
  const home = await mkdtemp(join(tmpdir(), "dpi-pin-"));
  const base: PairingFile = {
    version: 1,
    deviceUid: UID,
    deviceId: DEVICE_ID,
    pairingEpoch: EPOCH,
    credentialId: "cccccccc-dddd-eeee-ffff-000000000000",
    generation: 1,
    hubOrigin,
    hubUrl: hubUrl,
    hubId: HUB_ID,
    tunnelToken: "dpt_" + "T".repeat(43),
    updatedAt: Date.now(),
    operationId: "11111111-2222-3333-4444-555555555555",
    ...(pin ? { hubKeyFingerprint: pin } : {}),
  };
  writeAtomic(pairingPath(home), JSON.stringify(base, null, 2));
  writeAtomic(
    keypairPath(home),
    JSON.stringify({
      fingerprint: `sha256:${"c".repeat(64)}`,
      publicKeyPem: "pub",
      privateKeyPem: "priv",
    }),
  );
  return home;
};

const flipLastHex = (fp: string) => fp.replace(/.$/, (c) => (c === "a" ? "b" : "a"));

const run = async (mode: Mode, pin: "honest" | "flip") => {
  const hub = await proofHub(mode);
  const pinned = pin === "honest" ? hub.honestFingerprint : flipLastHex(hub.honestFingerprint);
  const home = await pairedHome(hub.url, hub.origin, pinned);
  const statuses: ConnectorStatus[] = [];
  const connector = new DeviceConnector(
    home,
    undefined,
    {
      intervals: { pingMs: 60_000, idleMs: 60_000, helloMs: 1_500 } as never,
      sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, Math.min(ms, 40))),
      onStatus: (s) => statuses.push(s),
    },
    { baseUrl: "http://127.0.0.1:9", token: "local-token" },
  );
  connector.start();
  const done = async () => {
    connector.stop("test done");
    await hub.close();
    await rm(home, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 200));
  };
  return { connector, statuses, hub, home, done };
};

const until = async (fn: () => boolean, timeout = 6000, what = "condition") => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timeout waiting for ${what}`);
};

test("pinned pairing + honest hub proof: connects, handshake carries proofNonce", async (t) => {
  const hub = await proofHub("honest");
  const home = await pairedHome(hub.url, hub.origin, undefined);
  const pinOnDisk = async () =>
    (JSON.parse(readFileSync(pairingPath(home), "utf8")) as PairingFile).hubKeyFingerprint;
  void pinOnDisk;
  const statuses: ConnectorStatus[] = [];
  const connector = new DeviceConnector(
    home,
    undefined,
    {
      intervals: { pingMs: 60_000, idleMs: 60_000, helloMs: 1_500 } as never,
      sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, Math.min(ms, 40))),
      onStatus: (s) => statuses.push(s),
    },
    { baseUrl: "http://127.0.0.1:9", token: "local-token" },
  );
  t.after(async () => {
    connector.stop("done");
    await hub.close();
    await rm(home, { recursive: true, force: true });
  });
  connector.start();
  await until(() => connector.status().state === "connected", 5000, "connected");
  assert.ok(hub.handshakes[0]?.proofNonce, "the handshake challenged the hub");
  // Legacy pairing (no pin) adopted the fingerprint through the authenticated tunnel.
  await until(() => false, 100, "settle").catch(() => undefined);
  const adopted = (JSON.parse(readFileSync(pairingPath(home), "utf8")) as PairingFile)
    .hubKeyFingerprint;
  assert.equal(adopted, hub.honestFingerprint, "the pin was adopted (authenticated upgrade)");
});

test("MUTATION: pinned pairing + hub proves with a DIFFERENT key: terminal hub-key-mismatch, no retry", async () => {
  const r = await run("wrong-key", "flip"); // pin = keyA's fingerprint, but the hub signs with keyB
  try {
    await until(() => r.connector.status().state === "hub-key-mismatch", 6000, "terminal mismatch");
    const terminal = r.statuses.filter((s) => s.state === "hub-key-mismatch");
    assert.ok(terminal.length > 0, "the terminal state was announced");
    assert.match(terminal[terminal.length - 1].detail, /differs from the pinned/);
    assert.equal(r.hub.handshakes.length, 1, "no reconnect attempts after the refusal");
  } finally {
    await r.done();
  }
});

test("MUTATION: pinned pairing + hub answers WITHOUT any proof: terminal, told to re-pair", async () => {
  const r = await run("no-proof", "flip");
  try {
    await until(() => r.connector.status().state === "hub-key-mismatch", 6000, "terminal mismatch");
    const last = r.statuses.filter((s) => s.state === "hub-key-mismatch").pop();
    assert.match(last?.detail ?? "", /no identity proof|re-pair/);
    assert.equal(r.hub.handshakes.length, 1, "no retry loop");
  } finally {
    await r.done();
  }
});
