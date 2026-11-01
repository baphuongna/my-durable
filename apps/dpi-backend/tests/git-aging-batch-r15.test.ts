/**
 * Run-15 (u2-1, backend hunter): run-13's aging promoted the ENTIRE aged
 * prefix in one promotion event, so a burst of aged fan-out waiters spliced
 * ahead of every fresh high waiter at once — f4's starvation inverted onto
 * interactive traffic. run-15 bounds promotion: at most GIT_SPAWN_AGE_BATCH
 * (=2) waiters move per promoteAgedLowWaiters() call. Progress still holds —
 * every acquire(low)/release re-runs the scan, so the aged prefix drains at
 * ≤2 per release and a fresh high waiter waits a bounded number of slots.
 *
 * Same harness as git-aging-r13.test.ts (which stays green alongside this):
 * saturate the budget with held children, park waiters, age the injected
 * clock, free slots one at a time, read who started. queuedAged is
 * cumulative per process — this file owns its own process (tsx --test), so
 * deltas are taken per release.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { git, gitSpawnStats, GIT_SPAWN_BUDGET, setGitClockForTests, setGitExecForTests } from "../src/git.js";

type ExecCb = (error: Error | null, stdout: string, stderr: string) => void;
type FakeExec = (file: string, args: string[], opts: Record<string, unknown>, cb: ExecCb) => unknown;
const asExecFile = (fake: FakeExec) => fake as unknown as typeof execFile;

/** Let queued acquires and spawn starts (microtask work) run to completion. */
const settle = () => new Promise<void>((r) => setImmediate(r));

/** Answer every held child with a failure — leak-proof teardown. */
const teardownHeld = async (held: Array<{ cb: ExecCb }>) => {
  for (const h of held.splice(0)) h.cb(Object.assign(new Error("test teardown"), { code: 1 }), "", "");
  await settle();
  await settle();
};

/** Saturate the budget with held low spawns — the precondition for queueing. */
const saturate = () =>
  Array.from({ length: GIT_SPAWN_BUDGET }, (_, i) => git("/repo", ["sat", String(i)]).catch(() => {}));

/** Free every held child one by one until both lanes rest. */
const drain = async (held: Array<{ cb: ExecCb }>) => {
  for (let guard = 0; held.length > 0 && guard < 100; guard++) {
    held.shift()!.cb(null, "", "");
    await settle();
  }
};

test("u2-1: one release promotes at most GIT_SPAWN_AGE_BATCH waiters; the aged prefix drains FIFO and the fresh high wakes after it", async () => {
  const started: string[] = [];
  const held: Array<{ cb: ExecCb }> = [];
  let now = 7_000_000;
  setGitClockForTests(() => now);
  setGitExecForTests(
    asExecFile((_file, args, _opts, cb) => {
      started.push(args.join(" "));
      held.push({ cb });
      return { on() {}, kill() {} };
    }),
  );
  try {
    const aged0 = gitSpawnStats().queuedAged;
    const lows = saturate();
    await settle();
    assert.equal(started.length, GIT_SPAWN_BUDGET, "the budget is saturated with live spawns");

    // Five aged-low candidates + ONE fresh high waiter: the u2-1 shape.
    // run-13 would have promoted ALL five at the first release — one event
    // splicing the whole fan-out ahead of the interactive waiter.
    const queuedLows = [1, 2, 3, 4, 5].map((n) => git("/repo", ["lo", `L${n}`]).catch(() => {}));
    await settle();
    const hi = git("/repo", ["hi", "fresh"], undefined, undefined, "high").catch(() => {});
    await settle();
    assert.equal(gitSpawnStats().queued, 6, "five low waiters + one high waiter parked");

    now += 10_500; // every low waiter is now strictly past GIT_SPAWN_AGE_MS

    // Free slots one at a time: each release promotes ≤2, the wake order
    // stays aged-FIFO, and the fresh high waiter wakes after all five.
    const want = ["lo L1", "lo L2", "lo L3", "lo L4", "lo L5", "hi fresh"];
    for (const w of want) {
      const before = gitSpawnStats().queuedAged;
      held.shift()!.cb(null, "", "");
      await settle();
      const promoted = gitSpawnStats().queuedAged - before;
      assert.ok(promoted <= 2, `one release promotes at most GIT_SPAWN_AGE_BATCH waiters (got ${promoted})`);
      assert.match(started.at(-1)!, new RegExp(`${w.replace(/ /g, "\\s+")}$`), `admit order: ${w} next`);
    }
    assert.equal(
      gitSpawnStats().queuedAged - aged0,
      5,
      "all five aged waiters were promoted across bounded events — the bound delays, it never blocks",
    );
    assert.equal(gitSpawnStats().queued, 0, "the fresh high waiter woke too — starvation is bounded, not eternal");

    await drain(held);
    await Promise.all([...lows, ...queuedLows, hi]);
    const rest = gitSpawnStats();
    assert.deepEqual(
      { live: rest.live, queued: rest.queued, queuedHigh: rest.queuedHigh },
      { live: 0, queued: 0, queuedHigh: 0 },
      "the semaphore fully drains",
    );
  } finally {
    await teardownHeld(held);
    setGitExecForTests(); // real execFile and clock before anything else runs
    setGitClockForTests();
  }
});
