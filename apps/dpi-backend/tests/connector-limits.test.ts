/**
 * Gate A GA-08 — the connector's device→hub direction is bounded.
 *
 * - A valid event larger than the 4 MB WebSocket cap (6 MiB) is paced against the socket queue, never
 *   enqueued at once (04 §10), and arrives intact once the hub reads.
 * - A hub that stops reading is cut with 1011 "backpressure" instead of letting the queue grow; readers
 *   stop, the connector backs off and reconnects.
 * - Loopback reads are capped before they are held: an SSE event or REST body that outgrows the logical
 *   cap is refused (reader fault / 502 response_too_large) without the connector buffering it, and the
 *   tunnel stays up.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { LOGICAL_MESSAGE_MAX_BYTES, WS_BACKPRESSURE_BYTES } from "../../dpi-sdk/src/protocol/limits.js";
import { MIB, REQ_ID, SUB_ID, pause, rig, until, type Hub, type LocalApi } from "./connector-rig.js";

/** Write `totalBytes` of `fill` in 64 KiB pieces, honouring backpressure, and stop when the client leaves. */
function pump(res: ServerResponse, api: LocalApi, totalBytes: number, fill = 0x61) {
  const piece = Buffer.alloc(65_536, fill);
  const step = () => {
    while (!res.destroyed && api.written < totalBytes) {
      api.written += piece.length;
      if (!res.write(piece)) return void res.once("drain", step);
    }
    if (!res.destroyed) res.end();
  };
  step();
}

const subscribe = (hub: Hub, sub = "/v1/events") =>
  assert.ok(hub.send({ type: "control", action: "subscribe", subscriptionId: SUB_ID, sub }), "subscribe sent");
const restRequest = (hub: Hub, path: string) =>
  assert.ok(hub.send({ type: "rest-request", reqId: REQ_ID, method: "GET", path }), "rest-request sent");

/** Resolves once `read()` is positive and has held its value for `quietMs`: the sender has run into the pacing and is waiting. */
async function stalls(read: () => number, what: string, quietMs = 250, timeout = 10_000) {
  const end = Date.now() + timeout;
  let value = read();
  let since = Date.now();
  while (Date.now() < end) {
    await pause(25);
    const now = read();
    if (now !== value) [value, since] = [now, Date.now()];
    else if (value > 0 && Date.now() - since >= quietMs) return;
  }
  throw new Error(`timeout waiting for ${what}`);
}

/** Reassemble the base64 chunks of one logical message into its JSON value. */
function reassemble(frames: any[], messageId: string): any {
  const parts = frames.filter((f) => f.type === "tunnel-chunk" && f.messageId === messageId).sort((a, b) => a.index - b.index);
  assert.ok(parts.length > 0, "chunks arrived");
  assert.equal(parts.length, parts[0].count, "every chunk arrived exactly once");
  const raw = Buffer.concat(parts.map((p) => Buffer.from(p.data, "base64")));
  assert.equal(raw.length, parts[0].totalBytes);
  return JSON.parse(raw.toString("utf8"));
}

