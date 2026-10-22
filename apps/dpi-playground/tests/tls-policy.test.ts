/**
 * S-9 / spec 05 §4.2 — `requireTls`: the hub trusts X-Forwarded-Proto only from a loopback peer (the
 * reference TLS proxy) and, when TLS is required, refuses everything that cannot prove it.
 *
 * Caddy already refuses plain HTTP/WS; this is the second line: a misrouted proxy, a hub started on a
 * LAN address, or a local process talking to the loopback port must not be served as if it were TLS.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { networkInterfaces } from "node:os";
import express from "express";
import { WebSocket } from "ws";
import { isTrustedProxy, viaTls } from "../apps/dpi-playground-hub/src/client-ip.js";
import { requireTls } from "../apps/dpi-playground-hub/src/guard.js";
import { bootHub } from "./harness/hub.js";
import { tunnelFixture } from "./harness/tunnel-fixture.js";

const https = { "x-forwarded-proto": "https" };
const ipv4Interfaces = Object.values(networkInterfaces())
  .flat()
  .filter((a) => a && a.family === "IPv4") as { address: string; internal: boolean }[];
const lanAddress = ipv4Interfaces.find((a) => !a.internal)?.address;
const ipv4Listed =
  ipv4Interfaces.map((a) => `${a.address}${a.internal ? " (internal)" : ""}`).join(", ") || "none";

const fakeReq = (peer: string | undefined, headers: Record<string, string | string[]> = {}) =>
  ({ socket: { remoteAddress: peer }, headers }) as never;

test("viaTls: only a loopback proxy can vouch for TLS, and only with exactly one https", () => {
  const table: Array<[string, string | undefined, Record<string, string | string[]>, boolean]> = [
    ["loopback IPv4 + https", "127.0.0.1", https, true],
    ["loopback IPv6 + https", "::1", https, true],
    ["scheme names are case-insensitive", "127.0.0.1", { "x-forwarded-proto": "HTTPS" }, true],
    ["loopback + http", "127.0.0.1", { "x-forwarded-proto": "http" }, false],
    ["loopback, header absent", "127.0.0.1", {}, false],
    ["loopback, empty value", "127.0.0.1", { "x-forwarded-proto": "" }, false],
    [
      "a list is not a single proxy's word (https first)",
      "127.0.0.1",
      { "x-forwarded-proto": "https, http" },
      false,
    ],
    [
      "a list is not a single proxy's word (https last)",
      "127.0.0.1",
      { "x-forwarded-proto": "http, https" },
      false,
    ],
    ["LAN peer forging https", "192.168.1.2", https, false],
    ["public peer forging https", "203.0.113.9", https, false],
    ["unknown peer", undefined, https, false],
  ];
  for (const [name, peer, headers, expected] of table)
    assert.equal(viaTls(fakeReq(peer, headers)), expected, name);
  assert.equal(
    isTrustedProxy("127.0.0.1"),
    true,
    "premise: the same trust rule as client addresses",
  );
});

/**
 * Loopback only — plus, when the forging case can run, a second listener on exactly
 * the one non-internal IPv4 address it needs. Never 0.0.0.0: these tests want
 * loopback specifically, not every interface the host happens to have.
 */
async function withGuardedApp(fn: (hosts: { loopback: string; lan?: string }) => Promise<void>) {
  const app = express();
  app.use(requireTls());
  app.get("/x", (_req, res) => res.json({ ok: true }));
  const listen = (host: string) =>
    new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
      const server = createServer(app);
      server.once("error", reject);
      server.listen(0, host, () => resolve(server));
    });
  const close = (server: ReturnType<typeof createServer>) =>
    new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => done());
    });
  const loopback = await listen("127.0.0.1");
  try {
    const lan = lanAddress ? await listen(lanAddress) : undefined;
    try {
      await fn({
        loopback: `127.0.0.1:${(loopback.address() as { port: number }).port}`,
        lan: lan ? `${lanAddress}:${(lan.address() as { port: number }).port}` : undefined,
      });
    } finally {
      if (lan) await close(lan);
    }
  } finally {
    await close(loopback);
  }
}

test("requireTls middleware: 403 tls_required unless a loopback proxy says https", async (t) => {
  await withGuardedApp(async (hosts) => {
    const get = async (host: string, headers: Record<string, string> = {}) => {
      const r = await fetch(`http://${host}/x`, { headers });
      return {
        status: r.status,
        body: (await r.json()) as { error?: { code: string; message: string } },
      };
    };
    assert.deepEqual(await get(hosts.loopback, https), {
      status: 200,
      body: { ok: true } as never,
    });
    for (const headers of [{}, { "x-forwarded-proto": "http" }]) {
      const refused = await get(hosts.loopback, headers);
      assert.equal(refused.status, 403);
      assert.equal(refused.body.error?.code, "tls_required");
      assert.ok(
        !/at |\.ts|\/home\//.test(refused.body.error?.message ?? ""),
        "no internals in the message",
      );
    }
    if (!hosts.lan) {
      // LOUD skip, not a silent pass: without a non-internal IPv4 address there is
      // no socket a non-loopback peer could open, so the forging half cannot run
      // here. (The pure-function table above still covers the same trust rule.)
      t.skip(
        `no non-internal IPv4 address to bind for the LAN-peer forging case (IPv4 interfaces: ${ipv4Listed})`,
      );
      return;
    }
    const forged = await get(hosts.lan, https);
    assert.equal(forged.status, 403, "a LAN peer that sets X-Forwarded-Proto is not believed");
    assert.equal(forged.body.error?.code, "tls_required");
  });
});

