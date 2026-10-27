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
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new DpiError("offline", `Cannot reach ${this.client.baseUrl}`, 0, { cause });
    }
    const raw = Buffer.from(await response.arrayBuffer());
    const ct = response.headers.get("content-type") ?? undefined;
    // Textual responses keep the legacy plain-string shape; binaries are base64-flagged
    // so the proxy can serve bytes byte-exact (R8 binary passthrough).
    const textual = ct === undefined || TEXTUAL_CT_RE.test(ct);
    return {
      status: response.status,
      contentType: ct,
      body: textual ? raw.toString("utf8") : raw.toString("base64"),
      ...(textual ? {} : { bodyEncoding: "base64" as const }),
      ...(textual ? {} : { contentDisposition: safeHeaderValue(response.headers.get("content-disposition")) }),
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
