/**
 * Gate A remediation (2026-10-21) — hub tunnel endpoint.
 *   GA-02 pre-auth denial storms are coalesced and an audit/DB fault fails closed instead of killing the hub.
 *   GA-03 an IP that is already refused cannot drain the hub-wide upgrade bucket.
 *   GA-04 reassembly is capped per connection (32 MiB), so one device cannot exhaust the hub budget.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { ByteBudget, sendChunked } from "../../dpi-sdk/src/node/chunk.js";
import { CONNECTION_BUFFER_BUDGET_BYTES, HUB_BUFFER_BUDGET_BYTES } from "../../dpi-sdk/src/protocol/limits.js";
import { TunnelTransport } from "../apps/dpi-playground-hub/src/tunnel-transport.js";
import { DEFAULT_TUNNEL_POLICY } from "../apps/dpi-playground-hub/src/tunnel.js";
import { mintToken, tunnelFixture } from "./harness/tunnel-fixture.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Bounded polled wait: small interval, loud timeout — never a guessed fixed sleep. */
const until = async (cond: () => boolean, timeoutMs: number, what: string, intervalMs = 20) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(intervalMs);
  }
  assert.fail(`timed out waiting for ${what}`);
};

// -- GA-02 ---------------------------------------------------------------

test("GA-02: a flood of rejected upgrades is audited as O(1) rows, not one synchronous row per request", async () => {
  const f = await tunnelFixture({ policy: { ipPerMinute: 20, globalPerMinute: 10_000 } });
  try {
    const statuses = new Set<number>();
    for (let i = 0; i < 150; i++) statuses.add(f.attempt("203.0.113.50").status);
    assert.ok(statuses.has(401) && statuses.has(429), `both denial paths were exercised (${[...statuses]})`);
    const rows = f.eventCount("auth.denied", "rate_limited");
    // One row per (action, ip, 1-minute window); allow one window rollover mid-test.
    assert.ok(rows <= 4, `150 refused upgrades wrote ${rows} audit rows`);
    assert.ok(f.eventCount("auth.denied") >= 1, "the bad-credential denials are still evidenced");
    assert.ok(f.eventCount("rate_limited") >= 1, "the rate limiting is still evidenced");
  } finally {
    await f.cleanup();
  }
});

test("GA-02: revoked-credential replays and unknown tokens from one IP stay distinguishable in the coalesced audit", async () => {
  const f = await tunnelFixture();
  try {
    const dev = f.addDevice("ga02-revoked");
    f.registry.db.prepare("UPDATE tunnel_credentials SET status='revoked', revoked_at=? WHERE device_id=?").run(Date.now(), dev.id);
    for (let i = 0; i < 5; i++) f.attempt("203.0.113.51");
    for (let i = 0; i < 5; i++) f.attempt("203.0.113.51", dev.token);
    const detail = (f.registry.db.prepare("SELECT detail_json FROM events WHERE action='auth.denied'").all() as { detail_json: string }[])
      .map((r) => r.detail_json)
      .join("\n");
    assert.match(detail, /token_unknown/);
    assert.match(detail, /revoked/);
  } finally {
    await f.cleanup();
  }
});

test("GA-02: an audit write failure on a refusal never escapes handleUpgrade; the client still gets the refusal", async () => {
  const hooks = { failAppend: true };
  const f = await tunnelFixture({ audit: hooks, policy: { ipPerMinute: 2, globalPerMinute: 1_000 } });
  try {
    const results: number[] = [];
    for (let i = 0; i < 4; i++) {
      assert.doesNotThrow(() => results.push(f.attempt("203.0.113.52").status));
    }
    assert.deepEqual(results, [401, 401, 429, 429]);
    assert.equal(f.eventCount("auth.denied", "rate_limited"), 0, "nothing was persisted while the audit was failing");
  } finally {
    await f.cleanup();
  }
});

test("GA-02: an unexpected exception inside the upgrade path fails closed with 503 instead of escaping", async () => {
  const f = await tunnelFixture();
  try {
    const dev = f.addDevice("ga02-db-fault");
    const db = f.registry.db as unknown as { prepare: (sql: string) => unknown };
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      if (/FROM tunnel_credentials/.test(sql)) throw new Error("disk I/O error");
      return realPrepare(sql);
    };
    let outcome: { status: number } | undefined;
    assert.doesNotThrow(() => {
      outcome = f.attempt("203.0.113.53", dev.token);
    });
    assert.equal(outcome?.status, 503);
    assert.equal(outcome?.socket.destroyed, true, "the socket is closed");
  } finally {
    await f.cleanup();
  }
});

