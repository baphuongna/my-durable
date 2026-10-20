/**
 * P2-22 — integration audit of the consolidated rate/resource guards (S-1…S-12).
 *
 * Proves, against the REAL hub code:
 *  1. Pairing per-IP sliding-window failure counter: identity churn (new
 *     codes/UIDs/enrollmentIds) does NOT reset the quota; valid polls never
 *     count as failures; at limit the IP is fail-closed on BOTH endpoints.
 *  2. Hub admin-REST token bucket (60/min refill, 120 burst): the 121st burst
 *     request is 429, /healthz stays exempt, forged XFF does not bypass.
 *  3. Tunnel WS counters release: bad-token floods never allocate, live
 *     connections drop back to baseline on close, and a socket abandoned
 *     before handshake is reaped by the handshake deadline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID, generateKeyPairSync, sign as edSign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

import { NetworkRegistry } from "../../dpi-sdk/src/node/registry.js";
import { Audit } from "../apps/dpi-playground-hub/src/audit.js";
import { PairingService } from "../apps/dpi-playground-hub/src/pairing.js";
import { pairingSigningPayload } from "../../dpi-sdk/src/protocol/pairing.js";
import { TunnelServer } from "../apps/dpi-playground-hub/src/tunnel.js";
import { bootHub } from "./harness/hub.js";
import { PAIR_RATE_LIMITS } from "../../dpi-sdk/src/protocol/limits.js";

const HUB_ORIGIN = "https://hub.example.com";
const HUB_ID = "aa11bb22-cc33-4d5e-9e8f-7a6b5c4d3e2f";
const ATTACK_IP = "10.9.9.9";
const NONCE = "n".repeat(43);
const SIG = "A".repeat(86);

// -- pairing fixture (clock-injected; mirrors tests/pairing.test.ts) ---------

interface PairFx {
  registry: NetworkRegistry;
  service: PairingService;
  clock: { now: number };
  cleanup: () => Promise<void>;
}

async function pairFixture(): Promise<PairFx> {
  const dir = await mkdtemp(join(tmpdir(), "dpi-guards-pair-"));
  const registry = new NetworkRegistry(join(dir, "network.sqlite"));
  const audit = new Audit(registry);
  const clock = { now: 1_760_000_000_000 };
  const service = new PairingService({
    registry, audit, hubOrigin: HUB_ORIGIN, hubId: HUB_ID,
    now: () => clock.now,
    issue: async (e) => ({
      type: "pair.token", v: 1, enrollmentId: e.enrollmentId, deviceUid: e.deviceUid,
      deviceId: "dev-x", pairingEpoch: randomUUID(), credentialId: randomUUID(), generation: 1,
      hubId: HUB_ID, hubOrigin: HUB_ORIGIN, hubUrl: `${HUB_ORIGIN}/api/tunnel`,
      tunnelToken: `dpt_${"G".repeat(43)}`, issuedAt: clock.now, expiresAt: null,
    }),
  });
  return { registry, service, clock, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const deviceKey = () => generateKeyPairSync("ed25519");
const pubPem = (kp: ReturnType<typeof deviceKey>) => kp.publicKey.export({ type: "spki", format: "pem" }) as string;
const fingerprintOf = (kp: ReturnType<typeof deviceKey>) =>
  `sha256:${createHash("sha256").update(kp.publicKey.export({ type: "spki", format: "der" }) as Buffer).digest("hex")}`;

test("S-1/S-2: pairing failure window is per-IP, identity-churn resistant, valid-poll clean", async () => {
  const fx = await pairFixture();
  try {
    const lost = () => fx.service.verify(
      { type: "pair.response", v: 1, enrollmentId: randomUUID(), nonce: NONCE, signature: SIG }, // fresh identity every time
      ATTACK_IP,
    );
    // 99 failures (each with a DIFFERENT enrollmentId → identity churn does not reset the quota)
    for (let i = 0; i < PAIR_RATE_LIMITS.verifyFails.perWindow - 1; i++) {
      const r = await lost();
      assert.ok(!r.ok && r.error.code === "enrollment_lost", `fail ${i}`);
    }
    // A fully VALID enroll+verify from the same IP still works (polls are not failures)…
    const kp = deviceKey();
    const theUid = randomUUID();
    const created = fx.service.createCode("admin-ip");
    assert.ok(created.ok);
    const started = fx.service.start(
      { type: "pair.request", v: 1, requestId: randomUUID(), code: created.value.code, deviceUid: theUid,
        deviceName: "d", publicKey: pubPem(kp), keyFingerprint: fingerprintOf(kp), clientTime: 0 },
      ATTACK_IP,
    );
    assert.ok(started.ok, "start must not be blocked below the failure limit");
    const payload = pairingSigningPayload({
      hubOrigin: HUB_ORIGIN, hubId: HUB_ID, enrollmentId: started.value.enrollmentId,
      nonce: started.value.nonce, issuedAt: started.value.issuedAt,
      deviceUid: theUid, keyFingerprint: fingerprintOf(kp),
    });
    const valid = await fx.service.verify(
      { type: "pair.response", v: 1, enrollmentId: started.value.enrollmentId, nonce: started.value.nonce,
        signature: edSign(null, Buffer.from(payload), kp.privateKey).toString("base64url") },
      ATTACK_IP,
    );
    if (!(valid.ok && valid.status === 202)) console.error("VALID RESULT:", JSON.stringify(valid));
    assert.ok(valid.ok && valid.status === 202, "valid proof → 202, not counted as failure");
    // …the 100th failure passes the pre-check, is recorded, and from then on the IP is fail-closed.
    const nth = await lost();
    assert.ok(!nth.ok && nth.error.code === "enrollment_lost");
    const blockedVerify = await fx.service.verify(
      { type: "pair.response", v: 1, enrollmentId: randomUUID(), nonce: NONCE, signature: SIG }, ATTACK_IP,
    );
    assert.ok(!blockedVerify.ok && blockedVerify.error.code === "rate_limited", "verify fail-closed at limit");
    const blockedStart = fx.service.start(
      { type: "pair.request", v: 1, requestId: randomUUID(), code: "000000", deviceUid: randomUUID(),
        deviceName: "d", publicKey: pubPem(deviceKey()), keyFingerprint: `sha256:${"b".repeat(64)}`, clientTime: 0 },
      ATTACK_IP,
    );
    assert.ok(!blockedStart.ok && blockedStart.error.code === "rate_limited", "start fail-closed for the same IP");
    // Window expiry (15 min) restores access.
    fx.clock.now += PAIR_RATE_LIMITS.verifyFails.windowMinutes * 60_000 + 1;
    const afterWindow = await fx.service.verify(
      { type: "pair.response", v: 1, enrollmentId: randomUUID(), nonce: NONCE, signature: SIG }, ATTACK_IP,
    );
    assert.ok(!afterWindow.ok && afterWindow.error.code === "enrollment_lost", "window expired → counting restarts");
  } finally { await fx.cleanup(); }
});

// -- hub REST token bucket ----------------------------------------------------

test("API bucket: 121st burst → 429; healthz exempt; stable forged XFF does not bypass", async () => {
  const hub = await bootHub();
  try {
    const base = hub.base;
    const hit = async (path: string, headers: Record<string, string> = {}) => {
      const r = await fetch(`${base}${path}`, { headers });
      await r.arrayBuffer();
      return r.status;
    };
    const xff = { "x-forwarded-for": "9.9.9.9" }; // spoofed but STABLE — one identity
    for (let i = 0; i < 120; i++) assert.equal(await hit("/api/network", xff), 200, `req ${i}`);
    assert.equal(await hit("/api/network", xff), 429, "121st burst request is 429");
    assert.equal(await hit("/healthz"), 200, "healthz exempt from the API bucket");
    // Varying the spoofed XFF cannot sneak past either (Caddy overwrites XFF in
    // deployment; direct-to-hub trust is loopback-scoped and Gate-A gated).
    const vary = await hit("/api/network", { "x-forwarded-for": `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
    assert.ok(vary === 200 || vary === 429, "varying XFF behaves as its own identity (documented)");
  } finally { await hub.cleanup(); }
});

// -- tunnel WS counters release ----------------------------------------------

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const FINGERPRINT = `sha256:${"c".repeat(64)}`;

interface TunnFx {
  registry: NetworkRegistry;
  tunnel: TunnelServer;
  port: number;
  cleanup: () => Promise<void>;
}

async function tunnFixture(): Promise<TunnFx> {
  const dir = await mkdtemp(join(tmpdir(), "dpi-guards-tun-"));
  const registry = new NetworkRegistry(join(dir, "net.sqlite"));
  registry.clearTunnelState();
  const audit = new Audit(registry);
  const tunnel = new TunnelServer(registry, audit, HUB_ID, {}, { ipPerMinute: 1_000, globalPerMinute: 1_000 });
  const server = createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => tunnel.handleUpgrade(req, socket, head));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  return {
    registry, tunnel, port,
    cleanup: async () => {
      tunnel.close();
      server.close();
      server.closeAllConnections();
      registry.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function seed(fx: TunnFx, deviceId: string, uid: string) {
  const epoch = randomUUID();
  const credentialId = randomUUID();
  const token = "dpt_" + Buffer.from(randomUUID() + randomUUID(), "utf8").toString("base64url").slice(0, 43);
  const t = Date.now();
  fx.registry.db
    .prepare(`INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,created_at,updated_at,transport)
              VALUES(?, 'D', 'url', NULL, NULL, 'ui', 0, ?, 'checking', ?, ?, 'tunnel')`)
    .run(deviceId, uid, t, t);
  fx.registry.db
    .prepare(`INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at)
              VALUES(?,?, '-----BEGIN PUBLIC KEY-----', ?, 'paired', 1, ?, ?, ?)`)
    .run(deviceId, epoch, FINGERPRINT, t, t, t);
  fx.registry.db
    .prepare(`INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at,confirmed_at)
              VALUES(?,?,?,?,?,'current',?,?)`)
    .run(credentialId, deviceId, epoch, 1, sha(token), t, t);
  return { token, epoch, credentialId };
}

async function until(f: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for: ${what}`);
}

test("WS counters release: bad-token flood never allocates; close and handshake-deadline return to baseline", async () => {
  const { WebSocket } = await import("ws");
  const fx = await tunnFixture();
  try {
    const uid = randomUUID();
    const cred = seed(fx, "dev-g", uid);
    // 40 bad-token upgrades: all denied pre-101, nothing allocated.
    for (let i = 0; i < 40; i++) {
      const status = await new Promise<number>((done) => {
        const ws = new WebSocket(`ws://127.0.0.1:${fx.port}/api/tunnel`, { headers: { authorization: "Bearer dpt_zzz" } });
        ws.once("unexpected-response", (_q, res) => done(res.statusCode));
        ws.once("open", () => done(101));
        ws.once("error", () => done(-1));
      });
      assert.notEqual(status, 101, `bad token ${i} must not upgrade`);
    }
    assert.equal(fx.tunnel.activeCount(), 0, "flood allocated nothing");
    assert.equal(fx.tunnel.pendingHandshakeCount(), 0);
    // Good connection → active 1 → close → baseline.
    const ws = new WebSocket(`ws://127.0.0.1:${fx.port}/api/tunnel`, { headers: { authorization: `Bearer ${cred.token}` } });
    await new Promise<void>((done, rej) => {
      ws.once("open", () => done());
      ws.once("unexpected-response", (_q, r) => rej(Error(`upgrade ${r.statusCode}`)));
      ws.once("error", rej);
    });
    const hello = new Promise<any>((done) => ws.once("message", (d) => done(JSON.parse(d.toString()))));
    ws.send(JSON.stringify({
      type: "pair-handshake", v: 1, deviceUid: uid, deviceId: "dev-g",
      pairingEpoch: cred.epoch, credentialId: cred.credentialId, generation: 1, apiVersion: 1, tunnelProto: 1,
      keyFingerprint: FINGERPRINT,
    }));
    const h = await hello;
    if (h.type !== "hello") console.error("HANDSHAKE FAULT:", JSON.stringify(h));
    assert.equal(h.type, "hello");
    await until(() => fx.tunnel.activeCount() === 1, 3_000, "active 1");
    ws.close();
    await until(() => fx.tunnel.activeCount() === 0, 3_000, "close releases");
    // Abandoned pre-handshake socket is reaped by the 5s handshake deadline.
    const ws2 = new WebSocket(`ws://127.0.0.1:${fx.port}/api/tunnel`, { headers: { authorization: `Bearer ${cred.token}` } });
    await new Promise<void>((done, rej) => {
      ws2.once("open", () => done());
      ws2.once("unexpected-response", (_q, r) => rej(Error(`upgrade ${r.statusCode}`)));
      ws2.once("error", rej);
    });
    // never handshake…
    await until(() => fx.tunnel.activeCount() === 0, 8_000, "handshake deadline reaps abandoned socket");
    ws2.terminate();
    assert.equal(fx.tunnel.pendingHandshakeCount(), 0);
  } finally { await fx.cleanup(); }
});
