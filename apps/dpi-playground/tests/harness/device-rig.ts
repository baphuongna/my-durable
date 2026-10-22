/**
 * A real dpi-backend daemon (child process, its own connector) behind the real hub tunnel stack:
 * TunnelServer, dispatcher, DeviceMonitor, StreamMux and the browser-facing SSE routes. Only the hub's pairing
 * ceremony is skipped: pairing.json is written with the device's own writer, next to the keypair the device
 * minted itself, and the hub registry gets the matching rows. That is the state a finished pairing leaves behind.
 *
 * Nothing here fakes a clock. `upgrades` records every tunnel upgrade the hub saw on the hub's monotonic clock, and
 * `rejectUpgrades(n)` makes the hub answer the next n attempts with 503 before they reach the tunnel server.
 */
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createHash, randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { NetworkRegistry } from "../../../dpi-sdk/src/node/registry.js";
import type { TunnelFrame } from "../../../dpi-sdk/src/protocol/tunnel.js";
import { Audit } from "../../apps/dpi-playground-hub/src/audit.js";
import { TunnelServer } from "../../apps/dpi-playground-hub/src/tunnel.js";
import {
  TunnelDispatcher,
  TunnelTransport,
} from "../../apps/dpi-playground-hub/src/tunnel-transport.js";
import { DeviceMonitor } from "../../apps/dpi-playground-hub/src/monitor.js";
import { StreamMux } from "../../apps/dpi-playground-hub/src/mux.js";
import { Store } from "../../../dpi-backend/src/store.js";
import { DevicePairing } from "../../../dpi-backend/src/pairing.js";
import {
  keypairPath,
  pairingPath,
  writeAtomic,
  type PairingFile,
} from "../../../dpi-backend/src/pairing-files.js";
import { bootServer, newToken } from "../../../dpi-backend/tests/helpers.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const HUB_ID = "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(fn: () => boolean | Promise<boolean>, timeoutMs: number, what: string) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

export interface TabFrame {
  /** Hub-side monotonic arrival time. */
  at: number;
  sub: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  frame: any;
}

/** A browser tab: one SSE connection to the hub mux, with every frame it received kept in order. */
export async function openMuxTab(base: string) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/stream`, { signal: controller.signal });
  if (res.status !== 200) throw new Error(`stream refused: ${res.status}`);
  const frames: TabFrame[] = [];
  let open = true;
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  void (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          for (const line of block.split("\n"))
            if (line.startsWith("data:")) {
              const parsed = JSON.parse(line.slice(5).trimStart()) as {
                sub: string;
                frame: unknown;
              };
              frames.push({ at: performance.now(), sub: parsed.sub, frame: parsed.frame });
            }
        }
      }
    } catch {
      /* closed by the test or the hub going away */
    } finally {
      open = false;
    }
  })();
  await until(() => frames.some((f) => f.sub === "hello"), 10_000, "the stream hello");
  const streamId = frames.find((f) => f.sub === "hello")!.frame.streamId as string;
  return {
    streamId,
    frames,
    get open() {
      return open;
    },
    async subscribe(keys: string[]) {
      const res = await fetch(`${base}/api/stream/${streamId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subs: keys }),
      });
      if (!res.ok) throw new Error(`subscribe refused: ${res.status} ${await res.text()}`);
    },
    until: (predicate: (all: TabFrame[]) => boolean, timeoutMs: number, what: string) =>
      until(() => predicate(frames), timeoutMs, what),
    close: () => controller.abort(),
  };
}
export type MuxTab = Awaited<ReturnType<typeof openMuxTab>>;

