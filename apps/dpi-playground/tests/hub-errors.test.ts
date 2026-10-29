/**
 * Gate A GA-10 / GA-02 / GA-15 against the real hub process: the HTTP error contract (no framework
 * error pages, no stack frames or absolute paths), the 503 contract for audited changes refused by
 * the disk guard, and an admin-API quota that survives churn through other client addresses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Agent, request, type IncomingHttpHeaders } from "node:http";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocket as WsClient } from "ws";
import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { bootHub } from "./harness/hub.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const until = async (fn: () => Promise<boolean>, timeout: number, what: string) => {
  const by = Date.now() + timeout;
  while (Date.now() < by) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.fail(`timed out waiting for ${what}`);
};

interface Reply {
  status: number;
  type: string;
  text: string;
  headers: IncomingHttpHeaders;
}

function raw(
  base: string,
  method: string,
  path: string,
  opts: { body?: string | Buffer; headers?: Record<string, string>; agent?: Agent } = {},
): Promise<Reply> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        method,
        path,
        headers: opts.headers,
        agent: opts.agent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            type: String(res.headers["content-type"] ?? ""),
            text: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

const JSON_BODY = { "content-type": "application/json" };

/** Nothing a stranger can use to map the install: frames, module paths, absolute paths, error class names. */
function assertClean(reply: Reply, label: string) {
  assert.match(reply.type, /^application\/json/, `${label}: content-type ${reply.type}`);
  assert.doesNotMatch(
    reply.text,
    /node_modules|\n\s+at |\.ts:\d+|\.js:\d+|\/home\/|\/usr\/|\/tmp\/|SyntaxError|URIError|PayloadTooLarge|<html|<pre>/i,
    `${label}: ${reply.text.slice(0, 300)}`,
  );
  const body = JSON.parse(reply.text) as { error?: { code?: string; message?: string } };
  assert.equal(typeof body.error?.code, "string", `${label}: error.code`);
  assert.equal(typeof body.error?.message, "string", `${label}: error.message`);
  assert.ok(body.error!.message!.length < 200, `${label}: short message`);
}

test("GA-10: malformed JSON on the public pairing surface is a clean JSON 400", async () => {
  const hub = await bootHub();
  try {
    for (const path of ["/api/pair/start", "/api/pair/verify", "/api/pair/code"]) {
      const r = await raw(hub.base, "POST", path, {
        body: '{"requestId":',
        headers: { ...JSON_BODY, ...hub.adminHeaders },
      });
      assert.equal(r.status, 400, path);
      assertClean(r, path);
      assert.equal((JSON.parse(r.text) as { error: { code: string } }).error.code, "invalid_json");
    }
  } finally {
    await hub.cleanup();
  }
});

test("GA-10: an oversized body is a clean JSON 413 on the pairing surface and on the admin API", async () => {
  const hub = await bootHub();
  try {
    const big20k = JSON.stringify({ pad: "x".repeat(20_000) });
    const pair = await raw(hub.base, "POST", "/api/pair/start", {
      body: big20k,
      headers: JSON_BODY,
    });
    assert.equal(pair.status, 413);
    assertClean(pair, "pair 16 KiB cap");
    assert.equal(
      (JSON.parse(pair.text) as { error: { code: string } }).error.code,
      "payload_too_large",
    );

    const big300k = JSON.stringify({ value: "x".repeat(300_000) });
    const admin = await raw(hub.base, "PUT", "/api/ui-state/k", {
      body: big300k,
      headers: JSON_BODY,
    });
    assert.equal(admin.status, 413);
    assertClean(admin, "admin 256 KiB cap");
  } finally {
    await hub.cleanup();
  }
});

