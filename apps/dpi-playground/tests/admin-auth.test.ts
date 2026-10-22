/**
 * Hub admin authentication: first-boot token bootstrap (mint, 0600, audit row),
 * POST /api/session login (cookie, rate limit, audit), cookie/bearer enforcement
 * across the admin surface, and the pairing ceremony staying open for devices.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bootHub } from "./harness/hub.js";
import { scrubSecrets } from "../apps/dpi-playground-hub/src/audit.js";
import { sanitize } from "./harness/logs.js";
import { ADMIN_COOKIE, signSession } from "../apps/dpi-playground-hub/src/admin-auth.js";

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Log in and return the Set-Cookie dpi_admin value. */
async function login(base: string, token: string) {
  const r = await fetch(`${base}/api/session`, json({ token }));
  const cookie = r.headers.get("set-cookie") ?? "";
  return { status: r.status, cookie, value: /dpi_admin=([^;]+)/.exec(cookie)?.[1] };
}

test("first boot mints an owner-only admin token, logs it, and audits admin.token_created", async () => {
  const hub = await bootHub();
  try {
    assert.match(hub.adminToken, /^adm_[A-Za-z0-9_-]{43}$/);
    const path = join(hub.home, "admin.token");
    const file = await readFile(path, "utf8");
    assert.equal(file.trim(), hub.adminToken);
    assert.equal(statSync(path).mode & 0o777, 0o600, "admin.token is owner-only");
    assert.ok(hub.log.tail(50).includes(`first run: created admin token in ${path}`));
    const db = new DatabaseSync(join(hub.home, "network.sqlite"), { readOnly: true });
    try {
      const rows = db
        .prepare(
          "SELECT actor, action, outcome, detail_json FROM events WHERE action='admin.token_created'",
        )
        .all() as { actor: string; action: string; outcome: string; detail_json: string }[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0].outcome, "ok");
      assert.ok(
        !JSON.stringify(rows).includes(hub.adminToken),
        "no token material in the audit row",
      );
    } finally {
      db.close();
    }
  } finally {
    await hub.cleanup();
  }
});

test("a second boot on the same home reuses the token; DPI_ADMIN_TOKEN_FILE relocates it", async () => {
  const hub = await bootHub();
  const first = hub.adminToken;
  await hub.stop();
  // The file already exists: no second mint, same token, no second audit row.
  await hub.start();
  try {
    assert.equal(hub.adminToken, first);
    assert.equal(
      hub.log.tail(100).split("first run: created admin token").length - 1,
      1,
      "the mint happened exactly once (first boot), never on restart",
    );
    const db = new DatabaseSync(join(hub.home, "network.sqlite"), { readOnly: true });
    try {
      const n = (
        db.prepare("SELECT count(*) AS n FROM events WHERE action='admin.token_created'").get() as {
          n: number;
        }
      ).n;
      assert.equal(n, 1, "token_created is audited once ever");
    } finally {
      db.close();
    }
  } finally {
    await hub.cleanup();
  }
  const elsewhere = join(hub.home, "elsewhere.token");
  const hub2 = await bootHub({ env: { DPI_ADMIN_TOKEN_FILE: elsewhere } });
  try {
    assert.match(hub2.adminToken, /^adm_[A-Za-z0-9_-]{43}$/);
    assert.equal(statSync(elsewhere).mode & 0o777, 0o600);
  } finally {
    await hub2.cleanup();
  }
});

test("DPI_ADMIN_TOKEN overrides the token; a set-but-short token refuses to boot", async () => {
  const fixed = "adm_" + "K".repeat(43);
  const hub = await bootHub({ env: { DPI_ADMIN_TOKEN: fixed } });
  try {
    assert.equal(hub.adminToken, fixed);
    assert.equal((await login(hub.base, fixed)).status, 200);
  } finally {
    await hub.cleanup();
  }
  await assert.rejects(
    bootHub({ env: { DPI_ADMIN_TOKEN: "adm_short" } }),
    (e: Error) =>
      /DPI_ADMIN_TOKEN is 9 characters/.test(e.message) && /hub child exited early/.test(e.message),
  );
});

