/**
 * R8 binary passthrough — device side (dpi-backend/src/tunnel.ts):
 *
 * The rest-response envelope gains optional bodyEncoding:"base64" + contentDisposition
 * for NON-textual device responses (zip exports, octet-streams). Textual responses
 * (json/text) keep the exact legacy wire shape — an old hub must see nothing new.
 *
 * Same rig as the connector tests: a fake hub over a real WebSocket, a scriptable
 * loopback device API, and the real DeviceConnector in between.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { until, rig, type Hub } from "./connector-rig.js";

const restRequest = (method: string, path: string, reqId: string) => ({
  type: "rest-request",
  reqId,
  method,
  path,
});

async function restReply(
  hub: Hub,
  method: string,
  path: string,
  opts: { res?: (res: import("node:http").ServerResponse) => void } = {},
) {
  const reqId = randomUUID();
  assert.ok(hub.send(restRequest(method, path, reqId)), "rest-request sent");
  await until(
    () => hub.frames.some((f) => f.type === "rest-response" && f.reqId === reqId),
    5000,
    `a reply to ${method} ${path}`,
  );
  return hub.frames.find((f) => f.type === "rest-response" && f.reqId === reqId)! as Record<
    string,
    unknown
  >;
}

const ZIP = Buffer.concat([
  Buffer.from("PK\x03\x04\x14\x00\x00\x00\x08\x00", "binary"),
  cryptoRandom(64),
  Buffer.from("binary payload \xe2\x9c\x93 tail", "utf8"),
]);
function cryptoRandom(n: number): Buffer {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 37 + 11) % 256;
  return b;
}

async function binaryRig(headers: Record<string, string>, body: Buffer) {
  return rig((_req, res) => {
    res.writeHead(200, headers);
    res.end(body);
  });
}

test("R8: a non-textual device response rides the envelope as base64 with its disposition", async () => {
  const disposition = 'attachment; filename="my-session.bundle.zip"';
  const r = await binaryRig({ "content-type": "application/zip", "content-disposition": disposition }, ZIP);
  try {
    const reply = await restReply(r.hub, "GET", "/v1/sessions/x/export");
    assert.equal(reply.bodyEncoding, "base64", "binary flag present");
    assert.equal(reply.contentDisposition, disposition, "filename rides through");
    assert.equal(reply.status, 200);
    assert.equal(reply.contentType, "application/zip");
    const decoded = Buffer.from(String(reply.body), "base64");
    assert.ok(decoded.equals(ZIP), "base64 round-trips byte-exact");
  } finally {
    await r.cleanup();
  }
});

test("R8: textual responses keep the legacy envelope (no bodyEncoding) — old hubs unaffected", async () => {
  const r = await rig((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, name: "stub" }));
  });
  try {
    const reply = await restReply(r.hub, "GET", "/v1/device");
    assert.equal(reply.bodyEncoding, undefined, "no flag on the wire for JSON");
    assert.equal(reply.contentDisposition, undefined);
    assert.deepEqual(JSON.parse(String(reply.body)), { ok: true, name: "stub" });
  } finally {
    await r.cleanup();
  }
});

test("R8: high-byte/tab content-disposition is sanitized to printable ASCII before the wire", async () => {
  // Node's http layer refuses CR/LF in header values outright; the realistic hostile
  // case is latin1/UTF-8 high bytes (which the HTTP layer accepts) plus control chars.
  const r = await binaryRig(
    {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="résumé\tHACK.zip"',
    },
    ZIP,
  );
  try {
    const reply = await restReply(r.hub, "GET", "/v1/sessions/x/export");
    const cd = String(reply.contentDisposition);
    assert.match(cd, /^[\x20-\x7E]+$/, "printable ASCII only");
    assert.ok(!/\t/.test(cd), "no tabs survive");
    assert.ok(cd.endsWith('HACK.zip"'), "filename tail kept");
  } finally {
    await r.cleanup();
  }
});