test("GA-10: malformed JSON and an undecodable URL on the admin API/static surface are clean JSON 400s", async () => {
  const hub = await bootHub();
  try {
    const json = await raw(hub.base, "PUT", "/api/ui-state/k", {
      body: "{not json",
      headers: JSON_BODY,
    });
    assert.equal(json.status, 400);
    assertClean(json, "admin malformed json");

    for (const path of ["/%E0%A4%A", "/assets/%E0%A4%A", "/api/devices/%E0%A4%A/check"]) {
      const r = await raw(hub.base, "GET", path, { headers: hub.adminHeaders });
      assert.equal(r.status, 400, path);
      assertClean(r, path);
    }
  } finally {
    await hub.cleanup();
  }
});

test("GA-02: while the audit volume is under its free-space floor an audited change is a JSON 503 and reads keep working", async () => {
  const hub = await bootHub({
    env: {
      DPI_AUDIT_MIN_FREE_BYTES: String(Number.MAX_SAFE_INTEGER),
      // A first boot mints + audits the admin token; under the floor that is a
      // boot refusal, which is not what THIS test measures. Hand it a token.
      DPI_ADMIN_TOKEN: `adm_${"h".repeat(43)}`,
    },
  });
  try {
    const refused = await raw(hub.base, "POST", "/api/pair/code", {
      headers: { ...JSON_BODY, ...hub.adminHeaders },
      body: "{}",
    });
    assert.equal(refused.status, 503);
    assertClean(refused, "audited change refused");
    assert.equal(
      (JSON.parse(refused.text) as { error: { code: string } }).error.code,
      "audit_unavailable",
    );

    const read = await raw(hub.base, "GET", "/api/network", { headers: hub.adminHeaders });
    assert.equal(read.status, 200, "read-only API is unaffected");
    const health = await raw(hub.base, "GET", "/healthz", {});
    assert.equal(health.status, 200);
  } finally {
    await hub.cleanup();
  }
});

/** A tunnel device with a live pairing and one current credential, written while no hub process holds the file. */
function seedPairedDevice(home: string, deviceId: string): void {
  const registry = new NetworkRegistry(join(home, "network.sqlite"));
  try {
    const t = Date.now();
    const epoch = randomUUID();
    registry.db
      .prepare(
        `INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,created_at,updated_at,transport)
         VALUES(?, 'Floor Dev', 'url', NULL, NULL, 'ui', 0, ?, 'checking', ?, ?, 'tunnel')`,
      )
      .run(deviceId, randomUUID(), t, t);
    registry.db
      .prepare(
        `INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at)
         VALUES(?,?,?,?,'paired',1,?,?,?)`,
      )
      .run(deviceId, epoch, "pub", `sha256:${"4".repeat(64)}`, t, t, t);
    registry.db
      .prepare(
        `INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at,confirmed_at)
         VALUES(?,?,?,?,?,'current',?,?)`,
      )
      .run(
        randomUUID(),
        deviceId,
        epoch,
        1,
        createHash("sha256").update(randomUUID(), "utf8").digest("hex"),
        t,
        t,
      );
  } finally {
    registry.close();
  }
}

interface RegistryState {
  pairing: { status: string; paired_at: number; rotation_requested_at: number | null };
  credentials: { status: string }[];
  events: { action: string }[];
}

/** Everything a revoke or a rotation could touch, read through a second connection while the hub runs. */
function registryState(home: string, deviceId: string): RegistryState {
  const db = new DatabaseSync(join(home, "network.sqlite"), { readOnly: true });
  try {
    const pairing = db.prepare("SELECT * FROM pairings WHERE device_id=?").get(deviceId);
    const credentials = db
      .prepare("SELECT * FROM tunnel_credentials WHERE device_id=? ORDER BY credential_id")
      .all(deviceId);
    const events = db.prepare("SELECT action FROM events ORDER BY rowid").all();
    return JSON.parse(JSON.stringify({ pairing, credentials, events })) as RegistryState;
  } finally {
    db.close();
  }
}

async function publicPairing(
  base: string,
  deviceId: string,
  headers?: Record<string, string>,
): Promise<{ status: string; rotationPending: boolean } | undefined> {
  const r = await raw(base, "GET", "/api/network", { headers });
  assert.equal(r.status, 200, "the device list is a read and must not depend on audit storage");
  const devices = (
    JSON.parse(r.text) as {
      devices: { id: string; pairing?: { status: string; rotationPending: boolean } }[];
    }
  ).devices;
  return devices.find((d) => d.id === deviceId)?.pairing;
}

