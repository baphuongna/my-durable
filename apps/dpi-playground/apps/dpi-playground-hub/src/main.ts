// The playground hub: the local registry of devices (~/.dpi/network.sqlite), their live status,
// a REST proxy that injects device tokens, one multiplexed SSE stream per browser tab, and the
// Vue client. It runs no agents; every agent lives in some device's dpi-backend.
import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { hostname, networkInterfaces } from "node:os";
import { NetworkRegistry } from "../../../../dpi-sdk/src/node/registry.js";
import { DeviceMonitor } from "./monitor.js";
import { StreamMux } from "./mux.js";
import { proxy } from "./proxy.js";
import { guard } from "./guard.js";
import { Audit, denialLogging } from "./audit.js";
import { PairingService } from "./pairing.js";
import { CredentialService } from "./credentials.js";
import { TunnelServer } from "./tunnel.js";
import { TunnelDispatcher, TunnelTransport } from "./tunnel-transport.js";
import { seedFromConfig } from "./seed.js";

const args = process.argv.slice(2);
const option = (key: string, fallback: string) => {
  const i = args.indexOf(key);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith("--")) throw Error(`${key} needs a value`);
  return args[i + 1];
};
const appDir = fileURLToPath(new URL("../../../", import.meta.url));
const port = Number(option("--port", process.env.DPI_HUB_PORT ?? "4781"));
const host = option("--host", process.env.DPI_HUB_HOST ?? "127.0.0.1");
// When running behind a TLS reverse proxy (reference profile: Caddy), the
// browser-facing host:port differs from this process's own port. The proxy
// forwards the original Host header, so it must be allow-listed explicitly.
const publicHost = option("--public-host", process.env.DPI_HUB_PUBLIC_HOST ?? "");

const registry = new NetworkRegistry();
registry.clearTunnelState(); // live tunnel state is RAM-only; never resurrect from DB
const configFile = seedFromConfig(registry, appDir);
const monitor = new DeviceMonitor(registry);
monitor.start();
const mux = new StreamMux(registry, monitor);

const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
if (host !== "127.0.0.1" && host !== "localhost") {
  allowedHosts.add(`${hostname().toLowerCase()}:${port}`);
  allowedHosts.add(
    `${hostname()
      .toLowerCase()
      .replace(/\.local$/, "")}.local:${port}`,
  );
  for (const addresses of Object.values(networkInterfaces()))
    for (const a of addresses ?? [])
      if (a.family === "IPv4") allowedHosts.add(`${a.address}:${port}`);
}

const err = (code: string, message: string) => ({ error: { code, message } });
// Unauthenticated liveness probe for process supervisors and the test
// harness. No registry data, no tokens — safe behind the loopback bind and
// the TLS reverse proxy.
if (publicHost) allowedHosts.add(publicHost.toLowerCase());
type Handler = (req: express.Request, res: express.Response) => unknown;
const safe =
  (fn: Handler): express.RequestHandler =>
  async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 400;
      if (!res.headersSent)
        res
          .status(status)
          .json(err(status === 404 ? "not_found" : "invalid", (e as Error).message));
    }
  };

const app = express();
app.get("/healthz", (_req, res) => res.json({ ok: true, pid: process.pid, uptime: process.uptime() }));
app.disable("x-powered-by");
const audit = new Audit(registry);
app.use("/api", denialLogging(audit), guard(allowedHosts), express.json({ limit: "256kb" }));

// Pairing endpoints (03 §4). Admin authentication + authz matrix land in P2-21;
// until then the hub is loopback/TLS-proxied and these routes are the same-origin
// guarded surface as every other /api route. Body cap for pairing is 16 KiB.
const hubId = (registry.db.prepare("SELECT value FROM hub_meta WHERE key='hub_id'").get() as { value: string }).value;
const hubOrigin = process.env.DPI_HUB_ORIGIN ?? `https://${hostname().toLowerCase()}`;
const credentials = new CredentialService(registry, audit, hubOrigin, hubId);
const pairing = new PairingService({
  registry, audit, hubOrigin, hubId,
  issue: (e) => credentials.issue(e),
  receiptValidator: (t) =>
    credentials.receiptStillValid(t) ? true : { code: credentials.receiptFailure(t) },
});
const pairErr = (r: { error: { status: number; code: string; message: string; retryAfterMs?: number } }, res: express.Response) =>
  res.status(r.error.status).json({ error: { code: r.error.code, message: r.error.message, ...(r.error.retryAfterMs ? { retryAfterMs: r.error.retryAfterMs } : {}) } });
