// REST proxy: /api/devices/:id/v1/... → <device url>/v1/... with the device token injected.
// Streams never go through here; browsers get them from the mux (one connection per tab).
import type { RequestHandler } from "express";
import type { NetworkRegistry } from "../../../../dpi-sdk/src/node/registry.js";
import type { DeviceMonitor } from "./monitor.js";
import { transportFor } from "./transport.js";
import type { TunnelTransportSource } from "./monitor.js";
import { DpiError } from "../../../../dpi-sdk/src/errors.js";

const err = (code: string, message: string) => ({ error: { code, message } });

// A device's response is attacker-influenced data served from the ADMIN origin,
// where the browser holds the operator's credentials. It may therefore never
// become an active document: only JSON keeps its type, every other type is an
// opaque download, and the headers below stay on even for JSON.
const mediaType = (value: string | undefined) =>
  (value ?? "").split(";", 1)[0].trim().toLowerCase();
const LOCKED_DOWN_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
} as const;

/** The app reaches this route with fetch()/XHR only (`Sec-Fetch-Dest: empty`); a navigation or an embed is a lure. */
const isBrowserLoad = (req: Parameters<RequestHandler>[0]) => {
  const dest = req.get("sec-fetch-dest");
  return req.get("sec-fetch-mode") === "navigate" || (dest !== undefined && dest !== "empty");
};

export function proxy(
  registry: NetworkRegistry,
  monitor: DeviceMonitor,
  tunnel?: TunnelTransportSource,
): RequestHandler {
  return async (req, res) => {
    if (isBrowserLoad(req))
      return void res
        .status(403)
        .json(err("forbidden", "Device responses are only served to API clients"));
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
    // Fail closed: when the matched URL does not start with the device prefix, forwarding the
    // raw originalUrl would send the whole /api/devices/... path to the device.
    if (!req.originalUrl.startsWith(prefix))
      return void res.status(400).json(err("invalid", "Request path is outside the device prefix"));
    const path = req.originalUrl.slice(prefix.length);
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
      const body =
        typeof upstream.body === "string" ? upstream.body : JSON.stringify(upstream.body ?? {});
      // The device is untrusted input at the ADMIN origin. Only final statuses may reach the
      // operator's client: the plain-frame schema admits 100-599 and a 1xx hangs or kills the
      // client connection; the chunked envelope carries no schema at all. A bad envelope is a
      // bad gateway, never the device's own status line.
      const status =
        typeof upstream.status === "number" &&
        Number.isInteger(upstream.status) &&
        upstream.status >= 200 &&
        upstream.status <= 599
          ? upstream.status
          : undefined;
      if (status === undefined)
        return void res
          .status(502)
          .json(err("invalid", `${device.name} answered out of contract (status)`));
      const contentType =
        typeof upstream.contentType === "string" ? upstream.contentType : undefined;
      res.status(status).set(LOCKED_DOWN_HEADERS);
      // R13 (R9-6.3 FE): the device's replay verdict surfaces as the standard
      // header — a hub-controlled literal (never a passthrough of arbitrary
      // device header names/values), same trust boundary as the zip label.
      if (upstream.idempotentReplay === true) res.set("Idempotent-Replay", "true");
      if (!contentType || mediaType(contentType) === "application/json")
        res.type("application/json").send(body);
      else {
        // R8 binary passthrough: base64-flagged device payloads are decoded byte-exact for
        // EVERY type; the LABEL is controlled by the hub. Only application/zip (the export
        // contract) keeps its type + the device's sanitized download filename — every other
        // non-JSON type stays an inert octet-stream attachment (Gate A GA-01), so a hostile
        // device cannot rebrand its bytes as html/svg/js at the ADMIN origin.
        const payload =
          upstream.bodyEncoding === "base64"
            ? Buffer.from(String(upstream.body ?? ""), "base64")
            : Buffer.from(body, "utf8");
        const isZip = mediaType(contentType) === "application/zip";
        const disposition =
          isZip && typeof upstream.contentDisposition === "string"
            ? upstream.contentDisposition
            : 'attachment; filename="device-response.bin"';
        res.type(isZip ? contentType : "application/octet-stream")
          .set("Content-Disposition", disposition)
          .send(payload);
      }
    } catch (e) {
      if (closed.signal.aborted) return;
      // Status-carrying tunnel outcomes keep their semantics: 413 too-large,
      // 429 pending-full, 504 deadline, 503 offline/unknown-outcome (a
      // mutation is NEVER auto-retried with a fresh reqId here — the client
      // sees the failure and decides). Everything else is a bad gateway.
      const dpi = e instanceof DpiError ? e : undefined;
      const status =
        dpi?.status && dpi.status >= 400 && dpi.status <= 599
          ? dpi.status
          : dpi?.code === "invalid"
            ? 400
            : 502;
      const code =
        dpi?.code === "rate_limited"
          ? "rate_limited"
          : dpi?.code === "timeout" || status === 504
            ? "timeout"
            : status === 503
              ? "unavailable"
              : dpi?.code === "invalid"
                ? "invalid"
                : "offline";
      if (!dpi || dpi.code === "offline") monitor.check(id);
      res.status(status).json(err(code, `${device.name}: ${(e as Error).message}`));
    }
  };
}
