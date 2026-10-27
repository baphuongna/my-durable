/**
 * R8 binary passthrough — FULL three-real-legs integration:
 *
 * real DeviceConnector (device leg) ↔ real TunnelServer/TunnelDispatcher (hub leg)
 * ↔ real proxy route. The loopback device API answers an export request with a
 * binary zip; the hub must serve it byte-exact with the device's filename.
 *
 * This is the test that mirrors production: device-side envelope (base64 flag +
 * disposition), hub-side decode, admin-origin lockdown headers, all in one hop.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import express from "express";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { Audit } from "../apps/dpi-playground-hub/src/audit.js";
import { TunnelServer } from "../apps/dpi-playground-hub/src/tunnel.js";
import { TunnelDispatcher, TunnelTransport } from "../apps/dpi-playground-hub/src/tunnel-transport.js";
import { DeviceMonitor } from "../apps/dpi-playground-hub/src/monitor.js";
import { proxy } from "../apps/dpi-playground-hub/src/proxy.js";
import { DeviceConnector } from "../../dpi-backend/src/tunnel.js";
import { writeAtomic } from "../../dpi-sdk/src/node/private-file.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const HUB_ID = "7a7a7a7a-8394-4a5b-9c0d-1e2f3a4b5c6d";
const FINGERPRINT = `sha256:${"f".repeat(64)}`;
const UID = randomUUID();
const TOKEN = "dpt_" + "E".repeat(43);
const EPOCH = randomUUID();
const CREDENTIAL_ID = randomUUID();

const ZIP = Buffer.concat([
  Buffer.from("PK\x03\x04\x14\x00\x00\x00\x08\x00", "binary"),
  Buffer.from("R8-three-real-legs", "utf8"),
]);

test("R8 e2e: binary zip export rides the real tunnel byte-exact with its filename", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-r8tun-"));
  try {
    const registry = new NetworkRegistry(join(dir, "net.sqlite"));
    registry.clearTunnelState();
    const audit = new Audit(registry);
    const tunnel = new TunnelServer(registry, audit, HUB_ID);
    const dispatcher = new TunnelDispatcher(tunnel, { audit });
    const deviceId = "r8-dev";
    const t0 = Date.now();
    registry.db
      .prepare(
        `INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,created_at,updated_at,transport)
         VALUES(?, 'R8 Dev', 'url', NULL, NULL, 'ui', 0, ?, 'checking', ?, ?, 'tunnel')`,
      )
      .run(deviceId, UID, t0, t0);
    registry.db
      .prepare(
        `INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at)
         VALUES(?,?,?,?,'paired',1,?,?,?)`,
      )
      .run(deviceId, EPOCH, "pub", FINGERPRINT, t0, t0, t0);
    registry.db
      .prepare(
        `INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at,confirmed_at)
         VALUES(?,?,?,?,?,'current',?,?)`,
      )
      .run(CREDENTIAL_ID, deviceId, EPOCH, 1, sha(TOKEN), t0, t0);

    const server = createServer();
    server.on("upgrade", (req, socket, head) => tunnel.handleUpgrade(req, socket, head));
    await new Promise<void>((d) => server.listen(0, "127.0.0.1", d));
    const hubPort = (server.address() as { port: number }).port;

    // Device home: pairing.json pointing at the REAL hub tunnel + matching keypair.
    const home = join(dir, "device-home");
    await mkdir(home);
    const hubUrl = `ws://127.0.0.1:${hubPort}/api/tunnel`;
    await writeFile(
      join(home, "pairing.json"),
      JSON.stringify({
        version: 1,
        deviceUid: UID,
        deviceId,
        pairingEpoch: EPOCH,
        credentialId: CREDENTIAL_ID,
        generation: 1,
        hubOrigin: `http://127.0.0.1:${hubPort}`,
        hubUrl,
        hubId: HUB_ID,
        tunnelToken: TOKEN,
        updatedAt: Date.now(),
        operationId: randomUUID(),
      }),
    );
    await writeFile(
      join(home, "device-keypair.json"),
      JSON.stringify({
        fingerprint: FINGERPRINT,
        publicKeyPem: "pub",
        privateKeyPem: "priv",
      }),
    );

    // Loopback device API: binary zip for the export path, JSON otherwise.
    let zipHits = 0;
    const api = createServer((req, res) => {
      const url = req.url ?? "";
      if (url.includes("/export")) {
        zipHits++;
        res.writeHead(200, {
          "content-type": "application/zip",
          "content-disposition": 'attachment; filename="r8-real-tunnel.bundle.zip"',
        });
        res.end(ZIP);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ apiVersion: 1, uid: UID, name: "R8 Dev" }));
    });
    await new Promise<void>((d) => api.listen(0, "127.0.0.1", d));
    const apiPort = (api.address() as { port: number }).port;

    const statuses: string[] = [];
    const connector = new DeviceConnector(
      home,
      undefined,
      {
        intervals: { pingMs: 60_000, idleMs: 60_000, helloMs: 2_000 } as never,
        sleep: (ms) => new Promise<void>((done) => setTimeout(done, Math.min(ms, 40))),
        onStatus: (st) => statuses.push(st),
      },
      { baseUrl: `http://127.0.0.1:${apiPort}`, token: "local-token" },
    );
    connector.start();
    const until = async (fn: () => boolean, what: string) => {
      for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(fn(), `timed out: ${what}`);
    };
    await until(() => connector.status().state === "connected", "connector connected");

    const monitor = new DeviceMonitor(registry);
    const source = {
      dispatcherFor: (row: { id: string; transport: string }) => new TunnelTransport(row, dispatcher),
      hasLiveConnection: (id: string) => tunnel.hasConnection(id),
    };
    monitor.setTunnelSource(source);
    const onlineBy = Date.now() + 15_000;
    while (Date.now() < onlineBy && monitor.state(deviceId)?.status !== "online")
      await new Promise((r) => setTimeout(r, 50));
    if (monitor.state(deviceId)?.status !== "online")
      throw new Error(
        "never online: monitor=" + JSON.stringify(monitor.state(deviceId)) +
        " connector=" + statuses.join("→") +
        " state=" + JSON.stringify(connector.status()),
      );
    const app = express();
    app.use(express.json({ limit: "5mb" }));
    app.all("/api/devices/:id/v1/{*rest}", proxy(registry, monitor, source));
    const apiServer = createServer(app);
    await new Promise<void>((d) => apiServer.listen(0, "127.0.0.1", d));
    const base = `http://127.0.0.1:${(apiServer.address() as { port: number }).port}`;

    let res = await fetch(`${base}/api/devices/${deviceId}/v1/sessions/x/export`);
    assert.equal(res.status, 200, res.status !== 200 ? await res.clone().text() : "");
    assert.equal(res.headers.get("content-type"), "application/zip");
    assert.equal(
      res.headers.get("content-disposition"),
      'attachment; filename="r8-real-tunnel.bundle.zip"',
    );
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.ok(bytes.equals(ZIP), "zip bytes byte-exact through the REAL tunnel");
    assert.equal(zipHits, 1, "the loopback export route was hit exactly once");

    const close = (s: createServer) =>
      new Promise<void>((done) => {
        s.closeAllConnections();
        s.close(() => done());
        setTimeout(done, 500).unref?.();
      });
    await close(apiServer);
    await close(server);
    await close(api);
    connector.stop();
    dispatcher.close();
    tunnel.close();
    monitor.stop();
    await rm(dir, { recursive: true, force: true });
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
});

import { mkdir } from "node:fs/promises";
type createServer = ReturnType<typeof createServer>;
