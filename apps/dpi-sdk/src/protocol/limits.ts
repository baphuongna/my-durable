/**
 * Centralized protocol limits and constants — Durable Agent Network P2.
 *
 * Single source of truth for every CANON number referenced by
 * specs 03 (pairing) and 04 (tunnel transport). Runtime code MUST NOT accept
 * TTL/counter/limit overrides from requests: these constants are server-side
 * policy. Config that derives from them is validated by `assertLimitsConfig`.
 */

/** WebSocket maxPayload for one fully-assembled RFC message (both sides). 1 MiB. */
export const WS_MAX_MESSAGE_BYTES = 1_048_576;
/** Application-layer chunk raw size (before base64). 64 KiB. */
export const CHUNK_RAW_BYTES = 65_536;
/** Maximum chunks per logical message. 256. */
export const MAX_CHUNKS_PER_MESSAGE = 256;
/** Maximum logical message size including envelope. 16 MiB. */
export const LOGICAL_MESSAGE_MAX_BYTES = 16_777_216;
/** Handshake/control/fault frames must fit without chunking. 4 KiB. */
export const CONTROL_FRAME_MAX_BYTES = 4_096;
/** Per-message reassembly timeout. 30 s. */
export const REASSEMBLY_TIMEOUT_MS = 30_000;
/** Concurrent messages being reassembled per connection. */
export const REASSEMBLY_CONCURRENT_PER_CONNECTION = 4;
/** Total reassembly + outbound queue budget per device connection. 32 MiB. */
export const CONNECTION_BUFFER_BUDGET_BYTES = 33_554_432;
/** Total hub-wide budget (reassembly + outbound queues + pending REST). 64 MiB. */
export const HUB_BUFFER_BUDGET_BYTES = 67_108_864;

/** Hub → browser SSE buffered-output cap before the viewer is ended. 4 MB. */
export const SSE_HUB_VIEWER_BYTES = 4_000_000;
/** Hub ↔ device WS buffered-output cap per direction before close(1011). 4 MB. */
export const WS_BACKPRESSURE_BYTES = 4_000_000;
/**
 * Pacing mark for the connector's outbound WS queue: a sender holds back while more than this is queued,
 * so a valid message up to the 16 MiB logical cap flows through without ever reaching the close above. 1 MiB.
 */
export const WS_PACE_LOW_WATER_BYTES = 1_048_576;
/** Backend → SSE viewer cap (LAN or connector). 2 MB. */
export const BACKEND_SSE_VIEWER_BYTES = 2_000_000;
/** Paced write segment for SSE/WS writers. 64 KiB. */
export const PACE_WRITE_BYTES = 65_536;

/** Subscription keys per browser SSE connection. */
export const SUBSCRIPTION_KEYS_PER_BROWSER_CONNECTION = 20;
/** Active readers per device, monitor included. */
export const READERS_PER_DEVICE = 128;
/** Active readers hub-wide. */
export const READERS_PER_HUB = 1_024;

/** REST request body cap (checked before and after reassembly). 256 KiB. */
export const REST_BODY_MAX_BYTES = 262_144;
/** REST end-to-end timeout (send + chunk + reassembly). 330 s. */
export const REST_TIMEOUT_MS = 330_000;
/** Pending REST requests per device. */
export const REST_PENDING_PER_DEVICE = 32;
/** Pending REST requests hub-wide. */
export const REST_PENDING_PER_HUB = 256;

/** Tunnel identity handshake deadline after 101. 5 s. */
export const HANDSHAKE_DEADLINE_MS = 5_000;
/** WS ping interval, both directions. 15 s. */
export const PING_INTERVAL_MS = 15_000;
/** Missed pings before close. */
export const PING_MISS_LIMIT = 2;
/** No-byte idle safety net. 45 s. */
export const IDLE_TIMEOUT_MS = 45_000;
/**
 * Reconnect backoff shared by the device connector, the hub's mux reader and the SDK stream follower:
 * 1, 2, 4, 8, 15, 15 s, back to 1 s on hello (see `Backoff`).
 */
export const RECONNECT_BACKOFF_S = { initS: 1, capS: 15 } as const;
/** Monitor probe backoff: the same curve with a 30 s cap. */
export const MONITOR_BACKOFF_S = { initS: 1, capS: 30 } as const;

/** Pairing code TTL by hub clock. 5 min. */
export const PAIR_CODE_TTL_MS = 300_000;
/** Challenge nonce TTL. 60 s. */
export const PAIR_NONCE_TTL_MS = 60_000;
/** Grace after code expiry for retrying an ALREADY issued TokenIssue. 120 s. */
export const PAIR_RECEIPT_GRACE_MS = 120_000;
/** Wrong signatures before an enrollment is cancelled. */
export const PAIR_SIGNATURE_FAIL_LIMIT = 3;
/** Clock-skew tolerance for challenges accepted by the device. ±60 s. */
export const PAIR_CLOCK_SKEW_MS = 60_000;

/** Rate limits (per real-IP, hub-side token buckets). */
export const PAIR_RATE_LIMITS = {
  codeCreate: { perMinute: 5, capacity: 5 },
  start: { perMinute: 20, capacity: 20 },
  verifyFails: { perWindow: 100, windowMinutes: 15 },
  verifyTotal: { perMinute: 300, capacity: 300 },
} as const;

