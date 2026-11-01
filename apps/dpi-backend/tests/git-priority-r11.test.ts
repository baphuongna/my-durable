/**
 * run-11 h2-2 (git spawn priority lane): r9's process-wide spawn budget is a
 * single FIFO — one 50-path /git/status-batch parks ~650 low spawns, and the
 * interactive op the user is LOOKING at (a bare /git/status poll, a
 * stage/commit/diff click through POST /git) queued behind ALL of them. The
 * fix is a second wake lane: acquireGitSpawn("high") callers are admitted
 * first when a slot frees (FIFO within each lane, low callers still never
 * refused, the per-op timeout still starts at child start). gitSpawnStats()
 * reports live/queued/queuedHigh for deviceVitals. This test drives the exec
 * seam directly: the budget is saturated with low spawns that answer only
 * when told, and the high lane (git(), bare gitStatus(), gitOp()) must start
 * before the earlier-queued lows.
 *
 * Note on shape: under saturation a status trickles its spawns (its first
 * await — the root rev-parse — must complete before the parallel batch), so
 * what the lane order guarantees is which caller's spawn runs on the NEXT
 * freed slot, not how many wait at once. The assertions below free exactly
 * one slot and read the admit order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  clearGitStatusCache,
  git,
  gitOp,
  gitSpawnStats,
  gitStatus,
  gitStatusBatch,
  GIT_SPAWN_BUDGET,
  setGitExecForTests,
} from "../src/git.js";
import { deviceVitals } from "../src/vitals.js";

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

test("h2-2: a high-priority spawn is admitted before earlier-queued low ones; gitSpawnStats counts the lanes", async () => {
  const started: string[] = [];
  const held: Array<{ cb: ExecCb }> = [];
  setGitExecForTests(
    asExecFile((_file, args, _opts, cb) => {
      started.push(args.join(" "));
      held.push({ cb });
      return { on() {}, kill() {} };
    }),
  );
  try {
    // Saturate: GIT_SPAWN_BUDGET low spawns, none answering — every further
    // caller must queue (never refuse, exactly like r9).
    const lows = Array.from({ length: GIT_SPAWN_BUDGET }, (_, i) => git("/repo", ["lo", String(i)]).catch(() => {}));
    await settle();
    assert.equal(started.length, GIT_SPAWN_BUDGET, "the budget is saturated with live spawns");
    assert.deepEqual(gitSpawnStats(), { live: GIT_SPAWN_BUDGET, queued: 0, queuedHigh: 0 });

    // Three more lows, then ONE high — the high arrived LAST, so a plain FIFO
    // would admit it after all three lows.
    const queuedLows = ["q1", "q2", "q3"].map((tag) => git("/repo", ["lo", tag]).catch(() => {}));
    const high = git("/repo", ["hi", "click"], undefined, undefined, "high").catch(() => {});
    await settle();
    assert.deepEqual(
      gitSpawnStats(),
      { live: GIT_SPAWN_BUDGET, queued: 4, queuedHigh: 1 },
      "3 low + 1 high wait behind the saturated budget",
    );
    assert.equal(started.length, GIT_SPAWN_BUDGET, "no queued caller has started yet");

    // Free ONE slot: the HIGH caller wakes first — not the earlier-queued lows.
    held.shift()!.cb(null, "", "");
    await settle();
    assert.equal(started.length, GIT_SPAWN_BUDGET + 1, "exactly one queued caller was admitted");
    assert.match(started.at(-1)!, /hi click$/, "the admitted caller is the HIGH one, not the older queued lows");
    assert.deepEqual(gitSpawnStats(), { live: GIT_SPAWN_BUDGET, queued: 3, queuedHigh: 0 });

    // Drain: every release wakes the next low in FIFO order until all settle,
    // and the semaphore returns to rest.
    for (let guard = 0; held.length > 0 && guard < 100; guard++) {
      held.shift()!.cb(null, "", "");
      await settle();
    }
    await Promise.all([...lows, ...queuedLows, high]);
    assert.deepEqual(gitSpawnStats(), { live: 0, queued: 0, queuedHigh: 0 }, "the semaphore fully drains");
  } finally {
    await teardownHeld(held);
    setGitExecForTests(); // real execFile before anything else in this process
  }
});

/** Answers every subcommand gitStatus() asks for, argv-keyed (r9's map):
 *  unknown calls FAIL loudly so a new spawn site shows up red, not silent. */
const statusReply = (args: string[]): { stdout: string } | { fail: string } => {
  const p = args[1] ?? ".";
  const sub = args.slice(2).join(" ");
  if (sub === "rev-parse --show-toplevel") return { stdout: p };
  if (sub === "rev-parse --absolute-git-dir") return { stdout: `${p}/.git` };
  if (sub === "rev-parse --git-dir") return { stdout: ".git" };
  if (sub === "rev-parse -q --verify MERGE_HEAD") return { fail: "exit 1: no merge in progress" };
  if (sub === "branch --show-current") return { stdout: "main" };
  if (sub === "log -1 --pretty=%h%x09%s") return { stdout: "deadbee\tfake subject" };
  if (sub === "--no-optional-locks status --porcelain=v1 -z -b") return { stdout: "## main...origin/main" };
  if (sub === "worktree list --porcelain") return { stdout: `worktree ${p}\nHEAD 0123456789abcdef\nbranch refs/heads/main\n` };
  if (sub.startsWith("for-each-ref")) return { stdout: "main\torigin/main\t1" };
  if (sub.startsWith("--no-optional-locks diff --numstat")) return { stdout: "" };
  if (sub === "var GIT_AUTHOR_IDENT") return { stdout: "Test User <t@example.test> 1730000000 +0000" };
  if (sub === "remote get-url origin") return { stdout: "" };
  return { fail: `git-priority-r11 fake does not know: git ${sub}` };
};

