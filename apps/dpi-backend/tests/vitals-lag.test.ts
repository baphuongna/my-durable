/**
 * Event-loop lag sampler (R7 perf lane): the numbers /v1/device/vitals now
 * carries must actually measure a blocked loop, in milliseconds, and ride the
 * DeviceVitals shape end to end.
 *
 * The sampler's window is 1 s (not configurable — it is the production value),
 * so this test spends ~2.5 s wall time: one window to arm, one that contains a
 * deliberate 160 ms busy block, then the read. If the histogram ever reports
 * nanoseconds instead of milliseconds (an upstream unit change), the upper
 * bound below fails loudly instead of shipping a vitals card reading 160000000.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceVitals, eventLoopLag, startEventLoopMonitor, stopEventLoopMonitor } from "../src/vitals.js";
import { delay } from "./helpers.js";

const busyBlock = (ms: number) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    /* spin: a synchronous CPU hold is exactly the kind of stall we hunt */
  }
};

test("eventLoopLag: a 160 ms sync block lands in lagMsLast, in milliseconds", async () => {
  stopEventLoopMonitor(); // fresh window, in case another test armed it first
  startEventLoopMonitor();
  await delay(1_100); // let window 1 complete (boot noise lives there)
  busyBlock(160); // window 2 must catch this
  await delay(1_200); // window 2 tick fires after the loop is free again
  const lag = eventLoopLag();
  assert.ok(lag.samples >= 2, `at least two windows sampled (got ${lag.samples})`);
  assert.ok(lag.samples <= 60, "window is capped at 60 samples");
  assert.ok(lag.lagMsLast >= 120, `blocked window records the stall (got ${lag.lagMsLast} ms)`);
  assert.ok(lag.lagMsLast < 5_000, `values are milliseconds, not nanoseconds (got ${lag.lagMsLast})`);
  assert.ok(lag.lagMsMax1m >= lag.lagMsLast, "rolling max is at least the last window");
});

test("deviceVitals carries the eventLoop block", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-vitals-lag-"));
  try {
    const vitals = deviceVitals(dir, Date.now() - 1_000);
    assert.equal(vitals.eventLoop.samples, eventLoopLag().samples);
    assert.ok(Number.isFinite(vitals.eventLoop.lagMsLast));
    assert.ok(Number.isFinite(vitals.eventLoop.lagMsMax1m));
    assert.ok(vitals.eventLoop.lagMsMax1m >= 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("startEventLoopMonitor is idempotent and stop forgets the window", () => {
  stopEventLoopMonitor();
  startEventLoopMonitor();
  startEventLoopMonitor(); // second call must not double-sample
  assert.equal(eventLoopLag().samples, 0, "fresh monitor has no windows yet");
  stopEventLoopMonitor();
  assert.equal(eventLoopLag().samples, 0, "stop clears the ring and restarts lazily");
});
