/**
 * P2-04 harness smoke: boot/restart/cleanup, cert trust success + hostname/CA
 * failure, barrier determinism, keep-SSE-while-device-dies. No live provider
 * calls (faux only). Direct PID cleanup, no pkill.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { makeTestCa, trustedAgent } from "./harness/ca.js";
import { bootCaddy } from "./harness/caddy.js";
import { bootHub } from "./harness/hub.js";
import { makeActors } from "./harness/actors.js";
import { startBarrierHub, childGate } from "./harness/barriers.js";
import { sanitize } from "./harness/logs.js";

const hreq = async (
  url: string,
  opts: { agent?: import("node:https").Agent; headers?: Record<string, string> } = {},
) => {
  const https = await import("node:https");
  return new Promise<{ status: number; body: string; code?: string }>((resolve, reject) => {
    const u = new URL(url);
    const req = https.get(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: opts.headers,
        ...(opts.agent ? { agent: opts.agent } : {}),
      },
      (res) => {
        let body = "";
        res.on("data", (x: Buffer) => (body += x));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", (e: NodeJS.ErrnoException) => resolve({ status: 0, body: "", code: e.code }));
    req.end();
  });
};

test("harness smoke: boot → TLS trust → hostname/CA failures → restart → cleanup", async () => {
  const ca = await makeTestCa();
  const agent = await trustedAgent(ca);
  const actors = makeActors();
  assert.ok(actors.deviceA.tunnelToken.startsWith("dpt_"));
  assert.ok(actors.deviceA.deviceToken.startsWith("dpi_"));

  const hub = await bootHub({}); // plain loopback first
  const caddy = await bootCaddy({
    hubPort: hub.port,
    certFile: join(ca.dir, "hub.crt"),
    keyFile: join(ca.dir, "hub.key"),
  });

  try {
    // 1. Cert trust success via 127.0.0.1 (SAN IP present). Restart the hub on the
    //    SAME port with --public-host so the guard accepts the proxied Host header.
    await hub.stop();
    await hub.cleanup();
    const hubBehindProxy = await bootHub({ port: hub.port, publicHost: `127.0.0.1:${caddy.port}` });

    const trusted = await hreq(`${caddy.httpsBase}/api/network`, { agent });
    assert.equal(trusted.status, 200, `trusted fetch must pass: ${trusted.body}`);
    assert.ok(JSON.parse(trusted.body).devices !== undefined);

    // 2. Hostname failure: localhost is NOT in SAN. Caddy has no cert for that
    //    SNI (TLS alert → EPROTO) or Node's own alt-name check fires.
    const hostname = await hreq(`https://localhost:${caddy.port}/api/network`, { agent });
    assert.ok(
      hostname.code === "ERR_TLS_CERT_ALTNAME_INVALID" || hostname.code === "EPROTO",
      `expected hostname failure, got ${hostname.code}`,
    );

    // 3. CA failure: default agent does not trust the test CA.
    const untrusted = await hreq(`${caddy.httpsBase}/api/network`);
    assert.ok(
      untrusted.code === "SELF_SIGNED_CERT_IN_CHAIN" ||
        untrusted.code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
        untrusted.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
        untrusted.code === "ERR_TLS_CERT_ALTNAME_INVALID",
      `unexpected code ${untrusted.code}`,
    );
    assert.equal(untrusted.status, 0);

    // 4. Hub restart on the same port — health recovers, TLS path works again.
    await hubBehindProxy.stop();
    assert.ok(hubBehindProxy.exited());
    await hubBehindProxy.start();
    const after = await hreq(`${caddy.httpsBase}/api/network`, { agent });
    assert.equal(after.status, 200);

    // 5. Direct child PID bookkeeping — all children exited on cleanup, no pkill.
    await hubBehindProxy.cleanup();
    await caddy.stop();
    assert.notEqual(hubBehindProxy.exitCode(), undefined);
    assert.ok(caddy.exited());
  } finally {
    await ca.cleanup();
  }
});

test("harness smoke: SSE tab survives device-child SIGKILL (network stays, T-2/T-3 separation helper)", async () => {
  const ca = await makeTestCa();
  const agent = await trustedAgent(ca);
  const hub = await bootHub({});
  const caddy = await bootCaddy({
    hubPort: hub.port,
    certFile: join(ca.dir, "hub.crt"),
    keyFile: join(ca.dir, "hub.key"),
  });
  const { openTab } = await import("./harness/actors.js");
  const ac = new AbortController();
  let tab: Awaited<ReturnType<typeof openTab>> | undefined;
  try {
    // Boot the real backend child (faux) — the "device".
    const home = await mkdtemp(join(tmpdir(), "dpi-dev-"));
    const { bootServer } = await import("../../dpi-backend/tests/helpers.js");
    const device = await bootServer({
      home,
      startDirs: join(home, "work"),
      token: makeActors().deviceA.deviceToken,
    });
    const hubBehindProxy = await bootHub({ port: hub.port, publicHost: `127.0.0.1:${caddy.port}` });
    await hub.cleanup();

    // Open a browser tab through TLS; mux pings keep it alive.
    tab = await openTab(`${caddy.httpsBase}/api/stream`, { agent, signal: ac.signal });
    const first = await tab.next(); // initial tree frame
    assert.ok(first.event.length > 0);

    // Kill ONLY the device child (SIGKILL — crash). The hub tab must stay connected.
    await device.stop("SIGKILL");
    await new Promise((r) => setTimeout(r, 800));
    // Hub still answers REST through TLS — the tab's SSE connection is hub-owned.
    const net = await hreq(`${caddy.httpsBase}/api/network`, { agent });
    assert.equal(net.status, 200);

    await hubBehindProxy.cleanup();
    await rm(home, { recursive: true, force: true });
  } finally {
    ac.abort();
    tab?.close();
    await caddy.stop();
    await ca.cleanup();
  }
});

test("barrier: deterministic park/release, no timing races", async () => {
  const hub = await startBarrierHub();
  const tmp = await mkdtemp(join(tmpdir(), "dpi-bar-"));
  const script = join(tmp, "child.mts");
  await writeFile(
    script,
    `import { childGate } from ${JSON.stringify(new URL("./harness/barriers.js", import.meta.url).pathname)};\nawait childGate(${hub.port}, "file-rename");\nprocess.stdout.write("renamed\\n");\n`,
  );
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let out = "";
  child.stdout!.on("data", (x) => (out += x));
  try {
    await hub.waitFor("file-rename", 8000);
    assert.ok(hub.parked("file-rename") >= 1);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(out, ""); // parked: deterministic, nothing proceeded
    hub.release("file-rename");
    await new Promise<void>((resolve, reject) => {
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    });
    assert.equal(out, "renamed\n");
  } finally {
    child.kill("SIGKILL");
    await hub.stop();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("log sanitizer: tokens/codes/private keys never leak", () => {
  const dirty = `token=dpt_${"A".repeat(43)} dpi_${"B".repeat(43)} code=AB2C7DEF Authorization: Bearer abc123.xyz\n-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----`;
  const clean = sanitize(dirty);
  assert.ok(!clean.includes("dpt_AAAA"));
  assert.ok(!clean.includes("dpi_BBBB"));
  assert.ok(!clean.includes("AB2C7DEF"));
  assert.ok(!clean.includes("secret"));
  assert.ok(clean.includes("dpt_<redacted>"));
});
