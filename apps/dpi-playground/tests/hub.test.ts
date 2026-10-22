import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  bootServer,
  freePort,
  newToken,
  tempStore,
  until,
  faux,
  delay,
} from "../../dpi-backend/tests/helpers.js";
import { readSse } from "../../dpi-sdk/src/sse.js";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { randomUUID } from "node:crypto";
import { CredentialService } from "../apps/dpi-playground-hub/src/credentials.js";
import { Audit } from "../apps/dpi-playground-hub/src/audit.js";
import { WebSocket } from "ws";
import type { MuxFrame, NetworkDevice } from "../../dpi-sdk/src/api.js";

async function bootHub(home: string, networkFile: string, env: Record<string, string>) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let output = "";
  const child: ChildProcess = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      resolve(import.meta.dirname, "../apps/dpi-playground-hub/src/main.ts"),
      "--port",
      String(port),
    ],
    {
      env: {
        ...process.env,
        ...env,
        DPI_HOME: home,
        DPI_NETWORK_FILE: networkFile,
        NODE_NO_WARNINGS: "1",
      },
      cwd: resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (x) => (output += x));
  child.stderr?.on("data", (x) => (output += x));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {}
    if (child.exitCode !== null) throw Error(output);
    await delay(100);
  }
  const adminToken = (await readFile(join(home, "admin.token"), "utf8")).trim();
  const adminHeaders = { authorization: `Bearer ${adminToken}` };
  return {
    base,
    adminHeaders,
    output: () => output,
    stop: async () => {
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
    },
  };
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
/** Admin-plane fetch: the same call with the hub's admin bearer attached. */
const adminFetch = (
  hub: { base: string; adminHeaders: Record<string, string> },
  path: string,
  init: RequestInit = {},
) =>
  fetch(`${hub.base}${path}`, {
    ...init,
    headers: { ...hub.adminHeaders, ...(init.headers as Record<string, string> | undefined) },
  });

test("R03: real hub publishes safe offline credential metadata and notifies an open tab after rotate/revoke", async () => {
  const t = await tempStore();
  const home = join(t.root, "hub");
  const registry = new NetworkRegistry(join(home, "network.sqlite"));
  const fingerprint = `sha256:${"b".repeat(64)}`;
  const ticket = await new CredentialService(
    registry,
    new Audit(registry),
    "https://fixture.test",
    randomUUID(),
  ).issue({
    enrollmentId: randomUUID(),
    codeId: randomUUID(),
    deviceUid: randomUUID(),
    deviceName: "Offline paired fixture",
    publicKeyPem: "fixture-public-key",
    keyFingerprint: fingerprint,
    replaceKey: false,
  });
  registry.close();
  const networkFile = join(t.root, "empty-network.yaml");
  writeFileSync(networkFile, "devices: {}\n");
  const hub = await bootHub(home, networkFile, {});
  const ctl = new AbortController();
  let ws: WebSocket | undefined;
  try {
    const network = (await (await adminFetch(hub, "/api/network")).json()) as {
      devices: NetworkDevice[];
    };
    const dto = network.devices.find((d) => d.id === ticket.deviceId)!;
    assert.deepEqual(dto.pairing, {
      status: "paired",
      keyFingerprint: fingerprint,
      pairedAt: ticket.issuedAt,
      credentialGeneration: 1,
      rotationPending: false,
    });
    assert.deepEqual(dto.tunnel, { state: "disconnected", readerCount: 0 });
    assert.equal(dto.status, "offline");
    const listing = await adminFetch(hub, "/api/pairings");
    assert.equal(listing.status, 200, "the canonical pairing API is available");
    assert.deepEqual(await listing.json(), [
      {
        ...dto.pairing,
        deviceId: ticket.deviceId,
        deviceUid: ticket.deviceUid,
        deviceName: dto.name,
        tunnel: dto.tunnel,
      },
    ]);
    const response = await adminFetch(hub, "/api/stream", { signal: ctl.signal });
    const frames: MuxFrame[] = [];
    void (async () => {
      for await (const event of readSse(response.body!))
        frames.push(JSON.parse(event.data) as MuxFrame);
    })().catch(() => {});
    const devices = () =>
      frames.flatMap((frame) => (frame.frame.type === "network" ? frame.frame.devices : []));
    await until(() => devices().length > 0, 2000, "initial credential metadata on SSE");
    assert.deepEqual(devices()[0].pairing, dto.pairing);
    assert.equal(
      (await adminFetch(hub, `/api/pairings/${ticket.deviceId}/rotate`, json({}))).status,
      202,
    );
    await until(
      () => devices().some((d) => d.pairing?.rotationPending),
      2000,
      "offline rotation intent on SSE without reload",
    );
    ws = new WebSocket(hub.base.replace("http:", "ws:") + "/api/tunnel", {
      headers: { authorization: `Bearer ${ticket.tunnelToken}` },
    });
    await once(ws, "open");
    let rotation:
      | { rotationId: string; credentialId: string; generation: number; pairingEpoch: string }
      | undefined;
    ws.on("message", (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.type === "control" && request.action === "token-rotate") rotation = request;
      if (request.type === "rest-request")
        ws!.send(
          JSON.stringify({
            type: "rest-response",
            reqId: request.reqId,
            status: 200,
            body: JSON.stringify({
              apiVersion: 1,
              uid: ticket.deviceUid,
              name: "Offline paired fixture",
            }),
          }),
        );
      if (request.type === "control" && request.action === "subscribe")
        ws!.send(
          JSON.stringify({
            type: "tunnel-data",
            subscriptionId: request.subscriptionId,
            sub: request.sub,
            frame: { type: "tree", tree: { sessions: [] } },
          }),
        );
    });
    const greeted = once(ws, "message");
    ws.send(
      JSON.stringify({
        type: "pair-handshake",
        v: 1,
        deviceUid: ticket.deviceUid,
        deviceId: ticket.deviceId,
        pairingEpoch: ticket.pairingEpoch,
        credentialId: ticket.credentialId,
        generation: 1,
        apiVersion: 1,
        tunnelProto: 1,
        keyFingerprint: fingerprint,
      }),
    );
    await greeted;
    await adminFetch(hub, `/api/devices/${ticket.deviceId}/check`, json({}));
    const liveNetwork = (await (await adminFetch(hub, "/api/network")).json()) as {
      devices: NetworkDevice[];
    };
    const live = liveNetwork.devices.find((d) => d.id === ticket.deviceId)!;
    assert.equal(live.tunnel?.state, "connected");
    assert.equal(live.tunnel?.readerCount, 1, "diagnostics count the actual monitor subscription");
    assert.ok(live.tunnel?.lastSeenAt);
    await until(
      () =>
        !!rotation &&
        devices().some((d) => d.pairing?.credentialGeneration === 2 && d.pairing.rotationPending),
      2000,
      "rotation delivered and pending on SSE",
    );
    ws.send(
      JSON.stringify({
        type: "control",
        action: "token-rotate-ack",
        rotationId: rotation!.rotationId,
        credentialId: rotation!.credentialId,
        generation: rotation!.generation,
        pairingEpoch: rotation!.pairingEpoch,
      }),
    );
    await until(
      () =>
        devices().some((d) => d.pairing?.credentialGeneration === 2 && !d.pairing.rotationPending),
      2000,
      "rotation ACK updates the open tab",
    );
    const disconnected = once(ws, "close");
    ws.close();
    await disconnected;
    assert.equal(
      (await adminFetch(hub, `/api/devices/${ticket.deviceId}/revoke`, json({ reason: "user" })))
        .status,
      202,
    );
    await until(
      () => devices().some((d) => d.pairing?.status === "revoked" && !d.pairing.rotationPending),
      2000,
      "offline revoke on SSE without reload",
    );
    const wire = JSON.stringify(frames);
    assert.equal(
      wire.includes(ticket.tunnelToken) ||
        wire.includes("fixture-public-key") ||
        wire.includes("token_hash"),
      false,
    );
  } finally {
    ctl.abort();
    ws?.terminate();
    await hub.stop();
    await t.cleanup();
  }
});