export async function deviceRig() {
  const dir = await mkdtemp(join(tmpdir(), "dpi-rig-"));
  const home = join(dir, "home");
  const startDirs = join(dir, "starts");
  await mkdir(startDirs, { recursive: true });
  /**
   * Every long-lived resource is registered here the MOMENT it is created, in
   * creation order; `shutdown` runs them in REVERSE (the registry closes last — it
   * is the store everything else writes to). The list drives both the returned
   * handle's cleanup/close and the boot-failure path below: if bootServer() throws
   * after monitor.start(), the loop, both servers and the registry are torn down
   * before the error is rethrown, so a failed rig never hangs the runner on a live
   * handle nobody can reach.
   */
  const teardown: Array<() => void | Promise<void>> = [];
  const tabs: MuxTab[] = [];
  try {
    // The device's own first boot: a store (uid) and the keypair it mints for itself.
    const pre = await Store.open({
      dataDir: join(home, "backend"),
      startDirs: [startDirs],
      name: "rig-device",
      provider: "faux",
    });
    let deviceUid: string;
    let fingerprint: string;
    try {
      deviceUid = pre.uid;
      fingerprint = new DevicePairing(pre, home, "rig-device", undefined).status().fingerprint;
    } finally {
      await pre.close();
    }

    const registry = new NetworkRegistry(join(dir, "net.sqlite"));
    teardown.push(() => registry.close());
    registry.clearTunnelState();
    const audit = new Audit(registry);
    const tunnel = new TunnelServer(registry, audit, HUB_ID);
    teardown.push(() => tunnel.close());
    const dispatcher = new TunnelDispatcher(tunnel);
    teardown.push(() => dispatcher.close());
    const monitor = new DeviceMonitor(registry);
    teardown.push(() => monitor.stop()); // a stop() before start() is a no-op
    const mux = new StreamMux(registry, monitor);

    // Every control frame the hub sends a device, in order (subscribe/unsubscribe carry the subscriptionId).
    const controls: { action: string; subscriptionId: string; sub: string }[] = [];
    const send = tunnel.send.bind(tunnel);
    tunnel.send = (deviceId: string, frame: TunnelFrame) => {
      if (
        frame.type === "control" &&
        (frame.action === "subscribe" || frame.action === "unsubscribe")
      )
        controls.push({
          action: frame.action,
          subscriptionId: frame.subscriptionId,
          sub: frame.sub,
        });
      return send(deviceId, frame);
    };

    const deviceId = "rig-dev";
    const epoch = randomUUID();
    const credentialId = randomUUID();
    const tunnelToken =
      "dpt_" +
      Buffer.from(randomUUID() + randomUUID())
        .toString("base64url")
        .slice(0, 43);
    const t0 = Date.now();
    registry.db
      .prepare(
        `INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,created_at,updated_at,transport)
       VALUES(?, 'Rig device', 'url', NULL, NULL, 'ui', 0, ?, 'checking', ?, ?, 'tunnel')`,
      )
      .run(deviceId, deviceUid, t0, t0);
    registry.db
      .prepare(
        `INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at)
       VALUES(?,?,?,?,'paired',1,?,?,?)`,
      )
      .run(deviceId, epoch, "pub", fingerprint, t0, t0, t0);
    registry.db
      .prepare(
        `INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at,confirmed_at)
       VALUES(?,?,?,?,?,'current',?,?)`,
      )
      .run(credentialId, deviceId, epoch, 1, sha(tunnelToken), t0, t0);

    const upgrades: { at: number; rejected: boolean }[] = [];
    let rejectNext = 0;
    const server = createServer((_req, res) => res.writeHead(404).end());
    server.on("upgrade", (req, socket, head) => {
      const rejected = rejectNext > 0;
      upgrades.push({ at: performance.now(), rejected });
      if (rejected) {
        rejectNext--;
        socket.end(
          "HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\ncontent-length: 0\r\n\r\n",
        );
        return;
      }
      tunnel.handleUpgrade(req, socket, head);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    teardown.push(() => {
      server.closeAllConnections();
      server.close();
    });
    const hubPort = (server.address() as { port: number }).port;

    const source = {
      dispatcherFor: (row: { id: string; transport: string }) =>
        new TunnelTransport(row, dispatcher),
      hasLiveConnection: (id: string) => tunnel.hasConnection(id),
    };
    monitor.setTunnelSource(source);
    mux.setTunnelSource(source);
    monitor.start();

    const app = express();
    app.use(express.json());
    app.get("/api/stream", (req: Request, res: Response) => mux.open(req, res));
    app.put("/api/stream/:streamId", (req: Request, res: Response) => {
      try {
        res.json(mux.subscribe(String(req.params.streamId), req.body?.subs));
      } catch (e) {
        res
          .status((e as { status?: number }).status ?? 400)
          .json({ error: { code: "invalid", message: (e as Error).message } });
      }
    });
    const api = createServer(app);
    await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));
    teardown.push(() => {
      api.closeAllConnections();
      api.close();
    });
    const base = `http://127.0.0.1:${(api.address() as { port: number }).port}`;

    // What a finished pairing leaves on the device, written by the device's own writer.
    const pairing: PairingFile = {
      version: 1,
      deviceUid,
      deviceId,
      pairingEpoch: epoch,
      credentialId,
      generation: 1,
      hubOrigin: `ws://127.0.0.1:${hubPort}`,
      hubUrl: `ws://127.0.0.1:${hubPort}/api/tunnel`,
      hubId: HUB_ID,
      tunnelToken,
      updatedAt: t0,
      operationId: randomUUID(),
    };
    writeAtomic(pairingPath(home), JSON.stringify(pairing, null, 2));

    const deviceToken = newToken();
    const backend = await bootServer({ home, startDirs, token: deviceToken });
    teardown.push(() => backend.stop());

    const registryRows = () => ({
      pairings: registry.db.prepare("SELECT * FROM pairings WHERE device_id=?").all(deviceId),
      credentials: registry.db
        .prepare("SELECT * FROM tunnel_credentials WHERE device_id=?")
        .all(deviceId),
      pairEvents: (
        registry.db.prepare("SELECT COUNT(*) AS n FROM events WHERE action LIKE 'pair%'").get() as {
          n: number;
        }
      ).n,
    });

    /** Close every tab, then every hub-side resource in reverse creation order, then the temp dir. */
    const shutdown = async () => {
      for (const tab of tabs) tab.close();
      for (const step of [...teardown].reverse()) await step();
      await rm(dir, { recursive: true, force: true });
    };

    return {
      deviceId,
      deviceUid,
      fingerprint,
      home,
      startDirs,
      deviceToken,
      backend,
      registry,
      tunnel,
      dispatcher,
      monitor,
      base,
      controls,
      upgrades,
      waitOnline: () =>
        until(
          () => monitor.state(deviceId)?.status === "online",
          30_000,
          `the device online (${backend.output().slice(-400)})`,
        ),
      /** The device's local view of its pairing, over its own API. */
      localPairing: async () =>
        (
          await fetch(`${backend.base}/v1/pairing`, {
            headers: { authorization: `Bearer ${deviceToken}` },
          })
        ).json() as Promise<Record<string, unknown>>,
      /** The daemon's connector counters (in memory, so they only grow while the same process lives). */
      localTunnel: async () =>
        (
          await fetch(`${backend.base}/v1/tunnel`, {
            headers: { authorization: `Bearer ${deviceToken}` },
          })
        ).json() as Promise<Record<string, unknown>>,
      /** Bytes of the two files a re-pair would rewrite, plus the hub rows that describe the pairing. */
      persisted: async () => ({
        pairingJson: await readFile(pairingPath(home), "utf8"),
        keypairJson: await readFile(keypairPath(home), "utf8"),
        ...registryRows(),
      }),
      rejectUpgrades: (n: number) => {
        rejectNext = n;
      },
      /** Cut the live device socket from the hub side without a close handshake, like a network blip. Returns the time. */
      dropTunnel: () => {
        const at = performance.now();
        for (const client of (tunnel as unknown as { wss: { clients: Set<{ terminate(): void }> } })
          .wss.clients)
          client.terminate();
        return at;
      },
      openTab: async () => {
        const tab = await openMuxTab(base);
        tabs.push(tab);
        return tab;
      },
      /** Alias of cleanup — the rig is also usable with `await using`-style manual disposal. */
      close: () => shutdown(),
      cleanup: () => shutdown(),
    };
  } catch (err) {
    // Boot failed: tear down everything created so far — the monitor loop, both
    // servers, the tunnel stack and the registry — then rethrow, so the caller's
    // failed `await deviceRig()` leaves no live handle that would hang the runner.
    for (const step of [...teardown].reverse()) {
      try {
        await step();
      } catch {
        /* a failed teardown step must not mask the boot error */
      }
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
export type DeviceRig = Awaited<ReturnType<typeof deviceRig>>;
