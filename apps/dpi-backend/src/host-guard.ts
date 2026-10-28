import type { RequestHandler } from "express";
import { hostname, networkInterfaces } from "node:os";

/**
 * R16 (run-2 h1 NV close): the enrollment surface is unauthenticated, and its
 * x-dpi-pair custom header only forces a CORS preflight on FOREIGN origins —
 * a DNS-rebind page (evil.com re-resolving to this device's LAN IP:port) makes
 * every fetch same-origin from the browser's point of view, so the preflight
 * guard does not see it. The Host header survives rebinding untouched: it
 * still says evil.com. Mirror the hub's 421 guard (guard.ts): only hosts this
 * device actually serves may talk to the unauthenticated routes.
 */
export function hostAllowlist(port: number): Set<string> {
  const hosts = new Set([
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    `[::1]:${port}`,
    `${hostname().toLowerCase()}:${port}`,
  ]);
  for (const addresses of Object.values(networkInterfaces()))
    for (const a of addresses ?? []) {
      if (a.family === "IPv4") hosts.add(`${a.address}:${port}`);
      else if (a.family === "IPv6") hosts.add(`[${a.address}]:${port}`);
    }
  return hosts;
}

export function hostGuard(allowed: Set<string>): RequestHandler {
  return (req, res, next) => {
    const host = (req.headers.host ?? "").toLowerCase();
    if (!allowed.has(host))
      return void res
        .status(421)
        .json({ error: { code: "invalid", message: `Unknown Host header: ${host}` } });
    next();
  };
}
