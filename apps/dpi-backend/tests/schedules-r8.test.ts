/**
 * R8 schedule-runner fixes (audit findings 2.1–2.4):
 *
 *   2.1 "Run now" honors the in-flight guard — a second dispatch gets a typed
 *       409 busy fault instead of double-firing the prompt.
 *   2.2 a wedged dispatch is bounded (recorded `timeout`, slot released) and
 *       the timer re-arms unconditionally, so one wedged pass cannot halt the
 *       other schedules.
 *   2.3 the recorded outcome comes from the session TURN (settled), not from
 *       the enqueue — a failed/unanswered turn is never a green "ok".
 *   2.4 the intent marker ("started") is persisted BEFORE the dispatch, so a
 *       crash in the create→outcome window surfaces as "interrupted" after a
 *       restart and never silently re-fires the same minute.
 *
 * The budgets (dispatch deadline, settle cap, tick) are injected through
 * StoreOptions so wedged paths run in milliseconds; the wedges themselves are
 * instance patches on public seams (create / settled / runDueSchedules — the
 * scheduler looks them up dynamically via `this.…`), so production code carries
 * no test hooks.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { faux, tempStore, until } from "./helpers.js";
import { Store, type StoreOptions } from "../src/store.js";

const MINUTE = 60_000;
/** Push `due()` past one 5-minute interval: a fresh schedule is due right now
 *  at +6 min, while one that just ran goes quiet again on the following ticks
 *  (its next slot is base + 5 min, measured from a later stamp). */
const DUE_AT = 6 * MINUTE;

const input = (over: Record<string, unknown> = {}) => ({
  name: "R8 nightly",
  cwd: "project",
  model: faux,
  prompt: "Say only: ok",
  everyMinutes: 5,
  ...over,
});

/** Instance-level patch seam: Store's scheduler calls `this.method(...)`, so a
 *  test can shadow a public method on the instance to wedge exactly the await
 *  it wants. Typed loosely on purpose — each test binds what it patches. */
const seams = (store: Store): Record<string, unknown> => store as unknown as Record<string, unknown>;

/** Keep the event loop alive while a test parks on a promise that never
 *  resolves (a wedged dispatch): every store timer is unref'd by design, so
 *  without a ref'd handle the runner's process would drain and exit mid-test. */
const keepAlive = () => {
  const keep = setInterval(() => {}, 50);
  return () => clearInterval(keep);
};

const onDiskSchedules = async (dataDir: string) =>
  JSON.parse(await readFile(join(dataDir, "schedules.json"), "utf8")).schedules as Array<{
    id: string;
    name: string;
    lastOutcome?: string;
    lastError?: string;
    lastRunAt?: number;
    lastSessionId?: string;
  }>;

test("2.1 running a schedule while a run is in flight answers 409 busy, never a second run", async () => {
  const t = await tempStore();
  const store = await t.open();
  const stopKeepAlive = keepAlive();
  try {
    const s = await store.createSchedule(input());
    // Gate the submission phase: dispatch #1 stays in flight until released.
    let release!: () => void;
    const gated = new Promise<void>((r) => {
      release = r;
    });
    const realCreate = store.create.bind(store) as (...args: unknown[]) => Promise<unknown>;
    let creates = 0;
    seams(store).create = (...args: unknown[]) => {
      creates += 1;
      return creates === 1 ? gated.then(() => realCreate(...args)) : realCreate(...args);
    };

    const first = store.runScheduleNow(s.id);
    await until(() => creates >= 1, 5000, "the first run reached the gated create");
    assert.equal(store.scheduleList()[0]?.running, true, "the run shows as in flight");

    // The shared entry point refuses, with the typed fault the route maps to 409.
    await assert.rejects(
      () => store.runScheduleNow(s.id),
      (e: unknown) => {
        const fault = e as { status?: number; code?: string; message?: string };
        assert.equal(fault.status, 409, "busy fault carries the HTTP status");
        assert.equal(fault.code, "busy");
        assert.match(fault.message ?? "", /already running/);
        return true;
      },
    );
    assert.equal(creates, 1, "the second Run click never reached create");

    // The timer path is guarded by the same entry point.
    assert.deepEqual(await store.runDueSchedules(Date.now() + DUE_AT), [], "a due pass during flight dispatches nothing");
    assert.equal(creates, 1, "the loop did not double-fire either");

    release();
    // R11 2.3: run-now returns as soon as the run is ARMED; the outcome lands
    // in the record afterwards — wait for it there.
    await until(() => store.scheduleList()[0]?.lastOutcome === "ok", 5000, "the released run completes");
    const view = store.scheduleList()[0]!;
    assert.equal(view.lastOutcome, "ok", "the released run completes normally");
    assert.equal(view.running, false);
  } finally {
    stopKeepAlive();
    await store.close();
    await t.cleanup();
  }
});

