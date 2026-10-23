// The playground hub: the local registry of devices (~/.dpi/network.sqlite), their live status,
// a REST proxy that injects device tokens, one multiplexed SSE stream per browser tab, and the
// Vue client. It runs no agents; every agent lives in some device's dpi-backend.
import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { extname, resolve } from "node:path";
import { hostname, networkInterfaces } from "node:os";
import { NetworkRegistry, UI_STATE_MAX_CHARS } from "../../../../dpi-sdk/src/node/registry.js";
import { ByteBudget } from "../../../../dpi-sdk/src/node/chunk.js";
import { DeviceMonitor } from "./monitor.js";
import { StreamMux } from "./mux.js";
import { proxy } from "./proxy.js";
import { guard, requireTls } from "./guard.js";
import { ipKey, isTrustedProxy, viaTls } from "./client-ip.js";
import { Audit, denialLogging } from "./audit.js";
import {
  ADMIN_COOKIE,
  LOGIN_RATE,
  SESSION_TTL_MS,
  bootstrapAdminToken,
  requireAdmin,
  signSession,
  tokenEquals,
} from "./admin-auth.js";
import { bootstrapHubIdentity } from "./hub-identity.js";
import { body as failureBody, describeFailure, errorMiddleware, safe } from "./http-errors.js";
import { TokenBuckets } from "./limiter.js";
import { PairingService } from "./pairing.js";
import { CredentialService } from "./credentials.js";
import { TunnelServer } from "./tunnel.js";
import { TunnelDispatcher, TunnelTransport } from "./tunnel-transport.js";
import { RotationService } from "./rotation.js";
import { seedFromConfig } from "./seed.js";
import {
  assertLimitsConfig,
  API_RATE_LIMITS,
  HUB_BUFFER_BUDGET_BYTES,
} from "../../../../dpi-sdk/src/protocol/limits.js";

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
// A public host means the hub sits behind the TLS proxy, so it then refuses anything the proxy did not
// vouch for (spec 05 §4.2). DPI_HUB_REQUIRE_TLS=1/0 overrides either way; a typo stops the start instead of
// silently picking a side.
function tlsRequired(): boolean {
  const raw = process.env.DPI_HUB_REQUIRE_TLS;
  if (raw === undefined || raw === "") return publicHost !== "";
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw Error("DPI_HUB_REQUIRE_TLS must be 1 or 0");
}
const requireTlsEnabled = tlsRequired();

const registry = new NetworkRegistry();
registry.clearTunnelState(); // live tunnel state is RAM-only; never resurrect from DB
// The operator's own credential: minted at first boot into DPI_HOME/admin.token (0600),
// overridable via DPI_ADMIN_TOKEN. A set-but-short token refuses to boot (admin-auth.ts).
const adminToken = bootstrapAdminToken();
// Gap #5: later boots point the operator at the file — the value itself only
// ever appears on the first-boot mint line (admin-auth.ts).
if (!adminToken.created) console.log(`admin: login with the token in ${adminToken.path}`);
const configFile = seedFromConfig(registry, appDir);
const monitor = new DeviceMonitor(registry);
monitor.start();
const bufferBudget = new ByteBudget("hub", HUB_BUFFER_BUDGET_BYTES);
const mux = new StreamMux(registry, monitor, { budget: bufferBudget });

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

