/**
 * The device-side browser enrollment surface (gap #4): GET /pair serves the
 * static page, and the narrow /v1/pair-enroll API drives an UNPAIRED device's
 * ceremony. Guard proofs: no header -> 403 (a foreign page's POST dies in the
 * CORS preflight before ever reaching this code); already paired -> 409; the
 * status view never leaks secrets.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { bootServer, newToken, tempStore } from "./helpers.js";
import { pairingPath } from "../src/pairing-files.js";
import { encodePairOffer } from "../../dpi-sdk/src/protocol/pairing.js";
import { PAIR_HUB_ID, PAIR_NOW } from "./pairing-hub.js";

const H = { "content-type": "application/json", "x-dpi-pair": "1" };
const ORIGIN = "https://h.example.com";
/** Unroutable LOCAL origin — a booted CHILD backend may try it without touching the network. */
const DEAD = "https://127.0.0.1:9";
const offerUrl = (hub: string = ORIGIN) =>
  `${hub}/pair#offer=${encodePairOffer({
    v: 2,
    hub,
    id: PAIR_HUB_ID,
    code: "d1d2e3f4-a5b6-4789-abcd-eff012345678",
    exp: PAIR_NOW + 300_000,
  })}`;

test("GET /pair: the static enrollment page, no token needed", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({
    home: join(t.root, "home"),
    startDirs: t.work,
    token,
    name: "page-box",
  });
  try {
    const res = await fetch(`${server.base}/pair`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /Pair this device/);
    assert.match(html, /x-dpi-pair/, "the page drives the guarded enroll API");
    assert.ok(!html.includes(token) && !/dpt_/.test(html), "no secrets in the page");
  } finally {
    await server.stop();
    await t.cleanup();
  }
});

test("pair-enroll guard matrix: headerless is 403; status carries no secrets; junk body is 400", async () => {
  const t = await tempStore();
  const server = await bootServer({
    home: join(t.root, "home"),
    startDirs: t.work,
    token: newToken(),
    name: "guard-box",
  });
  try {
    assert.equal(
      (await fetch(`${server.base}/v1/pair-enroll`)).status,
      403,
      "GET without the header is refused",
    );
    const post = await fetch(`${server.base}/v1/pair-enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairUrl: offerUrl() }),
    });
    assert.equal(
      post.status,
      403,
      "POST without the header is refused (drive-by pairing dies here)",
    );
    const status = await (await fetch(`${server.base}/v1/pair-enroll`, { headers: H })).json();
    assert.equal(status.state, "unpaired");
    assert.match(status.fingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.ok(!("tunnelToken" in status) && !("code" in status), "no secrets in the status view");
    const bad = await fetch(`${server.base}/v1/pair-enroll`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ pairUrl: "https://elsewhere.example/pair?code=not-an-offer" }),
    });
    assert.equal(bad.status, 400, "only offer links reach the ceremony");
  } finally {
    await server.stop();
    await t.cleanup();
  }
});

test("pair-enroll happy refusal: an unroutable hub surfaces a clean error, never a hang", async () => {
  const t = await tempStore();
  const server = await bootServer({
    home: join(t.root, "home"),
    startDirs: t.work,
    token: newToken(),
    name: "enroll-box",
  });
  try {
    // The DEAD origin is unroutable on purpose: the child's real pairing client
    // must surface a clean refusal, never a hang and never a real network call.
    const res = await fetch(`${server.base}/v1/pair-enroll`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ pairUrl: offerUrl(DEAD) }),
    });
    if (res.status >= 400) {
      const body = (await res.json()) as { error: { code: string } };
      assert.ok(
        ["offline", "invalid"].includes(body.error.code),
        `unexpected refusal: ${body.error.code}`,
      );
    } else {
      const started = (await res.json()) as { state: string };
      assert.equal(started.state, "pairing");
    }
  } finally {
    await server.stop();
    await t.cleanup();
  }
});

test("pair-enroll refuses an ALREADY-PAIRED device: re-pairing stays in the TUI", async () => {
  const home = await mkdtemp(join(tmpdir(), "dpi-enroll-"));
  try {
    // A paired device: pairing.json exists (dead local origin so the child's
    // connector never leaves the machine).
    const { writeAtomic } = await import("../src/pairing-files.js");
    writeAtomic(
      pairingPath(home),
      JSON.stringify({
        version: 1,
        deviceUid: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
        deviceId: "dev-1",
        pairingEpoch: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        credentialId: "cccccccc-dddd-eeee-ffff-000000000000",
        generation: 1,
        hubOrigin: DEAD,
        hubUrl: `${DEAD}/api/tunnel`,
        hubId: PAIR_HUB_ID,
        tunnelToken: `dpt_${"T".repeat(43)}`,
        updatedAt: Date.now(),
        operationId: "11111111-2222-3333-4444-555555555555",
      }),
    );
    const t = await tempStore();
    const server = await bootServer({
      home,
      startDirs: t.work,
      token: newToken(),
      name: "paired-box",
    });
    try {
      const res = await fetch(`${server.base}/v1/pair-enroll`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({ pairUrl: offerUrl() }),
      });
      assert.equal(res.status, 409);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, "paired");
    } finally {
      await server.stop();
      await t.cleanup();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the page polls exactly the states the API emits (static contract)", async () => {
  const t = await tempStore();
  const server = await bootServer({
    home: join(t.root, "home"),
    startDirs: t.work,
    token: newToken(),
    name: "poll-box",
  });
  try {
    const html = await (await fetch(`${server.base}/pair`)).text();
    // The page's poll loop branches on the API's state machine — keep the two
    // in lockstep or the page silently stops rendering progress. ("unpaired"
    // is the idle default with no branch; "revoked" surfaces via lastError.)
    for (const state of ['"pairing"', '"paired"'])
      assert.ok(html.includes(`s.state === ${state}`), `the page reacts to ${state}`);
    assert.match(html, /waiting for approval on the hub/, "the pending phase is user-visible");
    assert.match(html, /credential saved/, "the success phase tells the operator what to do next");
  } finally {
    await server.stop();
    await t.cleanup();
  }
});
