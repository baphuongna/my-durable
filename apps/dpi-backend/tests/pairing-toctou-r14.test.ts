/**
 * Audit run-1 HIGH — `DevicePairing.start` pending-in-flight-gap (TOCTOU):
 * the busy gate held only from the tail of completeChallenge, so two
 * concurrent start() calls both passed it during the hubFetch window and the
 * second enrollment hijacked the first. The fix reserves the slot
 * SYNCHRONOUSLY before the first await; these tests pin that contract:
 *
 *  1. status() reports "pairing" and a second start() gets "busy" WHILE the
 *     hub fetch is still in flight (the old window).
 *  2. cancel() during the same window wins — a later challenge response must
 *     not resurrect the cancelled operation (no verify polling starts).
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

/** pairHub with a gate that can HOLD the pairing routes mid-flight. */
function gatedHub() {
  const hub = pairHub({ origin: ORIGIN, now: PAIR_NOW });
  let gate: (() => void) | undefined;
  const hold = () => new Promise<void>((resolve) => (gate = resolve));
  const release = () => {
    gate?.();
    gate = undefined;
  };
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (gate && String(input).endsWith("/api/pair/start")) await hold();
    return hub.fetchImpl(input, init);
  };
  return { ...hub, fetchImpl, release };
}

async function device(hub: { fetchImpl: typeof fetch }) {
  const dir = await mkdtemp(join(tmpdir(), "dpi-toctou-"));
  const pairing = new DevicePairing({ uid: PAIR_UID } as never, dir, "dev", undefined, {
    fetchImpl: hub.fetchImpl as never,
    pollMs: 5,
    now: () => PAIR_NOW,
  });
  opened.push(pairing);
  return { dir, pairing, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("the busy gate holds while the hub fetch is in flight (no pending-in-flight gap)", async () => {
  const hub = gatedHub();
  const d = await device(hub);
  try {
    const first = d.pairing.start({ hub: ORIGIN, code: "AB2C7DEF" });
    // The window the old code left open: the hub fetch is unresolved, yet the
    // slot must already be reserved (status says pairing, start() says busy).
    await until(() => d.pairing.status().state === "pairing");
    assert.equal(d.pairing.status().state, "pairing");
    assert.ok(d.pairing.status().pending, "pending slot is visible during the window");
    assert.equal(d.pairing.status().pending?.hubOrigin, ORIGIN);

    await assert.rejects(
      d.pairing.start({ hub: ORIGIN, code: "AB2C7DEF" }),
      (e: Error & { code?: string }) => e.code === "busy",
    );
    // The rejected rival never reached the hub (asserted below, after release,
    // because the hub records the call only once its fetch actually runs).

    hub.release();
    const status = await first;
    assert.equal(status.state, "pairing");
    assert.equal(
      hub.calls.filter((c) => c.url.endsWith("/api/pair/start")).length,
      1,
      "only ONE enrollment request reached the hub",
    );
    // Exactly one enrollment proceeds to the verify poll.
    await until(() => hub.calls.some((c) => c.url.endsWith("/api/pair/verify")));
    assert.equal(hub.calls.filter((c) => c.url.endsWith("/api/pair/verify")).length > 0, true);
  } finally {
    hub.release();
    await d.cleanup();
  }
});

test("cancel() during the in-flight window wins — the challenge must not resurrect it", async () => {
  const hub = gatedHub();
  const d = await device(hub);
  try {
    const first = d.pairing.start({ hub: ORIGIN, code: "AB2C7DEF" });
    await until(() => d.pairing.status().state === "pairing");

    // Operator cancels while the hub fetch is still held.
    const cancelled = d.pairing.cancel();
    assert.notEqual(cancelled.state, "pairing");

    // The hub now answers with a perfectly valid challenge.
    hub.release();
    const status = await first;
    // completeChallenge must refuse to resurrect the cancelled slot.
    assert.notEqual(status.state, "pairing");
    assert.notEqual(d.pairing.status().state, "pairing");
    // No verify polling ever started for the cancelled operation.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(
      hub.calls.some((c) => c.url.endsWith("/api/pair/verify")),
      false,
      "a cancelled enrollment must not poll for issuance",
    );
    // And the slot is free for a fresh attempt.
    const retry = d.pairing.start({ hub: ORIGIN, code: "AB2C7DEF" });
    await until(() => d.pairing.status().state === "pairing");
    d.pairing.cancel();
    await retry.catch(() => undefined);
  } finally {
    hub.release();
    await d.cleanup();
  }
});

test("a failed hub response clears the reservation — the next start() is not stuck busy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-toctou-fail-"));
  const fallback = pairHub({ origin: ORIGIN, now: PAIR_NOW });
  let n = 0;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/pair/start")) {
      n += 1;
      if (n === 1)
        return new Response(JSON.stringify({ type: "unexpected" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
    }
    return fallback.fetchImpl(input, init);
  };
  const pairing = new DevicePairing({ uid: PAIR_UID } as never, dir, "dev", undefined, {
    fetchImpl: fetchImpl as never,
    pollMs: 5,
    now: () => PAIR_NOW,
  });
  opened.push(pairing);
  try {
    await assert.rejects(pairing.start({ hub: ORIGIN, code: "AB2C7DEF" }), /Unexpected hub response/);
    assert.equal(pairing.status().state, "unpaired", "reservation cleared after the failure");
    // The very next start() must not be told "busy" by a stale reservation.
    const second = pairing.start({ hub: ORIGIN, code: "AB2C7DEF" });
    await until(() => pairing.status().state === "pairing");
    pairing.cancel();
    await second.catch(() => undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
