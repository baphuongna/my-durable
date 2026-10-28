/**
 * R10 Design B — GC dangling-ref sweep:
 *
 *   - registries clear exactly the removed refs and KEEP outcome history
 *     (schedules: lastOutcome/lastError stay, lastSessionId goes, retention
 *     ring entries go too — Design A interplay; graphs: TaskRunState.sessionId
 *     goes, status/error stay).
 *   - gcPlan's dry-run reports the referential cost (danglingRefs counts).
 *   - the daemon route /v1/gc/sweep-refs (device-LOCAL: NOT tunnel-allowlisted)
 *     sweeps via the in-memory registries and caps at 10k ids.
 *   - offline sweep takes the same advisory lock Store.open takes — a live
 *     daemon refuses with the typed error.
 *   - idempotent: sweeping twice clears nothing the second time.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempStore } from "./helpers.js";
import { danglingRefCounts, gcPlan } from "../src/gc.js";
import { ScheduleRegistry } from "../src/schedules.js";
import { GraphRegistry } from "../src/graphs.js";

const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER = "11111111-2222-3333-4444-555555555555";

test("ScheduleRegistry.clearSessionRefs: the link goes, history stays, ring entries drop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "r10-sch-"));
  try {
    const reg = await ScheduleRegistry.open(join(dir, "schedules.json"));
    const s = await reg.create({
      name: "sweep",
      cwd: "/tmp/x",
      model: { provider: "faux", modelId: "echo" },
      prompt: "p",
      everyMinutes: 5,
    });
    await reg.update(s.id, { keepRuns: 3 });
    await reg.markRun(s.id, { sessionId: SID, outcome: "failed", error: "boom" });

    const touched = await reg.clearSessionRefs(new Set([SID]));
    assert.equal(touched, 1, "one record touched");
    const after = (await reg.list()).find((x) => x.id === s.id)!;
    assert.equal(after.lastSessionId, undefined, "the link is gone");
    assert.equal(after.lastOutcome, "failed", "outcome history STAYS");
    assert.equal(after.lastError, "boom", "error history STAYS");
    assert.equal(after.recentSessionIds, undefined, "ring entry dropped");

    // A ref to a DIFFERENT session is untouched.
    await reg.markRun(s.id, { sessionId: OTHER, outcome: "ok" });
    await reg.clearSessionRefs(new Set([SID]));
    const kept = (await reg.list()).find((x) => x.id === s.id)!;
    assert.equal(kept.lastSessionId, OTHER, "unrelated refs untouched");

    // Idempotent.
    assert.equal(await reg.clearSessionRefs(new Set([OTHER, SID])), 1);
    assert.equal(await reg.clearSessionRefs(new Set([OTHER, SID])), 0, "second sweep clears nothing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GraphRegistry.clearSessionRefs: sessionId goes, status/error stay, idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "r10-gr-"));
  try {
    const reg = await GraphRegistry.open(join(dir, "graphs.json"));
    const g = await reg.create({
      name: "g",
      cwd: "/tmp/x",
      tasks: [{ id: "t1", name: "T1", prompt: "p", dependsOn: [] }],
    });
    // Seed a run with a session link: patchTask is the runtime seam — use the
    // registry's own run API if present; otherwise write through recordTaskRun.
    const seeded = (reg as unknown as {
      runRecords: Array<{ id: string; tasks: Record<string, { status: string; sessionId?: string; error?: string }> }>;
    }).runRecords;
    seeded.push({
      id: "run-1",
      graphId: g.id,
      startedAt: new Date().toISOString(),
      status: "failed",
      tasks: { t1: { status: "failed", sessionId: SID, error: "provider down" } },
    } as never);

    const cleared = await reg.clearSessionRefs(new Set([SID]));
    assert.equal(cleared, 1);
    const after = (
      reg as unknown as { runRecords: Array<{ tasks: Record<string, { sessionId?: string; error?: string }> }> }
    ).runRecords[0];
    assert.equal(after.tasks.t1.sessionId, undefined, "the link is gone");
    assert.equal(after.tasks.t1.error, "provider down", "error history STAYS");
    // R12 P3-7: the no-op sweep must not churn the registry file — bytes
    // unchanged after the second (idempotent) call.
    const { readFile } = await import("node:fs/promises");
    const before = await readFile(join(dir, "graphs.json"), "utf8");
    assert.equal(await reg.clearSessionRefs(new Set([SID])), 0, "idempotent");
    assert.equal(await readFile(join(dir, "graphs.json"), "utf8"), before, "no-op sweep does not rewrite graphs.json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gcPlan reports danglingRefs (the referential cost of --yes)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "r10-plan-"));
  const archiveDir = join(dir, "archive");
  await mkdir(archiveDir, { recursive: true });
  try {
    const now = Date.now();
    const old = now - 40 * 86_400_000; // 40d old → candidate at 30d cutoff
    await mkdir(join(archiveDir, `${SID}-${old}`));
    await mkdir(join(archiveDir, `${OTHER}-${now - 86_400_000}`)); // 1d old → kept
    await writeFile(
      join(dir, "schedules.json"),
      JSON.stringify({ version: 1, schedules: [{ id: "sch_1", lastSessionId: SID }] }),
    );
    await writeFile(
      join(dir, "graphs.json"),
      JSON.stringify({ version: 1, graphs: [], runs: [{ id: "r", tasks: { t: { status: "ok", sessionId: SID } } }] }),
    );

    const plan = await gcPlan(archiveDir, { closedBeforeDays: 30, now });
    assert.equal(plan.candidates.length, 1, "only the 40d-old bundle is a candidate");
    assert.deepEqual(plan.danglingRefs, { schedules: 1, graphRuns: 1 }, "the dry-run names the cost");

    assert.deepEqual(
      danglingRefCounts(dir, new Set([OTHER])),
      { schedules: 0, graphRuns: 0 },
      "a kept session's refs are not dangling",
    );
    // R12 P3-11: ring refs count too — the sweep clears them, so the dry-run
    // must not under-promise.
    await writeFile(
      join(dir, "schedules.json"),
      JSON.stringify({
        version: 1,
        schedules: [{ id: "sch_ring", keepRuns: 5, recentSessionIds: [SID] }],
      }),
    );
    assert.deepEqual(
      danglingRefCounts(dir, new Set([SID])),
      { schedules: 1, graphRuns: 1 },
      "a retention-ring entry counts as a dangling ref",
    );
    // R13 P3-2: a JUNK keepRuns (out of range) is dropped together with its ring
    // by the registry coercion — the sweep will never clear it, so the dry-run
    // must not promise it either.
    await writeFile(
      join(dir, "schedules.json"),
      JSON.stringify({
        version: 1,
        schedules: [{ id: "sch_junk", keepRuns: -5, recentSessionIds: [SID] }],
      }),
    );
    assert.deepEqual(
      danglingRefCounts(dir, new Set([SID])),
      { schedules: 0, graphRuns: 1 },
      "a doomed (junk keepRuns) ring is not counted",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("daemon route: /v1/gc/sweep-refs sweeps in-process, caps 10k, refuses junk", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const s = await store.schedules.create({
      name: "route",
      cwd: "project",
      model: { provider: "faux", modelId: "echo" },
      prompt: "p",
      everyMinutes: 5,
    });
    await store.schedules.markRun(s.id, { sessionId: SID, outcome: "ok" });

    const cleared = await store.gcSweepRefs([SID, "not-a-real-id", 42]);
    assert.deepEqual(cleared, { schedules: 1, graphRuns: 0 }, "junk entries are filtered, the real ref swept");

    await assert.rejects(() => store.gcSweepRefs("nope"), /sessionIds/);
    await assert.rejects(() => store.gcSweepRefs(new Array(10_001).fill(SID)), /10000/);
    // Idempotent through the route path too.
    assert.deepEqual(await store.gcSweepRefs([SID]), { schedules: 0, graphRuns: 0 });
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("the sweep route is NOT tunnel-allowlisted (device-local operator surface)", async () => {
  const routes = await import("../../dpi-sdk/src/protocol/rest-routes.js");
  const listed = routes.REST_ROUTE_ALLOWLIST.some(
    (r: { method: string; route: string }) => r.method === "POST" && r.route.includes("sweep-refs"),
  );
  assert.equal(listed, false, "sweep-refs must stay off the tunnel allowlist");
});
