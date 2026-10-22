// R-1 / M4 (specs/20261019-durable-agent-network: 00-vision M4, 08-testing 3.1 and 4.3).
//
// One parent monotonic clock. t0 is read immediately before SIGKILL and the device restarts at once. t1 is read when
// the local API shows the job's next checkpoint, committed by the restarted process. Kill, reap, spawn, startup,
// reopen, health wait, recovery and poll latency are all inside t1 - t0; health-ready is never t0.
//
// This is not part of `npm test`: node runs those files in parallel, and a busy machine would turn load into a
// recovery regression. `npm run test:timing` (and `verify --phase all`) run it alone. Every sample is reported,
// including the ones that fail and the ones taken before a failure. Set DPI_M4_REPORT to keep the JSON report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { DpiClient } from "../../../dpi-sdk/src/client.js";
import type { JobRunsDoc } from "../../../dpi-sdk/src/jobs.js";
import { bootServer, delay, faux, newToken, tempStore, until } from "../helpers.js";

/** The M4 target is "below", never "at most". */
const BUDGET_MS = 2000;
const SAMPLES = 5;
const CHECKS = SAMPLES + 3;
const INTERVAL_S = 2;
/**
 * change-watch checks every INTERVAL_S seconds. Killing once the checkpoint is this old leaves the next check due
 * before the device can be back, so t1 - t0 measures recovery and not the job's own wait.
 */
const KILL_AFTER_CHECKPOINT_MS = 1500;
const POLL_MS = 20;

type Sample = {
  sample: number;
  checkpointBefore: number;
  checkpointAfter: number;
  /** t0 to the killed process being reaped. */
  killMs: number;
  /** Wall clock (the device stamps commits with the same clock) when the killed process had been reaped: nothing it could write comes later. */
  reapedAt: number;
  /** When the device stamped the checkpoint that was observed after the restart. */
  committedAt: number;
  /** t0 to /healthz answering: the point earlier drafts of the metric wrongly started from. */
  healthMs: number;
  /** t0 to the durable post-restart checkpoint being observed. The metric. */
  t1Ms: number;
  /** Local API calls that failed between health-ready and the checkpoint showing up. */
  apiErrors: number;
};

