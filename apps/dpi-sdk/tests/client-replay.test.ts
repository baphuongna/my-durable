/**
 * R13 (R9-6.3 FE): DpiClient surfaces the device's idempotency REPLAY verdict
 * via an optional hook — the answer is a replay of an earlier identical
 * request, not a fresh effect. UIs toast it; clients that need deliberate
 * repeats send their own idempotencyKey (which the test also proves still
 * reaches the wire).
 * Level: unit, loopback http fixture (hermetic — no device).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DpiClient } from "../src/client.js";

async function withServer(
  headers: Record<string, string>,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, headers);
    res.end('{"ok":true}');
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  await new Promise<void>((ok) => server.close(() => ok()));
}

test("onIdempotentReplay fires only when the device answers Idempotent-Replay: true", async () => {
  await withServer({ "content-type": "application/json", "idempotent-replay": "true" }, async (url) => {
    const seen: string[] = [];
    const client = new DpiClient(url, undefined, {
      onIdempotentReplay: (path) => seen.push(path),
    });
    await client.request("POST", "/v1/sessions", { name: "x" });
    assert.deepEqual(seen, ["/v1/sessions"], "the hook fires with the request path");
  });

  await withServer({ "content-type": "application/json" }, async (url) => {
    const seen: string[] = [];
    const client = new DpiClient(url, undefined, {
      onIdempotentReplay: (path) => seen.push(path),
    });
    await client.request("POST", "/v1/sessions", { name: "x" });
    assert.deepEqual(seen, [], "no replay verdict, no hook");
  });
});

test("a custom idempotency key still rides the wire (the deliberate-repeat escape hatch)", async () => {
  let header = "";
  const server: Server = createServer((req, res) => {
    header = String(req.headers["idempotency-key"] ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new DpiClient(url);
  await client.request("POST", "/v1/sessions", { name: "x" }, { idempotencyKey: "custom-42" });
  assert.equal(header, "custom-42", "the caller's key wins over the auto-key");
  await new Promise<void>((ok) => server.close(() => ok()));
});