test("GA-02: an audit fault while a device disconnects does not crash the hub and the registration is still removed", async () => {
  const hooks = { failAppend: false };
  const f = await tunnelFixture({ audit: hooks });
  try {
    const dev = f.addDevice("ga02-disconnect");
    const ws = await f.connect(dev);
    assert.ok(f.tunnel.hasConnection(dev.id));
    hooks.failAppend = true;
    ws.terminate();
    await until(() => !f.tunnel.hasConnection(dev.id) && f.tunnel.activeCount() === 0, 2_000, "deregistration after the disconnect");
    assert.equal(f.tunnel.hasConnection(dev.id), false, "the connection was deregistered");
    assert.equal(f.tunnel.activeCount(), 0);
    hooks.failAppend = false;
    const again = await f.connect(dev);
    assert.ok(f.tunnel.hasConnection(dev.id), "the hub is still serving after the fault");
    again.terminate();
  } finally {
    await f.cleanup();
  }
});

test("GA-02: if the connect cannot be audited the connection is refused (fail closed), not registered, and the hub survives", async () => {
  const hooks = { failAppend: true };
  const f = await tunnelFixture({ audit: hooks });
  try {
    const dev = f.addDevice("ga02-connect");
    const ws = await f.open(dev);
    const closed = once(ws, "close");
    ws.send(JSON.stringify({
      type: "pair-handshake", v: 1, deviceUid: dev.uid, deviceId: dev.id, pairingEpoch: dev.epoch,
      credentialId: dev.credentialId, generation: 1, apiVersion: 1, tunnelProto: 1,
      keyFingerprint: `sha256:${"9".repeat(64)}`,
    }));
    const [code] = await closed;
    assert.equal(code, 1011);
    assert.equal(f.tunnel.hasConnection(dev.id), false);
    assert.equal(f.tunnel.activeCount(), 0);
    assert.equal(f.registry.db.prepare("SELECT COUNT(*) c FROM tunnel_state").get().c, 0, "no tunnel_state row is left behind");
    hooks.failAppend = false;
    const ok = await f.connect(dev);
    assert.ok(f.tunnel.hasConnection(dev.id));
    ok.terminate();
  } finally {
    await f.cleanup();
  }
});

// -- GA-03 ---------------------------------------------------------------

test("GA-03: a refused IP does not spend the hub-wide upgrade bucket, so other devices still connect", async () => {
  const f = await tunnelFixture({ policy: { ipPerMinute: 5, globalPerMinute: 10 } });
  try {
    const dev = f.addDevice("ga03-victim");
    const statuses = new Map<number, number>();
    for (let i = 0; i < 60; i++) {
      const s = f.attempt("203.0.113.60").status;
      statuses.set(s, (statuses.get(s) ?? 0) + 1);
    }
    assert.equal(statuses.get(401), 5, "the flooding IP got exactly its own bucket");
    assert.equal(statuses.get(429), 55);
    const ws = await f.connect(dev, "203.0.113.61");
    assert.ok(f.tunnel.hasConnection(dev.id), "a different IP is not locked out by the flood");
    ws.terminate();
  } finally {
    await f.cleanup();
  }
});

test("GA-03: the hub-wide bucket still bounds the sum of upgrades that carry a real credential", async () => {
  const f = await tunnelFixture({ policy: { ipPerMinute: 5, globalPerMinute: 4 } });
  try {
    const devices = Array.from({ length: 6 }, (_, i) => f.addDevice(`ga03-sum-${i}`));
    const open: import("ws").WebSocket[] = [];
    for (let i = 0; i < 4; i++) open.push(await f.open(devices[i], `203.0.113.${71 + i}`));
    const fifth = await f.rejected(devices[4].token, "203.0.113.75");
    const sixth = await f.rejected(devices[5].token, "203.0.113.76");
    assert.deepEqual([fifth.status, sixth.status], [429, 429]);
    assert.equal(fifth.body.code, "rate_limited");
    assert.match(fifth.body.message, /too many upgrade attempts/);
    for (const ws of open) ws.terminate();
  } finally {
    await f.cleanup();
  }
});