test("2.2 a wedged dispatch times out, releases the slot, and the loop moves on", async () => {
  const t = await tempStore();
  // The soft-dead mount: create's realpath never returns. The 200 ms deadline
  // stands in for the production 60 s so the test stays in milliseconds.
  const store = await Store.open({ ...t.options, scheduleDispatchTimeoutMs: 200 });
  const stopKeepAlive = keepAlive();
  try {
    const s = await store.createSchedule(input());
    const realCreate = store.create.bind(store) as (...args: unknown[]) => Promise<unknown>;
    seams(store).create = () => new Promise(() => {});

    const pass = await store.runDueSchedules(Date.now() + DUE_AT);
    assert.deepEqual(pass, [s.id], "the pass itself settles despite the wedged create");
    const view = store.scheduleList()[0];
    assert.equal(view.lastOutcome, "timeout", "the run is recorded as an explicit timeout, not ok");
    assert.match(view.lastError ?? "", /dispatch timed out after 0\.2s/);
    assert.equal(view.running, false, "the in-flight slot is released for the next tick");
    assert.equal(store.list().length, 0, "no session is attributed to the timed-out run");

    // Deterministic next tick: the intent marker stamped lastRunAt BEFORE the
    // dispatch, so the schedule is not re-fired the same instant…
    assert.deepEqual(await store.runDueSchedules(Date.now()), [], "no same-instant refire after a timeout");
    // …and the next full slot runs cleanly once the mount is back (the timed-out
    // attempt is abandoned, not cancelled: at-least-once, documented).
    seams(store).create = (...args: unknown[]) => realCreate(...args);
    assert.deepEqual(await store.runDueSchedules(Date.now() + DUE_AT), [s.id]);
    assert.equal(store.scheduleList()[0].lastOutcome, "ok");
    assert.equal(store.list().length, 1);
  } finally {
    stopKeepAlive();
    await store.close();
    await t.cleanup();
  }
});

test("2.2b the scheduler keeps ticking while a pass is wedged (unconditional re-arm)", async () => {
  const t = await tempStore();
  // The wedge: the FIRST settle wait never resolves (a hang no deadline bounds —
  // the settle cap default is 120 s, far beyond this test). Pass 1 stays wedged;
  // the unconditional re-arm must still dispatch the healthy schedule on a later
  // tick. With the old `runDueSchedules().finally(tick)` chain, the pass count
  // freezes at 1 and the healthy schedule never runs.
  const store = await Store.open({ ...t.options, scheduleTickMs: 40 });
  const stopKeepAlive = keepAlive();
  const realRun = store.runDueSchedules.bind(store) as (at?: number) => Promise<string[]>;
  const realCreate = store.create.bind(store) as (...args: unknown[]) => Promise<unknown>;
  const realSettled = store.settled.bind(store) as (...args: unknown[]) => Promise<unknown>;
  let passes = 0;
  let creates = 0;
  let settledCalls = 0;
  let futureTicks = true;
  seams(store).runDueSchedules = async () => {
    passes += 1;
    const started = await realRun(futureTicks ? Date.now() + DUE_AT : Date.now());
    if (creates >= 2) futureTicks = false; // both schedules fired; back to real time
    return started;
  };
  seams(store).create = (...args: unknown[]) => {
    creates += 1;
    return realCreate(...args);
  };
  seams(store).settled = (...args: unknown[]) => {
    settledCalls += 1;
    return settledCalls === 1 ? new Promise(() => {}) : realSettled(...args);
  };

  try {
    // "A wedged" sorts first, so pass 1 dispatches it and wedges at its settle
    // wait; "B healthy" is left for a later tick.
    const wedged = await store.createSchedule(input({ name: "A wedged" }));
    const healthy = await store.createSchedule(input({ name: "B healthy" }));

    await until(() => settledCalls >= 1, 5000, "pass 1 wedged at its settle wait");
    assert.equal(store.scheduleList().find((s) => s.id === wedged.id)?.running, true);
    const passesAtWedge = passes;

    await until(
      () => store.scheduleList().find((s) => s.id === healthy.id)?.lastOutcome === "ok",
      10_000,
      "the healthy schedule ran on a later tick",
    );
    await until(() => passes >= passesAtWedge + 3, 5000, "the timer re-armed repeatedly");
    assert.equal(
      store.scheduleList().find((s) => s.id === wedged.id)?.running,
      true,
      "the wedged run still holds its guard (and only its own schedule)",
    );
    assert.equal(store.list().length, 2, "each schedule fired exactly once");
  } finally {
    stopKeepAlive();
    await store.close();
    await t.cleanup();
  }
});

