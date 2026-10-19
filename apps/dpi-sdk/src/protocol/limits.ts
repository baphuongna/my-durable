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
/** Connector reconnect backoff sequence, seconds. Reset to 1 s on hello. */
export const CONNECTOR_BACKOFF_S = [1, 2, 4, 8, 15, 15] as const;
/** Mux reader retry backoff (init / cap), seconds. */
export const MUX_READER_BACKOFF_S = { init: 1, cap: 15 } as const;
/** Monitor probe backoff (init / cap), seconds. */
export const MONITOR_BACKOFF_S = { init: 1, cap: 30 } as const;

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

/** Routine credential rotation interval. 90 days. */
export const ROTATION_INTERVAL_DAYS = 90;

/** Tunnel REST path allowlist. */
export const REST_PATH_PREFIX = "/v1/";
/** Paths under /v1 that must never be tunneled (SSE endpoints). */
export const REST_PATH_DENYLIST = ["/v1/events"];

export function assertLimitsConfig(): void {
  // Structural consistency guards — fail startup, not per-request.
  if (MAX_CHUNKS_PER_MESSAGE * CHUNK_RAW_BYTES < LOGICAL_MESSAGE_MAX_BYTES) {
    throw new Error("limits: chunk count cannot cover logical message budget");
  }
  if (CONNECTION_BUFFER_BUDGET_BYTES >= HUB_BUFFER_BUDGET_BYTES) {
    throw new Error("limits: connection budget must be smaller than hub budget");
  }
  if (CHUNK_RAW_BYTES * 2 > WS_MAX_MESSAGE_BYTES) {
    throw new Error("limits: single chunk + envelope must fit one WS message");
  }
  if (READERS_PER_DEVICE > READERS_PER_HUB) {
    throw new Error("limits: per-device reader cap exceeds hub cap");
  }
  if (REST_PENDING_PER_DEVICE > REST_PENDING_PER_HUB) {
    throw new Error("limits: per-device pending cap exceeds hub cap");
  }
  if (CONNECTOR_BACKOFF_S[0] < 1) {
    throw new Error("limits: backoff must start >= 1s");
  }
}