test("RR: refused credentials from any number of addresses never spend the hub-wide bucket, so a real device still connects", async () => {
  const f = await tunnelFixture({ policy: { ipPerMinute: 30, globalPerMinute: 5 } });
  try {
    const dev = f.addDevice("rr-global-victim");
    for (let host = 1; host <= 40; host++)
      for (let attempt = 0; attempt < 3; attempt++)
        assert.equal(f.attempt(`198.51.100.${host}`).status, 401, `host ${host} attempt ${attempt}`);
    const revoked = f.addDevice("rr-global-revoked");
    f.registry.db.prepare("UPDATE tunnel_credentials SET status='revoked', revoked_at=? WHERE device_id=?").run(Date.now(), revoked.id);
    for (let host = 41; host <= 80; host++) assert.equal(f.attempt(`198.51.100.${host}`, revoked.token).status, 401, `revoked ${host}`);

    const ws = await f.connect(dev, "203.0.113.200");
    assert.ok(f.tunnel.hasConnection(dev.id), "120 refused attempts did not consume the hub-wide budget");
    ws.terminate();
  } finally {
    await f.cleanup();
  }
});

test("RR: the hub-at-capacity refusal is not sent to a caller that has not shown a valid credential", async () => {
  const f = await tunnelFixture({ policy: { maxPendingHandshakes: 1, ipPerMinute: 30, globalPerMinute: 1_000 } });
  try {
    const holder = f.addDevice("rr-capacity-holder");
    const held = await f.open(holder, "203.0.113.201"); // takes the only pending slot
    const stranger = f.attempt("203.0.113.202");
    assert.equal(stranger.status, 401, "a stranger is told its credential is unknown, not that the hub is full");
    assert.equal(stranger.body.code, "token_unknown");
    const other = f.addDevice("rr-capacity-other");
    const refused = await f.rejected(other.token, "203.0.113.203");
    assert.equal(refused.status, 429);
    assert.match(refused.body.message, /capacity/);
    assert.equal(f.eventCount("rate_limited"), 1, "the capacity refusal is evidenced");
    held.terminate();
  } finally {
    await f.cleanup();
  }
});

// -- per-address identity (IPv6 /64, IPv4-mapped) -----------------------------

test("RR: addresses inside one IPv6 /64 share one upgrade bucket; the next /64 has its own", async () => {
  const f = await tunnelFixture({ policy: { ipPerMinute: 3, globalPerMinute: 1_000 } });
  try {
    const sameBlock = [1, 2, 3, 4, 5].map((n) => f.attempt(`2001:db8:1:2::${n.toString(16)}`).status);
    assert.deepEqual(sameBlock, [401, 401, 401, 429, 429]);
    assert.equal(f.attempt("2001:db8:1:2:ffff:ffff:ffff:ffff").status, 429, "any other address of the block is limited too");
    assert.equal(f.attempt("2001:db8:1:3::1").status, 401, "a different /64 is a different source");
  } finally {
    await f.cleanup();
  }
});

test("RR: an IPv4 client of a dual-stack listener is one source whichever way its address is written", async () => {
  const f = await tunnelFixture({ policy: { ipPerMinute: 3, globalPerMinute: 1_000 } });
  try {
    const spellings = ["203.0.113.150", "::ffff:203.0.113.150", "::ffff:cb00:7196", "203.0.113.150", "::FFFF:203.0.113.150"];
    assert.deepEqual(spellings.map((ip) => f.attempt(ip).status), [401, 401, 401, 429, 429]);
  } finally {
    await f.cleanup();
  }
});

test("RR: the per-address connection cap counts a whole IPv6 /64, not each address in it", async () => {
  const f = await tunnelFixture({ policy: { maxConnectionsPerIp: 2, ipPerMinute: 100, globalPerMinute: 1_000 } });
  try {
    const [a, b, c, d] = ["a", "b", "c", "d"].map((n) => f.addDevice(`rr-v6-${n}`));
    const sockets = [await f.open(a, "2001:db8:5:5::1"), await f.open(b, "2001:db8:5:5::2")];
    const refused = await f.rejected(c.token, "2001:db8:5:5::3");
    assert.equal(refused.status, 429);
    assert.match(refused.body.message, /connections/);
    sockets.push(await f.open(d, "2001:db8:5:6::1"));
    for (const ws of sockets) ws.terminate();
  } finally {
    await f.cleanup();
  }
});