test("2.3 the recorded outcome comes from the turn: unanswered fails, unfinished times out", async () => {
  const t = await tempStore();
  const store = await Store.open({ ...t.options, scheduleSettleCapMs: 1000 });
  const stopKeepAlive = keepAlive();
  try {
    const realSettled = store.settled.bind(store) as (...args: unknown[]) => Promise<unknown>;
    let mode: "unanswered" | "pending" | "real" = "unanswered";
    seams(store).settled = (...args: unknown[]) =>
      mode === "unanswered"
        ? Promise.resolve({ submissionId: 1, status: "unanswered", reason: "provider outage at fire time" })
        : mode === "pending"
          ? Promise.resolve({ submissionId: 2, status: "pending" })
          : realSettled(...args);

    const a = await store.createSchedule(input({ name: "Unanswered" }));
    // R11 2.3: run-now arms the run; outcomes land in the record afterwards.
    const untilOutcome = async (id: string, outcome: string) => {
      await until(
        () => store.scheduleList().find((v) => v.id === id)?.lastOutcome === outcome,
        5000,
        `${id} → ${outcome}`,
      );
      return store.scheduleList().find((v) => v.id === id)!;
    };
    await store.runScheduleNow(a.id);
    const ranA = await untilOutcome(a.id, "failed");
    assert.equal(ranA.lastOutcome, "failed", "an unanswered turn is never a green ok");
    assert.match(ranA.lastError ?? "", /without an answer.*provider outage/);

    mode = "pending";
    const b = await store.createSchedule(input({ name: "Unfinished" }));
    await store.runScheduleNow(b.id);
    const ranB = await untilOutcome(b.id, "timeout");
    assert.equal(ranB.lastOutcome, "timeout", "an unfinished turn records the explicit intermediate state");
    assert.match(ranB.lastError ?? "", /did not finish within 1s/);
    assert.ok(ranB.lastSessionId, "the turn's session stays linked while the outcome is pending");

    mode = "real";
    const c = await store.createSchedule(input({ name: "Settled" }));
    await store.runScheduleNow(c.id);
    const ranC = await untilOutcome(c.id, "ok");
    assert.equal(ranC.lastOutcome, "ok", "only the real settle path records ok");
    assert.equal(ranC.lastError, undefined);

    // And the outcomes are persisted, not just view state.
    const onDisk = await onDiskSchedules(t.options.dataDir);
    const byName = Object.fromEntries(onDisk.map((r) => [r.name, r.lastOutcome]));
    assert.equal(byName["Unanswered"], "failed");
    assert.equal(byName["Unfinished"], "timeout");
    assert.equal(byName["Settled"], "ok");
  } finally {
    stopKeepAlive();
    await store.close();
    await t.cleanup();
  }
});

