/**
 * Run-15 Unit B (u1-1 MED + u1-2/3/4 LOW) — hub relay stale-frame and
 * hostile-frame behavior, on the same e2e harness as relay-churn-r11
 * (real TunnelServer + WS device + TunnelDispatcher + monitor + mux; see the
 * r11 file header). Importing that module also registers the four pinned r11
 * tests — they must stay green alongside these.
 *
 *  u1-1 MED stale-forever: the h4-5 tree bucket's coalescing waited for "the
 *      next push" to deliver a fresh view — a device that goes QUIET right
 *      after a burst left the tab pinned to a stale tree forever (the newest
 *      snapshot was exactly the one the bucket refused). Fix: deferred
 *      latest-wins flush (single per-follow() slot, unref'd 600 ms timer,
 *      500 ms retry while the bucket is still exhausted, cleared by any
 *      delivered tree and on follow() exit).
 *  u1-2 LOW bucket re-arm: every (re)connect reset the bucket to full, so a
 *      flapping device re-armed 4 tokens per flap and bypassed the shaping.
 *      Fix: full only on the FIRST connect of each follow().
 *  u1-3 LOW token burn on violation: the belt-and-braces byteLength fault in
 *      the raw path fired AFTER admitTree consumed a token — a hostile
 *      expansion-encoded tree (raw ≤ cap, canonical > cap) drained the
 *      bucket once per fault. Fix: refund on violation faults.
 *  u1-4 LOW stringify RangeError: a wire-legal deeply-nested tree (<cap
 *      bytes) blows JSON.stringify's stack; the RangeError escaped as an
 *      "offline" disconnect + reconnect churn (mux) / a device status flap
 *      (monitor). Fix: catch → cap fault (mux) / skip + log (monitor).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CHUNK_RAW_BYTES } from "../../dpi-sdk/src/protocol/limits.js";
import { setup, openTab, tree, DEVICE_ID, type Ctx } from "./relay-churn-r11.test.js";

/**
 * One orphan-free frame tap per test. The r11 harness's tab.frames() hands
 * every generator the SAME shared queue, and a pending next() that lost a
 * race keeps consuming frames forever — stacking next()s (as a
 * race-per-iteration loop does on every timeout) silently steals frames from
 * later reads. The tap keeps AT MOST ONE armed next() and re-races it, so
 * phases can time out without poisoning the next phase.
 */
class TreeTap {
  private pending: Promise<IteratorResult<any, any>> | undefined;
  constructor(private readonly iter: AsyncGenerator<any, any, unknown>) {}

  /** Collect tree session ids for `ms` (or until `stop`); non-tree frames are
   *  consumed and discarded. */
  async drain(ms: number, stop: (ids: Set<string>) => boolean = () => false): Promise<Set<string>> {
    const ids = new Set<string>();
    const by = Date.now() + ms;
    for (;;) {
      if (stop(ids)) return ids;
      const remaining = by - Date.now();
      if (remaining <= 0) return ids;
      this.pending ??= this.iter.next();
      const r = await Promise.race([
        this.pending,
        new Promise<"idle">((res) => setTimeout(() => res("idle"), Math.min(remaining, 120))),
      ]);
      if (r === "idle") continue;
      this.pending = undefined;
      if (r.done) return ids;
      if (r.value.frame.type === "tree")
        for (const s of r.value.frame.tree.sessions) ids.add(s.id);
    }
  }

  /** First frame matching pred, or undefined after ms. */
  async until(pred: (frame: any) => boolean, ms: number): Promise<any | undefined> {
    const by = Date.now() + ms;
    for (;;) {
      const remaining = by - Date.now();
      if (remaining <= 0) return undefined;
      this.pending ??= this.iter.next();
      const r = await Promise.race([
        this.pending,
        new Promise<"idle">((res) => setTimeout(() => res("idle"), Math.min(remaining, 120))),
      ]);
      if (r === "idle") continue;
      this.pending = undefined;
      if (r.done) return undefined;
      if (pred(r.value)) return r.value;
    }
  }
}

