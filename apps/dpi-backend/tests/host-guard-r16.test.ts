/**
 * R16 (run-2 h1 NV close): the unauthenticated enrollment surface answers
 * only hosts this device serves. A DNS-rebind page (Host: evil.com:port)
 * must be told it is misdirected even though, from the browser's view, its
 * fetches are same-origin and need no CORS preflight.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { get } from "node:http";
import { hostAllowlist, hostGuard } from "../src/host-guard.js";

function once(port: number, hostHeader: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = get(
      { host: "127.0.0.1", port, path: "/healthz", headers: { Host: hostHeader } },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
  });
}

test("R16 h1: hostAllowlist carries loopback + own interfaces with the port", () => {
  const allow = hostAllowlist(4780);
  assert.ok(allow.has("localhost:4780"));
  assert.ok(allow.has("127.0.0.1:4780"));
  assert.ok(allow.has("[::1]:4780"));
  // every enumerated IPv4 interface appears as address:port
  let ipv4 = 0;
  for (const h of allow) if (/^\d+\.\d+\.\d+\.\d+:4780$/.test(h)) ipv4++;
  assert.ok(ipv4 >= 1, `expected own IPv4s, got ${[...allow].join(",")}`);
  // a rebound attacker host is never present
  assert.ok(!allow.has("evil.com:4780"));
});

test("R16 h1: the guard 421s a rebound Host and serves our own", async () => {
  const app = express();
  // Guard holds the Set by reference: fill it once the ephemeral port is known.
  const allow = new Set<string>();
  app.get("/healthz", hostGuard(allow), (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.on("listening", () => r()));
  const port = (server.address() as { port: number }).port;
  for (const h of hostAllowlist(port)) allow.add(h);
  try {
    const rebound = await once(port, "evil.com");
    assert.equal(rebound.status, 421);
    assert.ok(rebound.body.includes("Unknown Host header"));
    const own = await once(port, `127.0.0.1:${port}`);
    assert.equal(own.status, 200);
    assert.ok(own.body.includes('"ok"'));
    // Host header without a port (implicit 80) is NOT ours either
    const noPort = await once(port, "127.0.0.1");
    assert.equal(noPort.status, 421);
  } finally {
    server.close();
  }
});
