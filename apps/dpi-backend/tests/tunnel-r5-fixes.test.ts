/**
 * Round-5 tunnel fixes — device side (dpi-backend/src/tunnel.ts):
 *
 * 1a. A control:subscribe the device refuses (off-allowlist path, or a docs query
 *     longer than SUBSCRIBE_PATH_OK's 256-char budget) is answered with a
 *     tunnel-data fault frame carrying the hub's subscriptionId. It used to be a
 *     bare `return` — the hub kept the key open and the browser starved without
 *     frames, faults or a timeout.
 * 2.  A rest-request the validator refuses now answers 400 (the same verdict the
 *     hub's TunnelDispatcher gives the identical request) instead of a device-only
 *     404, with the validator's message passed through unchanged.
 *
 * Same rig as the connector tests: a fake hub over a real WebSocket, a scriptable
 * loopback device API, and the real DeviceConnector in between.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { until, pause, rig, type Hub, SUB_ID } from "./connector-rig.js";

/** Loopback API: JSON for REST hits, a live SSE stream for /v1/events*; logs every hit. */
async function sseRig() {
  const hits: string[] = [];
  const sseHits: string[] = [];
  const r = await rig((req, res) => {
    hits.push(`${req.method} ${req.url ?? ""}`);
    if (req.url?.startsWith("/v1/events")) {
      sseHits.push(req.url);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "tree", tree: { v: 1 } })}\n\n`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: "stub-device", apiVersion: 1 }));
  });
  return { ...r, hits, sseHits };
}

const subscribe = (sub: string, id = SUB_ID) => ({
  type: "control",
  action: "subscribe",
  subscriptionId: id,
  sub,
});

const restRequest = (method: string, path: string, reqId: string) => ({
  type: "rest-request",
  reqId,
  method,
  path,
});

async function restReply(hub: Hub, method: string, path: string) {
  const reqId = randomUUID();
  assert.ok(hub.send(restRequest(method, path, reqId)), "rest-request sent");
  await until(
    () => hub.frames.some((f) => f.type === "rest-response" && f.reqId === reqId),
    5000,
    `a reply to ${method} ${path}`,
  );
  return hub.frames.find((f) => f.type === "rest-response" && f.reqId === reqId)!;
}

const faultFor = (hub: Hub, id: string) =>
  hub.frames.find(
    (f) => f.type === "tunnel-data" && f.subscriptionId === id && f.frame?.type === "fault",
  );

// -- 1a: the refusal is LOUD --------------------------------------------------

test("R5: an over-cap docs query gets a fault frame, no reader, and the tunnel keeps working", async () => {
  const r = await sseRig();
  try {
    // "?docs=" + 252 chars = 257 characters after `?` — one past the device's 256 budget.
    const sub = `/v1/events?docs=${"a".repeat(252)}`;
    assert.ok(r.hub.send(subscribe(sub)), "subscribe sent");
    await until(
      () => faultFor(r.hub, SUB_ID) !== undefined,
      5000,
      "the fault frame naming the refused subscription",
    );
    const fault = faultFor(r.hub, SUB_ID)!;
    assert.equal(fault.frame.error.code, "invalid");
    assert.equal(fault.sub, sub, "the envelope names the refused key");
    assert.match(fault.frame.error.message, /subscribe refused/);
    await pause(250);
    assert.deepEqual(r.sseHits, [], "the refused path was never fetched from the device API");

    // The refusal was subscription-scoped: the tunnel itself is untouched.
    const reply = await restReply(r.hub, "GET", "/v1/device");
    assert.equal(reply.status, 200);
    const boundaryId = randomUUID();
    assert.ok(r.hub.send(subscribe(`/v1/events?docs=${"a".repeat(251)}`, boundaryId)));
    await until(
      () => r.sseHits.some((h) => h === `/v1/events?docs=${"a".repeat(251)}`),
      5000,
      "the in-budget query IS fetched",
    );
    assert.equal(faultFor(r.hub, boundaryId), undefined, "the boundary query opened a reader, not a fault");
  } finally {
    await r.cleanup();
  }
});

test("R5: a sub the allowlist refuses is faulted too (was a silent drop)", async () => {
  const r = await sseRig();
  try {
    assert.ok(r.hub.send(subscribe("/v1/pairing")), "subscribe sent");
    await until(
      () => faultFor(r.hub, SUB_ID) !== undefined,
      5000,
      "fault frame for the off-allowlist path",
    );
    assert.equal(faultFor(r.hub, SUB_ID)!.frame.error.code, "invalid");
    await pause(200);
    assert.deepEqual(r.hits, [], "nothing reached the device API");
  } finally {
    await r.cleanup();
  }
});

// -- 2: tunnelled REST refusal is 400 on both hops ----------------------------

test("R5: the device's tunnelled REST refusal matches the hub: 400 with the validator's message", async () => {
  const r = await sseRig();
  try {
    // A device-local control route: refused with the validator's own wording.
    const local = await restReply(r.hub, "GET", "/v1/pairing");
    assert.equal(local.status, 400, "device-local routes are 400 on the tunnelled path");
    assert.equal(local.body.error.code, "invalid");
    assert.equal(local.body.error.message, "rest: device-local control route must not be tunneled");

    // A route that is simply not allowlisted: the exact message the hub gives.
    const unknown = await restReply(r.hub, "GET", "/v1/nope");
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error.message, "rest: route is not allowlisted");

    await pause(200);
    assert.deepEqual(r.hits, [], "a refused request never reached the device API");

    // Control: an allowlisted request still makes the whole trip.
    const ok = await restReply(r.hub, "GET", "/v1/device");
    assert.equal(ok.status, 200);
    assert.deepEqual(r.hits, ["GET /v1/device"]);
  } finally {
    await r.cleanup();
  }
});