/**
 * Chunk a RAW JSON TEXT onto the wire exactly like the device-side codec,
 * except the payload is the string we built — the only way to put
 * NON-canonical JSON on the wire. sendChunked/broadcastChunked serialize an
 * object (canonicalizing it, or throwing on our fixtures before they are
 * ever sent), which is precisely what u1-3 (expansion numbers) and u1-4
 * (deep nesting) must NOT do.
 */
function sendRawChunked(f: Ctx, rawText: string): void {
  const buf = Buffer.from(rawText, "utf8");
  const count = Math.ceil(buf.length / CHUNK_RAW_BYTES);
  assert.ok(count > 0 && count <= 256, `fixture needs ${count} chunks (codec max 256)`);
  for (const [subscriptionId, sub] of f.device.subs) {
    for (let index = 0; index < count; index++) {
      const slice = buf.subarray(
        index * CHUNK_RAW_BYTES,
        Math.min((index + 1) * CHUNK_RAW_BYTES, buf.length),
      );
      f.sendWire({
        type: "tunnel-chunk",
        v: 1,
        messageId: subscriptionId,
        index,
        count,
        totalBytes: buf.length,
        data: slice.toString("base64"),
        kind: "tunnel-data",
        subscriptionId,
        sub,
      });
    }
  }
}

test(
  "run-15 u1-1: a 6-tree burst converges to the NEWEST tree via the deferred latest-wins flush (inline + chunked stash paths)",
  { timeout: 60_000 },
  async () => {
    const f = await setup();
    try {
      await f.waitOnline();
      const tab = await openTab(f.base, [`${DEVICE_ID}/device`]);
      await f.waitForMuxSubscribe();
      const tap = new TreeTap(tab.frames());

      // t0..t4 inline: the first 4 spend the bucket (capacity 4), t4 is
      // refused → stash WITH its already-serialized text (inline path).
      // t5 chunked: refused on the RAW path → stash without text, so the
      // flush performs the frame's one-and-only stringify itself. Both stash
      // flavors end in the same single latest-wins slot (t5 replaces t4).
      const burstStart = Date.now();
      for (let i = 0; i < 5; i++) f.sendToDevice({ type: "tree", tree: tree(`t${i}`) });
      f.broadcastChunked({ type: "tree", tree: tree("t5") });

      const ids = await tap.drain(5_000, (s) => s.has("t5"));
      const elapsed = Date.now() - burstStart;
      assert.ok(
        ids.has("t0") && ids.has("t1") && ids.has("t2") && ids.has("t3"),
        `the 4 immediate relays must land (${[...ids]})`,
      );
      assert.ok(
        ids.has("t5"),
        "u1-1: the deferred flush MUST deliver the newest refused tree — coalescing may never pin the tab to a stale tree",
      );
      assert.ok(
        !ids.has("t4"),
        "latest-wins: the superseded refused tree t4 is never replayed (no FIFO drain)",
      );
      // Expected ~600 ms (timer) — the bounds pin "deferred, not instant"
      // (≥1 token = 500 ms refill) and "converges promptly" (not stale).
      assert.ok(
        elapsed >= 400 && elapsed <= 2_500,
        `the flush must land in the deferred window (~600 ms), got ${elapsed} ms`,
      );
      assert.equal(f.mux.relayStats().coalescedTreeFrames, 2, "t4 + t5 were refused by the bucket");
      assert.equal(f.mux.relayStats().droppedTreeFrames, 0, "no drops — this burst is fully legal");
    } finally {
      await f.cleanup();
    }
  },
);

