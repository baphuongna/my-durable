// dpi-backend: one device of the Durable Agent Network.
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { assertLimitsConfig } from "../../dpi-sdk/src/protocol/limits.js";
import { createServer } from "node:http";
import { writeFileSync, rmSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { loadConfig, deviceHome } from "./config.js";
import { Store, PACKAGE_VERSION } from "./store.js";
import { installCrashHandlers } from "./crash.js";
import { bearerAuth } from "./auth.js";
import { errorMiddleware } from "./errors.js";
import { v1 } from "./routes.js";
import { DevicePairing } from "./pairing.js";
import { DeviceConnector, readCaPem } from "./tunnel.js";
import { PAIR_PAGE_HTML } from "./pair-page.js";
import { parseDeviceSub, runDeviceCommand, daemonPaths, boundedStep } from "./daemon.js";

// `dpi device start|stop|status|install|uninstall` manage a background daemon
// and exit; everything else (bare `dpi device` or flags) runs the daemon here.
{
  const { sub, rest } = parseDeviceSub(process.argv.slice(2));
  if (sub !== "run") process.exit(await runDeviceCommand(sub, rest));
}

assertLimitsConfig();

// Crash reports (policy gate #1) are installed FIRST, before anything below can
// throw: a config or store failure still leaves a redacted local report (nothing
// is ever uploaded). The state getter reads the store lazily — before it opens,
// every count is simply "unknown".
let crashStore: Store | null = null;
installCrashHandlers({
  home: deviceHome(),
  version: PACKAGE_VERSION,
  startedAt: Date.now(),
  state: () => {
    if (!crashStore) return {};
    const n = <T,>(f: () => T): T | undefined => {
      try {
        return f();
      } catch {
        return undefined;
      }
    };
    return {
      openSessions: n(() => crashStore!.list().length),
      totalSessions: n(() => crashStore!.list().length),
      schedules: n(() => crashStore!.schedules.list().length),
      graphs: n(() => crashStore!.graphList(true).length),
      runsInFlight: [...crashStore.graphRunsInFlight],
      notifySinks: n(() => crashStore!.notifySinkList().length),
    };
  },
});

const config = await loadConfig();
const store = await Store.open({
  dataDir: config.dataDir,
  startDirs: config.startDirs,
  name: config.name,
  provider: config.provider,
  envFile: config.envFile,
  telegramToken: process.env.DPI_TELEGRAM_TOKEN,
});
crashStore = store;

const app = express();
app.disable("x-powered-by");
app.get("/healthz", (_req, res) => res.json({ ok: true }));
// The base URL is what people type first; a JSON 404 reads like a broken
// daemon. Land them on the one real page (unpaired: enroll; paired: status).
app.get("/", (_req, res) => res.redirect("/pair"));
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
  {
    baseUrl: `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`,
    token: config.token,
  },
);
connector.start();
// GET /pair + /v1/pair-enroll — the device-side browser enrollment surface
// (gap #4). Unauthenticated BUT narrow: the custom x-dpi-pair header forces a
// CORS preflight on every foreign origin (a drive-by page cannot POST), the
// POST only runs while UNPAIRED (a paired device re-pairs through the TUI's
// token-authed route with force), and the status view carries no secrets.
const pairEnrollGuard = (req: Request, res: Response, next: NextFunction) => {
  if (req.get("x-dpi-pair") !== "1")
    return res
      .status(403)
      .json({ error: { code: "forbidden", message: "missing x-dpi-pair header" } });
  next();
};
app.get("/pair", (_req, res) => res.type("html").send(PAIR_PAGE_HTML));
app.get("/v1/pair-enroll", pairEnrollGuard, (_req, res) => {
  const s = pairing.status();
  res.json({
    state: s.state,
    deviceName: s.deviceName,
    fingerprint: s.fingerprint,
    hubOrigin: s.hubOrigin ?? s.pending?.hubOrigin,
    lastError: s.lastError,
  });
});
app.post("/v1/pair-enroll", pairEnrollGuard, express.json({ limit: "8kb" }), (req, res) => {
  void (async () => {
    const s = pairing.status();
    if (s.state === "paired")
      return res
        .status(409)
        .json({
          error: {
            code: "paired",
            message:
              "this device is already paired; re-pairing runs in the TUI (dpi tui) so it stays operator-driven",
          },
        });
    if (s.state === "pairing")
      return res
        .status(409)
        .json({
          error: {
            code: "busy",
            message: "a pairing operation is already running — watch its status below",
          },
        });
    const pairUrl = (req.body as { pairUrl?: unknown } | null)?.pairUrl;
    if (typeof pairUrl !== "string" || pairUrl.length === 0 || pairUrl.length > 4096)
      return res
        .status(400)
        .json({
          error: {
            code: "invalid",
            message: "body: { pairUrl: string } — the offer link from the hub",
          },
        });
    try {
      await pairing.start({ code: "", pairUrl });
      const after = pairing.status();
      res.json({
        state: after.state,
        deviceName: after.deviceName,
        fingerprint: after.fingerprint,
        hubOrigin: after.pending?.hubOrigin,
        lastError: after.lastError,
      });
    } catch (e) {
      res.status((e as { status?: number }).status ?? 400).json({
        error: { code: (e as { code?: string }).code ?? "invalid", message: (e as Error).message },
      });
    }
  })();
});
app.use(
  "/v1",
  bearerAuth(config.token),
  express.json({ limit: "256kb" }),
  v1(store, pairing, connector, () => void shutdown()),
);
app.use((_req, res) =>
  res.status(404).json({ error: { code: "not_found", message: "Route not found" } }),
);
app.use(errorMiddleware);

