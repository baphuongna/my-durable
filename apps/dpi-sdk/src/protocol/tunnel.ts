/**
 * Tunnel wire protocol — Durable Agent Network P2 (spec 04 §3).
 *
 * Runtime schemas for TunnelFrame / TunnelChunk / TunnelAuthError with
 * direction and phase guards. TypeScript unions are NOT sufficient: every
 * inbound message must pass Value.Check plus the guards below.
 *
 * This module must stay browser-safe: no Node builtin imports.
 */
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Frame } from "../api.js";
import { CHUNK_RAW_BYTES, MAX_CHUNKS_PER_MESSAGE, REST_PATH_PREFIX } from "./limits.js";
import { matchesRestRoute, restRouteKind } from "./rest-routes.js";

const Strict = { additionalProperties: false } as const;

const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  minLength: 36,
  maxLength: 36,
});
const DeviceId = Type.String({
  pattern: "^[a-z0-9][a-z0-9-]{0,31}(?![\\s\\S])",
  minLength: 1,
  maxLength: 32,
});
const Fingerprint = Type.String({ pattern: "^sha256:[0-9a-f]{64}$", minLength: 71, maxLength: 71 });
const TunnelToken = Type.String({
  pattern: "^dpt_[A-Za-z0-9_-]{43}$",
  minLength: 47,
  maxLength: 47,
});
const Nonce = Type.String({ pattern: "^[A-Za-z0-9_-]{43}$", minLength: 43, maxLength: 43 });
const SubscriptionFields = {
  subscriptionId: Uuid,
  sub: Type.String({ minLength: 1, maxLength: 512 }),
} as const;
const RotationFields = {
  pairingEpoch: Uuid,
  rotationId: Uuid,
  credentialId: Uuid,
  generation: Type.Integer({ minimum: 1 }),
} as const;

