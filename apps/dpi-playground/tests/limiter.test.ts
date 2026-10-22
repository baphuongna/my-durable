/**
 * Gate A GA-06 / GA-15 / GA-09 — the bounded per-key limiters shared by the pairing ingress, the
 * admin API and the tunnel upgrade path. Spec 05 §4.3: at most 10.000 keys, idle TTL 15 minutes,
 * and a full table refuses NEW keys instead of evicting a live counter (which would reset a quota).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SlidingWindows, TokenBuckets } from "../apps/dpi-playground-hub/src/limiter.js";

const clock = (start = 1_760_000_000_000) => {
  const c = { t: start };
  return { c, now: () => c.t };
};
const MIN = 60_000;

test("GA-06: token buckets refill continuously and refuse at empty with a bounded retry hint", () => {
  const { c, now } = clock();
  const b = new TokenBuckets({ capacity: 3, perMinute: 6, maxKeys: 10, idleTtlMs: 15 * MIN }, now);
  for (let i = 0; i < 3; i++) assert.deepEqual(b.take("a"), { ok: true }, `take ${i}`);
  const refused = b.take("a");
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.reason, "limited");
    assert.ok(refused.retryAfterMs > 0 && refused.retryAfterMs <= 10_000, `retry hint ${refused.retryAfterMs}`);
  }
  c.t += 10_000; // one token at 6/min
  assert.equal(b.take("a").ok, true);
  assert.equal(b.take("a").ok, false);
  assert.equal(b.take("other").ok, true, "keys are independent");
});

test("S-1/S-2: a refused attempt costs the caller no refill time (the edge is exact, however often it knocks)", () => {
  for (const [capacity, perMinute] of [[20, 20], [5, 5], [300, 300], [120, 60]]) {
    const { c, now } = clock();
    const b = new TokenBuckets({ capacity, perMinute, maxKeys: 10, idleTtlMs: 15 * MIN }, now);
    for (let i = 0; i < capacity; i++) assert.equal(b.take("a").ok, true);
    const interval = 60_000 / perMinute;
    // Knock every 7 ms through the first interval: each knock is refused and must change nothing.
    const start = c.t;
    for (let at = 7; at < interval; at += 7) {
      c.t = start + at;
      assert.equal(b.take("a").ok, false, `refused at +${at} ms (${perMinute}/min)`);
    }
    c.t = start + interval - 1;
    assert.equal(b.take("a").ok, false, `1 ms early (${perMinute}/min)`);
    c.t = start + interval;
    assert.equal(b.take("a").ok, true, `exactly one interval after the last accepted request (${perMinute}/min)`);
    assert.equal(b.take("a").ok, false);
  }
});

test("GA-06: a full table refuses NEW keys and never evicts a live counter to make room", () => {
  const { now } = clock();
  const b = new TokenBuckets({ capacity: 2, perMinute: 0.01, maxKeys: 2, idleTtlMs: 15 * MIN }, now);
  for (const key of ["a", "b"]) {
    assert.equal(b.take(key).ok, true);
    assert.equal(b.take(key).ok, true);
    assert.equal(b.take(key).ok, false, `${key} drained`);
  }
  assert.equal(b.size(), 2);
  const fresh = b.take("c");
  assert.equal(fresh.ok, false, "a third key is refused while two live counters hold the table");
  if (!fresh.ok) assert.equal(fresh.reason, "full");
  assert.equal(b.size(), 2, "the refused key was not admitted");
  assert.equal(b.take("a").ok, false, "a's drained counter was not evicted (that would reset its quota)");
  assert.equal(b.take("b").ok, false, "b's drained counter was not evicted either");
});

test("GA-06: keys idle for the TTL expire and free their slot; touched keys do not", () => {
  const { c, now } = clock();
  const b = new TokenBuckets({ capacity: 2, perMinute: 0.01, maxKeys: 2, idleTtlMs: 15 * MIN }, now);
  b.take("idle");
  b.take("busy");
  c.t += 14 * MIN;
  b.take("busy"); // second token of two; activity also renews the idle clock
  c.t += 2 * MIN; // idle: 16 min since last touch; busy: 2 min
  assert.equal(b.take("fresh").ok, true, "the idle key's slot is reclaimed for a new key");
  assert.equal(b.size(), 2);
  assert.equal(b.take("busy").ok, false, "busy kept its drained counter; a fresh one would have two tokens");
});

test("GA-06: sweep() drops idle keys without needing a lookup", () => {
  const { c, now } = clock();
  const b = new TokenBuckets({ capacity: 5, perMinute: 0.01, maxKeys: 100, idleTtlMs: 15 * MIN }, now);
  for (let i = 0; i < 40; i++) b.take(`ip-${i}`);
  assert.equal(b.size(), 40);
  c.t += 15 * MIN + 1;
  b.sweep();
  assert.equal(b.size(), 0);
});

test("GA-06: a bucket that has fully refilled is reclaimable (identical to a fresh one) before the TTL", () => {
  const { c, now } = clock();
  const b = new TokenBuckets({ capacity: 2, perMinute: 60, maxKeys: 1, idleTtlMs: 15 * MIN }, now);
  b.take("a");
  c.t += 5_000; // 5 tokens of refill at 60/min → back at capacity
  assert.equal(b.take("b").ok, true, "a no longer holds any state worth keeping");
  assert.equal(b.size(), 1);
});

test("GA-06: sliding windows count only inside the window and refuse new keys when the table is full", () => {
  const { c, now } = clock();
  const w = new SlidingWindows({ windowMs: 15 * MIN, maxKeys: 2 }, now);
  assert.equal(w.record("a"), true);
  assert.equal(w.record("a"), true);
  assert.equal(w.record("b"), true);
  assert.equal(w.count("a"), 2);
  assert.equal(w.saturatedFor("a"), false, "tracked keys are never saturated");
  assert.equal(w.saturatedFor("c"), true, "a new key cannot be tracked while the table is full");
  assert.equal(w.record("c"), false);
  assert.equal(w.count("a"), 2, "the refused key did not evict or alter a live counter");
  c.t += 15 * MIN + 1;
  assert.equal(w.count("a"), 0, "entries leave the window");
  assert.equal(w.saturatedFor("c"), false, "expired entries make room");
  assert.equal(w.record("c"), true);
});
