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
  /** Raw text for proxy passthrough, parsed JSON where the caller knows the shape. */
  body?: unknown;
}

export interface DeviceTransport {
  readonly deviceId: string;
  readonly kind: "lan" | "tunnel";
  readonly available: boolean;
  request(input: TransportRequest, signal: AbortSignal): Promise<TransportResponse>;
  watch(input: { path: string; consumerId: string }, signal: AbortSignal): AsyncIterable<Frame>;
}

const REST_TIMEOUT_MS = 330_000;

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
    const text = await response.text();
    return { status: response.status, contentType: response.headers.get("content-type") ?? undefined, body: text };
  }

  async *watch(input: { path: string; consumerId: string }, signal: AbortSignal): AsyncIterable<Frame> {
    if (!this.available) throw new DpiError("unauthorized", "LAN device has no URL/token", 0);
    yield* this.client.stream(input.path, signal);
  }
}

/**
 * Explicit transport selection from the registry row. Tunnel rows return
 * undefined until TunnelTransport exists (P2-12) — callers report "no tunnel
 * connection", they do NOT fall back to LAN.
 */
export function transportFor(row: DeviceRow): DeviceTransport | undefined {
  if (row.transport === "tunnel") return undefined;
  return new LanTransport(row);
}