const app = express();
// F10: behind the reference TLS proxy (same-host Caddy) the socket address
// is always loopback — trust ONLY loopback proxies so req.ip reflects the
// real client via the proxy-overwritten X-Forwarded-For. Forged XFF from a
// non-loopback direct connection is ignored (proxy-addr semantics).
app.set("trust proxy", isTrustedProxy);
app.disable("x-powered-by");
// Every answer is non-sniffable; the admin API is never cacheable (it carries pairing codes and, on the
// pairing routes, a credential). Registered first so that refusals made further down carry them too.
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  if (req.path === "/api" || req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
  next();
});
app.get("/healthz", (_req, res) => res.json({ ok: true }));
// All CANON limits must be sane or the hub refuses to start (P2-22: fail startup, not per-request).
assertLimitsConfig();
/** Operator floor for free space on the registry volume (bytes); below it audited changes are refused with 503. */
function auditFloorFromEnv(): { minFreeBytes?: number } {
  const raw = process.env.DPI_AUDIT_MIN_FREE_BYTES;
  if (raw === undefined || raw === "") return {};
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw Error("DPI_AUDIT_MIN_FREE_BYTES must be a non-negative integer");
  return { minFreeBytes: Number(raw) };
}
const audit = new Audit(registry, auditFloorFromEnv());
audit.startSweeper();
// Gap #6: the hub's persistent identity key — its fingerprint is the `kfp`
// pinned inside every v3 pairing offer and proven at ceremony + tunnel connect.
const identity = bootstrapHubIdentity(undefined, audit);
if (adminToken.created)
  audit.append({
    actor: "hub",
    action: "admin.token_created",
    outcome: "ok",
    detail: { file: adminToken.path },
  });
/** Every admin route requires this: the dpi_admin cookie or the raw token as a bearer. */
const adminAuth = requireAdmin(adminToken.token);
// Everything registered below needs proof of TLS; /healthz (above) stays reachable for supervisors.
if (requireTlsEnabled) app.use(denialLogging(audit), requireTls());

/**
 * Per-IP admin-REST token bucket (API_RATE_LIMITS policy; never request-overridable). Bounded to
 * 10.000 addresses with a 15 minute idle TTL; a full table refuses new addresses instead of
 * forgetting the ones that are being limited.
 */
const apiBuckets = new TokenBuckets({
  capacity: API_RATE_LIMITS.capacity,
  perMinute: API_RATE_LIMITS.perMinute,
  maxKeys: 10_000,
  idleTtlMs: 15 * 60_000,
});
setInterval(() => apiBuckets.sweep(), 60_000).unref();
const apiRate: express.RequestHandler = (req, res, next) => {
  const taken = apiBuckets.take(ipKey(req.ip ?? req.socket.remoteAddress ?? "?"));
  if (taken.ok) return void next();
  res.set("Retry-After", String(Math.max(1, Math.ceil(taken.retryAfterMs / 1000))));
  res
    .status(429)
    .json(
      err(
        "rate_limited",
        taken.reason === "full" ? "Too many clients; retry later" : "Too many requests; slow down",
      ),
    );
};
// /healthz exempt (uptime probes must survive floods); one SSE open = one request;
// stream frames are responses and never hit this middleware.

const hubId = (
  registry.db.prepare("SELECT value FROM hub_meta WHERE key='hub_id'").get() as { value: string }
).value;
const hubOrigin = process.env.DPI_HUB_ORIGIN ?? `https://${hostname().toLowerCase()}`;
const credentials = new CredentialService(registry, audit, hubOrigin, hubId, undefined, identity);
const pairing = new PairingService({
  registry,
  audit,
  hubOrigin,
  hubId,
  identity,
  issue: async (e) => {
    const ticket = await credentials.issue(e);
    tunnel.closeConnection(ticket.deviceId, 1000, "pairing replaced");
    monitor.watch(ticket.deviceId);
    return ticket;
  },
  receiptValidator: (t) =>
    credentials.receiptStillValid(t) ? true : { code: credentials.receiptFailure(t) },
});
// F15: housekeeping — past expiry+grace the entry goes, issued receipts
// included (they hold a plaintext token); the RAM maps never grow unbounded.
const pairSweeper = setInterval(() => pairing.sweep(), 60_000);
pairSweeper.unref();
const pairErr = (
  r: { error: { status: number; code: string; message: string; retryAfterMs?: number } },
  res: express.Response,
) =>
  res.status(r.error.status).json({
    error: {
      code: r.error.code,
      message: r.error.message,
      ...(r.error.retryAfterMs ? { retryAfterMs: r.error.retryAfterMs } : {}),
    },
  });

