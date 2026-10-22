/**
 * T-1 — one reconnect curve for every retry loop. The helper owns the numbers
 * (1 → 2 → 4 → 8 → 15 → 15 s; monitor cap 30 s); `follow()` is the browser/LAN loop built on it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Backoff } from "../src/protocol/backoff.js";
import { MONITOR_BACKOFF_S, RECONNECT_BACKOFF_S } from "../src/protocol/limits.js";
import { follow } from "../src/client.js";
import type { Frame } from "../src/api.js";

const walk = (b: Backoff, n: number): number[] => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(b.ms);
    b.advance();
  }
  return out;
};

test("reconnect policy waits 1 → 2 → 4 → 8 → 15 → 15 s", () => {
  assert.deepEqual(walk(new Backoff(RECONNECT_BACKOFF_S), 8), [1000, 2000, 4000, 8000, 15000, 15000, 15000, 15000]);
});

test("monitor policy is the same curve with a 30 s cap", () => {
  assert.deepEqual(walk(new Backoff(MONITOR_BACKOFF_S), 8), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test("reset starts the curve again from the first step", () => {
  const b = new Backoff(RECONNECT_BACKOFF_S);
  walk(b, 4);
  assert.equal(b.ms, 15000);
  b.reset();
  assert.deepEqual(walk(b, 3), [1000, 2000, 4000]);
});

test("a long outage stays at the cap", () => {
  const b = new Backoff(RECONNECT_BACKOFF_S);
  for (let i = 0; i < 100_000; i++) b.advance();
  assert.equal(b.ms, 15000);
  b.reset();
  assert.equal(b.ms, 1000);
});

// ---- follow() -----------------------------------------------------------------------------

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("follow(): waits 1 → 2 → 4 → 8 → 15 s between failed opens and goes back to 1 s after a hello", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ac = new AbortController();
  let opens = 0;
  let healthy = false;
  const states: string[] = [];
  const done = follow(
    (_signal) => {
      opens++;
      if (!healthy) throw new Error("device unreachable");
      return (async function* (): AsyncGenerator<Frame> {
        yield { type: "hello" } as Frame;
        throw new Error("stream cut");
      })();
    },
    () => {},
    (s) => states.push(s),
    ac.signal,
  );
  await flush();
  assert.equal(opens, 1);

  // Each wait must hold for exactly its delay: nothing a millisecond early, the next open on the dot.
  const expectNextOpenAfter = async (ms: number) => {
    const before = opens;
    t.mock.timers.tick(ms - 1);
    await flush();
    assert.equal(opens, before, `no new attempt ${ms - 1} ms in`);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(opens, before + 1, `new attempt after ${ms} ms`);
  };
  for (const ms of [1000, 2000, 4000, 8000, 15000, 15000]) await expectNextOpenAfter(ms);

  // The next open (still failing) waits the capped 15 s; let it succeed once, then fail after the hello.
  healthy = true;
  await expectNextOpenAfter(15000);
  await flush();
  // hello arrived, the stream then broke: the wait is back to the first step
  await expectNextOpenAfter(1000);

  ac.abort();
  t.mock.timers.tick(60_000);
  await done;
});