/** Typed pre-upgrade auth error body (04 §4): JSON 401 before 101. */
export const TunnelAuthError = Type.Object(
  {
    type: Type.Literal("tunnel.auth-error"),
    v: Type.Literal(1),
    code: Type.Union([
      Type.Literal("revoked"),
      Type.Literal("token_unknown"),
      Type.Literal("rate_limited"),
    ]),
    message: Type.String({ maxLength: 512 }),
    retryAfterMs: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  Strict,
);
export type TunnelAuthError = Static<typeof TunnelAuthError>;

/**
 * A backend SSE `Frame` ride-along. The Frame shape itself is owned by
 * models/api; the tunnel validates it only as a JSON object with a known
 * discriminator to avoid duplicating the full grammar here.
 */
const FramePayload = Type.Object(
  {
    type: Type.Union([
      Type.Literal("hello"),
      Type.Literal("fault"),
      Type.Literal("tree"),
      Type.Literal("activity"),
      Type.Literal("session"),
      Type.Literal("agents"),
      Type.Literal("tasks"),
      Type.Literal("usage"),
      Type.Literal("snapshot"),
      Type.Literal("batch"),
      Type.Literal("inbox"),
      Type.Literal("doc"),
    ]),
  },
  { additionalProperties: true },
);

/** Hub mux control frames must never be accepted from a device, even after chunk reassembly. */
export function checkDeviceFrame(
  value: unknown,
): value is Exclude<Frame, { type: "network" | "disconnected" }> {
  return Value.Check(FramePayload, value);
}

const TunnelControl = Type.Union([
  Type.Object(
    { type: Type.Literal("control"), action: Type.Literal("subscribe"), ...SubscriptionFields },
    Strict,
  ),
  Type.Object(
    { type: Type.Literal("control"), action: Type.Literal("unsubscribe"), ...SubscriptionFields },
    Strict,
  ),
  Type.Object(
    {
      type: Type.Literal("control"),
      action: Type.Literal("revoked"),
      notice: Type.Object(
        {
          type: Type.Literal("pair.revoke"),
          v: Type.Literal(1),
          deviceId: DeviceId,
          pairingEpoch: Uuid,
          reason: Type.Union([
            Type.Literal("user"),
            Type.Literal("compromise"),
            Type.Literal("hub_migrated"),
          ]),
          revokedAt: Type.Integer(),
        },
        Strict,
      ),
    },
    Strict,
  ),
  Type.Object(
    {
      type: Type.Literal("control"),
      action: Type.Literal("token-rotate"),
      tunnelToken: TunnelToken,
      ...RotationFields,
    },
    Strict,
  ),
  Type.Object(
    { type: Type.Literal("control"), action: Type.Literal("token-rotate-ack"), ...RotationFields },
    Strict,
  ),
  Type.Object(
    {
      type: Type.Literal("control"),
      action: Type.Literal("unpair"),
      pairingEpoch: Uuid,
      reason: Type.Literal("hub_migrated"),
    },
    Strict,
  ),
  Type.Object(
    {
      type: Type.Literal("control"),
      action: Type.Literal("close"),
      reason: Type.String({ maxLength: 512 }),
    },
    Strict,
  ),
]);

export const TunnelFrame = Type.Union([
  Type.Object(
    {
      type: Type.Literal("pair-handshake"),
      v: Type.Literal(1),
      deviceUid: Uuid,
      deviceId: DeviceId,
      pairingEpoch: Uuid,
      credentialId: Uuid,
      generation: Type.Integer({ minimum: 1 }),
      apiVersion: Type.Literal(1),
      tunnelProto: Type.Literal(1),
      keyFingerprint: Fingerprint,
      /**
       * Hub-proof challenge (pinned pairings): the hub's `hello` must answer
       * with proof of the pinned identity key over this nonce. Optional keeps
       * the v1 wire shape for pre-pinning devices.
       */
      proofNonce: Type.Optional(Nonce),
    },
    Strict,
  ),
  Type.Object(
    {
      type: Type.Literal("hello"),
      apiVersion: Type.Literal(1),
      tunnelProto: Type.Literal(1),
      hubId: Uuid,
      connectionId: Uuid,
      serverTime: Type.Integer(),
      /** Present iff the handshake carried proofNonce (hub identity proof). */
      hubPublicKey: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      hubKeyFingerprint: Type.Optional(Fingerprint),
      hubSignature: Type.Optional(
        Type.String({ pattern: "^[A-Za-z0-9_-]{86}$", minLength: 86, maxLength: 86 }),
      ),
    },
    Strict,
  ),
  Type.Object(
    { type: Type.Literal("tunnel-data"), frame: FramePayload, ...SubscriptionFields },
    Strict,
  ),
  Type.Object(
    {
      type: Type.Literal("rest-request"),
      reqId: Uuid,
      method: Type.Union([
        Type.Literal("GET"),
        Type.Literal("POST"),
        Type.Literal("PUT"),
        Type.Literal("PATCH"),
        Type.Literal("DELETE"),
      ]),
      path: Type.String({ minLength: 1, maxLength: 2048 }),
      idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      body: Type.Optional(Type.Unknown()),
    },
    Strict,
  ),
  Type.Object(
    {
      type: Type.Literal("rest-response"),
      reqId: Uuid,
      status: Type.Integer({ minimum: 100, maximum: 599 }),
      contentType: Type.Optional(Type.String({ maxLength: 256 })),
      body: Type.Optional(Type.Unknown()),
    },
    Strict,
  ),
  TunnelControl,
  Type.Object(
    {
      type: Type.Literal("fault"),
      error: Type.Object(
        { code: Type.String({ maxLength: 64 }), message: Type.String({ maxLength: 512 }) },
        Strict,
      ),
      subscriptionId: Type.Optional(Uuid),
      reqId: Type.Optional(Uuid),
    },
    Strict,
  ),
]);
export type TunnelFrame = Static<typeof TunnelFrame>;

const ChunkBase = {
  type: Type.Literal("tunnel-chunk"),
  v: Type.Literal(1),
  messageId: Uuid,
  index: Type.Integer({ minimum: 0, maximum: MAX_CHUNKS_PER_MESSAGE - 1 }),
  count: Type.Integer({ minimum: 1, maximum: MAX_CHUNKS_PER_MESSAGE }),
  totalBytes: Type.Integer({ minimum: 1 }),
  data: Type.String({ pattern: "^[A-Za-z0-9+/=]*$", minLength: 0 }),
} as const;

const TunnelChunk = Type.Union([
  Type.Object({ ...ChunkBase, kind: Type.Literal("tunnel-data"), ...SubscriptionFields }, Strict),
  Type.Object(
    {
      ...ChunkBase,
      kind: Type.Union([Type.Literal("rest-request"), Type.Literal("rest-response")]),
      reqId: Uuid,
    },
    Strict,
  ),
]);
export type TunnelChunk = Static<typeof TunnelChunk>;

export const TunnelWireMessage = Type.Union([TunnelFrame, TunnelChunk]);
export type TunnelWireMessage = Static<typeof TunnelWireMessage>;

export function checkTunnelMessage(value: unknown): value is TunnelWireMessage {
  return Value.Check(TunnelWireMessage, value);
}

// ---------------------------------------------------------------------------
// Direction guards (04 §3): who may send what.

export type Direction = "hub->device" | "device->hub";

const HUB_TO_DEVICE = new Set([
  "control:subscribe",
  "control:unsubscribe",
  "control:revoked",
  "control:token-rotate",
  "rest-request",
  "hello",
  "fault",
  "control:close",
]);
const DEVICE_TO_HUB = new Set([
  "pair-handshake",
  "control:token-rotate-ack",
  "control:unpair",
  "tunnel-data",
  "tunnel-chunk:tunnel-data",
  "rest-response",
  "tunnel-chunk:rest-response",
  "tunnel-chunk:rest-request",
]);

function messageKey(msg: { type: string; action?: string; kind?: string }): string {
  if (msg.type === "control") return `control:${msg.action}`;
  if (msg.type === "tunnel-chunk") return `tunnel-chunk:${msg.kind}`;
  return msg.type;
}

/** Returns the allowed direction(s), or null if the message type is unknown. */
export function messageDirection(msg: {
  type: string;
  action?: string;
  kind?: string;
}): Direction[] {
  const key = messageKey(msg);
  const dirs: Direction[] = [];
  if (HUB_TO_DEVICE.has(key)) dirs.push("hub->device");
  if (DEVICE_TO_HUB.has(key)) dirs.push("device->hub");
  return dirs;
}

export function assertDirection(
  msg: { type: string; action?: string; kind?: string },
  dir: Direction,
): void {
  const allowed = messageDirection(msg);
  if (allowed.length === 0) {
    throw new Error(`tunnel: unknown message type ${messageKey(msg)}`);
  }
  if (!allowed.includes(dir)) {
    throw new Error(`tunnel: ${messageKey(msg)} is not allowed in direction ${dir}`);
  }
}

// ---------------------------------------------------------------------------
// Phase guards (04 §4): handshake must complete before data flows.

export type TunnelPhase = "awaiting-handshake" | "open" | "closed";

/** Only pair-handshake (device→hub) is valid before the handshake deadline. */
export function allowedInPhase(
  msg: { type: string; action?: string; kind?: string },
  phase: TunnelPhase,
): boolean {
  if (phase === "closed") return false;
  const key = messageKey(msg);
  if (phase === "awaiting-handshake") return key === "pair-handshake";
  return key !== "pair-handshake"; // hello is hub→hub-transition; data only after open
}

// ---------------------------------------------------------------------------
// REST path/method validation for tunneled requests (04 §9).

/**
 * The connector passes `path` to fetch() unchanged, and Express then matches it case-insensitively. fetch()'s URL
 * parser drops tab/CR/LF, trims edge spaces, reads "\" as "/", resolves "." and "%2e" segments and cuts a
 * "#fragment". So a spelling that the parsers could read differently from this check is refused, not repaired:
 * the decision is made on exactly the bytes that will be requested, and only a route the device serves to a
 * remote caller (rest-routes.ts) with one of its methods passes.
 */
export function validateRestRequest(input: {
  method: string;
  path: string;
}): { ok: true } | { ok: false; error: string } {
  const refuse = (error: string) => ({ ok: false as const, error });
  if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(input.method))
    return refuse("rest: method not allowed");
  const raw = input.path;
  if (raw.includes("..") || raw.includes("\\") || raw.includes("://") || raw.startsWith("//")) {
    return refuse("rest: path traversal or absolute URL rejected");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return refuse("rest: invalid percent-encoding");
  }
  if (
    decoded.includes("..") ||
    decoded.includes("\\") ||
    decoded.includes("://") ||
    decoded.startsWith("//")
  ) {
    return refuse("rest: encoded traversal rejected");
  }
  if (!raw.startsWith(REST_PATH_PREFIX)) return refuse("rest: path outside /v1 rejected");
  if (!/^[\x21-\x7e]+$/.test(raw) || raw.includes("#")) {
    return refuse(
      "rest: path must be printable ASCII without a fragment (percent-encode everything else)",
    );
  }
  const query = raw.indexOf("?");
  const pathname = query < 0 ? raw : raw.slice(0, query);
  if (pathname.includes(";")) return refuse("rest: path parameters are not accepted");
  const segments = pathname.slice(REST_PATH_PREFIX.length).split("/");
  if (
    segments.some((segment) => segment === "" || segment.toLowerCase() === "%2e" || segment === ".")
  ) {
    return refuse("rest: path is not canonical (empty or dot segment)");
  }
  if (matchesRestRoute(input.method, segments)) return { ok: true };
  const kind = restRouteKind(segments);
  return refuse(
    kind === "stream"
      ? "rest: SSE endpoint must not be tunneled"
      : kind === "local"
        ? "rest: device-local control route must not be tunneled"
        : "rest: route is not allowlisted",
  );
}

