/**
 * DeviceTransport seam (spec 04 §1): the ONLY way monitor/mux/proxy reach a
 * device. LAN today; TunnelTransport (over the hub's authenticated device
 * connection) lands in P2-12 — until then tunnel rows have no transport and
 * there is NEVER a silent LAN fallback.
 *
 * Consumers own their retry loops; transports must not nest another one.
 */
import { DpiClient } from "../../../../dpi-sdk/src/client.js";
import { DpiError } from "../../../../dpi-sdk/src/errors.js";
import { validateRestRequest } from "../../../../dpi-sdk/src/protocol/tunnel.js";
import {
  LOGICAL_MESSAGE_MAX_BYTES,
  REST_PATH_PREFIX,
} from "../../../../dpi-sdk/src/protocol/limits.js";
import type { Frame } from "../../../../dpi-sdk/src/api.js";
import type { DeviceRow } from "../../../../dpi-sdk/src/node/registry.js";

export interface TransportRequest {
  method: string;
  path: string;
  idempotencyKey?: string;
  body?: unknown;
}

export interface TransportResponse {
  status: number;
  contentType?: string;
  /** Raw text for proxy passthrough, parsed JSON where the caller knows the shape.
   *  When bodyEncoding is "base64" this is the base64 of the device's raw bytes. */
  body?: unknown;
  /** Present ("base64") only for non-textual device responses (R8 binary passthrough):
   *  absent means body is plain UTF-8 text as before. */
  bodyEncoding?: "base64";
  /** Sanitized Content-Disposition from the device (binary responses); may be undefined. */
  contentDisposition?: string;
  /** R13 (R9-6.3 FE): the device answered this request with an idempotency
   *  REPLAY — the proxy surfaces it as the Idempotent-Replay response header
   *  so clients can tell a replay from a fresh create. */
  idempotentReplay?: true;
  /** Diagnostics: assembled byte count for chunked responses. */
  rawBytes?: number;
}

export interface DeviceTransport {
  readonly deviceId: string;
  readonly kind: "lan" | "tunnel";
  readonly available: boolean;
  request(input: TransportRequest, signal: AbortSignal): Promise<TransportResponse>;
  watch(input: { path: string; consumerId: string }, signal: AbortSignal): AsyncIterable<Frame>;
}

const REST_TIMEOUT_MS = 330_000;

/** Wire-textual content types — matches the device-side classifier in dpi-backend/tunnel.ts. */
const TEXTUAL_CT_RE = /^(?:text\/|application\/(?:json|javascript|xml|x-www-form-urlencoded)(?:;|$))/i;
/** Device headers are untrusted at the ADMIN origin: printable ASCII only, bounded length. */
const safeHeaderValue = (value: string | null | undefined): string | undefined => {
  if (!value) return undefined;
  const clean = value.replace(/[^\x20-\x7E]/g, "").slice(0, 200).trim();
  return clean.length > 0 ? clean : undefined;
};

/** Direct LAN device: full token injection, exactly today's behavior. */
export class LanTransport implements DeviceTransport {
  readonly kind = "lan" as const;
  readonly deviceId: string;
  readonly available: boolean;
  private readonly client: DpiClient;
  private readonly token?: string;

  constructor(row: Pick<DeviceRow, "id" | "url" | "token" | "transport">) {
    this.deviceId = row.id;
    this.available = row.transport === "lan" && !!row.url && !!row.token;
    this.token = row.token ?? undefined;
    this.client = new DpiClient(row.url ?? "http://unavailable.invalid", this.token);
  }