test(
  "run-15 u1-2: a reconnect no longer re-arms a full tree bucket — the 5th tree still coalesces (and u1-1 still converges it)",
  { timeout: 90_000 },
  async () => {
    const f = await setup();
    try {
      await f.waitOnline();
      const tab = await openTab(f.base, [`${DEVICE_ID}/device`]);
      await f.waitForMuxSubscribe();
      const tap = new TreeTap(tab.frames());

      // Spend the bucket: capacity-4 trees all relay immediately.
      for (let i = 0; i < 4; i++) f.sendToDevice({ type: "tree", tree: tree(`t${i}`) });
      const spent = await tap.drain(10_000, (s) => s.size >= 4);
      assert.equal(spent.size, 4, "the initial bucket spends on the first 4 trees");
      assert.equal(f.mux.relayStats().coalescedTreeFrames, 0);

      // Drop the device stream and bring it back: the mux follow() loop
      // RECONNECTS (a later while-iteration) while the tab's SSE stays open.
      await f.reconnectDevice();
      // Fast poll (10 ms — the token-refill rate is 2/s, so the exposure
      // window before the probe tree must stay far under 500 ms): wait for
      // BOTH the monitor's and the mux's re-subscribes on the new socket.
      const by = Date.now() + 20_000;
      while (Date.now() < by && f.device.subscribes.length < 4) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.ok(
        f.device.subscribes.length >= 4,
        "monitor + mux re-subscribed after the reconnect",
      );

      // OLD code: the reconnect reset the bucket to FULL → t4 relayed within
      // ms. NEW code: the reconnect carries the ~0 remaining tokens → t4 is
      // coalesced (its deferred flush may deliver it LATER — that is u1-1 —
      // but never inside the immediate window).
      f.sendToDevice({ type: "tree", tree: tree("t4") });
      const immediate = await tap.drain(420);
      assert.equal(
        immediate.size,
        0,
        "a reconnect must not re-arm the tree bucket — the 5th tree still coalesces",
      );
      assert.ok(
        f.mux.relayStats().coalescedTreeFrames >= 1,
        "t4 was refused by the carried-over bucket, not relayed",
      );

      // u1-1 must still converge the refused t4 after the flap (the stash and
      // its timer live on the follow() loop, across reconnect iterations).
      const late = await tap.drain(3_000, (s) => s.has("t4"));
      assert.ok(late.has("t4"), "the deferred flush converges the coalesced t4 after the reconnect");
    } finally {
      await f.cleanup();
    }
  },
);

test(
  "run-15 u1-3: an expansion-encoded chunked tree (raw ≤ cap, canonical > cap) faults AND refunds the token — the next 4 legal trees still relay",
  { timeout: 120_000 },
  async () => {
    const f = await setup();
    try {
      await f.waitOnline();
      const tab = await openTab(f.base, [`${DEVICE_ID}/device`]);
      await f.waitForMuxSubscribe();
      const tap = new TreeTap(tab.frames());

      // Non-canonical raw bytes: `1e21` (4 chars) parses to the number 1e21,
      // which JSON.stringify re-emits as `1e+21` (5 chars) — a 5/4 expansion.
      // N sized so the RAW text + wrapper clears the 4 MiB pre-check (the
      // raw path then consumes a token at admitTree) while the hub's own
      // re-stringification exceeds the cap → the belt-and-braces byteLength
      // fault fires — exactly the seam that used to burn the token.
      const CAP = 4 * 1024 * 1024;
      const N = 800_000;
      const subKey = `${DEVICE_ID}/device`;
      const rawText =
        `{"type":"tree","tree":{"uid":"00000000-0000-0000-0000-000000000000","name":"fixture",` +
        `"sessions":[{"id":"exp","title":"ok","nums":[${"1e21,".repeat(N - 1)}1e21]}],"at":1700000000000}}`;
      const rawBytes = Buffer.byteLength(rawText);
      const canonicalBytes = Buffer.byteLength(
        JSON.stringify({ sub: subKey, frame: JSON.parse(rawText) }),
      );
      assert.ok(
        rawBytes + 17 + Buffer.byteLength(JSON.stringify(subKey)) <= CAP,
        `fixture raw must clear the pre-check (raw ${rawBytes} B)`,
      );
      assert.ok(
        canonicalBytes > CAP,
        `fixture canonical must exceed the cap (${canonicalBytes} B)`,
      );

      sendRawChunked(f, rawText);
      const fault = await tap.until(
        (fr) => fr.frame.type === "fault" && String(fr.frame.error?.message ?? "").includes("relay cap"),
        30_000,
      );
      assert.ok(fault, "the expansion tree must fault at the belt-and-braces byteLength check");
      assert.match(fault.frame.error.message, /relay cap \(4194304 bytes\)/);

      // Token intact: the refunded bucket still admits 4 back-to-back legal
      // trees. WITHOUT the refund the fault drained one token → only 3 relay
      // (the 4th gets coalesced away).
      for (let i = 0; i < 4; i++) f.sendToDevice({ type: "tree", tree: tree(`t${i}`) });
      const ids = await tap.drain(8_000, (s) => s.size >= 4);
      assert.deepEqual(
        [...ids].sort(),
        ["t0", "t1", "t2", "t3"],
        "all 4 legal trees relay — a violation fault never burns a token",
      );
      assert.equal(f.mux.relayStats().coalescedTreeFrames, 0, "nothing was coalesced");
      assert.equal(f.mux.relayStats().droppedTreeFrames, 0);
    } finally {
      await f.cleanup();
    }
  },
);

