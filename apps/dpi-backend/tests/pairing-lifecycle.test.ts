/**
 * Device pairing client: what a hub-issued credential must satisfy before it is saved, how the local view follows
 * the connector (revoke, rotation), when the incumbent connector may be replaced, and how the key/temp files
 * survive read errors and crashes.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevicePairing } from "../src/pairing.js";
import { keypairPath, pairingPath, type PairingFile } from "../src/pairing-files.js";
import { bootServer, newToken, until } from "./helpers.js";
import { hubServer, pairedHome } from "./connector-rig.js";
import { PAIR_NOW, PAIR_UID, pairHub } from "./pairing-hub.js";

const CODE = "AB2C7DEF";
const ORIGIN = "https://h.example.com";

const opened: DevicePairing[] = [];
// The fake clock never reaches the operation's expiry, so an operation a test leaves pending would poll forever.
afterEach(() => {
  for (const dp of opened.splice(0)) if (dp.status().pending) dp.cancel();
});

const open = (home: string, hub: ReturnType<typeof pairHub>, hooks: Partial<ConstructorParameters<typeof DevicePairing>[4]> = {}) => {
  const dp = new DevicePairing({ uid: PAIR_UID } as never, home, "dev", undefined, { fetchImpl: hub.fetchImpl, pollMs: 5, now: () => PAIR_NOW, ...hooks });
  opened.push(dp);
  return dp;
};

/** A paired home whose key can really sign (the rig's placeholder key cannot). */
async function pairedWithKey(hubUrl: string) {
  const home = await pairedHome(hubUrl);
  const file = JSON.parse(readFileSync(pairingPath(home), "utf8")) as PairingFile;
  writeFileSync(pairingPath(home), JSON.stringify({ ...file, updatedAt: PAIR_NOW - 1000 }), { mode: 0o600 });
  rmSync(keypairPath(home));
  open(home, pairHub({ origin: ORIGIN }));
  return home;
}

async function scratch() {
  const home = await mkdtemp(join(tmpdir(), "dpi-pl-"));
  return { home, done: () => rm(home, { recursive: true, force: true }) };
}

// -- B3 ------------------------------------------------------------------------

const REJECTED: { name: string; issue?: Record<string, unknown>; challenge?: Record<string, unknown>; error: RegExp }[] = [
  { name: "hubUrl on another host", issue: { hubUrl: "https://evil.example.net/api/tunnel" }, error: /hubUrl/ },
  { name: "hubUrl on another port", issue: { hubUrl: "https://h.example.com:8443/api/tunnel" }, error: /hubUrl/ },
  { name: "hubUrl with plaintext ws on a public host", issue: { hubUrl: "ws://h.example.com/api/tunnel" }, error: /hubUrl/ },
  { name: "hubUrl with plaintext http on a public host", issue: { hubUrl: "http://h.example.com/api/tunnel" }, error: /hubUrl/ },
  { name: "hubUrl carrying credentials", issue: { hubUrl: "https://user:pw@h.example.com/api/tunnel" }, error: /hubUrl/ },
  { name: "hubUrl that is not a URL", issue: { hubUrl: "not a url" }, error: /hubUrl/ },
  { name: "hubUrl that is not a string", issue: { hubUrl: 7 }, error: /hubUrl/ },
  { name: "hubUrl on a path other than the tunnel", issue: { hubUrl: "https://h.example.com/elsewhere" }, error: /hubUrl/ },
  { name: "hubUrl with a query", issue: { hubUrl: "https://h.example.com/api/tunnel?x=1" }, error: /hubUrl/ },
  { name: "hubUrl with another scheme", issue: { hubUrl: "ftp://h.example.com/api/tunnel" }, error: /hubUrl/ },
  { name: "hubOrigin of another origin", issue: { hubOrigin: "https://other.example.com" }, error: /hubOrigin/ },
  { name: "hubId different from the challenge's", issue: { hubId: "ffffffff-5e6f-4a5b-8c9d-0e1f2a3b4c5d" }, error: /hubId/ },
  { name: "issuedAt that is not a number", issue: { issuedAt: null }, error: /issuedAt/ },
  { name: "issuedAt as a numeric string", issue: { issuedAt: String(PAIR_NOW) }, error: /issuedAt/ },
  { name: "issuedAt 61 s ahead", issue: { issuedAt: PAIR_NOW + 61_000 }, error: /clock|issuedAt/ },
  { name: "issuedAt 61 s behind", issue: { issuedAt: PAIR_NOW - 61_000 }, error: /clock|issuedAt/ },
  { name: "another deviceUid", issue: { deviceUid: randomUUID() }, error: /deviceUid/ },
  { name: "another enrollmentId", issue: { enrollmentId: randomUUID() }, error: /enrollmentId/ },
  { name: "empty deviceId", issue: { deviceId: "" }, error: /deviceId/ },
  { name: "non-string pairingEpoch", issue: { pairingEpoch: 5 }, error: /pairingEpoch/ },
  { name: "generation below 1", issue: { generation: 0 }, error: /generation/ },
  { name: "malformed tunnelToken", issue: { tunnelToken: "dpt_short" }, error: /tunnelToken/ },
];