// Public pairing ingress (03 §4) — registered BEFORE the admin /api chain so
// that (a) the pairing 16 KiB body parsers are the FIRST parsers to touch
// these bodies (F20: the global 256 KiB parser must not pre-read them), and
// (b) the admin token bucket never meters the public pairing surface (F10):
// PairingService enforces its own per-IP code/verify buckets + fail-window
// here. Host-allowlist + denial logging still apply.
const pairGuard = [denialLogging(audit), guard(allowedHosts)] as const;
// The operator side of pairing (mint/state/approve/cancel) is admin surface:
// it needs the admin cookie or bearer too. pair/start + pair/verify stay public
// — their bearer is the pairing code, presented by the DEVICE, not the operator.
const adminPairGuard = [denialLogging(audit), guard(allowedHosts), adminAuth] as const;
app.post("/api/pair/code", ...adminPairGuard, express.json({ limit: "16kb" }), (req, res) => {
  const r = pairing.createCode(req.ip ?? "unknown");
  return r.ok ? res.status(201).json(r.value) : pairErr(r, res);
});
app.post("/api/pair/start", ...pairGuard, express.json({ limit: "16kb" }), (req, res) => {
  const r = pairing.start(req.body, req.ip ?? "unknown");
  return r.ok ? res.json(r.value) : pairErr(r, res);
});
app.post("/api/pair/verify", ...pairGuard, express.json({ limit: "16kb" }), async (req, res) => {
  const r = await pairing.verify(req.body, req.ip ?? "unknown");
  if (r.ok) return res.status(r.status).json(r.value);
  pairErr(r, res);
});
/**
 * Device-INITIATED enrollment (public, same guard stack as pair/start): the
 * machine asks for a code, so the operator reads its full identity in the list
 * below instead of carrying a secret between machines.
 */
app.post("/api/pair/request", ...pairGuard, express.json({ limit: "16kb" }), (req, res) => {
  const r = pairing.requestForDevice(req.body, req.ip ?? "unknown");
  return r.ok ? res.json(r.value) : pairErr(r, res);
});
/** Every live request with the identity to approve against (no codes, no key material). */
app.get("/api/pair/codes", ...adminPairGuard, (_req, res) => res.json({ codes: pairing.listPending() }));
app.get("/api/pair/codes/:codeId", ...adminPairGuard, (req, res) => {
  const r = pairing.status(String(req.params.codeId));
  return r.ok ? res.json(r.value) : pairErr(r, res);
});
app.post(
  "/api/pair/codes/:codeId/approve",
  ...adminPairGuard,
  express.json({ limit: "16kb" }),
  (req, res) => {
    const r = pairing.approve(String(req.params.codeId), req.body);
    return r.ok ? res.json(r.value) : pairErr(r, res);
  },
);
app.post("/api/pair/codes/:codeId/cancel", ...adminPairGuard, (req, res) => {
  const r = pairing.cancel(String(req.params.codeId));
  return r.ok ? res.json(r.value) : pairErr(r, res);
});

