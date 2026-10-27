/**
 * `boundedStep` — the shutdown sequencing primitive (R6 cli finding 10).
 *
 * `dpi device stop` hung twice at teardown (40s+, zero output, device stayed
 * healthy). main.ts now races every shutdown step through boundedStep:
 *   - a step that settles in time returns/rejects normally;
 *   - a step that never settles is ABANDONED after the ceiling, with a log
 *     line, so server.close()/process.exit still happen;
 *   - a hanging step that rejects later must not become an unhandled rejection.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedStep, cleanChildEnv } from "../src/daemon.js";

test("a fast step resolves with its value", async () => {
  const logs: string[] = [];
  const v = await boundedStep("fast", 1_000, () => 42, (l) => logs.push(l));
  assert.equal(v, 42);
  assert.deepEqual(logs, []);
});

test("an async step that resolves in time returns its value", async () => {
  const v = await boundedStep("slow-ok", 500, () => new Promise<string>((r) => setTimeout(() => r("done"), 20)));
  assert.equal(v, "done");
});

test("a step that NEVER settles is abandoned at the ceiling, with a log line", async () => {
  const logs: string[] = [];
  const started = Date.now();
  const v = await boundedStep(
    "wedged",
    40,
    () => new Promise<string>(() => {}), // never settles
    (l) => logs.push(l),
  );
  assert.equal(v, undefined, "abandoned steps yield undefined");
  assert.ok(Date.now() - started < 2_000, "bounded by the ceiling, not the step");
  assert.deepEqual(logs, ["shutdown: wedged did not finish within 40ms — continuing without it"]);
});

test("a step that THROWS rejects (errors are not swallowed)", async () => {
  await assert.rejects(
    boundedStep("boom", 1_000, () => {
      throw new Error("connector exploded");
    }),
    /connector exploded/,
  );
  await assert.rejects(
    boundedStep("boom-async", 1_000, () => Promise.reject(new Error("async boom"))),
    /async boom/,
  );
});

test("a step abandoned at the ceiling that REJECTS later is not an unhandled rejection", async () => {
  const logs: string[] = [];
  const late = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("late")), 80));
  const v = await boundedStep("late-fail", 10, () => late, (l) => logs.push(l));
  assert.equal(v, undefined, "abandoned at the ceiling");
  // give the late rejection time to land; the process-level handler above
  // (installed by the test runner) would fail the suite if it were unhandled.
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(logs.length, 1);
});

test("a step resolving undefined in time is NOT mistaken for a hang", async () => {
  const logs: string[] = [];
  const v = await boundedStep("legit-undefined", 1_000, () => Promise.resolve(undefined), (l) => logs.push(l));
  assert.equal(v, undefined);
  assert.deepEqual(logs, [], "no bound log — it settled");
});

test("cleanChildEnv strips the launcher's wrapper marker — a detached daemon must not inherit the 2s orphan-watch", () => {
  const env = { DPI_HOME: "/tmp/x", DPI_WRAPPER_PID: "12345", DPI_WARNINGS_QUIETED: "1", PATH: "/usr/bin" };
  const out = cleanChildEnv(env);
  assert.equal(out.DPI_WRAPPER_PID, undefined, "the detached daemon must never watch a short-lived wrapper pid");
  assert.equal(out.DPI_WARNINGS_QUIETED, "1", "warning suppression survives (name-form flag, not pid-scoped)");
  assert.equal(out.DPI_HOME, "/tmp/x");
});