test("h2-2: a bare gitStatus (the /git/status route shape) outruns a queued status-batch fan-out", async () => {
  const started: string[] = [];
  const held: Array<{ args: string[]; cb: ExecCb }> = [];
  setGitExecForTests(
    asExecFile((_file, args, _opts, cb) => {
      started.push(args.join(" "));
      held.push({ args, cb });
      return { on() {}, kill() {} };
    }),
  );
  try {
    clearGitStatusCache();
    // The fan-out saturator: budget-worth of held LOW spawns (the shape a
    // 50-path status-batch leaves behind on a big poll).
    const saturators = Array.from({ length: GIT_SPAWN_BUDGET }, (_, i) =>
      git("/fan", ["sat", String(i)]).catch(() => {}),
    );
    await settle();
    assert.equal(started.length, GIT_SPAWN_BUDGET, "the budget is saturated");

    // gitStatusBatch is LOW (r9 fan-out); the BARE gitStatus() call — exactly
    // what GET /v1/git/status does — is HIGH. Both queue behind the budget.
    const batch = gitStatusBatch(["/fan/x"]).catch(() => undefined);
    const single = gitStatus("/fan/y").catch(() => undefined);
    await settle();
    assert.ok(gitSpawnStats().queuedHigh >= 1, "the interactive status parked its spawns in the high lane");
    assert.ok(gitSpawnStats().queued >= 2, "the batch's spawns wait in the low lane too");

    // One freed slot: the interactive status runs FIRST, the batch stays put.
    held.shift()!.cb(null, "", "");
    await settle();
    assert.ok(started.filter((s) => s.includes("/fan/y")).length >= 1, "the interactive status was admitted");
    assert.equal(started.filter((s) => s.includes("/fan/x")).length, 0, "the status-batch fan-out stays queued");

    // Drain with real answers: BOTH callers must still get full statuses —
    // priority changes wake order only, never correctness.
    for (let guard = 0; held.length > 0 && guard < 200; guard++) {
      const next = held.shift()!;
      const r = statusReply(next.args);
      if ("fail" in r) next.cb(Object.assign(new Error(r.fail), { code: 1 }), "", r.fail);
      else next.cb(null, r.stdout, "");
      await settle();
    }
    const [batchMap, status] = await Promise.all([batch, single]);
    assert.ok(status && status.repo === true, "the interactive status completed");
    assert.equal(status!.branch, "main", "the interactive status parsed a full answer");
    const bx = batchMap?.["/fan/x"];
    assert.ok(bx && "repo" in bx && bx.repo === true, "the batch path still resolves a full status");
    assert.deepEqual(gitSpawnStats(), { live: 0, queued: 0, queuedHigh: 0 });
  } finally {
    await teardownHeld(held);
    setGitExecForTests();
    clearGitStatusCache();
  }
});

test("h2-2: a gitOp mutation (the POST /git shape) rides the high lane", async () => {
  const started: string[] = [];
  const held: Array<{ cb: ExecCb }> = [];
  setGitExecForTests(
    asExecFile((_file, args, _opts, cb) => {
      started.push(args.join(" "));
      held.push({ cb });
      return { on() {}, kill() {} };
    }),
  );
  try {
    const saturators = Array.from({ length: GIT_SPAWN_BUDGET }, (_, i) =>
      git("/mut", ["sat", String(i)]).catch(() => {}),
    );
    await settle();
    assert.equal(started.length, GIT_SPAWN_BUDGET, "the budget is saturated");
    // Two queued lows arrive BEFORE the mutation the user just clicked.
    const queuedLows = ["q1", "q2"].map((tag) => git("/mut", ["lo", tag]).catch(() => {}));
    const op = gitOp("/mut/z", "branch").catch(() => undefined); // one spawn: --no-pager branch -vv
    await settle();
    assert.equal(gitSpawnStats().queuedHigh, 1, "the mutation queued in the high lane");

    held.shift()!.cb(null, "", "");
    await settle();
    assert.equal(started.length, GIT_SPAWN_BUDGET + 1, "exactly one queued caller was admitted");
    assert.match(started.at(-1)!, /branch -vv$/, "the mutation's spawn was admitted first");

    for (let guard = 0; held.length > 0 && guard < 100; guard++) {
      held.shift()!.cb(null, "", "");
      await settle();
    }
    const out = await op; // the mutation resolves once its spawn is answered
    assert.equal(typeof out?.text, "string", "the mutation completed with a text answer");
    await Promise.all(queuedLows);
    await Promise.all(saturators);
    assert.deepEqual(gitSpawnStats(), { live: 0, queued: 0, queuedHigh: 0 });
  } finally {
    await teardownHeld(held);
    setGitExecForTests();
  }
});

test("h2-2: deviceVitals carries the git spawn semaphore counts", () => {
  const v = deviceVitals(process.cwd(), Date.now());
  assert.deepEqual(Object.keys(v.gitSpawns).sort(), ["live", "queued", "queuedHigh"], "the three counters surface");
  for (const n of [v.gitSpawns.live, v.gitSpawns.queued, v.gitSpawns.queuedHigh]) {
    assert.ok(Number.isInteger(n) && n >= 0, `counter ${n} is a non-negative integer`);
  }
});