  private authHeaders(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}`, "x-dpi-token": this.token } : {};
  }

  async request(input: TransportRequest, signal: AbortSignal): Promise<TransportResponse> {
    if (!this.available) throw new DpiError("unauthorized", "LAN device has no URL/token", 0);
    // R16 (run-2 h4 parity): the tunnel dispatcher runs the REST allowlist on
    // every request; the LAN leg must not be the weaker twin — same principal
    // today, but drift here would surface as a hub-frontend-only capability.
    // The tunnel contract carries the /v1 prefix; this leg's paths are already
    // prefix-stripped, so re-attach it for the shared validator.
    const allow = validateRestRequest({
      method: input.method,
      path: input.path.startsWith(REST_PATH_PREFIX)
        ? input.path
        : `${REST_PATH_PREFIX}${input.path}`,
    });
    if (!allow.ok) throw new DpiError("invalid", allow.error ?? "path not allowed", 400);
    const timeout = AbortSignal.timeout(REST_TIMEOUT_MS);
    const effective = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const hasBody = !["GET", "HEAD", "DELETE"].includes(input.method);
    let response: Response;
    try {
      response = await fetch(this.client.baseUrl + input.path, {
        method: input.method,
        headers: {
          ...this.authHeaders(),
          ...(hasBody && input.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(input.idempotencyKey ? { "idempotency-key": input.idempotencyKey } : {}),
        },
        body: hasBody && input.body !== undefined ? JSON.stringify(input.body) : undefined,
        signal: effective,
        // R18 (run-4 h5): the device-side connector refuses redirects (one
        // exact origin); a compromised LAN peer must not aim the hub's fetches
        // elsewhere. 3xx → clean 502, same as the connector.
        redirect: "manual",
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new DpiError("offline", `Cannot reach ${this.client.baseUrl}`, 0, { cause });
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new DpiError(
        "offline",
        `Device API answered with a redirect (${response.status}); redirects are not followed`,
        502,
      );
    }
    // R17 (run-3 h8): size parity with the tunnel leg — the device connector
    // caps its own fetches (16 MiB textual / binary cap) and reassembly
    // budgets bound the tunnel; this leg used to buffer arrayBuffer() with NO
    // cap, so a hostile LAN peer (or compromised device) could OOM the whole
    // hub process. Mirror the connector's capped reader.
    const ct = response.headers.get("content-type") ?? undefined;
    const textual = ct === undefined || TEXTUAL_CT_RE.test(ct);
    const capped = await readBodyCapped(response, textual ? LOGICAL_MESSAGE_MAX_BYTES : BINARY_RESPONSE_MAX_BYTES);
    if (!capped.ok)
      throw new DpiError("invalid", `device answer exceeds ${textual ? "16 MiB" : "12 MB"}`, 413);
    const raw = capped.bytes;
    // Textual responses keep the legacy plain-string shape; binaries are base64-flagged
    // so the proxy can serve bytes byte-exact (R8 binary passthrough).
    return {
      status: response.status,
      contentType: ct,
      body: textual ? raw.toString("utf8") : raw.toString("base64"),
      ...(textual ? {} : { bodyEncoding: "base64" as const }),
      ...(textual ? {} : { contentDisposition: safeHeaderValue(response.headers.get("content-disposition")) }),
      // R13 (R9-6.3 FE): same replay verdict on the LAN leg — one TransportResponse
      // contract, both transports.
      ...(response.headers.get("idempotent-replay") === "true" ? { idempotentReplay: true as const } : {}),
    };
  }

  async *watch(
    input: { path: string; consumerId: string },
    signal: AbortSignal,
  ): AsyncIterable<Frame> {
    if (!this.available) throw new DpiError("unauthorized", "LAN device has no URL/token", 0);
    yield* this.client.stream(input.path, signal);
  }
}

/**
 * Explicit transport selection from the registry row. Tunnel rows need the
 * hub's live-connection dispatcher (P2-15); without one callers report "no
 * tunnel connection" — they NEVER fall back to the LAN URL.
 */
export function transportFor(
  row: DeviceRow,
  tunnel?: { dispatcherFor(row: DeviceRow): DeviceTransport },
): DeviceTransport | undefined {
  if (row.transport === "tunnel") return tunnel ? tunnel.dispatcherFor(row) : undefined;
  return new LanTransport(row);
}

/**
 * R17 (run-3 h8): the binary cap mirrors the device connector's own reader
 * (tunnel.ts uses 12_000_000 — aligned exactly so a binary that passes one
 * leg never surprises the other).
 */
const BINARY_RESPONSE_MAX_BYTES = 12_000_000;

async function readBodyCapped(
  res: Response,
  cap: number,
): Promise<{ ok: true; bytes: Buffer } | { ok: false }> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => {});
    return { ok: false };
  }
  if (!res.body) return { ok: true, bytes: Buffer.alloc(0) };
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return { ok: false };
    }
    parts.push(value);
  }
  return { ok: true, bytes: Buffer.concat(parts) };
}
