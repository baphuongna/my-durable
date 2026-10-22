/**
 * T-6 — TLS identity before the bearer, and what the hubId diagnostic may claim.
 * Real TLS servers with openssl-made certificates; the connector trusts a certificate only by
 * passing it as its CA bundle, so "trusted" never means "verification off".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpsServer, type Server } from "node:https";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { DeviceConnector } from "../src/tunnel.js";
import { HUB_ID, TOKEN, pairedHome, pause, until } from "./connector-rig.js";

interface Cert {
  key: string;
  cert: string;
}

/** The binary that mints the fixture certificates; overridable to prove the missing-binary skip. */
const OPENSSL_BIN = process.env.DPI_TEST_OPENSSL_BIN ?? "openssl";
const opensslMissing = spawnSync(OPENSSL_BIN, ["version"], { stdio: "ignore" }).status === 0
  ? false
  : `"${OPENSSL_BIN}" is not on PATH — cannot mint the TLS fixture certificates (install openssl to run T-6)`;

/** A self-signed certificate valid for exactly `san` (e.g. "IP:127.0.0.1" or "DNS:hub.invalid"). */
async function makeCert(dir: string, name: string, san: string): Promise<Cert> {
  const key = join(dir, `${name}.key`);
  const cert = join(dir, `${name}.crt`);
  execFileSync(OPENSSL_BIN, [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", key, "-out", cert, "-days", "2", "-subj", `/CN=${name}`, "-addext", `subjectAltName=${san}`,
  ], { stdio: "ignore" });
  return { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") };
}

interface TlsHub {
  url: string;
  /** Authorization header of every upgrade request that reached the application. */
  bearers: (string | undefined)[];
  /** Every byte that arrived on a completed TLS connection. */
  received: Buffer[];
  close(): Promise<void>;
}

async function tlsHub(cert: Cert, hubIdInHello: string): Promise<TlsHub> {
  const wss = new WebSocketServer({ noServer: true });
  const bearers: (string | undefined)[] = [];
  const received: Buffer[] = [];
  const server: Server = createHttpsServer({ key: cert.key, cert: cert.cert });
  server.on("secureConnection", (socket) => socket.on("data", (d: Buffer) => received.push(d)));
  server.on("upgrade", (req, socket, head) => {
    bearers.push(req.headers.authorization);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("error", () => {});
      ws.on("message", () =>
        ws.send(JSON.stringify({ type: "hello", apiVersion: 1, tunnelProto: 1, hubId: hubIdInHello, connectionId: "00000000-1111-2222-3333-444444444444", serverTime: Date.now() })),
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  return {
    url: `wss://127.0.0.1:${port}/api/tunnel`,
    bearers,
    received,
    async close() {
      for (const c of wss.clients) c.terminate();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

const hooks = { intervals: { helloMs: 800, pingMs: 60_000, idleMs: 60_000 }, sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, Math.min(ms, 40))) };

test("T-6: a certificate the connector trusts but issued for another name fails before any bearer is sent", { skip: opensslMissing }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-tls-"));
  const wrongName = await makeCert(dir, "wrong-name", "DNS:hub.invalid");
  const rightName = await makeCert(dir, "right-name", "IP:127.0.0.1");
  const bad = await tlsHub(wrongName, HUB_ID);
  const good = await tlsHub(rightName, HUB_ID);
  const badHome = await pairedHome(bad.url);
  const goodHome = await pairedHome(good.url);
  const badConnector = new DeviceConnector(badHome, wrongName.cert, hooks);
  const goodConnector = new DeviceConnector(goodHome, rightName.cert, hooks);
  try {
    // Control: the same trust mechanism with a matching name connects, so only the name differs.
    goodConnector.start();
    await until(() => goodConnector.status().state === "connected", 5000, "matching certificate connects");
    assert.deepEqual(good.bearers, [`Bearer ${TOKEN}`]);

    badConnector.start();
    await until(() => badConnector.status().attempts >= 2, 5000, "two attempts against the wrong-name certificate");
    await pause(150);
    assert.deepEqual(bad.bearers, [], "the upgrade never reached the application");
    assert.equal(Buffer.concat(bad.received).includes("Bearer"), false, "no HTTP bytes were sent over the connection");
    assert.notEqual(badConnector.status().state, "connected");
    assert.match(badConnector.status().detail, /altnames|hostname/i, "the failure names the certificate check");
    assert.ok(!JSON.stringify(badConnector.status()).includes(TOKEN), "status never carries the bearer");
  } finally {
    badConnector.stop("done");
    goodConnector.stop("done");
    await bad.close();
    await good.close();
    await rm(badHome, { recursive: true, force: true });
    await rm(goodHome, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("T-6: a trusted endpoint that answers with another hubId is reported as the wrong deployment, without claiming the secret stayed home", { skip: opensslMissing }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-tls-"));
  const cert = await makeCert(dir, "impostor", "IP:127.0.0.1");
  const otherHubId = "00000000-0000-4000-8000-000000000000";
  const hub = await tlsHub(cert, otherHubId);
  const home = await pairedHome(hub.url);
  const connector = new DeviceConnector(home, cert.cert, hooks);
  try {
    connector.start();
    await until(() => connector.status().state === "hub-mismatch", 5000, "hub-mismatch");
    // TLS proves the name, not the deployment: this endpoint legitimately received the bearer.
    assert.deepEqual(hub.bearers, [`Bearer ${TOKEN}`]);
    const { detail } = connector.status();
    assert.match(detail, /different hubId/);
    assert.match(detail, new RegExp(otherHubId));
    assert.doesNotMatch(detail, /not (been )?sent|never sent|did not receive|secret.*(safe|protected|intact)/i);
    const attempts = connector.status().attempts;
    await pause(150);
    assert.equal(connector.status().attempts, attempts, "terminal: no retries to the wrong deployment");
  } finally {
    connector.stop("done");
    await hub.close();
    await rm(home, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});