/** RAM caps for pending pairing state. */
export const PAIR_RAM_CAPS = { codes: 1_000, enrollments: 1_000 } as const;
/** Pairing endpoint body cap. 16 KiB. */
export const PAIRING_BODY_MAX_BYTES = 16_384;
/** HTTP pairing operation timeout / retry budget. */
export const PAIR_HTTP_TIMEOUT_MS = 10_000;
export const PAIR_HTTP_MAX_RETRIES = 3;
/** Approved-code polling cadence. 1 s. */
export const PAIR_POLL_MS = 1_000;

/** Hub admin REST rate limit (per real IP): refill 60/min, burst capacity 120. */
export const API_RATE_LIMITS = { perMinute: 60, capacity: 120 } as const;

/** Per-address limiter tables (pairing, admin API, tunnel upgrade): key cap and idle TTL. A full table refuses new keys. */
export const IP_BUCKET_MAX_KEYS = 10_000;
export const IP_BUCKET_IDLE_TTL_MS = 900_000;

/**
 * Tunnel upgrade allocation (05 §4.3 / S-10): attempts per real IP (refill and burst), pending+live
 * connections per real IP, and the hub-wide pending-handshake and authenticated-connection caps.
 */
export const WS_UPGRADE_LIMITS = {
  perMinutePerIp: 30,
  burstPerIp: 10,
  connectionsPerIp: 5,
  pendingPerHub: 100,
  livePerHub: 1_000,
} as const;

/** Routine credential rotation interval. 90 days. */
export const ROTATION_INTERVAL_DAYS = 90;

/**
 * Tunneled REST paths live under /v1 and must match the route allowlist (rest-routes.ts). SSE endpoints (streams
 * are subscription-based) and the device-LOCAL control surface (pairing/tunnel status) are not on it: they belong
 * to the device operator, not to remote hub callers.
 */
export const REST_PATH_PREFIX = "/v1/";

/** Canonical snapshot of every startup-validated number (testability: callers may pass mutated copies to validateLimits). */
export interface LimitsSnapshot {
  wsMaxMessageBytes: number;
  chunkRawBytes: number;
  maxChunksPerMessage: number;
  logicalMessageMaxBytes: number;
  connectionBufferBudgetBytes: number;
  hubBufferBudgetBytes: number;
  readersPerDevice: number;
  readersPerHub: number;
  restPendingPerDevice: number;
  restPendingPerHub: number;
  connectorBackoffFirstS: number;
  pairVerifyFailsPerWindow: number;
  pairVerifyFailWindowMinutes: number;
  apiPerMinute: number;
  apiCapacity: number;
}

/** CANON snapshot — the single source validated at startup. */
const CANON_SNAPSHOT: LimitsSnapshot = {
  wsMaxMessageBytes: WS_MAX_MESSAGE_BYTES,
  chunkRawBytes: CHUNK_RAW_BYTES,
  maxChunksPerMessage: MAX_CHUNKS_PER_MESSAGE,
  logicalMessageMaxBytes: LOGICAL_MESSAGE_MAX_BYTES,
  connectionBufferBudgetBytes: CONNECTION_BUFFER_BUDGET_BYTES,
  hubBufferBudgetBytes: HUB_BUFFER_BUDGET_BYTES,
  readersPerDevice: READERS_PER_DEVICE,
  readersPerHub: READERS_PER_HUB,
  restPendingPerDevice: REST_PENDING_PER_DEVICE,
  restPendingPerHub: REST_PENDING_PER_HUB,
  connectorBackoffFirstS: RECONNECT_BACKOFF_S.initS,
  pairVerifyFailsPerWindow: PAIR_RATE_LIMITS.verifyFails.perWindow,
  pairVerifyFailWindowMinutes: PAIR_RATE_LIMITS.verifyFails.windowMinutes,
  apiPerMinute: API_RATE_LIMITS.perMinute,
  apiCapacity: API_RATE_LIMITS.capacity,
};

/**
 * Pure validation over a snapshot: every number must be a positive safe
 * integer within sane bounds, and structural relations must hold. Exported
 * for compile-negative tests; production calls assertLimitsConfig() (CANON).
 */
export function validateLimits(l: LimitsSnapshot): void {
  const fields = Object.entries(l) as Array<[keyof LimitsSnapshot, number]>;
  for (const [name, v] of fields) {
    if (!Number.isSafeInteger(v) || v <= 0) throw new Error(`limits: ${name} must be a positive safe integer (got ${v})`);
  }
  if (l.maxChunksPerMessage > 65_536 || l.wsMaxMessageBytes > 64 * 1_048_576 || l.hubBufferBudgetBytes > (1 << 30))
    throw new Error("limits: value out of sane range");
  if (l.maxChunksPerMessage * l.chunkRawBytes < l.logicalMessageMaxBytes)
    throw new Error("limits: chunk count cannot cover logical message budget");
  if (l.chunkRawBytes * 2 > l.wsMaxMessageBytes)
    throw new Error("limits: single chunk + envelope must fit one WS message");
  if (l.connectionBufferBudgetBytes >= l.hubBufferBudgetBytes)
    throw new Error("limits: connection budget must be smaller than hub budget");
  if (l.readersPerDevice > l.readersPerHub)
    throw new Error("limits: per-device reader cap exceeds hub cap");
  if (l.restPendingPerDevice > l.restPendingPerHub)
    throw new Error("limits: per-device pending cap exceeds hub cap");
  if (l.apiCapacity < l.apiPerMinute)
    throw new Error("limits: API burst capacity must be >= per-minute refill");
}

export function assertLimitsConfig(): void {
  validateLimits(CANON_SNAPSHOT);
}