test("GA-08: a valid 6 MiB event crosses a hub that is not reading yet without the outbound queue passing the 4 MB cap, then arrives intact", async () => {
  const proof = "x".repeat(6 * MIB);
  const event = JSON.stringify({ type: "tree", tree: { sessions: [], proof } });
  const r = await rig((req, res) => {
    if (req.url !== "/v1/events") return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${event}\n\n`);
  });
  try {
    r.hub.stopReading();
    subscribe(r.hub);
    await stalls(() => r.peak(), "the outbound queue to build up and stop growing");
    assert.ok(!r.hub.frames.some((f) => f.type === "tunnel-chunk" && f.index === f.count - 1), "the hub has not read the message to its end");
    assert.ok(r.peak() <= WS_BACKPRESSURE_BYTES, `outbound queue peaked at ${r.peak()} B, cap ${WS_BACKPRESSURE_BYTES} B`);
    assert.equal(r.connector.status().state, "connected", "a hub that is merely slow is not a fault");
    r.hub.resumeReading();
    await until(() => r.hub.frames.some((f) => f.type === "tunnel-chunk" && f.index === f.count - 1), 15_000, "last chunk");
    const delivered = reassemble(r.hub.frames, SUB_ID);
    assert.equal(delivered.type, "tree");
    assert.equal(delivered.tree.proof.length, proof.length);
    assert.ok(delivered.tree.proof === proof, "byte-identical after reassembly");
    assert.ok(r.peak() <= WS_BACKPRESSURE_BYTES, `outbound queue peaked at ${r.peak()} B`);
    assert.equal(r.hub.handshakes.length, 1, "no reconnect was needed");
  } finally {
    await r.cleanup();
  }
});

test("GA-08: a hub that stops reading is cut with 1011 backpressure, its reader hangs up on the local stream, and the connector backs off and reconnects", async () => {
  const proof = "y".repeat(400_000);
  const event = `data: ${JSON.stringify({ type: "tree", tree: { proof } })}\n\n`;
  const r = await rig(
    (req, res, api) => {
      if (req.url !== "/v1/events") return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": "text/event-stream" });
      const piece = Buffer.from(event);
      let events = 0;
      const step = () => {
        while (!res.destroyed && events < 100) {
          events++;
          api.written += piece.length;
          if (!res.write(piece)) return void res.once("drain", step);
        }
      };
      step();
    },
    { drainMs: 400 },
  );
  try {
    const ws = (r.connector as unknown as { ws: WebSocket }).ws;
    const closeCalls: unknown[][] = [];
    const close = ws.close.bind(ws) as (...a: unknown[]) => void;
    (ws as unknown as { close: (...a: unknown[]) => void }).close = (...args) => (closeCalls.push(args), close(...args));
    r.hub.stopReading();
    subscribe(r.hub);
    await until(() => r.statuses.some((s) => /backpressure/i.test(s.detail)), 8000, "backpressure cut");
    assert.deepEqual(closeCalls[0], [1011, "backpressure"], "the connector closes the socket with 1011 backpressure");
    await until(() => r.statuses.some((s) => /closed 1011 backpressure/.test(s.detail)), 5000, "the end of the socket is reported as a 1011 cut");
    assert.ok(r.peak() <= WS_BACKPRESSURE_BYTES, `outbound queue peaked at ${r.peak()} B, cap ${WS_BACKPRESSURE_BYTES} B`);
    await until(() => r.api.hungUp, 3000, "local stream closed by the connector");
    await until(() => r.hub.handshakes.length === 2 && r.connector.status().state === "connected", 8000, "reconnect after backoff");
  } finally {
    await r.cleanup();
  }
});

test("GA-08: a send that finds the queue already past the cap closes with 1011 backpressure instead of piling on", async () => {
  const r = await rig((_req, res) => res.writeHead(404).end());
  try {
    const ws = (r.connector as unknown as { ws: WebSocket }).ws;
    Object.defineProperty(ws, "bufferedAmount", { configurable: true, get: () => WS_BACKPRESSURE_BYTES + 1 });
    restRequest(r.hub, "/v1/events"); // refused locally: the 404 reply is the send that must not go out
    await until(() => r.hub.closes.length > 0, 4000, "close frame at the hub");
    assert.deepEqual(r.hub.closes[0], { code: 1011, reason: "backpressure" });
    assert.ok(r.statuses.some((s) => s.state === "connecting" && /backpressure/i.test(s.detail)), "status names the cause");
    assert.equal(r.hub.frames.filter((f) => f.type === "rest-response").length, 0, "nothing was queued behind the cap");
  } finally {
    await r.cleanup();
  }
});

test("GA-08: an SSE event that outgrows the logical cap faults that reader only; the connector never holds it and the tunnel stays up", async () => {
  const r = await rig((req, res, api) => {
    if (req.url !== "/v1/events") return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: ");
    pump(res, api, 64 * MIB);
  });
  try {
    subscribe(r.hub);
    await until(() => r.hub.frames.some((f) => f.type === "tunnel-data" && f.frame?.type === "fault"), 6000, "reader fault frame");
    const fault = r.hub.frames.find((f) => f.type === "tunnel-data" && f.frame?.type === "fault");
    assert.equal(fault.subscriptionId, SUB_ID);
    assert.equal(fault.frame.error.code, "invalid");
    await until(() => r.api.hungUp, 3000, "local stream closed");
    assert.ok(r.api.written < LOGICAL_MESSAGE_MAX_BYTES + 16 * MIB, `local API wrote ${r.api.written} B before the connector stopped reading`);
    assert.equal(r.connector.status().state, "connected");
    assert.equal(r.hub.handshakes.length, 1, "no reconnect loop");
    assert.equal((r.connector as unknown as { readers: Map<string, unknown> }).readers.size, 0, "the failed reader is gone");
  } finally {
    await r.cleanup();
  }
});

test("GA-08: an SSE event inside the read cap that cannot be encoded as chunks faults the reader instead of vanishing", async () => {
  const body = JSON.stringify({ type: "tree", tree: { proof: "z".repeat(LOGICAL_MESSAGE_MAX_BYTES - 1_000) } });
  assert.ok(body.length < LOGICAL_MESSAGE_MAX_BYTES - 6);
  const r = await rig((req, res) => {
    if (req.url !== "/v1/events") return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${body}\n\n`);
  });
  try {
    subscribe(r.hub);
    await until(() => r.hub.frames.some((f) => f.type === "tunnel-data" && f.frame?.type === "fault"), 8000, "reader fault frame");
    assert.equal(r.hub.frames.filter((f) => f.type === "tunnel-chunk").length, 0, "no partial message was sent");
    assert.equal(r.hub.handshakes.length, 1);
  } finally {
    await r.cleanup();
  }
});

