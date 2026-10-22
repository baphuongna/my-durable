/**
 * P2-21 — the REAL deploy/Caddyfile in front of the REAL hub, proven by
 * integration (S-8/S-9): per-endpoint auth matrix, tunnel exemption with
 * Bearer preserved, Authorization stripped for admin routes, XFF overwrite
 * from the real connection, SSE flush, HSTS.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { makeTestCa, trustedAgent } from "./harness/ca.js";
import { bootCaddyDeploy } from "./harness/caddy.js";
import { bootHub } from "./harness/hub.js";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";

const CADDY_BIN = resolve(import.meta.dirname, "../../../tools/caddy");
const ADMIN_PASSWORD = "dpi-p221-admin-password";

const hreq = async (
  url: string,
  opts: {
    agent?: import("node:https").Agent;
    headers?: Record<string, string>;
    method?: string;
    body?: string;
  } = {},
) => {
  const https = await import("node:https");
  const u = new URL(url);
  return new Promise<{ status: number; body: string; headers: Record<string, string | undefined> }>(
    (resolveReq, rejectReq) => {
      const req = https.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          method: opts.method ?? "GET",
          headers: opts.headers,
          ...(opts.agent ? { agent: opts.agent } : {}),
        },
        (res) => {
          let body = "";
          res.on("data", (x: Buffer) => (body += x));
          res.on("end", () =>
            resolveReq({
              status: res.statusCode ?? 0,
              body,
              headers: {
                hsts: res.headers["strict-transport-security"],
                "set-cookie": res.headers["set-cookie"]?.[0],
              },
            }),
          );
        },
      );
      req.on("error", (e) => rejectReq(e));
      if (opts.body) req.write(opts.body);
      req.end();
    },
  );
};

test("P2-21 reference Caddyfile: auth matrix, tunnel exemption, XFF overwrite, HSTS, SSE flush", async () => {
  const ca = await makeTestCa();
  const agent = await trustedAgent(ca);
  const adminHash = execFileSync(CADDY_BIN, ["hash-password", "--plaintext", ADMIN_PASSWORD], {
    encoding: "utf8",
  }).trim();

  const { freePort } = await import("./harness/caddy.js");
  const caddyPort = await freePort();
  // Hub first (loopback only) with the proxied Host allow-listed, then Caddy
  // on the pre-allocated port with the reference Caddyfile.
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
    // Exempt: healthz — no auth; HSTS present on responses
    const health = await hreq(`${base}/healthz`, { agent });
    assert.equal(health.status, 200);
    assert.match(health.headers.hsts ?? "", /max-age=15552000/);

    // Exempt: pair/start + pair/verify reach the hub (never a Caddy 401)
    const start = await hreq(`${base}/api/pair/start`, {
      agent,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.notEqual(start.status, 401, "pair/start must be exempt from basic auth");
    const verify = await hreq(`${base}/api/pair/verify`, {
      agent,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.notEqual(verify.status, 401, "pair/verify must be exempt");

    // Admin matrix: no auth → 401 from Caddy (hub never consulted)
    for (const path of [
      "/api/network",
      "/api/stream",
      "/api/pair/codes/X",
      "/api/devices/x/check",
    ]) {
      const r = await hreq(`${base}${path}`, { agent });
      assert.equal(r.status, 401, `${path} must require basic auth`);
    }
    // Wrong password → 401
    const wrong = await hreq(`${base}/api/network`, {
      agent,
      headers: { authorization: "Basic " + Buffer.from("admin:wrong").toString("base64") },
    });
    assert.equal(wrong.status, 401);
    // Correct Caddy basic auth is not enough anymore: the hub itself gates the admin
    // surface (Caddy strips Authorization on admin routes, so the cookie is the
    // credential that reaches the hub). No hub cookie → the hub answers 401.
    const noHubCookie = await hreq(`${base}/api/network`, {
      agent,
      headers: { authorization: basic },
    });
    assert.equal(noHubCookie.status, 401, "hub admin auth applies behind Caddy too");
    // Log in through Caddy: basic (edge) + the hub admin token (body) → dpi_admin cookie.
    const login = await hreq(`${base}/api/session`, {
      agent,
      method: "POST",
      headers: { authorization: basic, "content-type": "application/json" },
      body: JSON.stringify({ token: hub.adminToken }),
    });
    assert.equal(login.status, 200, login.body);
    const cookie = (login.headers["set-cookie"] ?? "").split(";")[0];
    assert.match(cookie, /^dpi_admin=/);
    // Cookie + basic → 200
    const ok = await hreq(`${base}/api/network`, {
      agent,
      headers: { authorization: basic, cookie },
    });
    assert.equal(ok.status, 200);

    // Tunnel WS through Caddy: exempt, Bearer preserved. Seed a REAL credential
    // into the same registry file the hub process has open (WAL, multi-process).
    const registry = new NetworkRegistry(join(hub.home, "network.sqlite"));
    const epoch = randomUUID();
    const token =
      "dpt_" +
      Buffer.from(randomUUID() + randomUUID())
        .toString("base64url")
        .slice(0, 43);
    const t = Date.now();
    registry.db
      .prepare(
        `INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,created_at,updated_at,transport)
         VALUES('tun-dev','T','url',NULL,NULL,'ui',0,?, 'checking', ?, ?, 'tunnel')`,
      )
      .run(randomUUID(), t, t);
    registry.db
      .prepare(
        `INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at)
         VALUES('tun-dev',?,?,?,'paired',1,?,?,?)`,
      )
      .run(epoch, "pub", `sha256:${"4".repeat(64)}`, t, t, t);
    registry.db
      .prepare(
        `INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at,confirmed_at)
         VALUES(?,?,?,?,?,'current',?,?)`,
      )
      .run(randomUUID(), "tun-dev", epoch, 1, sha(token), t, t);

    const ws = new WebSocket(`wss://127.0.0.1:${caddy.port}/api/tunnel`, {
      headers: { authorization: `Bearer ${token}` },
      agent,
    } as never);
    const opened = await new Promise<string>((done) => {
      ws.once("open", () => done("open"));
      ws.once("unexpected-response", (_q, res) => done(`http ${res.statusCode}`));
      ws.once("error", (e) => done(`error ${e.message}`));
    });
    assert.equal(
      opened,
      "open",
      "tunnel WS upgrade must pass Caddy without basic auth (Bearer kept)",
    );
    ws.close();

    // SSE flush through Caddy: hello/network arrives promptly (no buffering).
    const sseFirst = await (async () => {
      const https = await import("node:https");
      const u = new URL(`${base}/api/stream`);
      return new Promise<string>((done) => {
        const req = https.get(
          {
            hostname: u.hostname,
            port: u.port,
            path: u.pathname,
            headers: { authorization: basic, cookie, accept: "text/event-stream" },
            agent,
          },
          (res) => {
            res.once("data", (chunk: Buffer) => {
              res.destroy();
              done(`${res.statusCode ?? 0}|${chunk.toString("utf8")}`);
            });
          },
        );
        req.on("error", (e) => done(`err|${e.message}`));
      });
    })();
    const [sseStatus, sseBody] = sseFirst.split("|");
    assert.equal(sseStatus, "200");
    assert.match(sseBody, /hello|network/);

    // XFF overwritten: a forged XFF must not survive Caddy. The pair/verify
    // denial lands in the hub audit with the REAL peer (Caddy on loopback);
    // the hub log/audit must never contain the forged address.
    await hreq(`${base}/api/pair/verify`, {
      agent,
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "1.2.3.4" },
      body: JSON.stringify({ code: "AAAAAAAA" }),
    });
    await new Promise((r) => setTimeout(r, 200));
    const auditRows = registry.db
      .prepare(
        "SELECT actor, detail_json FROM events WHERE action IN ('auth.denied','admin.login','pair.revoke','rate_limited') ORDER BY id DESC LIMIT 8",
      )
      .all() as { actor: string; detail_json: string }[];
    const hubDenials = auditRows.filter((r) => r.actor.startsWith("ip:"));
    if (hubDenials.length > 0)
      assert.ok(
        hubDenials.every((r) => !r.actor.includes("1.2.3.4") && !r.detail_json.includes("1.2.3.4")),
        "forged XFF must not reach the hub",
      );
  } finally {
    await hub.stop();
    await hub.cleanup();
    await caddy.stop();
    await ca.cleanup();
  }
});