test("tunnel upgrade with requireTls: refused before any bucket is touched, believed only from loopback", async () => {
  const f = await tunnelFixture({ policy: { requireTls: true } });
  try {
    const device = f.addDevice("tls-dev");
    const upgrade = (headers: Record<string, string>) =>
      new Promise<{ status: number; body: any }>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${f.port}/api/tunnel`, {
          headers: { authorization: `Bearer ${device.token}`, ...headers },
        });
        ws.once("open", () => {
          ws.terminate();
          resolve({ status: 101, body: null });
        });
        ws.once("error", reject);
        ws.once("unexpected-response", (_q, res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
            ws.terminate();
          });
        });
      });

    // 40 plain attempts from the same client address: far past the burst of 10.
    for (let i = 0; i < 40; i++) {
      const r = await upgrade({ "x-forwarded-for": "198.51.100.7" });
      assert.equal(r.status, 403, `attempt ${i}`);
      assert.equal(r.body.error.code, "tls_required");
    }
    assert.equal(
      (await upgrade({ "x-forwarded-for": "198.51.100.7", ...https })).status,
      101,
      "refusals spent none of the client's upgrade budget",
    );

    // A peer that is not the proxy cannot assert TLS (nor a client address).
    const forged = f.attempt("203.0.113.9", device.token, https);
    assert.equal(forged.status, 403);
    assert.equal(forged.body.error.code, "tls_required");
    assert.ok(f.eventCount("auth.denied") >= 1, "the refusals are visible in the audit log");
  } finally {
    await f.cleanup();
  }
});

test("tunnel upgrade without requireTls (development) is unaffected", async () => {
  const f = await tunnelFixture();
  try {
    const device = f.addDevice("dev-dev");
    const ws = await f.connect(device);
    ws.terminate();
  } finally {
    await f.cleanup();
  }
});

const rawGet = (
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
  body?: string,
) =>
  new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method, headers: { host: "hub.example.test", ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: any = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* html or empty */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });

test("hub process: a configured public host means TLS is required everywhere but /healthz", async () => {
  const hub = await bootHub({ publicHost: "hub.example.test" });
  try {
    assert.equal(
      (await rawGet(hub.port, "/healthz")).status,
      200,
      "supervisors probe /healthz without a proxy",
    );
    for (const [path, method, body] of [
      ["/api/network", "GET", undefined],
      ["/", "GET", undefined],
      ["/api/pair/start", "POST", "{}"],
      ["/api/pair/code", "POST", "{}"],
    ] as const) {
      const r = await rawGet(
        hub.port,
        path,
        body ? { "content-type": "application/json" } : {},
        method,
        body,
      );
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.equal(r.body.error?.code, "tls_required", `${method} ${path}`);
    }
    assert.equal(
      (await rawGet(hub.port, "/api/network", https)).status,
      200,
      "the proxy's word is accepted",
    );

    const upgrade = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/api/tunnel`, {
        headers: { authorization: `Bearer dpt_${"A".repeat(43)}` },
      });
      ws.once("unexpected-response", (_q, res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
        ws.terminate();
      });
      ws.once("error", reject);
      ws.once("open", () => reject(new Error("unexpected 101")));
    });
    assert.equal(upgrade, 403, "the tunnel endpoint enforces it too");
  } finally {
    await hub.cleanup();
  }
});

test("hub process: DPI_HUB_REQUIRE_TLS overrides the default in both directions and rejects typos", async () => {
  const off = await bootHub({ publicHost: "hub.example.test", env: { DPI_HUB_REQUIRE_TLS: "0" } });
  try {
    assert.equal((await rawGet(off.port, "/api/network")).status, 200);
  } finally {
    await off.cleanup();
  }
  const on = await bootHub({ env: { DPI_HUB_REQUIRE_TLS: "1" } });
  try {
    const r = await rawGet(on.port, "/api/network", { host: `127.0.0.1:${on.port}` });
    assert.equal(r.status, 403);
    assert.equal(r.body.error?.code, "tls_required");
  } finally {
    await on.cleanup();
  }
  const plain = await bootHub();
  try {
    assert.equal(
      (await rawGet(plain.port, "/api/network", { host: `127.0.0.1:${plain.port}` })).status,
      200,
      "no public host, no flag: local development works as before",
    );
  } finally {
    await plain.cleanup();
  }
  await assert.rejects(bootHub({ env: { DPI_HUB_REQUIRE_TLS: "maybe" } }), /DPI_HUB_REQUIRE_TLS/);
});
