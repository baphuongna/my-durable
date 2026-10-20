// REST proxy: /api/devices/:id/v1/... → <device url>/v1/... with the device token injected.
// Streams never go through here; browsers get them from the mux (one connection per tab).
import type { RequestHandler } from "express";
import type { NetworkRegistry } from "../../../../dpi-sdk/src/node/registry.js";
import type { DeviceMonitor } from "./monitor.js";
import { transportFor } from "./transport.js";
import type { TunnelTransportSource } from "./monitor.js";
import { DpiError } from "../../../../dpi-sdk/src/errors.js";

const err = (code: string, message: string) => ({ error: { code, message } });

export function proxy(registry: NetworkRegistry, monitor: DeviceMonitor, tunnel?: TunnelTransportSource): RequestHandler {
  return async (req, res) => {
    const id = String(req.params.id);
    const device = registry.get(id);
    if (!device) return void res.status(404).json(err("not_found", `No device ${id}`));
    const live = monitor.state(id);
    const transport = transportFor(device, tunnel);
    if (live?.status !== "online" || !transport?.available)
      return void res
        .status(503)
        .json(
          err(
            "unavailable",
            `${device.name} is ${live?.status ?? "checking"}${live?.error ? `: ${live.error}` : ""}`,
          ),
        );
    const prefix = `/api/devices/${encodeURIComponent(id)}`;
    const path = req.originalUrl.startsWith(prefix)
      ? req.originalUrl.slice(prefix.length)
      : req.originalUrl;
    if (/\/events(\?|$)/.test(path))
      return void res.status(400).json(err("invalid", "Streams are served by /api/stream"));
    const closed = new AbortController();
    res.on("close", () => closed.abort());
    try {
      const upstream = await transport!.request(
        {
          method: req.method,
          path,
          idempotencyKey: req.get("idempotency-key") ?? undefined,
          body: req.body ?? {},
        },
        closed.signal,
      );
      res
        .status(upstream.status)
        .type(upstream.contentType ?? "application/json")
        .send(typeof upstream.body === "string" ? upstream.body : JSON.stringify(upstream.body ?? {}));
    } catch (e) {
      if (closed.signal.aborted) return;
      // Status-carrying tunnel outcomes keep their semantics: 413 too-large,
      // 429 pending-full, 504 deadline, 503 offline/unknown-outcome (a
      // mutation is NEVER auto-retried with a fresh reqId here — the client
      // sees the failure and decides). Everything else is a bad gateway.
      const dpi = e instanceof DpiError ? e : undefined;
      const status = dpi?.status && dpi.status >= 400 && dpi.status <= 599 ? dpi.status : dpi?.code === "invalid" ? 400 : 502;
      const code =
        dpi?.code === "rate_limited" ? "rate_limited"
        : dpi?.code === "timeout" || status === 504 ? "timeout"
        : status === 503 ? "unavailable"
        : dpi?.code === "invalid" ? "invalid"
        : "offline";
      if (!dpi || dpi.code === "offline") monitor.check(id);
      res
        .status(status)
        .json(err(code, `${device.name}: ${(e as Error).message}`));
    }
  };
}
