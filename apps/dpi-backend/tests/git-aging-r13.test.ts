/**
 * run-13 (run-11 cold-review f4, git lo-lane aging): r11's two wake lanes
 * fixed interactive ops starving behind fan-outs, but inverted the risk —
 * releaseGitSpawn always wakes the HIGH lane first, so under sustained
 * interactive traffic (a user clicking through the status panel) the high
 * lane never empties and a LOW waiter (a status-batch fan-out, the boot
 * project-seed walk) queues forever. run-13 adds AGING: a low waiter queued
 * strictly longer than 10s (GIT_SPAWN_AGE_MS) is promoted into the high
 * lane — ahead of fresh high traffic, arrival-FIFO among promoted waiters.
 * No timers: ages are checked when a new low waiter is about to park
 * (acquire) and before each lane choice (release). gitSpawnStats() gains
 * queuedAged, the cumulative promotion count, for deviceVitals.
 *
 * The 10s boundary is crossed with the injected clock (setGitClockForTests)
 * — the suite never sleeps. Spawn order is driven through the exec seam
 * with held children exactly like git-priority-r11.test.ts: saturate the
 * budget, park waiters, age the clock, free ONE slot, read who woke.
 * queuedAged is cumulative per process, so every test asserts DELTAS from
 * its own baseline instead of absolutes.
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

/** Answer every held child with a failure — leak-proof teardown: every queued
 *  waiter wakes and every git() promise settles even when an assert above
 *  failed, so one red case cannot poison the next with parked slots. */
const teardownHeld = async (held: Array<{ cb: ExecCb }>) => {
  for (const h of held.splice(0)) h.cb(Object.assign(new Error("test teardown"), { code: 1 }), "", "");
  await settle();
  await settle();
};

/** Saturate the budget with held low spawns — the shape a 50-path
 *  status-batch leaves behind, and the precondition for any queueing. */
const saturate = () => Array.from({ length: GIT_SPAWN_BUDGET }, (_, i) => git("/repo", ["sat", String(i)]).catch(() => {}));

/** Free every held child one by one until both lanes rest — the r11 drain. */
const drain = async (held: Array<{ cb: ExecCb }>) => {
  for (let guard = 0; held.length > 0 && guard < 100; guard++) {
    held.shift()!.cb(null, "", "");
    await settle();
  }
};

test("f4: an aged low waiter is promoted and wakes before a fresh high waiter on the next release", async () => {
  const started: string[] = [];
  const held: Array<{ cb: ExecCb }> = [];
  let now = 1_000_000;
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

    const lo = git("/repo", ["lo", "stale"]).catch(() => {});
    await settle();
    const hi = git("/repo", ["hi", "fresh"], undefined, undefined, "high").catch(() => {});
    await settle();
    const s = gitSpawnStats();
    assert.deepEqual(
      { live: s.live, queued: s.queued, queuedHigh: s.queuedHigh },
      { live: GIT_SPAWN_BUDGET, queued: 2, queuedHigh: 1 },
      "the low waiter arrived first, the high one after it — both parked",
    );
    assert.equal(s.queuedAged, aged0, "nothing is promoted while the low waiter is young");

    now += 10_001; // strictly past GIT_SPAWN_AGE_MS — the f4 threshold
    held.shift()!.cb(null, "", ""); // ONE freed slot
    await settle();
    assert.equal(started.length, GIT_SPAWN_BUDGET + 1, "exactly one queued caller was admitted");
    assert.match(started.at(-1)!, /lo stale$/, "the AGED low waiter woke first — not the fresh high one");
    assert.equal(gitSpawnStats().queuedAged, aged0 + 1, "the promotion was counted");
    const after = gitSpawnStats();
    assert.equal(after.queuedHigh, 1, "the fresh high waiter is still parked");
    assert.equal(after.live, GIT_SPAWN_BUDGET, "the freed slot was handed to the woken waiter, not returned (r11 handover)");

    await drain(held);
    await Promise.all([...lows, lo, hi]);
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

test("f4: a young low waiter still waits behind the high lane — no premature promotion", async () => {
  const started: string[] = [];
  const held: Array<{ cb: ExecCb }> = [];
  let now = 2_000_000;
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
    const lo = git("/repo", ["lo", "young"]).catch(() => {});
    const hi = git("/repo", ["hi", "fresh"], undefined, undefined, "high").catch(() => {});
    await settle();

    // Young pair: pure r11 semantics — the high lane outranks the low one.
    held.shift()!.cb(null, "", "");
    await settle();
    assert.match(started.at(-1)!, /hi fresh$/, "the high lane still outranks a YOUNG low waiter (r11 h2-2 unchanged)");
    assert.equal(gitSpawnStats().queuedAged, aged0, "no promotion while under the age");
    assert.equal(gitSpawnStats().queued, 1, "only the low waiter is still parked");

    // EXACTLY 10s old: promotion needs strictly more ("> 10s", run-13 f4).
    // High is empty now, so the low waiter drains the plain r11 way.
    now += 10_000;
    held.shift()!.cb(null, "", "");
    await settle();
    assert.match(started.at(-1)!, /lo young$/, "exactly-10s-old promotes nothing; the low lane still drains once high is empty");
    assert.equal(gitSpawnStats().queuedAged, aged0, "the boundary itself promotes nothing");

    await drain(held);
    await Promise.all([...lows, lo, hi]);
    const rest = gitSpawnStats();
    assert.deepEqual({ live: rest.live, queued: rest.queued, queuedHigh: rest.queuedHigh }, { live: 0, queued: 0, queuedHigh: 0 });
  } finally {
    await teardownHeld(held);
    setGitExecForTests();
    setGitClockForTests();
  }
});

test("f4: a promoted batch keeps arrival FIFO and outranks fresh high traffic", async () => {
  const started: string[] = [];
  const held: Array<{ cb: ExecCb }> = [];
  let now = 3_000_000;
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
    const queuedLows = ["one", "two", "three"].map((tag) => git("/repo", ["lo", tag]).catch(() => {}));
    const queuedHighs = ["one", "two"].map((tag) => git("/repo", ["hi", tag], undefined, undefined, "high").catch(() => {}));
    await settle();
    assert.equal(gitSpawnStats().queued, 5, "3 low + 2 high waiters parked");

    now += 10_500; // all three low waiters aged at once
    // Free slots one at a time: the promoted batch (arrival order) wakes
    // BEFORE the high waiters that arrived after them.
    const want = ["lo one", "lo two", "lo three", "hi one", "hi two"];
    for (const w of want) {
      held.shift()!.cb(null, "", "");
      await settle();
      assert.match(started.at(-1)!, new RegExp(`${w.replace(/ /g, "\\s+")}$`), `admit order: ${w} next`);
    }
    assert.equal(gitSpawnStats().queuedAged, aged0 + 3, "cumulative promotions reached three — run-15 (u2-1) bounds each event to GIT_SPAWN_AGE_BATCH, so the third arrived on a later release");
    assert.equal(gitSpawnStats().queued, 0, "every waiter was admitted");

    await drain(held);
    await Promise.all([...lows, ...queuedLows, ...queuedHighs]);
    const rest = gitSpawnStats();
    assert.deepEqual({ live: rest.live, queued: rest.queued, queuedHigh: rest.queuedHigh }, { live: 0, queued: 0, queuedHigh: 0 });
  } finally {
    await teardownHeld(held);
    setGitExecForTests();
    setGitClockForTests();
  }
});