test("RR: rotating addresses inside a /64 cannot buy a fresh audit row, or a fresh quota, per request", async () => {
  const f = await tunnelFixture({ policy: { ipPerMinute: 5, globalPerMinute: 1_000_000 } });
  try {
    const statuses = new Map<number, number>();
    for (let i = 1; i <= 200; i++) {
      const s = f.attempt(`2001:db8:7:7::${i.toString(16)}`).status;
      statuses.set(s, (statuses.get(s) ?? 0) + 1);
    }
    assert.equal(statuses.get(401), 5, "the whole block got exactly one bucket");
    assert.equal(statuses.get(429), 195);
    assert.ok(f.eventCount("auth.denied", "rate_limited") <= 4, `200 refused upgrades wrote ${f.eventCount("auth.denied", "rate_limited")} audit rows`);
  } finally {
    await f.cleanup();
  }
});

// -- GA-04 ---------------------------------------------------------------

const FIRST_CHUNK_TOTAL = 255 * 65_536 + 1; // 256 chunks → ≈16 MiB advertised by a 64 KiB first chunk
const firstChunk = (reqId: string) => ({
  type: "tunnel-chunk", v: 1, kind: "rest-response", reqId,
  messageId: randomUUID(), index: 0, count: 256, totalBytes: FIRST_CHUNK_TOTAL,
  data: Buffer.alloc(65_536, 0x61).toString("base64"),
});

test("GA-04: one connection can hold at most 32 MiB of reassembly; the hub budget stays available to other devices", async () => {
  const hub = new ByteBudget("hub", HUB_BUFFER_BUDGET_BYTES);
  const f = await tunnelFixture({ dispatcher: { budget: hub, deadlineMs: 20_000 } });
  try {
    const attacker = f.addDevice("ga04-attacker");
    const victim = f.addDevice("ga04-victim");
    const aws = await f.connect(attacker, "203.0.113.80");
    const vws = await f.connect(victim, "203.0.113.81");

    const reqIds: string[] = [];
    const pathOf = new Map<string, string>(); // reqId → request path, exactly as the hub issued it
    aws.on("message", (buf: Buffer) => {
      const m = JSON.parse(buf.toString());
      if (m.type === "rest-request") {
        reqIds.push(m.reqId);
        pathOf.set(m.reqId, m.path);
      }
    });
    const attackerTransport = new TunnelTransport({ id: attacker.id, transport: "tunnel" }, f.dispatcher);
    interface Outcome { i: number; status: number; body: { error?: { code?: string } } }
    const settled = [0, 1, 2, 3].map((i) =>
      attackerTransport
        .request({ method: "GET", path: `/v1/tree?n=${i}` }, AbortSignal.timeout(15_000))
        .then((r) => ({ i, status: r.status, body: r.body as { error?: { code?: string } } }), (e: { status?: number }) => ({ i, status: e.status ?? 0, body: {} as { error?: { code?: string } } })),
    );
    const iOf = (reqId: string) => Number(pathOf.get(reqId)?.split("n=")[1]);
    for (let i = 0; i < 100 && reqIds.length < 4; i++) await sleep(20);
    assert.equal(reqIds.length, 4, "the hub issued the four REST requests");
    for (const id of reqIds) aws.send(JSON.stringify(firstChunk(id)));
    // Ordering barrier: the server has processed every chunk once it answers a ping.
    const pong = once(aws, "pong");
    aws.ping();
    await pong;

    // Which assemblies were admitted is decided by chunk ARRIVAL order (the first
    // chunks are sent in reqIds order), not by which request was issued first — so
    // outcomes are correlated by reqId, never by `settled` array index.
    const admittedIds = reqIds.slice(0, 2);
    const refusedIds = reqIds.slice(2);

    // Lower bound, sampled before the refusals are awaited: two ~16 MiB assemblies
    // MUST be resident. A tighter (broken) per-connection cap (0, 16 MiB) fails here
    // instead of hiding behind "the rest were refused" — if all four assemblies were
    // refused, used would sit near zero and this assertion catches it.
    assert.ok(hub.used >= 2 * FIRST_CHUNK_TOTAL, `two admitted assemblies hold ${hub.used} B of the hub budget; expected at least ${2 * FIRST_CHUNK_TOTAL} B (2 × first-chunk total)`);
    assert.ok(hub.used <= CONNECTION_BUFFER_BUDGET_BYTES, `one connection holds ${hub.used} B of the hub budget (cap ${CONNECTION_BUFFER_BUDGET_BYTES})`);
    const refused = (await Promise.race([Promise.all(refusedIds.map((id) => settled[iOf(id)])), sleep(2_000).then(() => "pending" as const)]));
    assert.notEqual(refused, "pending", "assemblies beyond the connection cap are refused immediately");
    assert.deepEqual((refused as Outcome[]).map((r) => r.status), [502, 502]);
    assert.equal((refused as Outcome[])[0].body.error?.code, "response_too_large");

    // A different device can still complete a chunked response while the attacker holds its 32 MiB.
    const victimTransport = new TunnelTransport({ id: victim.id, transport: "tunnel" }, f.dispatcher);
    vws.once("message", (buf: Buffer) => {
      const req = JSON.parse(buf.toString());
      const out = sendChunked(
        { type: "rest-response", reqId: req.reqId, status: 200, body: "v".repeat(131_072) },
        { kind: "rest-response", reqId: req.reqId },
        (chunk) => vws.send(JSON.stringify(chunk)),
      );
      assert.ok(out.ok);
    });
    const answer = await victimTransport.request({ method: "GET", path: "/v1/tree" }, AbortSignal.timeout(10_000));
    assert.equal(answer.status, 200, "the victim's 128 KiB response is admitted");

    aws.terminate();
    await until(() => hub.used === 0, 2_000, "the attacker's reservation to return to the hub");
    assert.equal(hub.used, 0, "closing the connection returns its whole reservation to the hub");
    vws.terminate();
    // Only now can the two admitted assemblies settle (their connection is gone).
    // They must NOT end as 502 response_too_large: that would mean the cap refused
    // an assembly this test claims was admitted (e.g. a 16 MiB cap would show up
    // here, and in the hub.used lower bound above).
    const finalOutcomes = (await Promise.all(settled)) as Outcome[];
    for (const id of admittedIds) {
      const r = finalOutcomes[iOf(id)];
      assert.notEqual(r.status, 502, `the assembly for ${pathOf.get(id)} was admitted under the cap and must not be refused as response_too_large (got ${r.status})`);
    }
  } finally {
    await f.cleanup();
  }
});

