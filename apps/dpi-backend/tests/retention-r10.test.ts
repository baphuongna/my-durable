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

const keepAlive = () => {
  const keep = setInterval(() => {}, 50);
  return () => clearInterval(keep);
};

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

    // Run 2 with a second real session: runScheduleNow ARMS the run (R11 2.3)
    // and the real turn (faux provider answers) completes afterwards — the ring
    // trims to the new session and the prune (void, best-effort) archives the
    // evicted one. Wait for both.
    await store.runScheduleNow(s.id);
    await until(
      () => {
        const v = store.scheduleList().find((x) => x.id === s.id);
        return v?.lastOutcome === "ok" && v.lastSessionId !== undefined && v.lastSessionId !== first;
      },
      5000,
      "the real dispatch completed (a NEW session id recorded)",
    );
    const second = store.scheduleList().find((v) => v.id === s.id)!.lastSessionId!;
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
    // The archive bundle is on disk under archive/ (nothing deleted). Wait for
    // the MOVE to finish — R11 2.3 armed the run asynchronously, and the prune
    // (void) can still be copying when the catalog row is already gone; ending
    // the test mid-copy would race teardown (ENOTEMPTY).
    const archived = join(t.options.dataDir, "archive");
    await until(
      () => existsSync(archived) && existsSync(join(t.options.dataDir, "sessions", first)) === false,
      5000,
      "the archived session's directory finished moving out of sessions/",
    );
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

test("R12 P2-1: a failing prune reports the degraded episode once; recovery resumes it", async () => {
  const t = await tempStore();
  const store = await t.open();
  const stopKeepAlive = keepAlive();
  const delivered: { kind: string; title: string }[] = [];
  try {
    (store.sinks as unknown as { deliver: unknown }).deliver = async (event: { kind: string; title: string }) => {
      delivered.push({ kind: event.kind, title: event.title });
      return [];
    };
    await store.createNotifySink({ kind: "webhook", url: "https://example.com/hook" });
    const s = await store.createSchedule(input({ name: "Retention", keepRuns: 1 }));
    const view = async () => store.scheduleList().find((x) => x.id === s.id)!;

    // Run 1 fills the window (ring=[A]).
    await store.runScheduleNow(s.id);
    await until(async () => (await view()).lastSessionId !== undefined && (await view()).lastOutcome === "ok", 5000, "run 1");
    const a = (await view()).lastSessionId!;

    // The archive path starts failing (read-only archive/, ENOSPC, …).
    const realArchive = store.archive.bind(store);
    (store as unknown as { archive: unknown }).archive = async () => {
      throw new Error("EROFS: archive is read-only");
    };

    // Run 2 evicts A; the prune fails and reports the episode ONCE.
    await store.runScheduleNow(s.id);
    await until(
      () => delivered.some((d) => d.title.includes("Retention paused")),
      5000,
      "the paused episode is reported",
    );
    await until(async () => (await view()).lastSessionId !== a, 5000, "run 2 settles");
    const b = (await view()).lastSessionId!;
    assert.ok(store.catalog.prepare("SELECT 1 FROM sessions WHERE id=?").get(a), "the evicted session stays live");

    // Run 3 fails the prune AGAIN — same episode, no second event.
    await store.runScheduleNow(s.id);
    await until(
      async () => {
        const v = await view();
        return v.lastSessionId !== undefined && v.lastSessionId !== b && v.lastOutcome === "ok";
      },
      8000,
      "run 3 settles",
    );
    // Give the (failing) void prune a beat to run, then assert once-ness.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(
      delivered.filter((d) => d.title.includes("Retention paused")).length,
      1,
      "ONE paused event per episode, not one per run",
    );
    const c = (await view()).lastSessionId!;

    // Recovery: archiving works again; the next eviction reports the resume.
    (store as unknown as { archive: unknown }).archive = realArchive;
    await store.runScheduleNow(s.id);
    await until(
      async () => {
        const v = await view();
        return v.lastSessionId !== undefined && v.lastSessionId !== c && v.lastOutcome === "ok";
      },
      8000,
      "the recovery run settles",
    );
    await until(
      () => delivered.some((d) => d.title.includes("Retention resumed")),
      5000,
      "the resumed episode is reported",
    );
  } finally {
    stopKeepAlive();
    await store.close();
    await t.cleanup();
  }
});

test("R12 P3-4: removing a schedule drops its degraded-episode markers; P3-8: junk keepRuns parses to absent", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const s = await store.createSchedule(input());
    const sets = store as unknown as {
      scheduleRegistryDegraded: Set<string>;
      schedulePruneDegraded: Set<string>;
    };
    sets.scheduleRegistryDegraded.add(s.id);
    sets.schedulePruneDegraded.add(s.id);
    await store.removeSchedule(s.id);
    assert.equal(sets.scheduleRegistryDegraded.has(s.id), false, "registry marker dropped");
    assert.equal(sets.schedulePruneDegraded.has(s.id), false, "prune marker dropped");
  } finally {
    await store.close();
    await t.cleanup();
  }

  // P3-8: a hand-edited registry with garbage keepRuns drops it (no silent
  // arming via clamp) — create/patch reject these values at the API.
  const { ScheduleRegistry } = await import("../src/schedules.js");
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "r12-parse-"));
  try {
    await writeFile(
      join(dir, "schedules.json"),
      JSON.stringify({
        version: 1,
        schedules: [{ id: "sch_junk", name: "j", cwd: "/x", model: { provider: "faux", modelId: "echo" }, prompt: "p", everyMinutes: 5, keepRuns: -5 }],
      }),
    );
    const reg = await ScheduleRegistry.open(join(dir, "schedules.json"));
    assert.equal(reg.get("sch_junk")?.keepRuns, undefined, "negative keepRuns is DROPPED, not clamped to 1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