test("GA-08: a REST response that outgrows the logical cap is answered 502 response_too_large without being buffered", async () => {
  const r = await rig((req, res, api) => {
    if (req.url !== "/v1/sessions") return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/json" }); // no content-length: only the byte count can stop it
    pump(res, api, 64 * MIB);
  });
  try {
    restRequest(r.hub, "/v1/sessions");
    await until(() => r.hub.frames.some((f) => f.type === "rest-response"), 6000, "rest-response");
    const reply = r.hub.frames.find((f) => f.type === "rest-response");
    assert.equal(reply.reqId, REQ_ID);
    assert.equal(reply.status, 502);
    assert.equal(reply.body.error.code, "response_too_large");
    await until(() => r.api.hungUp, 3000, "local response abandoned");
    assert.ok(r.api.written < LOGICAL_MESSAGE_MAX_BYTES + 16 * MIB, `local API wrote ${r.api.written} B before the connector stopped reading`);
    assert.equal(r.hub.handshakes.length, 1);
  } finally {
    await r.cleanup();
  }
});

test("GA-08: a REST response that declares an over-cap length is refused before its body is read", async () => {
  const r = await rig((req, res, api) => {
    if (req.url !== "/v1/sessions") return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/json", "content-length": String(64 * MIB) });
    pump(res, api, 64 * MIB);
  });
  try {
    restRequest(r.hub, "/v1/sessions");
    await until(() => r.hub.frames.some((f) => f.type === "rest-response"), 6000, "rest-response");
    assert.equal(r.hub.frames.find((f) => f.type === "rest-response").body.error.code, "response_too_large");
    await until(() => r.api.hungUp, 3000, "local response abandoned");
    assert.ok(r.api.written < 16 * MIB, `local API wrote ${r.api.written} B for a response refused on its headers`);
  } finally {
    await r.cleanup();
  }
});

test("GA-08: a REST response inside the read cap that cannot be encoded as chunks is answered 502, not dropped", async () => {
  const r = await rig((req, res, api) => {
    if (req.url !== "/v1/sessions") return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/plain" });
    pump(res, api, LOGICAL_MESSAGE_MAX_BYTES - 65_536); // 255 pieces: under the read cap, over the encodable size
  });
  try {
    restRequest(r.hub, "/v1/sessions");
    await until(() => r.hub.frames.some((f) => f.type === "rest-response"), 8000, "rest-response");
    const reply = r.hub.frames.find((f) => f.type === "rest-response");
    assert.equal(reply.status, 502);
    assert.equal(reply.body.error.code, "response_too_large");
    assert.equal(r.hub.frames.filter((f) => f.type === "tunnel-chunk").length, 0);
  } finally {
    await r.cleanup();
  }
});

test("GA-08: a large REST response inside the cap is delivered intact as paced chunks", async () => {
  const text = "q".repeat(3 * MIB);
  const r = await rig((req, res) => {
    if (req.url !== "/v1/sessions") return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(text);
  });
  try {
    restRequest(r.hub, "/v1/sessions");
    await until(() => r.hub.frames.some((f) => f.type === "tunnel-chunk" && f.index === f.count - 1), 10_000, "last chunk");
    const envelope = reassemble(r.hub.frames, REQ_ID);
    assert.equal(envelope.type, "rest-response");
    assert.equal(envelope.status, 200);
    assert.ok(envelope.body === text);
    assert.ok(r.peak() <= WS_BACKPRESSURE_BYTES);
  } finally {
    await r.cleanup();
  }
});