test("GA-04: a partial assembly is accounted against the budget and released when the connection closes", async () => {
  const hub = new ByteBudget("hub", HUB_BUFFER_BUDGET_BYTES);
  const f = await tunnelFixture({ dispatcher: { budget: hub } });
  try {
    const dev = f.addDevice("ga04-close");
    const ws = await f.connect(dev);
    const seen: string[] = [];
    ws.on("message", (buf: Buffer) => {
      const m = JSON.parse(buf.toString());
      if (m.type === "rest-request") seen.push(m.reqId);
    });
    const transport = new TunnelTransport({ id: dev.id, transport: "tunnel" }, f.dispatcher);
    const pending = transport.request({ method: "GET", path: "/v1/tree" }, AbortSignal.timeout(10_000)).catch((e: { status?: number }) => e.status);
    for (let i = 0; i < 100 && seen.length < 1; i++) await sleep(20);
    ws.send(JSON.stringify(firstChunk(seen[0])));
    const pong = once(ws, "pong");
    ws.ping();
    await pong;
    assert.ok(hub.used > 16_000_000, "the partial assembly is accounted");
    ws.terminate();
    assert.equal(await pending, 503);
    await until(() => hub.used === 0, 2_000, "the partial assembly's reservation to be released on close");
    assert.equal(hub.used, 0, "closing the connection releases the partial assembly");
  } finally {
    await f.cleanup();
  }
});

// -- GA-09 ---------------------------------------------------------------

test("GA-09: the default tunnel policy is the S-10 allocation (30/min with a burst of 10, 5 per address, 100 pending, 1.000 live)", () => {
  assert.deepEqual(
    {
      ipPerMinute: DEFAULT_TUNNEL_POLICY.ipPerMinute,
      ipCapacity: DEFAULT_TUNNEL_POLICY.ipCapacity,
      maxConnectionsPerIp: DEFAULT_TUNNEL_POLICY.maxConnectionsPerIp,
      maxPendingHandshakes: DEFAULT_TUNNEL_POLICY.maxPendingHandshakes,
      maxAuthenticated: DEFAULT_TUNNEL_POLICY.maxAuthenticated,
    },
    { ipPerMinute: 30, ipCapacity: 10, maxConnectionsPerIp: 5, maxPendingHandshakes: 100, maxAuthenticated: 1_000 },
  );
});