test("GA-02: under the audit floor revoke and rotate of a paired device are JSON 503s that change nothing, and the same requests succeed once the floor is lifted", async () => {
  const env: Record<string, string> = {};
  const hub = await bootHub({ env });
  const id = "floor-dev";
  const post = (path: string) =>
    raw(hub.base, "POST", path, {
      headers: { ...JSON_BODY, ...hub.adminHeaders },
      body: JSON.stringify({ reason: "compromise" }),
    });
  try {
    await hub.stop(); // the first boot created the schema; seed while no process holds the file
    seedPairedDevice(hub.home, id);
    env.DPI_AUDIT_MIN_FREE_BYTES = String(Number.MAX_SAFE_INTEGER);
    await hub.start();

    const before = registryState(hub.home, id);
    assert.equal(before.pairing.status, "paired");
    assert.equal(before.pairing.rotation_requested_at, null);
    assert.deepEqual(
      before.credentials.map((c) => c.status),
      ["current"],
    );
    assert.deepEqual(await publicPairing(hub.base, id, hub.adminHeaders), {
      status: "paired",
      keyFingerprint: `sha256:${"4".repeat(64)}`,
      pairedAt: before.pairing.paired_at,
      credentialGeneration: 1,
      rotationPending: false,
    });

    const refusals = [
      ["rotate", `/api/pairings/${id}/rotate`],
      ["rotate via the device alias", `/api/devices/${id}/rotate`],
      ["revoke", `/api/pairings/${id}/revoke`],
      ["revoke via the device alias", `/api/devices/${id}/revoke`],
    ] as const;
    for (const [label, path] of refusals) {
      const r = await post(path);
      assert.equal(r.status, 503, `${label}: ${r.text}`);
      assertClean(r, label);
      assert.equal(
        (JSON.parse(r.text) as { error: { code: string } }).error.code,
        "audit_unavailable",
        label,
      );
    }
    assert.deepEqual(
      registryState(hub.home, id),
      before,
      "a refused revoke/rotate leaves the pairing, every credential and the audit log as they were",
    );
    assert.equal(
      (await publicPairing(hub.base, id, hub.adminHeaders))?.status,
      "paired",
      "reads still show the device as paired",
    );
    assert.equal(
      (await raw(hub.base, "GET", "/api/pairings", { headers: hub.adminHeaders })).status,
      200,
    );

    // Same device, same requests, floor lifted: the 503 above was the floor and not the fixture.
    await hub.stop();
    delete env.DPI_AUDIT_MIN_FREE_BYTES;
    await hub.start();

    const rotate = await post(`/api/pairings/${id}/rotate`);
    assert.equal(rotate.status, 202, rotate.text);
    const rotated = registryState(hub.home, id);
    assert.notEqual(
      rotated.pairing.rotation_requested_at,
      null,
      "an offline device records that a rotation is due",
    );
    assert.deepEqual(
      rotated.events.slice(before.events.length).map((e) => e.action),
      ["token.rotate_started"],
    );

    const revoke = await post(`/api/pairings/${id}/revoke`);
    assert.equal(revoke.status, 202, revoke.text);
    const revoked = registryState(hub.home, id);
    assert.equal(revoked.pairing.status, "revoked");
    assert.deepEqual(
      revoked.credentials.map((c) => c.status),
      ["revoked"],
      "the credential row stays as a tombstone",
    );
    assert.deepEqual(
      revoked.events.slice(before.events.length).map((e) => e.action),
      ["token.rotate_started", "pair.revoke"],
    );
    assert.equal((await publicPairing(hub.base, id, hub.adminHeaders))?.status, "revoked");
  } finally {
    await hub.cleanup();
  }
});

