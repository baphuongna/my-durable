/**
 * Device-INITIATED enrollment: the machine asks the hub for a code, sending its
 * full identity (name, hostname, platform, public key). This is the shape
 * orca/paseo offers have — except the hub still mints the 122-bit code, still
 * computes the fingerprint itself, and a human still approves.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevicePairing } from "../src/pairing.js";
import { until } from "./helpers.js";
import { PAIR_NOW, PAIR_UID, pairHub } from "./pairing-hub.js";

const ORIGIN = "https://h.example.com";
const opened: DevicePairing[] = [];
afterEach(() => {
  for (const p of opened.splice(0)) if (p.status().pending) p.cancel();
});

async function device() {
  const dir = await mkdtemp(join(tmpdir(), "dpi-di-"));
  const hub = pairHub({ origin: ORIGIN, now: PAIR_NOW });
  const pairing = new DevicePairing(
    { uid: PAIR_UID } as never,
    dir,
    "PhuongNB-Laptop",
    undefined,
    { fetchImpl: hub.fetchImpl, pollMs: 5, now: () => PAIR_NOW },
  );
  opened.push(pairing);
  return { dir, hub, pairing, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("a code-less start asks the hub for a code and sends the machine's identity", async () => {
  const d = await device();
  try {
    const status = await d.pairing.start({ hub: ORIGIN });
    assert.equal(status.state, "pairing");
    const call = d.hub.calls.find((c) => c.url.endsWith("/api/pair/request"));
    assert.ok(call, "the device must use the device-initiated endpoint");
    // The full identity rides the request: this is what the operator approves against.
    assert.equal(call.body.type, "pair.device-request");
    assert.equal(call.body.deviceName, "PhuongNB-Laptop");
    assert.ok(call.body.hostname && call.body.hostname.length > 0, "hostname present");
    assert.match(call.body.platform, /node v/, "platform present");
    assert.match(call.body.publicKey, /BEGIN PUBLIC KEY/, "public key present");
    assert.match(call.body.keyFingerprint, /^sha256:[0-9a-f]{64}$/);
    // No code was sent — the hub mints it.
    assert.equal(call.body.code, undefined);
  } finally {
    await d.cleanup();
  }
});

test("after the ack the device signs the hub's challenge and polls until issued", async () => {
  const d = await device();
  try {
    await d.pairing.start({ hub: ORIGIN });
    // The verify round carries the signed proof — the shared tail of both flows.
    await until(() => d.hub.calls.some((c) => c.url.endsWith("/api/pair/verify")));
    const verify = d.hub.calls.filter((c) => c.url.endsWith("/api/pair/verify")).at(-1)!;
    assert.equal(verify.body.type, "pair.response");
    assert.match(verify.body.signature, /^[A-Za-z0-9_-]{86}$/);
    await until(async () => (await d.pairing.status()).state === "paired");
    assert.equal((await d.pairing.status()).state, "paired");
  } finally {
    await d.cleanup();
  }
});

test("a code-less start with no hub origin fails honestly, before any network call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-di-"));
  const hub = pairHub({ origin: ORIGIN, now: PAIR_NOW });
  const pairing = new DevicePairing({ uid: PAIR_UID } as never, dir, "box", undefined, {
    fetchImpl: hub.fetchImpl,
    pollMs: 5,
    now: () => PAIR_NOW,
  });
  opened.push(pairing);
  try {
    await assert.rejects(() => pairing.start({}), /hub|--hub/i);
    assert.equal(hub.calls.length, 0);
  } finally {
    if (pairing.status().pending) pairing.cancel();
    await rm(dir, { recursive: true, force: true });
  }
});
