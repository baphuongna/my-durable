/**
 * S-9 — the TLS floor of the reference deployment (spec 05 §4: minimum TLS 1.2).
 *
 * Two independent proofs: the Caddyfile must DECLARE the floor (so an upgrade of Caddy that changes
 * its defaults cannot silently lower it), and the real Caddy must REFUSE TLS 1.0/1.1 while serving 1.2/1.3.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import tls from "node:tls";
import { makeTestCa } from "./harness/ca.js";
import { bootCaddyDeploy, DEPLOY_CADDYFILE, freePort } from "./harness/caddy.js";

const CADDY_BIN = resolve(import.meta.dirname, "../../../tools/caddy");
const ADMIN_PASSWORD = "p".repeat(24);

interface Policy { match?: { sni?: string[] }; protocol_min?: string; protocol_max?: string }

function adaptedPolicies(): Policy[] {
  const out = execFileSync(CADDY_BIN, ["adapt", "--config", DEPLOY_CADDYFILE, "--adapter", "caddyfile"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"], // Caddy's advisory warnings go to stderr
    env: {
      ...process.env,
      DPI_PUBLIC_HOST: "hub.example.test:8443",
      DPI_TLS_CERT: "/nonexistent/hub.crt",
      DPI_TLS_KEY: "/nonexistent/hub.key",
      DPI_HUB_ADDR: "127.0.0.1:4781",
      DPI_ADMIN_HASH: "$2a$14$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012",
    },
  });
  const servers = JSON.parse(out).apps.http.servers as Record<string, { tls_connection_policies?: Policy[] }>;
  return Object.values(servers).flatMap((s) => s.tls_connection_policies ?? []);
}

test("S-9: the reference Caddyfile declares TLS 1.2 as the minimum for the public site", () => {
  const named = adaptedPolicies().filter((p) => p.match?.sni?.includes("hub.example.test"));
  assert.equal(named.length, 1, "exactly one policy serves the public host name");
  assert.equal(named[0].protocol_min, "tls1.2");
  assert.equal(named[0].protocol_max, "tls1.3");
  for (const p of adaptedPolicies()) {
    assert.ok(!p.protocol_min || p.protocol_min >= "tls1.2", `no policy may lower the floor: ${JSON.stringify(p)}`);
  }
});

test("S-9: the real Caddy refuses TLS 1.0 and 1.1 and serves TLS 1.2 and 1.3", async () => {
  const ca = await makeTestCa();
  const adminHash = execFileSync(CADDY_BIN, ["hash-password", "--plaintext", ADMIN_PASSWORD], { encoding: "utf8" }).trim();
  const caddy = await bootCaddyDeploy({
    hubPort: await freePort(), // nothing listens there; the TLS handshake does not need the hub
    certFile: join(ca.dir, "hub.crt"),
    keyFile: join(ca.dir, "hub.key"),
    adminHash,
  });
  // SECLEVEL=0 lets THIS client offer the legacy versions at all; otherwise it would refuse before Caddy does.
  const handshake = (version: tls.SecureVersion) =>
    new Promise<string>((done) => {
      const socket = tls.connect(
        { host: "127.0.0.1", port: caddy.port, rejectUnauthorized: false, minVersion: version, maxVersion: version, ciphers: "ALL:@SECLEVEL=0" },
        () => {
          done(`accepted ${socket.getProtocol()}`);
          socket.destroy();
        },
      );
      socket.on("error", (e) => done(`refused ${/alert protocol version|protocol version/i.test(e.message) ? "protocol version" : e.message}`));
    });
  try {
    assert.equal(await handshake("TLSv1"), "refused protocol version");
    assert.equal(await handshake("TLSv1.1"), "refused protocol version");
    assert.equal(await handshake("TLSv1.2"), "accepted TLSv1.2");
    assert.equal(await handshake("TLSv1.3"), "accepted TLSv1.3");
  } finally {
    await caddy.stop();
    await ca.cleanup();
  }
});
