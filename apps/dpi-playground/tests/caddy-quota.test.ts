/**
 * Review 2026-10-20 regressions — hub ingress (Cluster E).
 * F10 real client IPs through trust-proxy: distinct per-IP pairing buckets,
 * public pairing traffic never drains the admin API bucket.
 * F20 the pairing 16 KiB body cap sits at the ingress boundary (not behind
 * the global 256 KiB parser).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { makeTestCa, trustedAgent } from "./harness/ca.js";
import { bootCaddyDeploy, freePort } from "./harness/caddy.js";
import { bootHub } from "./harness/hub.js";

const CADDY_BIN = resolve(import.meta.dirname, "../../../tools/caddy");
const ADMIN_PASSWORD = "dpi-f10-admin-password";

const hreq = async (
  url: string,
  opts: { agent?: import("node:https").Agent; headers?: Record<string, string>; method?: string; body?: string; localAddress?: string } = {},
) => {
  const https = await import("node:https");
  const u = new URL(url);
  return new Promise<{ status: number; body: string }>((resolveReq, rejectReq) => {
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method ?? "GET",
        headers: opts.headers,
        ...(opts.agent ? { agent: opts.agent } : {}),
        ...(opts.localAddress ? { localAddress: opts.localAddress } : {}),
      },
      (res) => {
        let body = "";
        res.on("data", (x: Buffer) => (body += x));
        res.on("end", () => resolveReq({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", (e) => rejectReq(e));
    if (opts.body) req.write(opts.body);
    req.end();
  });
};

test("F10 regression: two real client IPs keep separate pairing buckets; a public pairing flood never 429s the admin API", async () => {
  const ca = await makeTestCa();
  const agent = await trustedAgent(ca);
  const adminHash = execFileSync(CADDY_BIN, ["hash-password", "--plaintext", ADMIN_PASSWORD], { encoding: "utf8" }).trim();
  const caddyPort = await freePort();
  const hub = await bootHub({ publicHost: `127.0.0.1:${caddyPort}` });
  const caddy = await bootCaddyDeploy({
    hubPort: hub.port,
    port: caddyPort,
    certFile: join(ca.dir, "hub.crt"),
    keyFile: join(ca.dir, "hub.key"),
    adminHash,
  });
  const base = caddy.httpsBase;
  const basic = "Basic " + Buffer.from(`admin:${ADMIN_PASSWORD}`).toString("base64");
  try {
    const mkCode = (from: string) => hreq(`${base}/api/pair/code`, { method: "POST", agent, localAddress: from, headers: { authorization: basic, "content-type": "application/json" }, body: "{}" });
    // Client A (127.0.0.1) exhausts ITS pairing code bucket (5 / 15 min).
    const a: number[] = [];
    for (let i = 0; i < 6; i++) a.push((await mkCode("127.0.0.1")).status);
    assert.deepEqual(a.slice(0, 5), [201, 201, 201, 201, 201], "A's five codes");
    assert.equal(a[5], 429, "A's own bucket exhausted");
    // Client B — a DIFFERENT real source IP — has its own bucket.
    const b1 = await mkCode("127.0.0.2");
    assert.equal(b1.status, 201, `B's first code must not inherit A's bucket (got ${b1.status}: ${b1.body.slice(0, 120)})`);

    // B floods the PUBLIC verify endpoint (no admin auth, no valid body): the
    // admin API bucket must stay untouched — pairing is metered by its own
    // per-IP buckets, never by apiRate.
    const garbage = JSON.stringify({ type: "pair.response", v: 1, enrollmentId: "0".repeat(36), nonce: "n".repeat(43), signature: "A".repeat(86) });
    // The admin bucket message is exactly "Too many requests; slow down";
    // PairingService has its OWN verify buckets ("Too many verify requests…",
    // "Too many pairing failures…") — hitting those is correct S-2 behavior.
    let pairingOwn429 = false;
    for (let i = 0; i < 130; i++) {
      const r = await hreq(`${base}/api/pair/verify`, { method: "POST", agent, localAddress: "127.0.0.2", headers: { "content-type": "application/json" }, body: garbage });
      if (r.status === 429) {
        if (r.body.includes("\"Too many requests; slow down\"") || (r.body.includes("rate_limited") && !/verify requests|pairing failures/.test(r.body)))
          throw new Error(`ADMIN bucket 429 leaked onto public pairing at i=${i}: ${r.body.slice(0, 140)}`);
        pairingOwn429 = true;
        break; // pairing's own global verify cap kicked in — exactly as designed
      }
    }
    assert.ok(pairingOwn429, "the flood DID reach pairing's own verify limiter (100/min global)");
    // The admin API from another client still answers.
    const net = await hreq(`${base}/api/network`, { agent, localAddress: "127.0.0.1", headers: { authorization: basic } });
    assert.equal(net.status, 200, `admin API unaffected by the public flood (got ${net.status}: ${net.body.slice(0, 120)})`);
  } finally {
    await caddy.stop();
    await hub.stop();
  }
});

test("F20 regression: a 20 KB pairing body is rejected 413 by the 16 KB ingress cap (not pre-parsed by the global 256 KB parser)", async () => {
  const hub = await bootHub();
  try {
    const base = hub.base;
    const big = { type: "pair.request", v: 1, requestId: "0".repeat(36), code: "ABC-DEF", deviceUid: "1".repeat(36), deviceName: "x".repeat(20_000), publicKey: "not-a-key", keyFingerprint: "sha256:" + "0".repeat(64), clientTime: 0 };
    const bytes = Buffer.byteLength(JSON.stringify(big));
    assert.ok(bytes > 16_384 && bytes < 256 * 1024, `body ${bytes}B sits between the two caps`);
    const res = await fetch(`${base}/api/pair/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(big) });
    assert.equal(res.status, 413, `16 KiB pairing cap enforced at ingress (got ${res.status})`);
    const text = await res.text();
    assert.ok(!text.includes("tunnelToken"), "no credential material in the error");
  } finally {
    await hub.stop();
  }
  void DatabaseSync;
  void mkdtemp;
  void tmpdir;
});
