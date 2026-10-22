// dpi-backend: one device of the Durable Agent Network.
import express from "express";
import { assertLimitsConfig } from "../../dpi-sdk/src/protocol/limits.js";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { bearerAuth } from "./auth.js";
import { errorMiddleware } from "./errors.js";
import { v1 } from "./routes.js";
import { DevicePairing } from "./pairing.js";
import { DeviceConnector, readCaPem } from "./tunnel.js";

assertLimitsConfig();

const config = loadConfig();
const store = await Store.open({
  dataDir: config.dataDir,
  startDirs: config.startDirs,
  name: config.name,
  provider: config.provider,
});

const app = express();
app.disable("x-powered-by");
app.get("/healthz", (_req, res) => res.json({ ok: true }));
const pairing = new DevicePairing(store, config.home, config.name, process.env.DPI_HUB_URL, {
  // Forced hub change (P-5): once the new pairing is persisted the OLD
  // connector is stopped — never two live tunnels for one device, and the old
  // hub keeps its tunnel until a replacement exists.
  stopOldConnector: () => connector.stop("re-pairing: hub changed"),
  // Pairing success (P2-15/20 glue, F05): adopt the freshly persisted pairing
  // file — reload() swaps the RUNNING connector onto the new epoch instead of
  // no-op'ing with stale RAM credential/tuple.
  onPaired: () => connector.reload("re-paired"),
});
// One connector per daemon, from the persisted pairing file (P2-13). DPI_HUB_CA
// narrows TLS trust for the reference profile; verification is never disabled.
const connector = new DeviceConnector(
  config.home,
  readCaPem(process.env.DPI_HUB_CA),
  {
    // The local pairing view follows what the hub did to this pairing.
    onRevoked: (epoch, reason) => pairing.markRevoked(reason, epoch),
    onRotated: (file) => pairing.markRotated(file),
  },
  { baseUrl: `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`, token: config.token },
);
connector.start();
app.use("/v1", bearerAuth(config.token), express.json({ limit: "256kb" }), v1(store, pairing, connector));
app.use((_req, res) => res.status(404).json({ error: { code: "not_found", message: "Route not found" } }));
app.use(errorMiddleware);

const server = createServer(app);
server.keepAliveTimeout = 65_000;
server.listen(config.port, config.host, () => {
  console.log(`dpi-backend "${config.name}" (uid ${store.uid}) on http://${config.host}:${config.port}`);
  if (config.tokenCreated)
    console.log(`first run: created DPI_TOKEN in ${config.envFile} — keep this file private`);
  console.log(`data: ${config.dataDir}  start dirs: ${config.startDirs.join(", ")}  provider: ${config.provider}`);
  if (config.host === "0.0.0.0")
    for (const addresses of Object.values(networkInterfaces()))
      for (const a of addresses ?? [])
        if (a.family === "IPv4" && !a.internal) console.log(`LAN: http://${a.address}:${config.port}`);
});

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  connector.stop("backend shutdown"); // readers/pending ops before storage closes
  server.close();
  server.closeAllConnections();
  await store.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
