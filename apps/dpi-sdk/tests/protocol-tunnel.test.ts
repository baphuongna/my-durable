/**
 * Early W-2: tunnel wire schemas — direction guards, phase guards, auth-error
 * shape, REST path allowlist, chunk envelope math (spec 04 §3/§4/§9, 08 W-2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Value } from "@sinclair/typebox/value";
import {
  CHUNK_RAW_BYTES,
  LOGICAL_MESSAGE_MAX_BYTES,
  MAX_CHUNKS_PER_MESSAGE,
  WS_MAX_MESSAGE_BYTES,
} from "../src/protocol/limits.js";
import {
  TunnelAuthError,
  assertDirection,
  allowedInPhase,
  checkTunnelMessage,
  validateChunkEnvelope,
  validateRestRequest,
} from "../src/protocol/tunnel.js";

const uuid = () => "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const fp = () => "sha256:" + "ab".repeat(32);

const handshake = {
  type: "pair-handshake", v: 1, deviceUid: uuid(), deviceId: "dev-1",
  pairingEpoch: uuid(), credentialId: uuid(), generation: 2,
  apiVersion: 1, tunnelProto: 1, keyFingerprint: fp(),
};

test("W-2: pair-handshake valid + unknown field rejected", () => {
  assert.ok(checkTunnelMessage(handshake));
  assert.ok(!checkTunnelMessage({ ...handshake, extra: true }));
  assert.ok(!checkTunnelMessage({ ...handshake, generation: 0 }));
  assert.ok(!checkTunnelMessage({ ...handshake, apiVersion: 2 }));
  assert.ok(!checkTunnelMessage({ ...handshake, deviceId: "DEV-1" }));
});

test("W-2: hello valid; fault carries optional correlation", () => {
  assert.ok(checkTunnelMessage({ type: "hello", apiVersion: 1, tunnelProto: 1, hubId: uuid(), connectionId: uuid(), serverTime: 1 }));
  assert.ok(checkTunnelMessage({ type: "fault", error: { code: "payload_too_large", message: "m" }, reqId: uuid() }));
  assert.ok(!checkTunnelMessage({ type: "fault", error: { code: "x".repeat(65), message: "m" } }));
});

test("W-2: direction guards — hub-only, device-only, violations throw", () => {
  // hub → device only
  assert.throws(() => assertDirection({ type: "control", action: "subscribe" }, "device->hub"));
  assert.throws(() => assertDirection({ type: "rest-request" }, "device->hub"));
  assert.doesNotThrow(() => assertDirection({ type: "control", action: "subscribe" }, "hub->device"));
  assert.doesNotThrow(() => assertDirection({ type: "rest-request" }, "hub->device"));
  // device → hub only
  assert.throws(() => assertDirection({ type: "pair-handshake" }, "hub->device"));
  assert.throws(() => assertDirection({ type: "tunnel-data" }, "hub->device"));
  assert.throws(() => assertDirection({ type: "rest-response" }, "hub->device"));
  assert.throws(() => assertDirection({ type: "control", action: "token-rotate-ack" }, "hub->device"));
  assert.throws(() => assertDirection({ type: "control", action: "unpair" }, "hub->device"));
  assert.doesNotThrow(() => assertDirection({ type: "tunnel-data" }, "device->hub"));
  assert.doesNotThrow(() => assertDirection({ type: "rest-response" }, "device->hub"));
  // token-rotate is hub-only; token-rotate-ack device-only
  assert.throws(() => assertDirection({ type: "control", action: "token-rotate" }, "device->hub"));
  // chunks follow their payload direction
  assert.doesNotThrow(() => assertDirection({ type: "tunnel-chunk", kind: "tunnel-data" }, "device->hub"));
  assert.throws(() => assertDirection({ type: "tunnel-chunk", kind: "tunnel-data" }, "hub->device"));
  assert.doesNotThrow(() => assertDirection({ type: "tunnel-chunk", kind: "rest-response" }, "device->hub"));
  assert.doesNotThrow(() => assertDirection({ type: "tunnel-chunk", kind: "rest-request" }, "device->hub"));
  // unknown type
  assert.throws(() => assertDirection({ type: "mystery" }, "hub->device"));
});

test("W-2: phase guards — nothing before handshake except pair-handshake", () => {
  assert.ok(allowedInPhase(handshake, "awaiting-handshake"));
  assert.ok(!allowedInPhase({ type: "tunnel-data" }, "awaiting-handshake"));
  assert.ok(!allowedInPhase({ type: "control", action: "subscribe" }, "awaiting-handshake"));
  assert.ok(!allowedInPhase({ type: "rest-request" }, "awaiting-handshake"));
  assert.ok(allowedInPhase({ type: "tunnel-data" }, "open"));
  assert.ok(allowedInPhase({ type: "control", action: "subscribe" }, "open"));
  assert.ok(!allowedInPhase(handshake, "open")); // no re-handshake mid-connection
  assert.ok(!allowedInPhase({ type: "tunnel-data" }, "closed"));
});

test("W-2: TunnelAuthError typed pre-upgrade body", () => {
  const revoked = { type: "tunnel.auth-error", v: 1, code: "revoked", message: "credential revoked" };
  const unknown = { type: "tunnel.auth-error", v: 1, code: "token_unknown", message: "m" };
  const limited = { type: "tunnel.auth-error", v: 1, code: "rate_limited", message: "m", retryAfterMs: 5000 };
  assert.ok(Value.Check(TunnelAuthError, revoked));
  assert.ok(Value.Check(TunnelAuthError, unknown));
  assert.ok(Value.Check(TunnelAuthError, limited));
  assert.ok(!Value.Check(TunnelAuthError, { type: "tunnel.auth-error", v: 1, code: "gone", message: "m" }));
  assert.ok(!Value.Check(TunnelAuthError, { ...limited, retryAfterMs: 0 }));
  assert.ok(!Value.Check(TunnelAuthError, { ...revoked, extra: 1 }));
});

test("W-2: REST path/method allowlist — traversal, absolute, SSE, encoded bypass rejected", () => {
  assert.deepEqual(validateRestRequest({ method: "GET", path: "/v1/device" }), { ok: true });
  assert.deepEqual(validateRestRequest({ method: "POST", path: "/v1/sessions" }), { ok: true });
  assert.equal(validateRestRequest({ method: "GET", path: "/v1/events" }).ok, false);
  assert.equal(validateRestRequest({ method: "GET", path: "/v1/events?scope=x" }).ok, false);
  // Device-local control surface must stay local (04 §9 / P2-16).
  assert.equal(validateRestRequest({ method: "GET", path: "/v1/pairing" }).ok, false);
  assert.equal(validateRestRequest({ method: "POST", path: "/v1/pairing/start" }).ok, false);
  assert.equal(validateRestRequest({ method: "GET", path: "/v1/tunnel" }).ok, false);
  assert.equal(validateRestRequest({ method: "GET", path: "/api/other" }).ok, false);
  assert.equal(validateRestRequest({ method: "GET", path: "/V1/device" }).ok, false);
  assert.equal(validateRestRequest({ method: "GET", path: "http://127.0.0.1:9/v1" }).ok, false);
  assert.equal(validateRestRequest({ method: "GET", path: "//host/v1" }).ok, false);
  assert.equal(validateRestRequest({ method: "GET", path: "/v1/../private" }).ok, false);
  assert.equal(validateRestRequest({ method: "GET", path: "/v1/%2e%2e/private" }).ok, false);
  assert.equal(validateRestRequest({ method: "HEAD", path: "/v1/device" }).ok, false);
  assert.equal(validateRestRequest({ method: "get", path: "/v1/device" }).ok, false);
});

test("W-2: chunk envelope math — count, index, remainder, base64", () => {
  const b64 = (n: number) => Buffer.alloc(n).toString("base64"); // canonical, correctly padded
  // full chunk
  assert.deepEqual(validateChunkEnvelope({ index: 0, count: 2, totalBytes: CHUNK_RAW_BYTES + 10, data: b64(CHUNK_RAW_BYTES) }), { ok: true, remainder: CHUNK_RAW_BYTES });
  // final remainder chunk
  assert.deepEqual(validateChunkEnvelope({ index: 1, count: 2, totalBytes: CHUNK_RAW_BYTES + 10, data: b64(10) }), { ok: true, remainder: 10 });
  // count mismatch
  assert.equal(validateChunkEnvelope({ index: 0, count: 3, totalBytes: CHUNK_RAW_BYTES + 10, data: b64(CHUNK_RAW_BYTES) }).ok, false);
  // index out of range
  assert.equal(validateChunkEnvelope({ index: 2, count: 2, totalBytes: CHUNK_RAW_BYTES + 10, data: b64(10) }).ok, false);
  // wrong size for a middle chunk
  assert.equal(validateChunkEnvelope({ index: 0, count: 2, totalBytes: CHUNK_RAW_BYTES + 10, data: b64(10) }).ok, false);
  // non-multiple-of-4 base64
  assert.equal(validateChunkEnvelope({ index: 0, count: 1, totalBytes: 10, data: "AAAAA" }).ok, false);
  // bad alphabet
  assert.equal(validateChunkEnvelope({ index: 0, count: 1, totalBytes: 10, data: "!!!!" }).ok, false);
});

test("W-2: TunnelChunk schema discriminates kind with correlation", () => {
  const dataChunk = {
    type: "tunnel-chunk", v: 1, messageId: uuid(), index: 0, count: 1,
    totalBytes: 10, data: "AAAAAA==", kind: "tunnel-data",
    subscriptionId: uuid(), sub: "dev-1/agent/s/a",
  };
  const restChunk = {
    type: "tunnel-chunk", v: 1, messageId: uuid(), index: 0, count: 1,
    totalBytes: 10, data: "AAAAAA==", kind: "rest-response", reqId: uuid(),
  };
  assert.ok(checkTunnelMessage(dataChunk));
  assert.ok(checkTunnelMessage(restChunk));
  assert.ok(!checkTunnelMessage({ ...dataChunk, reqId: uuid() })); // data chunk has no reqId
  assert.ok(!checkTunnelMessage({ ...restChunk, subscriptionId: uuid(), sub: "x" }));
  assert.ok(!checkTunnelMessage({ ...dataChunk, kind: "mystery" }));
});

test("W-2: limits — wire/logical/chunk invariants", () => {
  assert.equal(WS_MAX_MESSAGE_BYTES, 1_048_576);
  assert.equal(CHUNK_RAW_BYTES, 65_536);
  assert.equal(LOGICAL_MESSAGE_MAX_BYTES, 16_777_216);
  assert.equal(MAX_CHUNKS_PER_MESSAGE, 256);
  assert.ok(MAX_CHUNKS_PER_MESSAGE * CHUNK_RAW_BYTES >= LOGICAL_MESSAGE_MAX_BYTES);
});

test("W-2: tunnel-data requires subscription correlation; frame is passthrough object", () => {
  const msg = { type: "tunnel-data", frame: { kind: "tree" }, subscriptionId: uuid(), sub: "dev-1/device" };
  assert.ok(checkTunnelMessage(msg));
  assert.ok(!checkTunnelMessage({ type: "tunnel-data", frame: { kind: "tree" } })); // missing correlation
  assert.ok(!checkTunnelMessage({ type: "tunnel-data", frame: {}, subscriptionId: uuid(), sub: "x" })); // empty frame
});