// ---------------------------------------------------------------------------
// Chunk envelope validation (04 §3.3).

export function validateChunkEnvelope(chunk: {
  index: number;
  count: number;
  totalBytes: number;
  data: string;
}): { ok: true; remainder: number } | { ok: false; error: string } {
  const expectedCount = Math.ceil(chunk.totalBytes / CHUNK_RAW_BYTES);
  if (chunk.count !== expectedCount) {
    return { ok: false, error: "chunk: count/totalBytes mismatch" };
  }
  if (chunk.index >= chunk.count) {
    return { ok: false, error: "chunk: index out of range" };
  }
  const decodedLength = base64DecodedLength(chunk.data);
  if (decodedLength < 0) return { ok: false, error: "chunk: invalid base64" };
  const expected =
    chunk.index === chunk.count - 1
      ? chunk.totalBytes - CHUNK_RAW_BYTES * (chunk.count - 1)
      : CHUNK_RAW_BYTES;
  if (decodedLength !== expected) {
    return { ok: false, error: `chunk: size mismatch at index ${chunk.index}` };
  }
  return { ok: true, remainder: decodedLength };
}

function base64DecodedLength(data: string): number {
  if (!/^[A-Za-z0-9+/=]*$/.test(data)) return -1;
  if (data.length % 4 !== 0) return -1;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}