test("R-1 / M4: a SIGKILLed device shows its job's next durable checkpoint in under 2 s, timed from before the kill", { timeout: 180_000 }, async () => {
  const t = await tempStore();
  const token = newToken();
  let server: Awaited<ReturnType<typeof bootServer>> | undefined;
  const samples: Sample[] = [];
  const loadBefore = os.loadavg();
  // Set only once every correctness assertion has held: a fast wrong answer must not be reported as a pass.
  let correct = false;
  try {
    server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token, healthPollMs: POLL_MS });
    const device = server;
    const client = new DpiClient(server.base, token);
    const s = await client.createSession({ name: "M4", cwd: t.work, model: faux });
    const main = client.agent(s.id, "main");
    const { taskId } = await main.demo<{ taskId: number }>("jobs", { job: "change-watch", input: { checks: CHECKS, interval_seconds: INTERVAL_S } });
    const run = async () => (await main.doc<JobRunsDoc>("demo.job-runs")).value.items[taskId];
    const snapshot = async () => {
      const r = await run();
      return { done: r?.phases[1].progress?.done ?? 0, committedAt: r?.updatedAt ?? 0 };
    };
    const observe = async (reached: (done: number) => boolean, timeoutMs: number, what: string) => {
      const end = performance.now() + timeoutMs;
      let errors = 0;
      for (;;) {
        try {
          const now = await snapshot();
          if (reached(now.done)) return { ...now, at: performance.now(), errors };
        } catch {
          errors++;
        }
        if (performance.now() > end) throw Error(`Timed out waiting for ${what}`);
        await delay(POLL_MS);
      }
    };

    let seen = await observe((n) => n >= 1, 15_000, "the first check");
    for (let sample = 1; sample <= SAMPLES; sample++) {
      // Wait out the checkpoint's age (the device stamps the commit), not the time since it was noticed: after a slow
      // restart the two differ. A later check landing first only moves the kill to the next checkpoint.
      let before = seen;
      for (;;) {
        await delay(Math.max(0, KILL_AFTER_CHECKPOINT_MS - (Date.now() - before.committedAt)));
        const now = await snapshot();
        if (now.done === before.done) break;
        before = { ...now, at: performance.now(), errors: 0 };
      }
      const t0 = performance.now();
      await device.stop("SIGKILL");
      const killed = performance.now();
      const reapedAt = Date.now();
      await device.start();
      const healthy = performance.now();
      seen = await observe((n) => n > before.done, 30_000, "durable progress after the restart");
      samples.push({
        sample,
        checkpointBefore: before.done,
        checkpointAfter: seen.done,
        killMs: Math.round(killed - t0),
        reapedAt,
        committedAt: seen.committedAt,
        healthMs: Math.round(healthy - t0),
        t1Ms: Math.round(seen.at - t0),
        apiErrors: seen.errors,
      });
    }
    await until(async () => (await run())?.status === "completed", 30_000, "completion after the last restart");

    // Correctness first: a fast wrong answer is not a pass.
    for (const x of samples) {
      assert.equal(x.checkpointAfter, x.checkpointBefore + 1, `sample ${x.sample}: resumed at the committed checkpoint, not earlier and not later`);
      assert.ok(x.killMs > 0 && x.killMs <= x.healthMs && x.healthMs <= x.t1Ms, `sample ${x.sample}: the clocks nest (kill, health, progress)`);
      assert.ok(x.committedAt > x.reapedAt, `sample ${x.sample}: the observed checkpoint was stamped ${x.committedAt - x.reapedAt} ms before the killed process was reaped, so the restarted device did not write it`);
    }
    const done = await run();
    assert.deepEqual(done.phases.map((p) => p.status), ["done", "done", "done"]);
    assert.deepEqual(
      done.phases[1].steps.filter((step) => step.kind === "checkpoint" && step.status === "done").map((step) => step.label),
      Array.from({ length: CHECKS }, (_, i) => `Check ${i + 1}/${CHECKS}`),
      "one checkpoint per check: none repeated by a restart, none skipped",
    );
    assert.equal((await main.entries({ scope: "all" })).items.filter((e) => e.kind === "demo.job").length, 1);
    const shared = await client.deviceDoc<{ jobs: Record<string, { run: number; checks: number }> }>("app.shared-state");
    assert.equal(shared.value.jobs["change-watch"]?.run, 1, "the report was saved once");
    assert.equal(shared.value.jobs["change-watch"]?.checks, CHECKS);
    correct = true;

    const over = samples.filter((x) => !(x.t1Ms < BUDGET_MS));
    assert.deepEqual(over, [], `M4: t1 - t0 must stay under ${BUDGET_MS} ms for every sample; got ${samples.map((x) => x.t1Ms).join(", ")}`);
  } finally {
    const cpus = os.cpus();
    const timely = samples.length === SAMPLES && samples.every((x) => x.t1Ms < BUDGET_MS);
    const report = {
      metric: "M4",
      requirement: "R-1",
      pass: "every correctness assertion held, all samples taken, and every one with t1 - t0 < budgetMs (strict)",
      budgetMs: BUDGET_MS,
      correct,
      timely,
      result: correct && timely ? "pass" : "fail",
      boundary: "t0 immediately before SIGKILL; restart immediately; t1 = restarted process's next checkpoint seen through the local API",
      fixture: { job: "change-watch", checks: CHECKS, intervalSeconds: INTERVAL_S, killAfterCheckpointMs: KILL_AFTER_CHECKPOINT_MS, signal: "SIGKILL", provider: "faux" },
      pollMs: { health: POLL_MS, progress: POLL_MS },
      pollIntervalMs: POLL_MS,
      environment: {
        node: process.version,
        platform: os.platform(),
        arch: os.arch(),
        osRelease: os.release(),
        os: `${os.platform()} ${os.release()} ${os.arch()}`,
        cpuModel: cpus[0]?.model ?? "unknown",
        cpuCount: cpus.length,
        cpu: `${cpus[0]?.model ?? "unknown"} x${cpus.length}`,
        memoryMiB: Math.round(os.totalmem() / 2 ** 20),
        loadavgBefore: loadBefore.map((n) => Math.round(n * 100) / 100),
        loadavgAfter: os.loadavg().map((n) => Math.round(n * 100) / 100),
      },
      samples,
    };
    // Recovery is CPU-bound (process start, module load); the load figure tells a reader whether a slow sample means a slow host.
    console.log(
      `M4 R-1 ${report.result}: ${samples.length}/${SAMPLES} samples (ms from before SIGKILL): ${samples.map((x) => x.t1Ms).join(" ")}; host load ${loadBefore[0]!.toFixed(2)} on ${cpus.length} CPUs before the first sample`,
    );
    console.log(`M4 R-1 report ${JSON.stringify(report)}`);
    if (process.env.DPI_M4_REPORT) {
      await mkdir(dirname(process.env.DPI_M4_REPORT), { recursive: true });
      await writeFile(process.env.DPI_M4_REPORT, `${JSON.stringify(report, null, 2)}\n`);
    }
    try {
      await server?.stop();
    } finally {
      await t.cleanup();
    }
  }
});
