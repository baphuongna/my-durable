/**
 * P2-11 device pairing: origin resolution (P-13), keypair lifecycle, proof
 * polling, atomic pairing.json commit, cancel semantics, force re-hub (P-5),
 * clock skew (P-4), malformed files, local API routes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DevicePairing } from "../src/pairing.js";
import { keypairPath, pairingPath, writeAtomic } from "../src/pairing-files.js";
import { bootServer, newToken, until } from "./helpers.js";

const UID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const HUB_ID = "1a2b3c4d-5e6f-4a5b-8c9d-0e1f2a3b4c5d";

interface HubScript {
  challengeAt?: number; // issuedAt override
  verifyStatus?: number[]; // sequence of statuses for /verify
  verifyBodies?: unknown[];
  startStatus?: number;
}

/** Fake hub: records every fetch; plays a scripted start/verify sequence. */
function fakeHub(script: HubScript = {}) {
  const calls: { url: string; body: unknown }[] = [];
  let verifyIndex = 0;
  const kp = generateKeyPairSync("ed25519"); // not used for signing (hub doesn't sign in these tests)
  void kp;
  const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, body });
    if (url.endsWith("/api/pair/start")) {
      const status = script.startStatus ?? 200;
      const issuedAt = script.challengeAt ?? 1760000000000;
      return new Response(
        JSON.stringify(
          status === 200
            ? { type: "pair.challenge", v: 1, enrollmentId: randomUUID(), nonce: "N".repeat(43), issuedAt, hubId: HUB_ID }
            : { error: { code: "rate_limited", message: "no" } },
        ),
        { status, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/api/pair/verify")) {
      const statuses = script.verifyStatus ?? [];
      const status = statuses[Math.min(verifyIndex, statuses.length - 1)] ?? 202;
      const bodies = script.verifyBodies ?? [];
      const bodyOut = bodies[Math.min(verifyIndex, bodies.length - 1)] ?? { type: "pair.pending", v: 1, enrollmentId: "e", state: "awaiting_approval", expiresAt: 1760000300000, pollAfterMs: 1 };
      verifyIndex += 1;
      return new Response(JSON.stringify(bodyOut), { status, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/api/tunnel")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { code: "not_found", message: "?" } }), { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function tempHome() {
  return mkdtemp(join(tmpdir(), "dpi-dp-"));
}

const newPairing = (home: string, hub: ReturnType<typeof fakeHub>, opts: { envHub?: string; now?: () => number; pollMs?: number; stopOldConnector?: (o: string) => void } = {}) =>
  new DevicePairing({ uid: UID } as never, home, "dev", opts.envHub, {
    fetchImpl: hub.fetchImpl,
    pollMs: opts.pollMs ?? 10,
    now: opts.now ?? (() => 1760000000000),
    stopOldConnector: opts.stopOldConnector,
  });

test("P-13: code without any origin fails hub_required BEFORE network", async () => {
  const home = await tempHome();
  const hub = fakeHub();
  const dp = newPairing(home, hub);
  try {
    await assert.rejects(dp.start({ code: "AB2C7DEF" }), /not enough|hub_required/);
    assert.equal(hub.calls.length, 0); // no network was touched
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("P-13: precedence pair URL → hub → env → saved; explicit conflict fails; http rejected", async () => {
  const home = await tempHome();
  const hub = fakeHub();
  const dp = newPairing(home, hub);
  try {
    // pairUrl alone (no other explicit source)
    await dp.start({ code: "", pairUrl: "https://url.example.com/pair?code=AB2C7DEF&v=1" });
    dp.cancel();
    // pairUrl + --hub same origin → fine
    await dp.start({ code: "", pairUrl: "https://url.example.com/pair?code=AB2C7DEF&v=1", hub: "https://url.example.com" });
    dp.cancel();
    // pairUrl + --hub different origin → explicit conflict, no network
    const calls = hub.calls.length;
    await assert.rejects(dp.start({ code: "", pairUrl: "https://url.example.com/pair?code=AB2C7DEF&v=1", hub: "https://other.example.com" }), /conflict/);
    assert.equal(hub.calls.length, calls);
    // http origin rejected before network
    await assert.rejects(dp.start({ code: "AB2C7DEF", hub: "http://insecure.example.com" }), /HTTPS/);
    // env fallback used when no explicit pair url/hub
    const envDp = newPairing(home, hub, { envHub: "https://env.example.com" });
    await envDp.start({ code: "AB2C7DEF" });
    assert.ok(hub.calls.some((c) => c.url.startsWith("https://env.example.com")));
    envDp.cancel();
    // pairUrl vs env with different origins → explicit conflict
    await assert.rejects(envDp.start({ code: "", pairUrl: "https://url.example.com/pair?code=AB2C7DEF&v=1" }), /conflict/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("keypair: minted once, 0600, stable fingerprint across restarts", async () => {
  const home = await tempHome();
  const hub = fakeHub();
  const dp1 = newPairing(home, hub);
  const fp1 = dp1.status().fingerprint;
  assert.match(fp1, /^sha256:[0-9a-f]{64}$/);
  assert.equal(statSync(keypairPath(home)).mode & 0o777, 0o600);
  const dp2 = newPairing(home, hub);
  assert.equal(dp2.status().fingerprint, fp1); // reused, not reminted
  await rm(home, { recursive: true, force: true });
});

test("P-4: challenge skew ±61s rejected, ±60s accepted (client clock never drives TTL)", async () => {
  const home = await tempHome();
  try {
    const now = 1760000000000;
    const skewHub = fakeHub({ challengeAt: now + 61_000 });
    const skewDp = new DevicePairing({ uid: UID } as never, home, "dev", undefined, { fetchImpl: skewHub.fetchImpl, pollMs: 10, now: () => now });
    await assert.rejects(skewDp.start({ code: "AB2C7DEF", hub: "https://h.example.com" }), /clock/i);
    const okHub = fakeHub({ challengeAt: now + 60_000 });
    const okDp = new DevicePairing({ uid: UID } as never, home, "dev", undefined, { fetchImpl: okHub.fetchImpl, pollMs: 10, now: () => now });
    await okDp.start({ code: "AB2C7DEF", hub: "https://h.example.com" });
    assert.equal(okDp.status().state, "pairing");
    okDp.cancel();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("happy path: proof → poll → TokenIssue → pairing.json 0600 with every field; same proof body each poll", async () => {
  const home = await tempHome();
  const hub = fakeHub({ verifyStatus: [202, 202, 200], verifyBodies: [
    { type: "pair.pending", v: 1, enrollmentId: "e1", state: "awaiting_approval", expiresAt: 1, pollAfterMs: 1 },
    { type: "pair.pending", v: 1, enrollmentId: "e1", state: "awaiting_approval", expiresAt: 1, pollAfterMs: 1 },
    { type: "pair.token", v: 1, enrollmentId: "e1", deviceUid: UID, deviceId: "dev-9", pairingEpoch: "ep-1", credentialId: "c-1", generation: 1, hubId: HUB_ID, hubOrigin: "https://h.example.com", hubUrl: "https://h.example.com/api/tunnel", tunnelToken: `dpt_${"T".repeat(43)}`, issuedAt: 1, expiresAt: null },
  ] });
  const dp = newPairing(home, hub);
  try {
    await dp.start({ code: "AB2C7DEF", hub: "https://h.example.com" });
    await until(() => dp.status().state === "paired", 5000, "paired");
    const file = JSON.parse(readFileSync(pairingPath(home), "utf8")) as Record<string, unknown>;
    assert.equal(file.deviceUid, UID);
    assert.equal(file.deviceId, "dev-9");
    assert.equal(file.pairingEpoch, "ep-1");
    assert.equal(file.generation, 1);
    assert.equal(file.hubOrigin, "https://h.example.com");
    assert.equal(statSync(pairingPath(home)).mode & 0o777, 0o600);
    const status = dp.status();
    assert.equal(status.state, "paired");
    assert.equal(status.deviceId, "dev-9");
    assert.ok(!JSON.stringify(status).includes(`dpt_${"T".repeat(10)}`)); // status DTO has no token
    // every verify poll sent the SAME signed proof body
    const verifies = hub.calls.filter((c) => c.url.endsWith("/api/pair/verify"));
    assert.ok(verifies.length >= 3);
    const bodies = new Set(verifies.map((c) => JSON.stringify(c.body)));
    assert.equal(bodies.size, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("cancel: local abort only; keypair kept; honest message", async () => {
  const home = await tempHome();
  const hub = fakeHub({ verifyStatus: [202] });
  const dp = newPairing(home, hub);
  try {
    await dp.start({ code: "AB2C7DEF", hub: "https://h.example.com" });
    dp.cancel();
    assert.equal(dp.status().state, "unpaired");
    assert.ok(existsSync(keypairPath(home))); // keypair survives
    const status = dp.status();
    assert.ok(!status.pending);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("P-5: incumbent hub wins without force; force stops old connector + best-effort unpair", async () => {
  const home = await tempHome();
  const hubA = fakeHub({ verifyStatus: [200], verifyBodies: [
    { type: "pair.token", v: 1, enrollmentId: "e1", deviceUid: UID, deviceId: "dev-a", pairingEpoch: "ep-a", credentialId: "c-a", generation: 1, hubId: HUB_ID, hubOrigin: "https://hub-a.example.com", hubUrl: "https://hub-a.example.com/api/tunnel", tunnelToken: `dpt_${"A".repeat(43)}`, issuedAt: 1, expiresAt: null },
  ] });
  const dp = newPairing(home, hubA);
  try {
    await dp.start({ code: "AB2C7DEF", hub: "https://hub-a.example.com" });
    await until(() => dp.status().state === "paired", 5000, "paired to A");
    // switch without force → incumbent wins
    const hubB = fakeHub();
    await assert.rejects(dp.start({ code: "ZZ7Y6X2W", hub: "https://hub-b.example.com" }), /force/);
    // with force: old connector stopped first, unpair attempted, then proceeds
    let stopped: string | undefined;
    const dp2 = new DevicePairing({ uid: UID } as never, home, "dev", undefined, {
      fetchImpl: hubB.fetchImpl, pollMs: 10, now: () => 1760000000000,
      stopOldConnector: (origin) => (stopped = origin),
    });
    await dp2.start({ code: "ZZ7Y6X2W", hub: "https://hub-b.example.com", force: true });
    assert.equal(stopped, "https://hub-a.example.com");
    assert.ok(hubB.calls.some((c) => c.url.startsWith("https://hub-b.example.com")));
    dp2.cancel();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("malformed pairing.json ignored at boot; keypair still loads", async () => {
  const home = await tempHome();
  const hub = fakeHub();
  const dp1 = newPairing(home, hub);
  void dp1;
  try {
    writeFileSync(pairingPath(home), "{ not json", { mode: 0o600 });
    const dp2 = newPairing(home, hub);
    assert.equal(dp2.status().state, "unpaired"); // malformed → ignored, no crash
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("writeAtomic: final file 0600, no temp leftovers, content exact", async () => {
  const home = await tempHome();
  try {
    const target = join(home, "pairing.json");
    writeAtomic(target, JSON.stringify({ a: 1 }));
    assert.equal(JSON.parse(readFileSync(target, "utf8")).a, 1);
    assert.equal(statSync(target).mode & 0o777, 0o600);
    const leftovers = readdirSync(home).filter((f) => f.includes(".tmp-"));
    assert.equal(leftovers.length, 0);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("local API: GET/POST /v1/pairing over the real backend (auth, no secrets)", async () => {
  const home = await mkdtemp(join(tmpdir(), "dpi-be-"));
  const token = newToken();
  const server = await bootServer({ home, startDirs: join(home, "work"), token });
  try {
    // unauthorized without token
    const anon = await fetch(`${server.base}/v1/pairing`);
    assert.equal(anon.status, 401);
    const auth = { authorization: `Bearer ${token}` };
    const status = await (await fetch(`${server.base}/v1/pairing`, { headers: auth })).json();
    assert.equal(status.state, "unpaired");
    assert.match(status.fingerprint, /^sha256:[0-9a-f]{64}$/);
    // code-only start → hub_required before any network
    const start = await fetch(`${server.base}/v1/pairing/start`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ code: "AB2C7DEF" }) });
    assert.equal(start.status, 400);
    const body = (await start.json()) as { error: { message: string } };
    assert.match(body.error.message, /not enough|hub/i);
    // cancel without pending → 400
    const cancel = await fetch(`${server.base}/v1/pairing/cancel`, { method: "POST", headers: auth });
    assert.equal(cancel.status, 400);
  } finally {
    await server.stop();
    await rm(home, { recursive: true, force: true });
  }
});