test("GA-09: one address gets a burst of 10 upgrade attempts, then 429 until tokens refill at 30/min", async () => {
  const clock = { t: 1_760_000_000_000 };
  const f = await tunnelFixture({ policy: { globalPerMinute: 1_000_000 }, hooks: { now: () => clock.t } });
  try {
    const statuses = Array.from({ length: 12 }, () => f.attempt("203.0.113.90").status);
    assert.deepEqual(statuses, [...Array(10).fill(401), 429, 429]);
    const limited = f.attempt("203.0.113.90");
    assert.ok(limited.body.retryAfterMs > 0 && limited.body.retryAfterMs <= 2_000, `retry hint ${limited.body.retryAfterMs} ms (one token per 2 s)`);
    clock.t += 2_000;
    assert.equal(f.attempt("203.0.113.90").status, 401, "one token refilled after 2 s");
    assert.equal(f.attempt("203.0.113.90").status, 429);
    assert.equal(f.attempt("203.0.113.91").status, 401, "other addresses have their own burst");
  } finally {
    await f.cleanup();
  }
});

test("GA-09: at most 5 pending or live connections per address are admitted, refused before the upgrade, and slots are released", async () => {
  const f = await tunnelFixture();
  try {
    const devices = Array.from({ length: 7 }, (_, i) => f.addDevice(`ga09-ip-${i}`));
    const ip = "203.0.113.92";
    const sockets = [
      await f.connect(devices[0], ip),
      await f.connect(devices[1], ip),
      await f.connect(devices[2], ip),
      await f.open(devices[3], ip), // pending: 101 but no application handshake yet
      await f.open(devices[4], ip),
    ];
    const sixth = await f.rejected(devices[5].token, ip);
    assert.equal(sixth.status, 429);
    assert.equal(sixth.body.code, "rate_limited");
    assert.match(sixth.body.message, /connections/);

    const elsewhere = await f.connect(devices[5], "203.0.113.93");
    assert.ok(f.tunnel.hasConnection(devices[5].id), "another address is unaffected");

    const closed = once(sockets[4], "close");
    sockets[4].close();
    await closed;
    // teardown() releases the per-address slot and deregisters the device in the
    // same synchronous block, so "no connection for devices[4]" IS the
    // slot-released signal — poll it instead of guessing a fixed delay.
    await until(() => !f.tunnel.hasConnection(devices[4].id), 2_000, "the per-address slot of the closed connection to be released");
    const again = await f.connect(devices[6], ip);
    assert.ok(f.tunnel.hasConnection(devices[6].id), "a released slot is reusable");
    for (const s of [...sockets, elsewhere, again]) s.terminate();
  } finally {
    await f.cleanup();
  }
});

test("GA-09: a request carrying any Origin is refused with 403 before auth and without spending the rate buckets", async (t) => {
  // Mid-window frozen clock: the 43 Origin denials must share ONE 60 s aggregation window,
  // so the row count below is exact — not "<= 3" on the luck of a minute boundary.
  t.mock.timers.enable({ apis: ["Date"], now: 1_760_000_030_000 });
  const f = await tunnelFixture({ policy: { globalPerMinute: 1_000_000 } });
  try {
    const dev = f.addDevice("ga09-origin");
    for (const origin of ["https://evil.example", "null", "https://hub.example.com"]) {
      const r = f.attempt("203.0.113.94", dev.token, { origin });
      assert.equal(r.status, 403, origin);
      assert.equal(r.body.error.code, "origin_forbidden");
    }
    for (let i = 0; i < 40; i++) assert.equal(f.attempt("203.0.113.94", dev.token, { origin: "https://evil.example" }).status, 403);
    assert.equal(f.attempt("203.0.113.94", mintToken()).status, 401, "origin refusals did not drain the address's burst");
    // Deterministic under the frozen clock: one coalesced row for the 43 origin_forbidden
    // denials + one for the final token_unknown denial (its own kind) — no window luck.
    assert.equal(f.eventCount("auth.denied"), 2, "43 Origin refusals coalesce to one audit row plus one token_unknown row");

    const ok = await f.connect(dev, "203.0.113.94");
    assert.ok(f.tunnel.hasConnection(dev.id), "a connector (no Origin header) still connects");
    ok.terminate();
  } finally {
    await f.cleanup();
  }
});