app.post("/api/pair/code", express.json({ limit: "16kb" }), (req, res) => {
  const r = pairing.createCode(req.ip ?? "unknown");
  return r.ok ? res.status(201).json(r.value) : pairErr(r, res);
});
app.post("/api/pair/start", express.json({ limit: "16kb" }), (req, res) => {
  const r = pairing.start(req.body, req.ip ?? "unknown");
  return r.ok ? res.json(r.value) : pairErr(r, res);
});
app.post("/api/pair/verify", express.json({ limit: "16kb" }), async (req, res) => {
  const r = await pairing.verify(req.body, req.ip ?? "unknown");
  if (r.ok) return res.status(r.status).json(r.value);
  pairErr(r, res);
});
app.get("/api/pair/codes/:codeId", (req, res) => {
  const r = pairing.status(req.params.codeId);
  return r.ok ? res.json(r.value) : pairErr(r, res);
});
app.post("/api/pair/codes/:codeId/approve", express.json({ limit: "16kb" }), (req, res) => {
  const r = pairing.approve(req.params.codeId, req.body);
  return r.ok ? res.json(r.value) : pairErr(r, res);
});
app.post("/api/pair/codes/:codeId/cancel", (req, res) => {
  const r = pairing.cancel(req.params.codeId);
  return r.ok ? res.json(r.value) : pairErr(r, res);
});

app.get("/api/network", (_req, res) => res.json({ configFile, devices: monitor.network() }));
// Devices are configured in dpi-network.yaml and `just net register`; the hub only reads them.
app.post(
  "/api/devices/:id/check",
  safe(async (req, res) => {
    const id = String(req.params.id);
    if (!registry.get(id)) throw Object.assign(Error(`No device ${id}`), { status: 404 });
    monitor.check(id);
    res.json(await monitor.settled(id));
  }),
);
app.get("/api/ui-state/:key", (req, res) =>
  res.json({ value: registry.uiGet(String(req.params.key)) ?? null }),
);
app.put(
  "/api/ui-state/:key",
  safe((req, res) => {
    registry.uiSet(String(req.params.key), req.body?.value ?? null);
    res.json({ ok: true });
  }),
);
app.get("/api/stream", (req, res) => mux.open(req, res));
app.put(
  "/api/stream/:streamId",
  safe((req, res) => res.json(mux.subscribe(String(req.params.streamId), req.body?.subs))),
);
app.all("/api/devices/:id/v1/{*rest}", proxy(registry, monitor, {
  dispatcherFor: (row) => new TunnelTransport(row, dispatcher),
  hasLiveConnection: (id) => tunnel.hasConnection(id),
}));
app.use("/api", (_req, res) => res.status(404).json(err("not_found", "API route not found")));

const server = createServer(app);
let vite: Awaited<ReturnType<(typeof import("vite"))["createServer"]>> | undefined;
if (args.includes("--dev")) {
  const { createServer: createVite } = await import("vite");
  vite = await createVite({
    configFile: resolve(appDir, "apps/dpi-playground-fe/vite.config.ts"),
    server: { middlewareMode: true, hmr: { server } },
  });
  app.use(vite.middlewares);
} else {
  app.use(express.static(resolve(appDir, "apps/dpi-playground-fe/dist")));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(resolve(appDir, "apps/dpi-playground-fe/dist/index.html")),
  );
}

// Tunnel endpoint (04 §4): /api/tunnel upgrades after hash-first credential
// auth. In --dev mode Vite owns its own HMR upgrade path, so only the exact
// tunnel path is claimed here and other upgrades are left alone.
const tunnel = new TunnelServer(registry, audit, hubId);
const dispatcher = new TunnelDispatcher(tunnel);
mux.setTunnelSource({
  dispatcherFor: (row) => new TunnelTransport(row, dispatcher),
  hasLiveConnection: (id) => tunnel.hasConnection(id),
});
monitor.setTunnelSource({
  dispatcherFor: (row) => new TunnelTransport(row, dispatcher),
  hasLiveConnection: (id) => tunnel.hasConnection(id),
});
server.on("upgrade", (req, socket, head) => {
  let path = "/";
  try {
    path = new URL(req.url ?? "/", "http://hub.local").pathname;
  } catch {
    /* reject below */
  }
  if (path === "/api/tunnel") tunnel.handleUpgrade(req, socket, head);
  else if (!vite) socket.destroy();
});

server.listen(port, host, () => {
  console.log(`Durable Pi hub: http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
  console.log(
    `registry: ${registry.path}${configFile ? `  config: ${configFile}` : "  (no dpi-network.yaml)"}`,
  );
  console.log(
    `devices: ${
      registry
        .list()
        .map((d) => d.id)
        .join(", ") || "none"
    }`,
  );
  if (host !== "127.0.0.1" && host !== "localhost")
    console.warn(
      `WARNING: the hub is listening on ${host}. Anyone who can reach it can drive every device it holds tokens for.`,
    );
});

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  dispatcher.close();
  tunnel.close();
  monitor.stop();
  server.close();
  server.closeAllConnections();
  await vite?.close();
  registry.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