test("f4: acquire-time aging promotes before a new low waiter parks; later-aged batches keep FIFO among promoted", async () => {
  const started: string[] = [];
  const held: Array<{ cb: ExecCb }> = [];
  let now = 4_000_000;
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
    const lo1 = git("/repo", ["lo", "one"]).catch(() => {});
    const lo2 = git("/repo", ["lo", "two"]).catch(() => {});
    await settle();
    now += 10_500; // both aged — but no acquire(low)/release since, so nothing moved
    const hi1 = git("/repo", ["hi", "one"], undefined, undefined, "high").catch(() => {});
    await settle();
    assert.equal(gitSpawnStats().queuedAged, aged0, "a HIGH arrival triggers no promotion — only releases drain them");

    // The next LOW arrival is the acquire-time check: the aged pair moves
    // to the high head (ahead of the fresh high), the newcomer parks low.
    const lo3 = git("/repo", ["lo", "three"]).catch(() => {});
    await settle();
    const s = gitSpawnStats();
    assert.equal(s.queuedAged, aged0 + 2, "the ACQUIRE-time check promoted the aged pair");
    assert.equal(s.queuedHigh, 3, "promoted pair sits at the high head ahead of the fresh high waiter");
    assert.equal(s.queued, 4, "3 (promoted pair + high) + the young low newcomer");

    now += 10_500; // the newcomer ages too — it must slot AFTER the pair
    held.shift()!.cb(null, "", "");
    await settle();
    assert.match(started.at(-1)!, /lo one$/);
    held.shift()!.cb(null, "", "");
    await settle();
    assert.match(started.at(-1)!, /lo two$/);
    held.shift()!.cb(null, "", "");
    await settle();
    assert.match(started.at(-1)!, /lo three$/, "the later-aged waiter keeps FIFO among promoted — after the earlier pair");
    held.shift()!.cb(null, "", "");
    await settle();
    assert.match(started.at(-1)!, /hi one$/, "fresh high traffic still runs after every promoted waiter");
    assert.equal(gitSpawnStats().queuedAged, aged0 + 3, "cumulative: the second promotion event added one");

    await drain(held);
    await Promise.all([...lows, lo1, lo2, lo3, hi1]);
    const rest = gitSpawnStats();
    assert.deepEqual({ live: rest.live, queued: rest.queued, queuedHigh: rest.queuedHigh }, { live: 0, queued: 0, queuedHigh: 0 });
  } finally {
    await teardownHeld(held);
    setGitExecForTests();
    setGitClockForTests();
  }
});

test("f4: only the aged prefix moves — a young low waiter behind aged ones stays in the low lane", async () => {
  const started: string[] = [];
  const held: Array<{ cb: ExecCb }> = [];
  let now = 5_000_000;
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
    const oldLo = git("/repo", ["lo", "old"]).catch(() => {});
    await settle();
    now += 10_500; // the first low waiter is now aged
    const youngLo = git("/repo", ["lo", "young2"]).catch(() => {}); // acquire-time: promotes ONLY the aged prefix
    await settle();
    const s = gitSpawnStats();
    assert.equal(s.queuedAged, aged0 + 1, "the acquire-time check promoted the aged head only");
    assert.equal(s.queuedHigh, 1, "exactly the aged waiter moved to the high lane");
    assert.equal(s.queued, 2, "the young waiter stayed parked in the low lane");

    held.shift()!.cb(null, "", "");
    await settle();
    assert.match(started.at(-1)!, /lo old$/, "the aged waiter woke first");
    held.shift()!.cb(null, "", "");
    await settle();
    assert.match(started.at(-1)!, /lo young2$/, "the young one followed through the plain low lane");

    await drain(held);
    await Promise.all([...lows, oldLo, youngLo]);
    const rest = gitSpawnStats();
    assert.deepEqual({ live: rest.live, queued: rest.queued, queuedHigh: rest.queuedHigh }, { live: 0, queued: 0, queuedHigh: 0 });
  } finally {
    await teardownHeld(held);
    setGitExecForTests();
    setGitClockForTests();
  }
});
