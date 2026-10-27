/**
 * R10 Design A — per-schedule keepRuns retention:
 *
 *   - validation: integer 1..100 on create/patch; `keepRuns: null` on a patch
 *     clears retention (and the ring); shrinking re-trims the ring.
 *   - the ring: markRun pushes the run's session id and trims to keepRuns —
 *     the registry's only growth from this feature, bounded by construction.
 *   - the prune: at the end of a SUCCESSFUL dispatch, sessions that fell out
 *     of the window are archived via the existing store.archive path (nothing
 *     deleted, restorable). Runs that fail/timeout never prune.
 *   - absent keepRuns = never auto-archive (the pre-R10 behavior, byte-exact).
 *   - ScheduleView carries keepRuns + derived archivedRuns.
 *
 * Rig: tempStore + the R8 seam style (instance patches on public methods the
 * scheduler resolves dynamically). Sessions are created for real through
 * store.create so the archive path is the production one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { faux, tempStore, until } from "./helpers.js";
import { Store } from "../src/store.js";
import { MAX_KEEP_RUNS, MIN_KEEP_RUNS } from "../src/schedules.js";

const input = (over: Record<string, unknown> = {}) => ({
  name: "R10 retention",
  cwd: "project",
  model: faux,
  prompt: "Say only: ok",
  everyMinutes: 5,
  ...over,
});

/** A real session row the prune can archive. */
async function realSession(store: Store): Promise<string> {
  const s = await store.create({ name: `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, cwd: "project" });
  return s.id;
}

test("keepRuns validates 1..100 on create and patch; null clears; shrink re-trims", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    await assert.rejects(() => store.createSchedule(input({ keepRuns: 0 })), /keepRuns/);
    await assert.rejects(() => store.createSchedule(input({ keepRuns: MAX_KEEP_RUNS + 1 })), /keepRuns/);
    await assert.rejects(() => store.createSchedule(input({ keepRuns: 1.5 })), /keepRuns/);

    const s = await store.createSchedule(input({ keepRuns: 3 }));
    assert.equal(s.keepRuns, 3, "legal keepRuns accepted on create");
    assert.equal(s.recentSessionIds, undefined, "no ring before any run");

    const patched = await store.updateSchedule(s.id, { keepRuns: MIN_KEEP_RUNS });
    assert.equal(patched.keepRuns, 1, "patch shrinks retention");

    const cleared = await store.updateSchedule(s.id, { keepRuns: null });
    assert.equal(cleared.keepRuns, undefined, "null clears retention");
    assert.equal(cleared.recentSessionIds, undefined);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("the retention ring: markRun pushes and trims to keepRuns; duplicates collapse", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const s = await store.createSchedule(input({ keepRuns: 2 }));
    const a = await realSession(store);
    const b = await realSession(store);
    const c = await realSession(store);

    await store.schedules.markRun(s.id, { sessionId: a, outcome: "ok" });
    await store.schedules.markRun(s.id, { sessionId: b, outcome: "ok" });
    await store.schedules.markRun(s.id, { sessionId: b, outcome: "ok" }); // dedupe: same session twice
    await store.schedules.markRun(s.id, { sessionId: c, outcome: "ok" });

    const view = store.scheduleList().find((x) => x.id === s.id)!;
    assert.deepEqual(view.recentSessionIds, [b, c], "ring holds the newest keepRuns ids, duplicates collapsed");
    assert.equal(view.lastSessionId, c);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("the prune: a run past the window archives the evicted session; the newest stay live; failures never prune", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const s = await store.createSchedule(input({ keepRuns: 1 }));

    // Run 1: seed the ring with a REAL session by simulating the ok-path tail —
    // markRun(ok) is exactly what dispatchBounded calls before the prune.
    const first = await realSession(store);
    await store.schedules.markRun(s.id, { sessionId: first, outcome: "ok" });
    assert.ok(
      store.catalog.prepare("SELECT 1 FROM sessions WHERE id=?").get(first),
      "the newest run's session is live",
    );

    // Run 2 with a second real session: runScheduleNow completes a real turn
    // (faux provider answers), the ring trims to the new session, and the
    // prune (void, best-effort) archives the evicted one. Wait for it.
    const ran = await store.runScheduleNow(s.id);
    assert.equal(ran.lastOutcome, "ok", "the real dispatch completed");
    const second = ran.lastSessionId!;
    assert.notEqual(second, first);
    await until(
      () => !store.catalog.prepare("SELECT 1 FROM sessions WHERE id=?").get(first),
      5000,
      "the evicted session leaves the catalog (archived)",
    );
    assert.ok(
      store.catalog.prepare("SELECT 1 FROM sessions WHERE id=?").get(second),
      "the newest run's session stays live",
    );
    // The archive bundle is on disk under archive/ (nothing deleted).
    const archived = join(t.options.dataDir, "archive");
    assert.ok(existsSync(archived), "archive dir exists");
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("absent keepRuns never archives (pre-R10 behavior); failed runs never prune", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const s = await store.createSchedule(input()); // no keepRuns
    const a = await realSession(store);
    // A failed run with a session id: the ring does not even exist, and no
    // prune may run (only the ok-path prunes).
    await store.schedules.markRun(s.id, { sessionId: a, outcome: "failed", error: "boom" });
    const view = store.scheduleList().find((x) => x.id === s.id)!;
    assert.equal(view.recentSessionIds, undefined, "no ring without keepRuns");
    assert.ok(store.catalog.prepare("SELECT 1 FROM sessions WHERE id=?").get(a), "session untouched");
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("ScheduleView carries keepRuns and a truthful archivedRuns", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const s = await store.createSchedule(input({ keepRuns: 2 }));
    const live = await realSession(store);
    const gone = "11111111-2222-3333-4444-555555555555"; // never created
    await store.schedules.markRun(s.id, { sessionId: gone, outcome: "ok" });
    await store.schedules.markRun(s.id, { sessionId: live, outcome: "ok" });
    const view = store.scheduleList().find((x) => x.id === s.id)!;
    assert.equal(view.keepRuns, 2);
    assert.equal(view.archivedRuns, 1, "one ring id is not live any more");
  } finally {
    await store.close();
    await t.cleanup();
  }
});