for (const c of REJECTED) {
  test(`B3: an issue with ${c.name} is refused and nothing is persisted`, async () => {
    const s = await scratch();
    const hub = pairHub({ origin: ORIGIN, issue: c.issue, challenge: c.challenge });
    let paired = 0;
    const dp = open(s.home, hub, { onPaired: () => paired++ });
    try {
      await dp.start({ code: CODE, hub: ORIGIN });
      await until(() => !dp.status().pending, 3000, "pairing operation ended");
      const status = dp.status();
      assert.match(status.lastError ?? "", c.error);
      assert.equal(status.state, "unpaired");
      assert.equal(existsSync(pairingPath(s.home)), false, "no pairing file written");
      assert.deepEqual(readdirSync(s.home).filter((f) => f.includes("pairing")), [], "no temp or pairing file left");
      assert.equal(paired, 0);
    } finally {
      await s.done();
    }
  });
}

test("B3: a bad issue never replaces the incumbent pairing", async () => {
  const s = await scratch();
  const home = await pairedWithKey("https://h.example.com/api/tunnel");
  try {
    const before = readFileSync(pairingPath(home), "utf8");
    const dp = open(home, pairHub({ origin: ORIGIN, issue: { hubUrl: "https://evil.example.net/api/tunnel" } }));
    await dp.start({ code: CODE, hub: ORIGIN });
    await until(() => !dp.status().pending, 3000, "ended");
    assert.equal(readFileSync(pairingPath(home), "utf8"), before);
    assert.equal(dp.status().state, "paired");
  } finally {
    await s.done();
    await rm(home, { recursive: true, force: true });
  }
});

test("B3: a challenge whose issuedAt is not a number is refused before anything is signed", async () => {
  const s = await scratch();
  const hub = pairHub({ origin: ORIGIN, challenge: { issuedAt: "soon" } });
  const dp = open(s.home, hub);
  try {
    await assert.rejects(dp.start({ code: CODE, hub: ORIGIN }), /issuedAt|clock/);
    assert.equal(hub.calls.some((c) => c.url.endsWith("/api/pair/verify")), false);
  } finally {
    await s.done();
  }
});

const ACCEPTED: { name: string; origin: string; issue?: Record<string, unknown> }[] = [
  { name: "the hub's own https tunnel URL", origin: ORIGIN },
  { name: "the wss form of the paired origin", origin: ORIGIN, issue: { hubUrl: "wss://h.example.com/api/tunnel" } },
  { name: "issuedAt exactly 60 s from the device clock", origin: ORIGIN, issue: { issuedAt: PAIR_NOW + 60_000 } },
  { name: "plaintext ws on a loopback host", origin: "https://127.0.0.1:8443", issue: { hubUrl: "ws://127.0.0.1:8443/api/tunnel" } },
];

for (const c of ACCEPTED) {
  test(`B3 control: ${c.name} is accepted and persisted`, async () => {
    const s = await scratch();
    const hub = pairHub({ origin: c.origin, issue: c.issue });
    let paired = 0;
    const dp = open(s.home, hub, { onPaired: () => paired++ });
    try {
      await dp.start({ code: CODE, hub: c.origin });
      await until(() => dp.status().state === "paired", 3000, "paired");
      const file = JSON.parse(readFileSync(pairingPath(s.home), "utf8")) as PairingFile;
      assert.equal(file.hubUrl, c.issue?.hubUrl ?? `${c.origin}/api/tunnel`);
      assert.equal(file.deviceUid, PAIR_UID);
      assert.equal(paired, 1);
    } finally {
      await s.done();
    }
  });
}

// -- B2 ------------------------------------------------------------------------

const EPOCH = "3c3c3c3c-1111-2222-3333-444444444444";
const rotated = (home: string, generation: number, epoch = EPOCH): PairingFile => ({
  ...(JSON.parse(readFileSync(pairingPath(home), "utf8")) as PairingFile),
  pairingEpoch: epoch,
  credentialId: randomUUID(),
  generation,
  tunnelToken: `dpt_${"R".repeat(43)}`,
});