test("login: correct token sets a hardened cookie that carries the admin surface; wrong token is a 401", async () => {
  const hub = await bootHub();
  try {
    const bad = await login(hub.base, "adm_" + "X".repeat(43));
    assert.equal(bad.status, 401);
    const ok = await login(hub.base, hub.adminToken);
    assert.equal(ok.status, 200);
    assert.match(ok.cookie, /dpi_admin=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    assert.match(ok.cookie, /HttpOnly/i);
    assert.match(ok.cookie, /SameSite=Strict/i);
    assert.match(ok.cookie, /Path=\//);
    assert.ok(!/Secure/i.test(ok.cookie), "plain loopback: no Secure flag");
    const cookie = `${ADMIN_COOKIE}=${ok.value}`;
    for (const path of ["/api/network", "/api/pairings"]) {
      const r = await fetch(`${hub.base}${path}`, { headers: { cookie } });
      assert.equal(r.status, 200, `${path} with the session cookie`);
    }
    // The cookie is stateless: it survives a hub restart.
    await hub.stop();
    await hub.start();
    const after = await fetch(`${hub.base}/api/network`, { headers: { cookie } });
    assert.equal(after.status, 200, "cookie still valid after restart");
  } finally {
    await hub.cleanup();
  }
});

test("login attempts are rate-limited per IP: 5 burst, then 429", async () => {
  const hub = await bootHub();
  try {
    for (let i = 0; i < 5; i++)
      assert.equal((await login(hub.base, "nope")).status, 401, `attempt ${i}`);
    const sixth = await login(hub.base, hub.adminToken);
    assert.equal(sixth.status, 429, "the bucket is spent for this address");
  } finally {
    await hub.cleanup();
  }
});

test("429 carries Retry-After, and the limit is per client address", async () => {
  const hub = await bootHub();
  try {
    for (let i = 0; i < 5; i++) await fetch(`${hub.base}/api/session`, json({ token: "nope" }));
    const limited = await fetch(`${hub.base}/api/session`, json({ token: hub.adminToken }));
    assert.equal(limited.status, 429);
    assert.ok(/^\d+$/.test(limited.headers.get("retry-after") ?? ""), "Retry-After: seconds");
    const body = (await limited.json()) as { error: { code: string } };
    assert.equal(body.error.code, "rate_limited");
    // A different client address has its own login bucket (loopback peer = trusted proxy).
    const other = await fetch(`${hub.base}/api/session`, {
      ...json({ token: hub.adminToken }),
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.50" },
    });
    assert.equal(other.status, 200, "another address is not punished");
  } finally {
    await hub.cleanup();
  }
});

test("admin.login is audited ok and denied with the client address, never the token", async () => {
  const hub = await bootHub();
  try {
    await login(hub.base, hub.adminToken);
    await login(hub.base, "adm_" + "Q".repeat(43));
    const db = new DatabaseSync(join(hub.home, "network.sqlite"), { readOnly: true });
    try {
      const rows = db
        .prepare(
          "SELECT actor, action, outcome, detail_json FROM events WHERE action='admin.login' ORDER BY rowid",
        )
        .all() as { actor: string; action: string; outcome: string; detail_json: string }[];
      assert.ok(rows.some((r) => r.outcome === "ok" && r.actor === "ip:127.0.0.1"));
      assert.ok(rows.some((r) => r.outcome === "denied"));
      assert.ok(!JSON.stringify(rows).includes(hub.adminToken));
    } finally {
      db.close();
    }
  } finally {
    await hub.cleanup();
  }
});

test("the whole admin surface answers 401 {code:unauthorized} without a credential, bearer or cookie", async () => {
  const hub = await bootHub();
  try {
    for (const [method, path, body] of [
      ["GET", "/api/network", undefined],
      ["POST", "/api/pair/code", {}],
      ["POST", "/api/pair/resolve", { code: "ABCD2345" }],
      ["GET", "/api/pair/codes/0d87c6c0-a46d-4d9b-a3fe-b2f0a5669c62", undefined],
      ["POST", "/api/pair/codes/0d87c6c0-a46d-4d9b-a3fe-b2f0a5669c62/approve", {}],
      ["POST", "/api/pair/codes/0d87c6c0-a46d-4d9b-a3fe-b2f0a5669c62/cancel", {}],
      ["GET", "/api/pairings", undefined],
      ["GET", "/api/ui-state/x", undefined],
      ["PUT", "/api/ui-state/x", { value: 1 }],
      ["POST", "/api/devices/ghost/check", {}],
      ["POST", "/api/pairings/ghost/rotate", {}],
      ["POST", "/api/pairings/ghost/revoke", {}],
    ] as const) {
      const r = await fetch(`${hub.base}${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      assert.equal(r.status, 401, `${method} ${path}`);
      assert.equal(((await r.json()) as { error: { code: string } }).error.code, "unauthorized");
    }
    // The SSE stream refuses BEFORE it starts: a JSON 401, not an event-stream.
    const sse = await fetch(`${hub.base}/api/stream`);
    assert.equal(sse.status, 401);
    assert.match(sse.headers.get("content-type") ?? "", /application\/json/);
    // The device proxy is admin surface too.
    const proxy = await fetch(`${hub.base}/api/devices/ghost/v1/device`);
    assert.equal(proxy.status, 401);
  } finally {
    await hub.cleanup();
  }
});

test("admin routes answer 200 with the bearer header (Authorization) and X-Admin-Token alike", async () => {
  const hub = await bootHub();
  try {
    for (const headers of [
      { authorization: `Bearer ${hub.adminToken}` },
      { "x-admin-token": hub.adminToken },
    ]) {
      const network = await fetch(`${hub.base}/api/network`, { headers });
      assert.equal(network.status, 200);
      const code = await fetch(`${hub.base}/api/pair/code`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(code.status, 201, "code mint with the alternate admin header");
      const state = await fetch(
        `${hub.base}/api/pair/codes/${((await code.json()) as { codeId: string }).codeId}`,
        { headers },
      );
      assert.equal(state.status, 200);
    }
    const wrong = await fetch(`${hub.base}/api/network`, {
      headers: { authorization: `Bearer adm_${"Z".repeat(43)}` },
    });
    assert.equal(wrong.status, 401);
    const device = await fetch(`${hub.base}/api/devices/ghost/v1/device`, {
      headers: hub.adminHeaders,
    });
    assert.ok(
      [404, 503].includes(device.status),
      "proxy reached (past auth), then device-plane answered",
    );
  } finally {
    await hub.cleanup();
  }
});

test("a forged or expired cookie is rejected", async () => {
  const hub = await bootHub();
  try {
    const ok = await login(hub.base, hub.adminToken);
    const flip = (value: string, at: number) => {
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz234567";
      const i = at % value.length;
      return (
        value.slice(0, i) + chars[(chars.indexOf(value[i]) + 7) % chars.length] + value.slice(i + 1)
      );
    };
    // Flip a byte in the payload (the "exp" claim) and in the signature.
    for (const at of [0, ok.value.length - 2]) {
      const forged = await fetch(`${hub.base}/api/network`, {
        headers: { cookie: `${ADMIN_COOKIE}=${flip(ok.value, at)}` },
      });
      assert.equal(forged.status, 401, `flipped cookie byte ${at}`);
    }
    // Correctly signed by the real token, but exp in the past.
    const expired = signSession(hub.adminToken, Date.now() - 60_000);
    const stale = await fetch(`${hub.base}/api/network`, {
      headers: { cookie: `${ADMIN_COOKIE}=${expired}` },
    });
    assert.equal(stale.status, 401, "expired session");
    // Correctly signed with a LONGER expiry still works (sanity).
    const live = signSession(hub.adminToken, Date.now() + 60_000);
    const good = await fetch(`${hub.base}/api/network`, {
      headers: { cookie: `${ADMIN_COOKIE}=${live}` },
    });
    assert.equal(good.status, 200);
    // Something signed with the wrong key never passes.
    const enemy = signSession("adm_" + "0".repeat(43), Date.now() + 60_000);
    const foreignKey = await fetch(`${hub.base}/api/network`, {
      headers: { cookie: `${ADMIN_COOKIE}=${enemy}` },
    });
    assert.equal(foreignKey.status, 401);
  } finally {
    await hub.cleanup();
  }
});

test("the device pairing ceremony stays open: /api/pair/start and /api/pair/verify answer pairing errors, never 401", async () => {
  const hub = await bootHub();
  try {
    const start = await fetch(`${hub.base}/api/pair/start`, json({ type: "pair.request", v: 1 }));
    assert.equal(start.status, 400, "pair/start validates the body — it is not admin-gated");
    const verify = await fetch(
      `${hub.base}/api/pair/verify`,
      json({ type: "pair.response", v: 1 }),
    );
    assert.equal(verify.status, 400, "pair/verify validates the body — it is not admin-gated");
    const health = await fetch(`${hub.base}/healthz`);
    assert.equal(health.status, 200);
  } finally {
    await hub.cleanup();
  }
});

test("cookie carries the Secure attribute when the request arrived via the TLS proxy", async () => {
  const hub = await bootHub({ publicHost: "hub.example.test" });
  const https = { "x-forwarded-proto": "https" };
  try {
    const r = await fetch(`${hub.base}/api/session`, {
      ...json({ token: hub.adminToken }),
      headers: { "content-type": "application/json", ...https, host: "hub.example.test" },
    });
    assert.equal(r.status, 200, await r.text());
    assert.match(r.headers.get("set-cookie") ?? "", /Secure/);
    const plain = await fetch(`${hub.base}/api/session`, json({ token: hub.adminToken }));
    assert.equal(plain.status, 403, "without the proxy's TLS word requireTls answers first");
    const body = (await plain.json()) as { error: { code: string } };
    assert.equal(body.error.code, "tls_required");
  } finally {
    await hub.cleanup();
  }
});

test("redaction: adm_ tokens are scrubbed from audit details and sanitized out of child logs", () => {
  const token = "adm_" + "A".repeat(43);
  assert.ok(!scrubSecrets(`login failed with ${token}`).includes(token));
  assert.ok(scrubSecrets(`login failed with ${token}`).includes("adm_<redacted>"));
  assert.ok(!sanitize(`hub: token ${token} rejected`).includes(token));
  // Device tokens keep their own rule.
  assert.ok(!scrubSecrets("dpt_" + "B".repeat(43)).includes("dpt_BBBB"));
});

test("a looser admin.token file is tightened at boot (0600 re-enforced)", async () => {
  const hub = await bootHub();
  const path = join(hub.home, "admin.token");
  await hub.stop();
  chmodSync(path, 0o644);
  await writeFile(path, `${hub.adminToken}\n`);
  await hub.start();
  try {
    assert.equal(statSync(path).mode & 0o777, 0o600, "re-tightened on the next boot");
    assert.equal((await login(hub.base, hub.adminToken)).status, 200, "token unchanged");
  } finally {
    await hub.cleanup();
  }
});
