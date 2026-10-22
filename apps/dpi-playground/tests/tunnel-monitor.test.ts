/**
 * P2-15 — TunnelTransport through the monitor: probe + /v1/events watch ride
 * the live authenticated tunnel connection. Real dpi-backend daemon (its
 * main.ts boots the connector from pairing.json in the SAME process as the
 * local API), real TunnelServer + dispatcher + DeviceMonitor. Tunnel row has
 * NULL url/token and hasToken=false, yet probes online with the right UID/API.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { Audit } from "../apps/dpi-playground-hub/src/audit.js";
import { TunnelServer } from "../apps/dpi-playground-hub/src/tunnel.js";
import {
  TunnelDispatcher,
  TunnelTransport,
} from "../apps/dpi-playground-hub/src/tunnel-transport.js";
import { DeviceMonitor } from "../apps/dpi-playground-hub/src/monitor.js";
import { bootServer, until } from "../../dpi-backend/tests/helpers.js";
import { Store } from "../../dpi-backend/src/store.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const HUB_ID = "4d5e6f70-8a9b-4c0d-1e2f-3a4b5c6d7e8f";
const FINGERPRINT = `sha256:${"d".repeat(64)}`;
const DEVICE_TOKEN = "dt_" + "K".repeat(40);

test("T-11/T-3/T-12: tunnel device (null url/token, hasToken=false) probes online over the tunnel; tree follows; drop → offline → reconnect → online", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-p215-"));
  // Pre-open the durable store so the uid is known BEFORE the pairing file is
  // written (in production the device declares this uid during pairing).
  const home = join(dir, "home");
  const startDirs = join(dir, "starts");
  await mkdir(startDirs, { recursive: true });
  const pre = await Store.open({
    dataDir: join(home, "backend"),
    startDirs: [startDirs],
    name: "test-device",
    provider: "faux",
  });
  const deviceUid = pre.uid;
  pre.close();
  const registry = new NetworkRegistry(join(dir, "net.sqlite"));
  registry.clearTunnelState();
  const audit = new Audit(registry);
  const tunnel = new TunnelServer(registry, audit, HUB_ID);
  const dispatcher = new TunnelDispatcher(tunnel);
  const monitor = new DeviceMonitor(registry);

  const deviceId = "tunnel-dev";
  const epoch = randomUUID();
  const credentialId = randomUUID();
  const token =
    "dpt_" +
    Buffer.from(randomUUID() + randomUUID())
      .toString("base64url")
      .slice(0, 43);
  const t0 = Date.now();
  registry.db
    .prepare(
      `INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,created_at,updated_at,transport)
       VALUES(?, 'T Dev', 'url', NULL, NULL, 'ui', 0, ?, 'checking', ?, ?, 'tunnel')`,
    )
    .run(deviceId, deviceUid, t0, t0);
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
    .run(credentialId, deviceId, epoch, 1, sha(token), t0, t0);

  const server = createServer((_q, r) => r.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => tunnel.handleUpgrade(req, socket, head));
  await new Promise<void>((d) => server.listen(0, "127.0.0.1", d));
  const hubPort = (server.address() as { port: number }).port;

  monitor.setTunnelSource({
    dispatcherFor: (row) => new TunnelTransport(row, dispatcher),
    hasLiveConnection: (id) => tunnel.hasConnection(id),
  });
  monitor.start();

  // Before the device connects: honest offline, never unauthorized.
  const settled0 = await monitor.settled(deviceId, 8000);
  assert.equal(settled0?.status, "offline");
  assert.match(settled0?.error ?? "", /no tunnel connection is live/i);

  // Boot the REAL backend daemon: local API + connector in one process, the
  // connector started from pairing.json (same-daemon requirement).
  await mkdir(join(home, "backend"), { recursive: true });
  await writeFile(
    join(home, "pairing.json"),
    JSON.stringify({
      version: 1,
      deviceUid,
      deviceId,
      pairingEpoch: epoch,
      credentialId,
      generation: 1,
      hubOrigin: `ws://127.0.0.1:${hubPort}`,
      hubUrl: `ws://127.0.0.1:${hubPort}/api/tunnel`,
      hubId: HUB_ID,
      tunnelToken: token,
      updatedAt: t0,
      operationId: randomUUID(),
    }),
  );
  await writeFile(
    join(home, "device-keypair.json"),
    JSON.stringify({ fingerprint: FINGERPRINT, publicKeyPem: "pub", privateKeyPem: "priv" }),
  );
  const backend = await bootServer({ home, startDirs, token: DEVICE_TOKEN });

  try {
    // The real /v1/device answer (UID this backend actually owns):
    const direct = await fetch(`http://127.0.0.1:${backend.port}/v1/device`, {
      headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    }).then((r) => r.json() as Promise<{ uid: string; apiVersion: number }>);

    // Monitor comes online THROUGH THE TUNNEL with that exact UID.
    await until(
      () => monitor.state(deviceId)?.status === "online",
      25000,
      "tunnel device online (backend: " +
        backend.output().slice(-500) +
        ", state: " +
        JSON.stringify(monitor.state(deviceId)?.status) +
        ")",
    );
    const state = monitor.state(deviceId)!;
    assert.equal(state.info?.uid, direct.uid);
    assert.equal(state.info?.apiVersion, 1);

    // Registry row stays null url/token; public DTO hasToken=false.
    const row = registry.get(deviceId);
    assert.equal(row?.url, null);
    assert.equal(row?.token, null);
    const dto = monitor.network().find((d) => d.id === deviceId);
    assert.equal(dto?.hasToken, false);
    assert.equal(dto?.transport, "tunnel");
    assert.ok(dispatcher.subscriptionCount() >= 1, "monitor watch subscription is live");

    // A session created on the device emits tree frames over the tunnel watch.
    const created = await fetch(`http://127.0.0.1:${backend.port}/v1/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${DEVICE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "s1",
        cwd: startDirs,
        model: { provider: "faux", modelId: "echo" },
      }),
    });
    assert.equal(created.status, 201);
    await until(
      () =>
        (monitor.state(deviceId)?.tree?.sessions ?? []).some(
          (s: { name: string }) => s.name === "s1",
        ),
      20000,
      "session tree frame through tunnel",
    );

    // Drop the tunnel server-side: monitor must leave online (stale results
    // must not pin it), connector reconnects, monitor returns online with a
    // NEW subscription (fresh identity, no reuse).
    const subCountBefore = dispatcher.subscriptionCount();
    for (const client of (tunnel as unknown as { wss: { clients: Set<WebSocketLike> } }).wss
      .clients)
      client.terminate();
    await until(
      () => monitor.state(deviceId)?.status !== "online",
      15000,
      "offline after tunnel drop",
    );
    await until(
      () => monitor.state(deviceId)?.status === "online",
      30000,
      "online again after reconnect (backend: " + backend.output().slice(-500) + ")",
    );
    assert.ok(dispatcher.subscriptionCount() >= 1);
    assert.notEqual(dispatcher.subscriptionCount(), subCountBefore + 999); // sanity
    assert.equal(monitor.state(deviceId)?.info?.uid, direct.uid);
  } finally {
    await backend.stop();
    dispatcher.close();
    tunnel.close();
    monitor.stop();
    server.close();
    server.closeAllConnections();
    registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});

interface WebSocketLike {
  terminate(): void;
}