test("B2: after the connector reports a revoke the pairing reads revoked and a fresh pair start needs no force", async () => {
  const home = await pairedWithKey("https://hub-a.example.com/api/tunnel");
  try {
    let stopped = 0;
    const hubB = pairHub({ origin: "https://hub-b.example.com", held: true });
    const dp = open(home, hubB, { stopOldConnector: () => stopped++ });
    assert.equal(dp.status().state, "paired");
    dp.markRevoked("hub revoked this pairing", "ffffffff-1111-2222-3333-444444444444");
    assert.equal(dp.status().state, "paired", "a notice for another epoch is ignored");
    dp.markRevoked("hub revoked this pairing", EPOCH);
    assert.equal(dp.status().state, "revoked");
    assert.match(dp.status().lastError ?? "", /revoked/);
    const started = await dp.start({ code: CODE, hub: "https://hub-b.example.com" });
    assert.equal(started.state, "pairing");
    assert.equal(stopped, 0, "a revoked incumbent has no connector to stop");
    assert.equal(hubB.calls.some((c) => c.url.startsWith("https://hub-a.example.com")), false, "nothing is sent to the hub that revoked us");
    dp.cancel();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("B2: a completed re-pair after a revoke reads paired again", async () => {
  const home = await pairedWithKey("https://hub-a.example.com/api/tunnel");
  try {
    const dp = open(home, pairHub({ origin: "https://hub-b.example.com" }));
    dp.markRevoked("hub revoked this pairing", EPOCH);
    await dp.start({ code: CODE, hub: "https://hub-b.example.com" });
    await until(() => dp.status().state === "paired", 3000, "paired again");
    assert.equal(dp.status().hubOrigin, "https://hub-b.example.com");
    assert.equal(dp.status().lastError, undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("B2: a rotation reported by the connector moves the status to the new generation; stale ones are ignored", async () => {
  const home = await pairedHome("https://hub-a.example.com/api/tunnel");
  try {
    const dp = open(home, pairHub({ origin: ORIGIN }));
    assert.equal(dp.status().generation, 1);
    dp.markRotated(rotated(home, 3));
    assert.equal(dp.status().generation, 3);
    dp.markRotated(rotated(home, 2));
    assert.equal(dp.status().generation, 3, "an older generation never wins");
    dp.markRotated(rotated(home, 9, "ffffffff-1111-2222-3333-444444444444"));
    assert.equal(dp.status().generation, 3, "another pairing epoch is not ours");
    assert.ok(!JSON.stringify(dp.status()).includes("RRRRRRRR"), "status never carries the token");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("B2: through the real daemon, a hub revoke and a hub rotation show up in GET /v1/pairing", async () => {
  const hub = await hubServer();
  const home = await pairedHome(hub.url);
  const token = newToken();
  const server = await bootServer({ home, startDirs: join(home, "work"), token });
  const auth = { authorization: `Bearer ${token}` };
  const status = async () => (await (await fetch(`${server.base}/v1/pairing`, { headers: auth })).json()) as { state: string; generation?: number };
  try {
    await until(() => hub.handshakes.length === 1, 10_000, "daemon connected to the hub");
    const next = randomUUID();
    assert.ok(hub.send({ type: "control", action: "token-rotate", pairingEpoch: EPOCH, rotationId: randomUUID(), credentialId: next, generation: 2, tunnelToken: `dpt_${"R".repeat(43)}` }));
    await until(async () => (await status()).generation === 2, 5000, "status shows generation 2");
    assert.equal(JSON.parse(readFileSync(pairingPath(home), "utf8")).generation, 2);

    assert.ok(hub.send({ type: "control", action: "revoked", notice: { type: "pair.revoke", v: 1, deviceId: "dev-1", pairingEpoch: EPOCH, reason: "user", revokedAt: Date.now() } }));
    await until(async () => (await status()).state === "revoked", 5000, "status shows revoked");
    assert.equal(existsSync(pairingPath(home)), false);
  } finally {
    await server.stop();
    await hub.close();
    await rm(home, { recursive: true, force: true });
  }
});

// -- B7 ------------------------------------------------------------------------

test("B7: a forced hub change keeps the incumbent connector and hub until the new pairing is persisted", async () => {
  const home = await pairedWithKey("https://hub-a.example.com/api/tunnel");
  try {
    const hubB = pairHub({ origin: "https://hub-b.example.com", held: true });
    const events: string[] = [];
    const dp = open(home, hubB, {
      stopOldConnector: (origin) => {
        events.push(`stop ${origin} while file is ${JSON.parse(readFileSync(pairingPath(home), "utf8")).hubOrigin}`);
      },
      onPaired: () => events.push("paired"),
    });
    await dp.start({ code: CODE, hub: "https://hub-b.example.com", force: true });
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(events, [], "still pending: the incumbent is untouched");
    assert.equal(hubB.calls.some((c) => c.url === "https://hub-a.example.com/api/tunnel"), false, "no unpair notice yet");
    assert.equal(dp.status().state, "pairing");
    hubB.approve();
    await until(() => dp.status().state === "paired", 3000, "paired to B");
    assert.deepEqual(events, ["stop https://hub-a.example.com while file is https://hub-b.example.com", "paired"]);
    await until(() => hubB.calls.some((c) => c.url === "https://hub-a.example.com/api/tunnel" && c.body.action === "unpair"), 3000, "unpair notice for the old hub");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("B7: a forced hub change that fails leaves the incumbent connector and hub alone", async () => {
  const home = await pairedWithKey("https://hub-a.example.com/api/tunnel");
  try {
    const hubB = pairHub({ origin: "https://hub-b.example.com", issue: { hubUrl: "https://evil.example.net/api/tunnel" } });
    let stopped = 0;
    const dp = open(home, hubB, { stopOldConnector: () => stopped++ });
    await dp.start({ code: CODE, hub: "https://hub-b.example.com", force: true });
    await until(() => !dp.status().pending, 3000, "ended");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(stopped, 0);
    assert.equal(hubB.calls.some((c) => c.url === "https://hub-a.example.com/api/tunnel"), false);
    assert.equal(dp.status().state, "paired");
    assert.equal(dp.status().hubOrigin, "https://hub-a.example.com");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// -- B6 ------------------------------------------------------------------------

const unprivileged = process.getuid?.() !== 0;

test("B6: a keypair file that cannot be read is never replaced", async () => {
  const s = await scratch();
  try {
    const path = keypairPath(s.home);
    mkdirSync(path); // EISDIR on read: any error other than ENOENT
    writeFileSync(join(path, "keep"), "x");
    assert.throws(() => open(s.home, pairHub({ origin: ORIGIN })), /refusing to replace/);
    assert.deepEqual(readdirSync(path), ["keep"]);
  } finally {
    await s.done();
  }
});

test("B6: a keypair file without read permission is never replaced", { skip: !unprivileged && "root ignores file modes" }, async () => {
  const s = await scratch();
  try {
    open(s.home, pairHub({ origin: ORIGIN }));
    const path = keypairPath(s.home);
    const original = readFileSync(path, "utf8");
    chmodSync(path, 0o000);
    assert.throws(() => open(s.home, pairHub({ origin: ORIGIN })), /refusing to replace/);
    chmodSync(path, 0o600);
    assert.equal(readFileSync(path, "utf8"), original);
  } finally {
    await s.done();
  }
});

test("B6: a corrupt or incomplete keypair file fails loudly and is left byte-identical", async () => {
  for (const content of ["{ not json", JSON.stringify({ fingerprint: "sha256:x" }), ""]) {
    const s = await scratch();
    try {
      writeFileSync(keypairPath(s.home), content, { mode: 0o600 });
      assert.throws(() => open(s.home, pairHub({ origin: ORIGIN })), /refusing to replace/);
      assert.equal(readFileSync(keypairPath(s.home), "utf8"), content);
    } finally {
      await s.done();
    }
  }
});

test("B6: only a missing keypair file mints a key", async () => {
  const s = await scratch();
  try {
    const dp = open(s.home, pairHub({ origin: ORIGIN }));
    assert.match(dp.status().fingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.ok(existsSync(keypairPath(s.home)));
  } finally {
    await s.done();
  }
});

test("B6: temp files a crashed writer left behind are removed at start-up, and nothing else is", async () => {
  const s = await scratch();
  try {
    const stale = [".pairing.json.tmp-aabbccddeeff", ".device-keypair.json.tmp-0123456789ab"];
    const keep = [".pairing.json.tmp-zz", "notes.tmp-aabbccddeeff", ".other.json.tmp-aabbccddeeff", ".pairing.json.tmp-aabbccddeeff0", "pairing.json.tmp-aabbccddeeff"];
    for (const name of [...stale, ...keep]) writeFileSync(join(s.home, name), "x", { mode: 0o600 });
    const outside = mkdtempSync(join(tmpdir(), "dpi-pl-out-"));
    writeFileSync(join(outside, "target"), "precious");
    symlinkSync(join(outside, "target"), join(s.home, ".pairing.json.tmp-112233445566"));
    mkdirSync(join(s.home, ".pairing.json.tmp-ffffffffffff"));
    try {
      open(s.home, pairHub({ origin: ORIGIN }));
      const left = readdirSync(s.home).sort();
      for (const name of stale) assert.ok(!left.includes(name), `${name} removed`);
      for (const name of keep) assert.ok(left.includes(name), `${name} kept`);
      assert.ok(!left.includes(".pairing.json.tmp-112233445566"), "a symlink with the temp name is removed as a link");
      assert.equal(readFileSync(join(outside, "target"), "utf8"), "precious", "never followed");
      assert.ok(left.includes(".pairing.json.tmp-ffffffffffff"), "a directory with the temp name is not ours to delete");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    await s.done();
  }
});