test("GA-15: the admin API quota of one address survives churn through thousands of other addresses", async () => {
  const hub = await bootHub();
  const agent = new Agent({ keepAlive: true, maxSockets: 16 });
  try {
    const hit = (ip: string) =>
      raw(hub.base, "GET", "/api/network", {
        headers: { "x-forwarded-for": ip, ...hub.adminHeaders },
        agent,
      }).then((r) => r.status);
    const victim = "9.9.9.9";
    let served = 0;
    const burstStartedAt = Date.now();
    while ((await hit(victim)) === 200) assert.ok(++served <= 200, "the burst limit must engage");
    const drainedAt = Date.now();
    // The bucket is 120 tokens refilling at 1 token/s (API_RATE_LIMITS). The burst is
    // sequential, so on a loaded machine it can take long enough for refills to
    // matter; the ceiling scales with the MEASURED burst duration (+2 s slack)
    // instead of assuming < 10 s. It stays far below the 4.200-request churn and the
    // 200-request guard: an unlimited (broken) limiter still fails hard at the guard.
    const burstElapsedS = (drainedAt - burstStartedAt) / 1000;
    assert.ok(
      served >= 100,
      `burst of ${served} before the first 429 — a bucket materially smaller than 120 would be a defect`,
    );
    assert.ok(
      served <= 120 + Math.floor(burstElapsedS) + 2,
      `burst of ${served} in ${burstElapsedS.toFixed(1)} s exceeds 120 tokens + refill (+2 s slack)`,
    );

    // 4.200 distinct client addresses (the old table wiped EVERY bucket once it held more than 4.096).
    const churn = 4_200;
    let next = 0;
    const statuses = new Set<number>();
    await Promise.all(
      Array.from({ length: 16 }, async () => {
        for (;;) {
          const i = next++;
          if (i >= churn) return;
          statuses.add(await hit(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`));
        }
      }),
    );
    assert.deepEqual([...statuses], [200], "every new address is served normally");

    // The victim only earns back what refilled since it was drained (1 token/s). A wiped table would hand it a fresh burst of 120.
    let regained = 0;
    for (let i = 0; i < 60; i++) if ((await hit(victim)) === 200) regained++;
    const refillable = Math.ceil((Date.now() - drainedAt) / 1000) + 1;
    assert.ok(
      regained <= refillable,
      `victim regained ${regained} requests; only ${refillable} could have refilled`,
    );
  } finally {
    agent.destroy();
    await hub.cleanup();
  }
});

// -- Gate A re-review: the shell, the liveness probe, 404s and the UI-state limit ----------------------

const directives = (policy: string | string[] | undefined): Record<string, string[]> =>
  Object.fromEntries(
    String(policy ?? "")
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...values] = d.split(/\s+/);
        return [name, values];
      }),
  );

test("RR: the app shell is served under a CSP without inline script, framing or third-party connections", async () => {
  const hub = await bootHub();
  try {
    for (const path of ["/", "/pair?code=ABCDEFGH&v=1", "/sessions/anything"]) {
      const r = await raw(hub.base, "GET", path, {});
      assert.equal(r.status, 200, path);
      const csp = directives(r.headers["content-security-policy"]);
      assert.deepEqual(
        csp["default-src"],
        ["'none'"],
        `${path}: nothing is allowed unless a directive says so`,
      );
      assert.deepEqual(
        csp["script-src"],
        ["'self'", "https://static.cloudflareinsights.com"],
        `${path}: no inline script, no eval — the sole extra origin is the Cloudflare Web Analytics beacon the zone auto-injects`,
      );
      assert.deepEqual(
        csp["connect-src"],
        ["'self'"],
        `${path}: the app only talks to its own hub`,
      );
      assert.deepEqual(csp["frame-ancestors"], ["'none'"], `${path}: not frameable`);
      assert.deepEqual(csp["base-uri"], ["'none'"]);
      assert.deepEqual(csp["form-action"], ["'self'"]);
      assert.ok(
        !(csp["style-src"] ?? []).includes("'unsafe-inline'"),
        `${path}: styles come from files`,
      );
      assert.ok(
        !(csp["img-src"] ?? []).some((s) => s === "*" || s.startsWith("http")),
        `${path}: no remote images`,
      );
      assert.equal(r.headers["x-frame-options"], "DENY", path);
      assert.equal(r.headers["x-content-type-options"], "nosniff", path);
    }
  } finally {
    await hub.cleanup();
  }
});

test("RR: admin API answers are never cached and are not sniffable", async () => {
  const hub = await bootHub();
  try {
    const r = await raw(hub.base, "GET", "/api/network", { headers: hub.adminHeaders });
    assert.equal(r.status, 200);
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    const missing = await raw(hub.base, "GET", "/api/nope", { headers: hub.adminHeaders });
    assert.equal(missing.status, 404);
    assert.equal(missing.headers["cache-control"], "no-store");
  } finally {
    await hub.cleanup();
  }
});

test("RR: /healthz says that the process is up and nothing else", async () => {
  const hub = await bootHub();
  try {
    const r = await raw(hub.base, "GET", "/healthz", {});
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { ok: true });
  } finally {
    await hub.cleanup();
  }
});

test("RR: an unknown route or a missing asset is a clean JSON 404, whatever the method", async () => {
  const hub = await bootHub();
  try {
    for (const [method, path] of [
      ["POST", "/nope"],
      ["PUT", "/x/y"],
      ["DELETE", "/"],
      ["PATCH", "/pair"],
      ["GET", "/assets/missing.js"],
      ["GET", "/missing.png"],
      ["POST", "/api/nope"],
      ["DELETE", "/api/devices"],
    ] as const) {
      const r = await raw(hub.base, method, path, {
        headers: { ...JSON_BODY, ...hub.adminHeaders },
      });
      assert.equal(r.status, 404, `${method} ${path}`);
      assertClean(r, `${method} ${path}`);
      assert.equal(
        (JSON.parse(r.text) as { error: { code: string } }).error.code,
        "not_found",
        `${method} ${path}`,
      );
    }
  } finally {
    await hub.cleanup();
  }
});

test("RR: a UI-state value over the limit is a clean 413, not a 400 that echoes an internal message", async () => {
  const hub = await bootHub();
  try {
    const r = await raw(hub.base, "PUT", "/api/ui-state/k", {
      body: JSON.stringify({ value: "x".repeat(150_000) }),
      headers: { ...JSON_BODY, ...hub.adminHeaders },
    });
    assert.equal(r.status, 413);
    assertClean(r, "ui-state over limit");
    assert.equal(
      (JSON.parse(r.text) as { error: { code: string } }).error.code,
      "payload_too_large",
    );
    const ok = await raw(hub.base, "PUT", "/api/ui-state/k", {
      body: JSON.stringify({ value: { fine: true } }),
      headers: { ...JSON_BODY, ...hub.adminHeaders },
    });
    assert.equal(ok.status, 200);
  } finally {
    await hub.cleanup();
  }
});

/**
 * Rotate-route statuses: an unknown device and a device without a live pairing are
 * 404s (nothing to rotate), a second rotate while one is in flight is a 409, and only
 * a device that can never rotate over a tunnel is a 400. A paired offline device
 * records the request and answers 202 mode "requested".
 */
test("RR: the rotate route reports 404/400/202/409 to match what actually happened", async () => {
  const hub = await bootHub();
  let devWs: WsClient | undefined;
  const rotate = (id: string) =>
    raw(hub.base, "POST", `/api/devices/${id}/rotate`, {
      headers: { ...JSON_BODY, ...hub.adminHeaders },
      body: "{}",
    });
  try {
    const ghost = await rotate("ghost-dev");
    assert.equal(ghost.status, 404, ghost.text);
    assertClean(ghost, "unknown device");

    // Two devices the hub's seeded dpi-network.yaml does not know, written via a second
    // connection (WAL allows one writer at a time; the hub holds none).
    const registry = new NetworkRegistry(join(hub.home, "network.sqlite"));
    const t0 = Date.now();
    const npDev = { id: "np-dev", uid: randomUUID() };
    const onDev = {
      id: "on-dev",
      uid: randomUUID(),
      epoch: randomUUID(),
      token: "dpt_" + randomUUID().replace(/-/g, "") + randomUUID().slice(0, 11),
    };
    const lanDev = { id: "lan-dev", uid: randomUUID() };
    try {
      for (const [d, transport] of [
        [npDev, "tunnel"],
        [onDev, "tunnel"],
        [lanDev, "lan"],
      ] as const) {
        registry.db
          .prepare(
            `INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,created_at,updated_at,transport)
             VALUES(?, 'RR Dev', 'url', ?, NULL, 'ui', 0, ?, 'checking', ?, ?, ?)`,
          )
          .run(d.id, transport === "lan" ? "http://192.0.2.9" : null, d.uid, t0, t0, transport);
      }
      registry.db
        .prepare(
          `INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at)
           VALUES(?,?,?,?,'paired',1,?,?,?)`,
        )
        .run(onDev.id, onDev.epoch, "pub", `sha256:${"9".repeat(64)}`, t0, t0, t0);
      registry.db
        .prepare(
          `INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at,confirmed_at)
           VALUES(?,?,?,?,?,'current',?,?)`,
        )
        .run(randomUUID(), onDev.id, onDev.epoch, 1, sha(onDev.token), t0, t0);
    } finally {
      registry.close();
    }

    const noPairing = await rotate(npDev.id);
    assert.equal(noPairing.status, 404, `a device without a pairing: ${noPairing.text}`);
    assertClean(noPairing, "no pairing");

    const lan = await rotate(lanDev.id);
    assert.equal(lan.status, 400, `a LAN device: ${lan.text}`);
    assertClean(lan, "LAN device");

    // Paired but offline: the request is recorded (rotation_requested_at), 202 "requested".
    const offline = await rotate(onDev.id);
    assert.equal(offline.status, 202, offline.text);
    assert.equal((JSON.parse(offline.text) as { mode: string }).mode, "requested");
    const registry2 = new NetworkRegistry(join(hub.home, "network.sqlite"));
    let pending: number | null;
    try {
      pending = (
        registry2.db
          .prepare("SELECT rotation_requested_at FROM pairings WHERE device_id=?")
          .get(onDev.id) as { rotation_requested_at: number | null }
      ).rotation_requested_at;
    } finally {
      registry2.close();
    }
    assert.ok(
      typeof pending === "number" && pending > 0,
      "the offline request is recorded against the pairing",
    );

    // Online now: 202 "online" the first time, 409 while that rotation is in flight.
    // The fake device applies and acks rotations only while autoAck is set.
    let autoAck = true;
    const file = {
      pairingEpoch: onDev.epoch,
      credentialId: "",
      generation: 1,
      tunnelToken: onDev.token,
    };
    {
      const r3 = new NetworkRegistry(join(hub.home, "network.sqlite"));
      try {
        file.credentialId = (
          r3.db
            .prepare("SELECT credential_id FROM tunnel_credentials WHERE device_id=?")
            .get(onDev.id) as { credential_id: string }
        ).credential_id;
      } finally {
        r3.close();
      }
    }
    devWs = new WsClient(`ws://127.0.0.1:${hub.port}/api/tunnel`, {
      headers: { authorization: `Bearer ${file.tunnelToken}` },
    });
    await new Promise<void>((d, rej) => {
      devWs!.once("open", d);
      devWs!.once("unexpected-response", (_q, res) => rej(new Error(`upgrade ${res.statusCode}`)));
    });
    devWs.on("message", (d) => {
      const msg = JSON.parse(d.toString());
      // The reconnect redelivery of the OFFLINE-pending rotation (generation 2) is always
      // acked, even after autoAck flips to false below: under load the delivered frame can
      // sit in this fake device's queue past the flip, and an unacked redelivery would
      // legitimately stay in flight forever (the real device acks on apply), making the
      // later "202 online" assertion racy. Force-acking exactly generation 2 keeps the
      // un-acked rotation under test the POSTed one (generation 3).
      if (
        msg.type === "control" &&
        msg.action === "token-rotate" &&
        (autoAck || msg.generation === 2) &&
        msg.generation > file.generation
      ) {
        file.pairingEpoch = msg.pairingEpoch;
        file.credentialId = msg.credentialId;
        file.generation = msg.generation;
        file.tunnelToken = msg.tunnelToken;
        devWs!.send(
          JSON.stringify({
            type: "control",
            action: "token-rotate-ack",
            rotationId: msg.rotationId,
            credentialId: msg.credentialId,
            generation: msg.generation,
            pairingEpoch: msg.pairingEpoch,
          }),
        );
      }
    });
    devWs.send(
      JSON.stringify({
        type: "pair-handshake",
        v: 1,
        deviceUid: onDev.uid,
        deviceId: onDev.id,
        pairingEpoch: file.pairingEpoch,
        credentialId: file.credentialId,
        generation: file.generation,
        apiVersion: 1,
        tunnelProto: 1,
        keyFingerprint: `sha256:${"9".repeat(64)}`,
      }),
    );
    await new Promise<void>((d) => devWs!.once("message", () => d())); // hello
    const pairingRow = () =>
      new Promise<{ gen: number; rid: string | null; started: number | null }>((d) => {
        const r3 = new NetworkRegistry(join(hub.home, "network.sqlite"));
        try {
          const row = r3.db
            .prepare(
              "SELECT credential_generation AS gen, rotation_id AS rid, rotation_started_at AS started FROM pairings WHERE device_id=?",
            )
            .get(onDev.id) as { gen: number; rid: string | null; started: number | null };
          d(row);
        } finally {
          r3.close();
        }
      });
    const pairingGen = async () => (await pairingRow()).gen;
    // Settled, not merely recorded: generation 2 AND the in-flight markers cleared by the
    // ack. Waiting only for gen===2 races the hub's redelivery against this test's POST.
    await until(
      async () => {
        const row = await pairingRow();
        return row.gen === 2 && row.rid === null && row.started === null;
      },
      10_000,
      "reconnect completes and settles the pending rotation (gen 2, acked, no in-flight marker)",
    );

    autoAck = false; // the next rotate is delivered but never acked → stays in flight
    const online = await rotate(onDev.id);
    assert.equal(online.status, 202, online.text);
    assert.equal((JSON.parse(online.text) as { mode: string }).mode, "online");
    await until(
      async () => (await pairingGen()) === 3,
      5_000,
      "the in-flight rotation is recorded",
    );
    const again = await rotate(onDev.id);
    assert.equal(again.status, 409, `in-flight rotation: ${again.text}`);
    assertClean(again, "in-flight rotation");
    assert.equal((JSON.parse(again.text) as { error: { code: string } }).error.code, "conflict");
  } finally {
    devWs?.terminate();
    await hub.cleanup();
  }
});

// -------------------------------------------------------------------- Round 5

test("R5: the /api mount is case-sensitive like the device, and the public surfaces still resolve", async () => {
  const hub = await bootHub();
  try {
    const upper = await raw(hub.base, "GET", "/API/NETWORK", { headers: hub.adminHeaders });
    assert.equal(upper.status, 404, "/API/NETWORK must not alias /api/network (uniformity with the device)");
    assertClean(upper, "case variant");
    assert.equal((JSON.parse(upper.text) as { error: { code: string } }).error.code, "not_found");

    const lower = await raw(hub.base, "GET", "/api/network", { headers: hub.adminHeaders });
    assert.equal(lower.status, 200, "the lowercase mount keeps working");

    // Uniformity must not strand the public routes (every caller spells them
    // lowercase on the wire): the pairing ingress reaches its handler, and the
    // share page route still renders — an unknown token is the 404 PAGE, not
    // the JSON API 404.
    const pair = await raw(hub.base, "POST", "/api/pair/start", { body: "{}", headers: JSON_BODY });
    assert.notEqual(pair.status, 404, "POST /api/pair/start must reach its handler");
    assertClean(pair, "pair/start");
    const gone = await raw(hub.base, "GET", `/share/${"z".repeat(24)}`);
    assert.equal(gone.status, 404);
    assert.match(gone.type, /text\/html/, "the share route still renders");
  } finally {
    await hub.cleanup();
  }
});

test("R5: POST /api/shares is governed by the shares limits, not the chain's 256 KiB parser", async () => {
  const hub = await bootHub();
  try {
    const body = JSON.stringify({
      title: "R5 parser",
      agents: [{ name: "main", markdown: "x".repeat(300 * 1024) }],
    });
    assert.ok(body.length > 256 * 1024, "payload must exceed the chain parser's limit");
    const created = await raw(hub.base, "POST", "/api/shares", {
      body,
      headers: { ...JSON_BODY, ...hub.adminHeaders },
    });
    assert.equal(created.status, 201, created.text.slice(0, 200));
    const share = JSON.parse(created.text) as { token: string; url: string };
    assert.match(share.url, /^\/share\//);

    // Over the per-agent limit: the SHARES answer (400 invalid with the bound
    // in the message), not the chain parser's 413 and not a 500.
    const over = await raw(hub.base, "POST", "/api/shares", {
      body: JSON.stringify({ title: "t", agents: [{ name: "main", markdown: "y".repeat(2 * 1024 * 1024 + 64) }] }),
      headers: { ...JSON_BODY, ...hub.adminHeaders },
    });
    assert.equal(over.status, 400, over.text.slice(0, 200));
    assert.match(over.text, /larger than/);
    assertClean(over, "share over limit");

    // The small admin routes still resolve behind the chain.
    const list = await raw(hub.base, "GET", "/api/shares", { headers: hub.adminHeaders });
    assert.equal(list.status, 200);
    const killed = await raw(hub.base, "DELETE", `/api/shares/${share.token}`, { headers: hub.adminHeaders });
    assert.equal(killed.status, 200);
  } finally {
    await hub.cleanup();
  }
});

test("R5: share pages refuse framing, on the 200 and the 404 shape", async () => {
  const hub = await bootHub();
  try {
    const created = await raw(hub.base, "POST", "/api/shares", {
      body: JSON.stringify({ title: "frame me", agents: [{ name: "main", markdown: "hello" }] }),
      headers: { ...JSON_BODY, ...hub.adminHeaders },
    });
    assert.equal(created.status, 201, created.text.slice(0, 200));
    const { url } = JSON.parse(created.text) as { url: string };
    const page = await raw(hub.base, "GET", url);
    assert.equal(page.status, 200);
    assert.match(page.headers["content-security-policy"] ?? "", /frame-ancestors 'none'/);
    assert.equal(page.headers["x-frame-options"], "DENY");

    const missing = await raw(hub.base, "GET", `/share/${"q".repeat(24)}`);
    assert.equal(missing.status, 404);
    assert.match(missing.headers["content-security-policy"] ?? "", /frame-ancestors 'none'/);
    assert.equal(missing.headers["x-frame-options"], "DENY");
  } finally {
    await hub.cleanup();
  }
});

test("R5: hashed /assets cache immutable; the shell revalidates", async () => {
  const hub = await bootHub();
  try {
    const assets = readdirSync(resolve(import.meta.dirname, "../apps/dpi-playground-fe/dist/assets"));
    const js = assets.find((f) => f.endsWith(".js"));
    assert.ok(js, "the built shell has a hashed asset");
    const asset = await raw(hub.base, "GET", `/assets/${js}`);
    assert.equal(asset.status, 200, `GET /assets/${js}`);
    assert.match(asset.headers["cache-control"] ?? "", /max-age=31536000, immutable/);
    const shell = await raw(hub.base, "GET", "/");
    assert.equal(shell.status, 200);
    assert.match(shell.headers["cache-control"] ?? "", /no-cache/);
  } finally {
    await hub.cleanup();
  }
});