test("GA-09: the per-address table holds 10.000 addresses; when full it refuses NEW addresses and keeps limiting the old ones", async () => {
  const clock = { t: 1_760_000_000_000 };
  const f = await tunnelFixture({ policy: { globalPerMinute: 10_000_000 }, hooks: { now: () => clock.t } });
  try {
    const ipOf = (i: number) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
    for (let i = 0; i < 10; i++) f.attempt(ipOf(0)); // address 0 drains its burst
    assert.equal(f.attempt(ipOf(0)).status, 429);
    for (let i = 1; i < 10_000; i++) assert.equal(f.attempt(ipOf(i)).status, 401, `address ${i}`);
    const overflow = f.attempt(ipOf(10_000));
    assert.equal(overflow.status, 429, "the table is full of live counters");
    assert.equal(f.attempt(ipOf(0)).status, 429, "the drained address was not evicted to make room");

    clock.t += 15 * 60_000 + 1;
    assert.equal(f.attempt(ipOf(10_000)).status, 401, "after the 15 minute idle TTL there is room again");
  } finally {
    await f.cleanup();
  }
});

// -- GA-11 (T-7) ---------------------------------------------------------

const dataFrame = (subscriptionId: string, sub = "/v1/tree") => ({ type: "tunnel-data", frame: { type: "activity" }, subscriptionId, sub });
const dataChunk = (subscriptionId: string, sub = "/v1/tree") => ({
  type: "tunnel-chunk", v: 1, kind: "tunnel-data", subscriptionId, sub,
  messageId: randomUUID(), index: 0, count: 4, totalBytes: 4 * 65_536,
  data: Buffer.alloc(65_536, 0x61).toString("base64"),
});

/** Start a hub-side watch on `dev` and resolve once the device has been told to subscribe. */
async function watching(f: Awaited<ReturnType<typeof tunnelFixture>>, dev: { id: string }, ws: import("ws").WebSocket) {
  const seen = new Promise<string>((resolve) => {
    const on = (buf: Buffer) => {
      const m = JSON.parse(buf.toString());
      if (m.type === "control" && m.action === "subscribe") {
        ws.off("message", on);
        resolve(m.subscriptionId);
      }
    };
    ws.on("message", on);
  });
  const ac = new AbortController();
  const frames: unknown[] = [];
  const transport = new TunnelTransport({ id: dev.id, transport: "tunnel" }, f.dispatcher);
  const reader = (async () => {
    try {
      for await (const frame of transport.watch({ path: "/v1/tree", consumerId: "ga11" }, ac.signal)) frames.push(frame);
    } catch {
      /* the reader ends when the connection or the consumer does */
    }
  })();
  return { subscriptionId: await seen, frames, stop: async () => { ac.abort(); await reader; } };
}

const within = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([promise, sleep(ms).then((): never => { throw new Error(`timed out waiting for ${what}`); })]);

const barrier = async (ws: import("ws").WebSocket) => {
  const pong = once(ws, "pong");
  ws.ping();
  await pong;
};

const deniedRows = (f: Awaited<ReturnType<typeof tunnelFixture>>) =>
  (f.registry.db.prepare("SELECT actor, detail_json FROM events WHERE action='auth.denied'").all() as { actor: string; detail_json: string }[]);

test("GA-11: tunnel-data for a subscription the hub never issued is denied, audited, and closes only that connection", async () => {
  const f = await tunnelFixture();
  try {
    const a = f.addDevice("ga11-a");
    const b = f.addDevice("ga11-b");
    const aws = await f.connect(a, "203.0.113.100");
    const bws = await f.connect(b, "203.0.113.101");
    const closed = once(bws, "close");
    bws.send(JSON.stringify(dataFrame(randomUUID())));
    const [code] = await within(closed, 3_000, "the hub to cut the sender");
    assert.equal(code, 1008);
    assert.equal(f.tunnel.hasConnection(b.id), false);
    assert.equal(f.tunnel.hasConnection(a.id), true, "the other device is untouched");
    const rows = deniedRows(f).filter((r) => r.actor === `device:${b.id}`);
    assert.equal(rows.length, 1);
    assert.match(rows[0].detail_json, /foreign_subscription/);
    aws.terminate();
  } finally {
    await f.cleanup();
  }
});