test("2.4 a crash between intent and outcome leaves 'interrupted' and never re-fires after restart", async () => {
  const t = await tempStore();
  const stopKeepAlive = keepAlive();
  const file = join(t.options.dataDir, "schedules.json");
  let intentAt = 0;

  // "Crash": the dispatch wedges at create (the patched never-resolving promise)
  // right after the intent marker landed on disk, and the daemon goes away.
  const store1 = await Store.open(t.options);
  try {
    const s = await store1.createSchedule(input());
    seams(store1).create = () => new Promise(() => {});
    void store1.runScheduleNow(s.id); // abandoned mid-flight, like a killed daemon
    await until(
      async () => (await onDiskSchedules(t.options.dataDir))[0]?.lastOutcome === "started",
      5000,
      "intent marker persisted before the dispatch",
    );
    intentAt = (await onDiskSchedules(t.options.dataDir))[0].lastRunAt ?? 0;
    assert.ok(intentAt > 0);
    assert.equal((await onDiskSchedules(t.options.dataDir))[0].lastSessionId, undefined);
  } finally {
    await store1.close(); // the crash
  }
  // The restart: boot recovery surfaces the gap instead of silently re-firing.
  const store2 = await Store.open(t.options);
  try {
    const after = store2.scheduleList()[0];
    assert.equal(after.lastOutcome, "interrupted");
    assert.match(after.lastError ?? "", /interrupted by a device restart/);
    assert.equal(after.lastRunAt, intentAt, "the intent stamp survives the restart");
    assert.equal(after.running, false);

    // At-most-once: the schedule is NOT due again until its next full slot.
    assert.deepEqual(await store2.runDueSchedules(Date.now()), [], "no silent re-fire of the interrupted run");
    assert.deepEqual(await store2.runDueSchedules(Date.now() + DUE_AT), [after.id], "the next slot runs fresh");
    const reran = store2.scheduleList()[0];
    assert.equal(reran.lastOutcome, "ok");
    assert.equal(store2.list().length, 1, "exactly one session exists: the fresh run's");
    assert.equal(reran.lastSessionId, store2.list()[0].id);
    const onDisk = await onDiskSchedules(t.options.dataDir);
    assert.equal(onDisk[0].lastOutcome, "ok", "the interrupted gap is replaced by the real outcome");
  } finally {
    stopKeepAlive();
    await store2.close();
    await t.cleanup();
  }
});

test("pre-R8 registries (ok/failed outcomes only) still boot, run and record", async () => {
  const t = await tempStore();
  const stopKeepAlive = keepAlive();
  const file = join(t.options.dataDir, "schedules.json");
  await mkdir(dirname(file), { recursive: true });
  const legacy = {
    version: 1,
    schedules: [
      {
        id: "sch_0000000000aa",
        name: "Legacy",
        cwd: join(t.root, "work", "project"),
        model: faux,
        prompt: "Say only: ok",
        everyMinutes: 5,
        enabled: true,
        // 30 s ago: parses, but NOT due (next slot = lastRunAt + 5 min) — the
        // boot pass must leave it alone while this test inspects the record.
        lastRunAt: Date.now() - 30_000,
        lastOutcome: "failed",
        lastError: "old failure",
        createdAt: Date.now() - 3_600_000,
        updatedAt: Date.now() - 3_600_000,
      },
    ],
  };
  await writeFile(file, `${JSON.stringify(legacy, null, 2)}\n`);
  const store = await Store.open(t.options);
  try {
    const view = store.scheduleList()[0];
    assert.equal(view.id, "sch_0000000000aa");
    assert.equal(view.lastOutcome, "failed", "old outcome values parse unchanged");
    assert.equal(view.lastError, "old failure");
    assert.equal(view.running, false);
    assert.ok(view.nextRunAt !== null, "the legacy record still schedules");

    // And it flows through the new pipeline to a real post-turn outcome.
    await store.runScheduleNow(view.id);
    await until(
      () => store.scheduleList().find((v) => v.id === view.id)?.lastOutcome === "ok",
      5000,
      "the legacy schedule runs",
    );
    assert.equal(store.scheduleList().find((v) => v.id === view.id)?.lastError, undefined, "a real run clears the stale failure reason");
    const onDisk = await onDiskSchedules(t.options.dataDir);
    assert.equal(onDisk[0].lastOutcome, "ok");
  } finally {
    stopKeepAlive();
    await store.close();
    await t.cleanup();
  }
});