const server = createServer(app);
server.keepAliveTimeout = 65_000;
server.listen(config.port, config.host, () => {
  // Pid file for `dpi device stop/status` (written fresh every boot).
  try {
    writeFileSync(daemonPaths(process.env).pid, String(process.pid));
  } catch {
    /* read-only home: stop falls back to the HTTP shutdown */
  }
  console.log(
    `dpi-backend "${config.name}" (uid ${store.uid}) on http://${config.host}:${config.port}`,
  );
  if (config.tokenCreated)
    console.log(`first run: created DPI_TOKEN in ${config.envFile} — keep this file private`);
  console.log(
    `data: ${config.dataDir}  start dirs: ${config.startDirs.join(", ")}  provider: ${config.provider}`,
  );
  if (config.host === "0.0.0.0")
    for (const addresses of Object.values(networkInterfaces()))
      for (const a of addresses ?? [])
        if (a.family === "IPv4" && !a.internal)
          console.log(`LAN: http://${a.address}:${config.port}`);
  console.log(`background: dpi device start | stop | status | install (service)`);
  {
    const providers = [...new Set(store.modelList.map((m) => m.provider))];
    if (providers.length) console.log(`providers: ${providers.join(", ")} (pi auth/models.json + env)`);
    for (const s of store.pi.skipped) console.log(`  custom provider ${s.id} skipped: ${s.reason}`);
  }
  if (store.keyless)
    console.log(
      `no provider key: the model list is the built-in catalog; set OPENROUTER_API_KEY in ${config.envFile} to chat`,
    );

  // Enrollment guidance: an unpaired machine must be told exactly what to do,
  // and — when a hub is configured — it asks for a code ITSELF so the operator
  // reads this machine's identity in the hub's approval list (no secret to carry).
  const boot = pairing.status();
  if (boot.state === "unpaired") {
    const hubOrigin = process.env.DPI_HUB_URL;
    console.log("");
    console.log(`unpaired: open http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}/pair`);
    if (hubOrigin) {
      console.log(`requesting a pairing code from ${hubOrigin} …`);
      void pairing
        .start({ hub: hubOrigin })
        .then((s) => {
          if (s.state !== "pairing") return;
          console.log("");
          console.log(`  APPROVE THIS MACHINE ON THE HUB (${s.pending?.hubOrigin ?? hubOrigin}):`);
          console.log(`    device    ${s.deviceName}`);
          console.log(`    fingerprint ${s.fingerprint}`);
          console.log("  Compare that fingerprint with the hub's approval card, then approve there.");
          console.log("  This command keeps running; the credential is saved automatically.");
        })
        .catch((e: Error) => {
          console.log(`pairing request failed: ${e.message}`);
          console.log(`retry from the TUI (dpi tui, then /pair --hub ${hubOrigin}) or open /pair`);
        });
    } else {
      console.log(`  then pair from the hub wizard, or run: dpi tui  →  /pair <code> --hub <origin>`);
      console.log("  set DPI_HUB_URL=<https origin> to let this machine request a code by itself");
    }
  }
});

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  // R6 cli finding 10: `dpi device stop` hung twice at teardown (40s+, zero
  // output, device stayed healthy; direct SIGTERM exits <5s). No step of the
  // shutdown may block forever:
  //   - connector.stop is synchronous; a throw is logged, never fatal;
  //   - store.close is raced against a 5s ceiling (boundedStep) and abandoned;
  //   - a hard watchdog guarantees the process still exits at 10s.
  const log = (line: string) => console.log(line);
  const watchdog = setTimeout(() => {
    console.log("shutdown: still not down after 10s — forcing exit");
    process.exit(0);
  }, 10_000);
  try {
    await boundedStep("connector.stop", 5_000, () => connector.stop("backend shutdown"), log);
  } catch (e) {
    log(`shutdown: connector stop failed (${e instanceof Error ? e.message : String(e)}) — continuing`);
  }
  server.close();
  server.closeAllConnections();
  try {
    await boundedStep("store.close", 5_000, () => store.close(), log);
  } catch (e) {
    log(`shutdown: store close failed (${e instanceof Error ? e.message : String(e)}) — exiting anyway`);
  }
  try {
    rmSync(daemonPaths(process.env).pid, { force: true });
  } catch {
    /* nothing to clean */
  }
  clearTimeout(watchdog);
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