// Admin login: POST /api/session {token} → the dpi_admin cookie. Own per-IP bucket
// (5/min burst 5) — a failed guess must never be retried at line rate. Audited as
// admin.login ok|denied with the client address as the actor and no token material.
const loginBuckets = new TokenBuckets({
  capacity: LOGIN_RATE.capacity,
  perMinute: LOGIN_RATE.perMinute,
  maxKeys: 10_000,
  idleTtlMs: 15 * 60_000,
});
setInterval(() => loginBuckets.sweep(), 60_000).unref();
app.post(
  "/api/session",
  denialLogging(audit),
  guard(allowedHosts),
  (req, res, next) => {
    const taken = loginBuckets.take(ipKey(req.ip ?? req.socket.remoteAddress ?? "?"));
    if (taken.ok) return void next();
    res.set("Retry-After", String(Math.max(1, Math.ceil(taken.retryAfterMs / 1000))));
    res.status(429).json(err("rate_limited", "Too many login attempts; slow down"));
  },
  express.json({ limit: "16kb" }),
  (req, res) => {
    const presented = typeof req.body?.token === "string" ? req.body.token : "";
    const ip = req.ip ?? "unknown";
    if (!presented || !tokenEquals(presented, adminToken.token)) {
      audit.denied("admin.login", ip, { reason: "bad_token" });
      return void res.status(401).json(err("unauthorized", "Missing or invalid admin token"));
    }
    const exp = Date.now() + SESSION_TTL_MS;
    audit.append({ actor: `ip:${ipKey(ip)}`, action: "admin.login", outcome: "ok" });
    // Secure only when the request arrived via the TLS proxy: on plain loopback
    // (local development, tests) the flag would just break the cookie.
    res.cookie(ADMIN_COOKIE, signSession(adminToken.token, exp), {
      httpOnly: true,
      sameSite: "strict",
      secure: viaTls(req),
      path: "/",
      maxAge: SESSION_TTL_MS,
    });
    res.json({ ok: true, exp });
  },
);

// Admin /api surface: guarded, rate-bucketed per real client IP, 256 KiB JSON,
// and behind the admin credential (cookie or bearer).
app.use(
  "/api",
  denialLogging(audit),
  guard(allowedHosts),
  apiRate,
  express.json({ limit: "256kb" }),
  adminAuth,
);
app.post("/api/pair/resolve", (req, res) => {
  const r = pairing.resolveCode(req.body);
  return r.ok ? res.json(r.value) : pairErr(r, res);
});
app.get("/api/pairings", (_req, res) =>
  res.json(
    monitor.network().flatMap((device) =>
      device.pairing && device.deviceUid && device.tunnel
        ? [
            {
              ...device.pairing,
              deviceId: device.id,
              deviceUid: device.deviceUid,
              deviceName: device.name,
              tunnel: device.tunnel,
            },
          ]
        : [],
    ),
  ),
);
// Keep the original device routes as aliases for existing clients.
app.post(["/api/pairings/:id/rotate", "/api/devices/:id/rotate"], (req, res) => {
  const r = rotation.startRotation(String(req.params.id), `admin:${req.ip ?? "unknown"}`);
  if (r.ok) {
    monitor.refresh();
    return res.status(202).json(r);
  }
  // Honest statuses: an unknown device or a device with no active pairing is a 404,
  // a second rotate while one is in flight is a 409, and only a request that names
  // something that can never rotate (a non-tunnel device) is a 400.
  const status =
    r.code === "unknown_device" || r.code === "no_pairing"
      ? 404
      : r.code === "in_flight"
        ? 409
        : 400;
  const code = status === 404 ? "not_found" : status === 409 ? "conflict" : "invalid";
  return res.status(status).json({ error: { code, message: r.error } });
});
app.post(
  ["/api/pairings/:id/revoke", "/api/devices/:id/revoke"],
  express.json({ limit: "4kb" }),
  (req, res) => {
    const id = String(req.params.id);
    const pairingRow = registry.db
      .prepare("SELECT pairing_epoch FROM pairings WHERE device_id=? AND status='paired'")
      .get(id) as { pairing_epoch: string } | undefined;
    try {
      credentials.revoke(
        id,
        req.body?.reason === "compromise" ? "compromise" : "user",
        `admin:${req.ip ?? "unknown"}`,
      );
    } catch (e) {
      const failure = describeFailure(e);
      return res.status(failure.status).json(failureBody(failure));
    }
    // Durable revoke committed: notice the live transport for ITS epoch and cut
    // it immediately (<1 s). Authorization never waits for a notice ACK.
    if (pairingRow)
      tunnel.send(id, {
        type: "control",
        action: "revoked",
        notice: {
          type: "pair.revoke",
          v: 1,
          deviceId: id,
          pairingEpoch: pairingRow.pairing_epoch,
          reason: req.body?.reason === "compromise" ? "compromise" : "user",
          revokedAt: Date.now(),
        },
      });
    tunnel.closeConnection(id, 1000, "pairing revoked");
    monitor.check(id);
    res.status(202).json({ ok: true });
  },
);

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
    const value = req.body?.value ?? null;
    if (JSON.stringify(value).length > UI_STATE_MAX_CHARS)
      throw Object.assign(Error("UI state value too large"), { status: 413 });
    registry.uiSet(String(req.params.key), value);
    res.json({ ok: true });
  }),
);
app.get("/api/stream", (req, res) => mux.open(req, res));
app.put(
  "/api/stream/:streamId",
  safe((req, res) => res.json(mux.subscribe(String(req.params.streamId), req.body?.subs))),
);
app.all(
  "/api/devices/:id/v1/{*rest}",
  proxy(registry, monitor, {
    dispatcherFor: (row) => new TunnelTransport(row, dispatcher),
    hasLiveConnection: (id) => tunnel.hasConnection(id),
  }),
);
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
  // The shell is the page that holds the operator's credentials. It loads only its own script and
  // styles (plus the stylesheet host of the brand fonts), talks only to this hub and cannot be framed.
  const shellPolicy = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  app.use((_req, res, next) => {
    res.set({
      "Content-Security-Policy": shellPolicy,
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    });
    next();
  });
  app.use(express.static(resolve(appDir, "apps/dpi-playground-fe/dist")));
  app.get("/{*path}", (req, res, next) => {
    // A path that names a file is an asset that does not exist, not a page of the app.
    if (extname(req.path)) return void next();
    res.sendFile(resolve(appDir, "apps/dpi-playground-fe/dist/index.html"));
  });
}
app.use((_req, res) => res.status(404).json(err("not_found", "Not found")));
app.use(errorMiddleware);