test("GA-11: tunnel-data aimed at ANOTHER device's live subscription is denied and never reaches its owner", async () => {
  const f = await tunnelFixture();
  try {
    const a = f.addDevice("ga11-owner");
    const b = f.addDevice("ga11-intruder");
    const aws = await f.connect(a, "203.0.113.102");
    const bws = await f.connect(b, "203.0.113.103");
    const watch = await watching(f, a, aws);

    const closed = once(bws, "close");
    bws.send(JSON.stringify(dataFrame(watch.subscriptionId)));
    const [code] = await within(closed, 3_000, "the hub to cut the intruder");
    assert.equal(code, 1008);
    assert.deepEqual(watch.frames, [], "the owner's reader saw nothing from the intruder");
    assert.match(deniedRows(f).map((r) => r.detail_json).join("\n"), /foreign_subscription/);

    aws.send(JSON.stringify(dataFrame(watch.subscriptionId)));
    await barrier(aws);
    for (let i = 0; i < 50 && watch.frames.length === 0; i++) await sleep(10);
    assert.equal(watch.frames.length, 1, "the owner's own frame is still delivered");
    await watch.stop();
    aws.terminate();
  } finally {
    await f.cleanup();
  }
});

test("GA-11: chunked tunnel-data for an unknown or foreign subscription is denied before anything is allocated", async () => {
  const hub = new ByteBudget("hub", HUB_BUFFER_BUDGET_BYTES);
  const f = await tunnelFixture({ dispatcher: { budget: hub } });
  try {
    const a = f.addDevice("ga11-chunk-owner");
    const aws = await f.connect(a, "203.0.113.104");
    const watch = await watching(f, a, aws);
    // Sample hub.used AT the moment of each denial, not after the close: denyDevice()
    // audits BEFORE it closes the connection, and closing releases the connection's
    // whole reservation — a post-close `used === 0` would also pass if the hub
    // allocated first and denied afterwards (vacuous). At the audit hook the
    // sender's socket is still open, so a reservation taken by an allocate-then-deny
    // defect would still be live and visible here.
    const usedAtDenial: number[] = [];
    const realAppend = f.audit.append.bind(f.audit);
    (f.audit as { append: (event: { action?: string; detail?: { code?: string } }) => void }).append = (event) => {
      if (event.detail?.code === "foreign_subscription") usedAtDenial.push(hub.used);
      realAppend(event as never);
    };
    for (const [label, id] of [["unknown", randomUUID()], ["foreign", watch.subscriptionId]] as const) {
      const intruder = f.addDevice(`ga11-chunk-${label}`);
      const ws = await f.connect(intruder, `203.0.113.${label === "unknown" ? 105 : 106}`);
      const closed = once(ws, "close");
      ws.send(JSON.stringify(dataChunk(id)));
      const [code] = await within(closed, 3_000, `the hub to cut the ${label} sender`);
      assert.equal(code, 1008, label);
      assert.equal(hub.used, 0, `${label}: no reassembly budget was held after the denial`);
    }
    assert.equal(deniedRows(f).filter((r) => /foreign_subscription/.test(r.detail_json)).length, 2);
    assert.equal(usedAtDenial.length, 2, "both denials were observed at the pre-close audit hook");
    assert.deepEqual(usedAtDenial, [0, 0], "at the instant of each denial (sender socket still open) no reassembly budget had been taken");
    await watch.stop();
    aws.terminate();
  } finally {
    await f.cleanup();
  }
});

test("GA-11: late frames for the connection's OWN just-closed subscription are dropped without penalty", async () => {
  const f = await tunnelFixture();
  try {
    const a = f.addDevice("ga11-late");
    const ws = await f.connect(a, "203.0.113.107");
    const watch = await watching(f, a, ws);
    const unsubscribed = new Promise<void>((resolve) =>
      ws.on("message", (buf: Buffer) => {
        const m = JSON.parse(buf.toString());
        if (m.type === "control" && m.action === "unsubscribe") resolve();
      }),
    );
    await watch.stop();
    await within(unsubscribed, 3_000, "the unsubscribe control");
    ws.send(JSON.stringify(dataFrame(watch.subscriptionId)));
    ws.send(JSON.stringify(dataChunk(watch.subscriptionId)));
    await barrier(ws);
    assert.equal(f.tunnel.hasConnection(a.id), true, "a benign in-flight frame must not cut the device");
    assert.equal(deniedRows(f).length, 0);
    ws.terminate();
  } finally {
    await f.cleanup();
  }
});
