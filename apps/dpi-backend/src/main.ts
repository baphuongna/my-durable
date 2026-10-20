// dpi-backend: one device of the Durable Agent Network.
import express from "express";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { bearerAuth } from "./auth.js";
import { errorMiddleware } from "./errors.js";
import { v1 } from "./routes.js";
import { DevicePairing } from "./pairing.js";
import { DeviceConnector, readCaPem } from "./tunnel.js";

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
const pairing = new DevicePairing(store, config.home, config.name, process.env.DPI_HUB_URL);
// One connector per daemon, from the persisted pairing file (P2-13). DPI_HUB_CA
// narrows TLS trust for the reference profile; verification is never disabled.
const connector = new DeviceConnector(config.home, readCaPem(process.env.DPI_HUB_CA));
connector.start();
app.use("/v1", bearerAuth(config.token), express.json({ limit: "256kb" }), v1(store, pairing, connector));
app.use((_req, res) => res.status(404).json({ error: { code: "not_found", message: "Route not found" } }));
app.use(errorMiddleware);

const server = createServer(app);
server.keepAliveTimeout = 65_000;
server.listen(config.port, config.host, () => {
  console.log(`dpi-backend "${config.name}" (uid ${store.uid}) on http://${config.host}:${config.port}`);
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