// Tunnel endpoint (04 §4): /api/tunnel upgrades after hash-first credential
// auth. In --dev mode Vite owns its own HMR upgrade path, so only the exact
// tunnel path is claimed here and other upgrades are left alone.
const tunnel = new TunnelServer(
  registry,
  audit,
  hubId,
  {},
  { requireTls: requireTlsEnabled },
  {},
  hubOrigin,
  identity,
);
const dispatcher = new TunnelDispatcher(tunnel, { audit, budget: bufferBudget });
const rotation = new RotationService(registry, audit, tunnel, {
  onChange: () => monitor.refresh(),
});
mux.setTunnelSource({
  dispatcherFor: (row) => new TunnelTransport(row, dispatcher),
  hasLiveConnection: (id) => tunnel.hasConnection(id),
});
monitor.setTunnelSource({
  dispatcherFor: (row) => new TunnelTransport(row, dispatcher),
  hasLiveConnection: (id) => tunnel.hasConnection(id),
  diagnostics: (id) => ({
    ...tunnel.diagnostics(id),
    readerCount: dispatcher.subscriptionCount(id),
  }),
});
server.on("upgrade", (req, socket, head) => {
  let path = "/";
  try {
    path = new URL(req.url ?? "/", "http://hub.local").pathname;
  } catch {
    /* reject below */
  }
  if (path !== "/api/tunnel") {
    if (!vite) socket.destroy();
    return;
  }
  // handleUpgrade fails closed on its own; this guard keeps a bug there from ever becoming an uncaught exception.
  try {
    tunnel.handleUpgrade(req, socket, head);
  } catch {
    socket.destroy();
  }
});

server.listen(port, host, () => {
  assertLimitsConfig();
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
  if (requireTlsEnabled)
    console.log(
      "TLS required: only requests the loopback TLS proxy marks X-Forwarded-Proto: https are served",
    );
  console.log(
    `admin: login with the token in ${adminToken.path} (POST /api/session sets the browser cookie)`,
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
  rotation.close();
  monitor.stop();
  server.close();
  server.closeAllConnections();
  await vite?.close();
  audit.flushDenials();
  registry.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