test("hub: registry from YAML, monitoring, token-injecting proxy, guard, mux, offline and mismatch", async () => {
  const t = await tempStore();
  const tokenA = newToken();
  const tokenB = newToken();
  const a = await bootServer({
    home: join(t.root, "a"),
    startDirs: t.work,
    token: tokenA,
    name: "box-a",
  });
  let b = await bootServer({
    home: join(t.root, "b"),
    startDirs: t.work,
    token: tokenB,
    name: "box-b",
  });
  const hubHome = join(t.root, "hub");
  mkdirSync(hubHome, { recursive: true });
  const networkFile = join(t.root, "dpi-network.yaml");
  writeFileSync(
    networkFile,
    `devices:\n  box-a:\n    kind: url\n    url: ${a.base}\n    token_env: TOKEN_A\n  box-b:\n    kind: url\n    url: ${b.base}\n    token_env: TOKEN_B\n`,
  );
  const hub = await bootHub(hubHome, networkFile, { TOKEN_A: tokenA, TOKEN_B: tokenB });
  const network = async () =>
    ((await (await adminFetch(hub, "/api/network")).json()) as { devices: NetworkDevice[] })
      .devices;
  const status = async (id: string) => (await network()).find((d) => d.id === id)?.status;
  try {
    await until(
      async () => (await status("box-a")) === "online" && (await status("box-b")) === "online",
      15000,
      "both online",
    );
    const all = await (await adminFetch(hub, "/api/network")).text();
    assert.equal(
      all.includes(tokenA) || all.includes(tokenB),
      false,
      "tokens never reach the browser",
    );

    // Proxy: browser requests carry no token; the hub injects it.
    const info = await (await adminFetch(hub, "/api/devices/box-a/v1/device")).json();
    assert.equal(info.name, "box-a");
    const created = await adminFetch(
      hub,
      "/api/devices/box-a/v1/sessions",
      json({ name: "Via hub", cwd: t.work, model: faux }),
    );
    assert.equal(created.status, 201);
    const session = await created.json();
    assert.equal(
      (await adminFetch(hub, `/api/devices/box-a/v1/sessions/${session.id}/agents/main/events`))
        .status,
      400,
      "streams only via mux",
    );

    // Guard.
    const { request } = await import("node:http");
    const evil = await new Promise<number>((done) => {
      const u = new URL(`${hub.base}/api/network`);
      request(
        { host: u.hostname, port: u.port, path: u.pathname, headers: { host: "evil.test" } },
        (r) => (r.resume(), done(r.statusCode ?? 0)),
      ).end();
    });
    assert.equal(evil, 421, "DNS-rebinding Host rejected");
    assert.equal(
      (
        await fetch(`${hub.base}/api/ui-state/x`, {
          method: "PUT",
          body: "{}",
          headers: { "content-type": "application/json", origin: "http://evil.test" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(`${hub.base}/api/ui-state/x`, { method: "PUT", body: "id=x" })).status,
      415,
    );

    // Devices are configured outside the UI: the hub has no device write routes. A wrong token in
    // the registry → unauthorized; `just net register` fixes the registry, a check brings it online.
    assert.equal(
      (await adminFetch(hub, "/api/devices", json({ id: "x", url: "http://x" }))).status,
      404,
    );
    const registry = new NetworkRegistry(join(hubHome, "network.sqlite"));
    registry.setToken("box-b", "x".repeat(40));
    await adminFetch(hub, "/api/devices/box-b/check", json({}));
    await until(async () => (await status("box-b")) === "unauthorized", 8000, "box-b unauthorized");
    registry.setToken("box-b", tokenB);
    assert.equal(
      (await (await adminFetch(hub, "/api/devices/box-b/check", json({}))).json()).status,
      "online",
    );

    // Mux: one browser stream carries network + device + agent frames; subscription changes close upstreams.
    const stop = new AbortController();
    const res = await adminFetch(hub, "/api/stream", { signal: stop.signal });
    const frames: MuxFrame[] = [];
    let streamId = "";
    void (async () => {
      for await (const m of readSse(res.body!)) {
        const frame = JSON.parse(m.data) as MuxFrame;
        frames.push(frame);
        if (frame.frame.type === "stream") streamId = frame.frame.streamId;
      }
    })().catch(() => {});
    await until(async () => !!streamId, 5000, "stream id");
    const subs = [
      "box-a/device",
      `box-a/agent/${session.id}/main?docs=demo.job-runs`,
      `box-a/session/${session.id}`,
    ];
    const put = await adminFetch(hub, `/api/stream/${streamId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subs }),
    });
    assert.deepEqual((await put.json()).subs, ["network", ...subs]);
    await until(
      async () => frames.some((f) => f.sub === subs[1] && f.frame.type === "snapshot"),
      8000,
      "agent snapshot via mux",
    );
    await adminFetch(
      hub,
      `/api/devices/box-a/v1/sessions/${session.id}/agents/main/messages`,
      json({ content: "hi hub", requestId: "hub-1" }),
    );
    await until(
      async () =>
        frames.some(
          (f) =>
            f.sub === subs[1] &&
            f.frame.type === "batch" &&
            f.frame.events.some((e) => e.type === "run_end"),
        ),
      10000,
      "batch via mux",
    );
    assert.ok(frames.some((f) => f.sub === "network" && f.frame.type === "network"));
    assert.ok(frames.some((f) => f.sub === subs[0] && f.frame.type === "tree"));
    assert.ok(frames.some((f) => f.sub === subs[2] && f.frame.type === "session"));
    assert.ok(frames.some((f) => f.sub === subs[1] && f.frame.type === "doc"));
    const bad = await adminFetch(hub, `/api/stream/${streamId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subs: ["nope/agent"] }),
    });
    assert.equal(bad.status, 400);

    // Offline: kill box-b → offline with a cached tree; proxy answers 503; restart → online again.
    await b.stop("SIGKILL");
    await until(async () => (await status("box-b")) === "offline", 15000, "box-b offline");
    assert.equal((await adminFetch(hub, "/api/devices/box-b/v1/device")).status, 503);
    assert.ok(
      (await network()).find((d) => d.id === "box-b")?.tree,
      "cached tree survives offline",
    );
    await b.start();
    await until(async () => (await status("box-b")) === "online", 30000, "box-b back online");

    // Mismatch: same URL, different device (new data dir = new uid).
    const port = b.port;
    await b.stop();
    b = await bootServer({
      home: join(t.root, "b2"),
      startDirs: t.work,
      token: tokenB,
      name: "box-b-new",
      port,
    });
    await until(async () => (await status("box-b")) === "mismatch", 30000, "mismatch");
    registry.forgetUid("box-b"); // what `just net register box-b` does
    const accepted = await adminFetch(hub, "/api/devices/box-b/check", json({}));
    assert.equal((await accepted.json()).status, "online");
    registry.close();
    stop.abort();
  } finally {
    await hub.stop();
    await a.stop();
    await b.stop();
    await t.cleanup();
  }
});