test(
  "run-15 u1-4: a deeply-nested chunked tree faults cleanly — subscription survives, no disconnect churn, monitor stays online",
  { timeout: 90_000 },
  async () => {
    const f = await setup();
    try {
      await f.waitOnline();
      const tab = await openTab(f.base, [`${DEVICE_ID}/device`]);
      await f.waitForMuxSubscribe();
      const tap = new TreeTap(tab.frames());

      // ~50k array depth, built as a JSON STRING (no object ever exists on
      // this side — building one would blow OUR stack first): JSON.parse
      // accepts this depth, JSON.stringify does not (RangeError) — the exact
      // u1-4 seam, on both the mux relay and the monitor's tree sizing.
      const DEPTH = 50_000;
      const rawText =
        `{"type":"tree","tree":{"uid":"00000000-0000-0000-0000-000000000000","name":"fixture",` +
        `"sessions":[{"id":"deep","title":"ok","pad":` +
        "[".repeat(DEPTH) +
        "]".repeat(DEPTH) +
        `}],"at":1700000000000}}`;
      assert.ok(Buffer.byteLength(rawText) < 1024 * 1024, "fixture stays under 1 MiB");
      sendRawChunked(f, rawText);

      const fault = await tap.until(
        (fr) => fr.frame.type === "fault" && String(fr.frame.error?.message ?? "").includes("relay cap"),
        30_000,
      );
      assert.ok(
        fault,
        "the unserializable tree must fault at the relay cap — the RangeError may not escape as a disconnect",
      );

      // Skip, not cut: a legal tree right after the fault still relays, and
      // no disconnected frame follows (the OLD code surfaced the RangeError
      // as offline → disconnect → reconnect churn per hostile frame).
      f.sendToDevice({ type: "tree", tree: tree("after") });
      const after = await tap.until((fr) => fr.frame.type === "tree", 10_000);
      assert.ok(after, "subscription survives the RangeError fault");
      assert.equal(after.frame.tree.sessions[0].id, "after");
      const disconnected = await tap.until((fr) => fr.frame.type === "disconnected", 1_500);
      assert.equal(disconnected, undefined, "no disconnect/reconnect churn from the hostile frame");
      assert.equal(f.mux.relayStats().coalescedTreeFrames, 0);
      assert.equal(f.mux.relayStats().droppedTreeFrames, 0);

      // Monitor side: skip the frame + log, do NOT fault the device — the
      // status must stay online across the whole window (the OLD code flapped
      // it to offline on the first RangeError and re-probed forever).
      const until = Date.now() + 1_500;
      while (Date.now() < until) {
        assert.equal(
          f.monitor.state(DEVICE_ID)?.status,
          "online",
          "monitor must not flap the device for an unserializable tree (u1-4)",
        );
        await new Promise((r) => setTimeout(r, 150));
      }
      // Reaching this line is also the "hub process alive" check: an
      // uncaught RangeError (e.g. from the deferred-flush timer's stringify)
      // would have torn the test process down.
    } finally {
      await f.cleanup();
    }
  },
);
