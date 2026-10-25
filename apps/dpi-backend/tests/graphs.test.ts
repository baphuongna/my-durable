/**
 * Wave 3 of docs/host-project-checklist.md: the device-side task-graph registry
 * ("Task-graph orchestration"). The file is the contract the device loop reads,
 * so every test that mutates also looks at the bytes on disk — a registry that
 * only remembers in RAM would run nothing after a restart. The pure planning
 * helpers (`topoOrder`/`readyTasks`/`cascadeSkips`/`runComplete`) are tested
 * with no fs at all, because the store will lean on them on every tick.
 *
 * The clock is injected (`now: () => string`, ISO) so run ids, eviction order
 * and recovery stamps are asserted instead of slept through.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GraphError,
  GraphRegistry,
  MAX_TASKS,
  MAX_TASK_PROMPT_LENGTH,
  cascadeSkips,
  migrate,
  newGraphId,
  newRunId,
  normaliseGraphCwd,
  readyTasks,
  runComplete,
  topoOrder,
  type GraphTask,
  type TaskRunState,
  type TaskRunStatus,
} from "../src/graphs.js";

const mode = (path: string) => stat(path).then((stats) => stats.mode & 0o777);

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "dpi-graphs-"));
  const dataDir = join(root, "data");
  return {
    root,
    dataDir,
    file: join(dataDir, "graphs.json"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** A settable ISO clock, so a test can walk a run through an afternoon in a few lines. */
function clockAt(start: number) {
  const state = { now: start };
  return {
    now: () => new Date(state.now).toISOString(),
    set: (value: number) => {
      state.now = value;
    },
    advance: (ms: number) => {
      state.now += ms;
    },
  };
}

/** `open` with the warnings captured, so recovery is asserted instead of printed. */
function openWith(file: string, warnings: string[] = [], clock?: { now: () => string }) {
  return GraphRegistry.open(file, {
    warn: (message) => warnings.push(message),
    ...(clock ? { now: clock.now } : {}),
  });
}

const readFileJson = async (file: string) => JSON.parse(await readFile(file, "utf8"));

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 0, 15, 9, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

/** install → build → (ship | report): enough shape for every planning case. */
const baseTasks = (): GraphTask[] => [
  { id: "install", name: "Install deps", prompt: "Run npm install.", dependsOn: [] },
  { id: "build", name: "Build", prompt: "Run npm run build.", dependsOn: ["install"] },
  { id: "ship", name: "Ship", prompt: "Publish the build.", dependsOn: ["build"] },
];

const baseGraph = (overrides: Record<string, unknown> = {}) => ({
  name: "Release flow",
  cwd: "/srv/app",
  tasks: baseTasks(),
  ...overrides,
});

/** a→b→c→a, the classic ring the cycle error must name. */
const ringTasks = (): GraphTask[] => [
  { id: "a", name: "A", prompt: "a", dependsOn: ["b"] },
  { id: "b", name: "B", prompt: "b", dependsOn: ["c"] },
  { id: "c", name: "C", prompt: "c", dependsOn: ["a"] },
];

test("create/list/get round-trips through the file, and ids are grp_<10 hex>", async () => {
  const s = await scratch();
  try {
    const clock = clockAt(T0);
    const registry = await openWith(s.file, [], clock);
    const release = await registry.create(baseGraph());

    assert.match(release.id, /^grp_[0-9a-f]{10}$/);
    assert.equal(release.name, "Release flow");
    assert.equal(release.cwd, "/srv/app");
    assert.equal(release.tasks.length, 3);
    assert.deepEqual(release.tasks[1].dependsOn, ["install"]);
    assert.equal(release.createdAt, iso(T0));
    assert.equal(release.updatedAt, iso(T0));
    assert.equal(release.archivedAt, null);

    clock.advance(MINUTE);
    const other = await registry.create(baseGraph({ name: "Audit sweep", cwd: "/srv/other" }));
    assert.equal(other.createdAt, iso(T0 + MINUTE));
    assert.deepEqual(
      registry.list().map((record) => record.name),
      ["Audit sweep", "Release flow"],
      "list is sorted by the name a human reads",
    );
    assert.equal(registry.get(release.id)?.id, release.id);
    assert.equal(registry.get("grp_0000000000"), undefined);

    const onDisk = await readFileJson(s.file);
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.graphs.length, 2);
    assert.deepEqual(onDisk.runs, [], "a fresh registry has no runs");

    // A reopen reads the graphs back rather than minting new ids.
    const reopened = await openWith(s.file, [], clock);
    assert.deepEqual(
      reopened.list().map((record) => record.id),
      [other.id, release.id],
    );

    assert.equal(await registry.remove(release.id), true);
    assert.equal(await registry.remove(release.id), false, "removing a missing graph is a no-op");
    assert.deepEqual((await readFileJson(s.file)).graphs.map((record: { id: string }) => record.id), [other.id]);

    await assert.rejects(
      () => registry.update("grp_0000000000", { name: "ghost" }),
      (error: unknown) => error instanceof GraphError && error.code === "not_found",
    );
  } finally {
    await s.cleanup();
  }
});

test("name and cwd are validated, and the human-typed cwd is kept", async () => {
  const s = await scratch();
  try {
    const registry = await openWith(s.file, [], clockAt(T0));
    await assert.rejects(() => registry.create(baseGraph({ name: "   " })), /name is required/);
    await assert.rejects(() => registry.create(baseGraph({ name: "x".repeat(81) })), /the limit is 80/);
    await assert.rejects(() => registry.create(baseGraph({ cwd: " " })), /cwd is required/);

    // Home and relative paths stay as typed (the device resolves them); absolute
    // paths are normalised; a trailing separator never makes two spellings.
    const home = await registry.create(baseGraph({ name: "home", cwd: "~/work" }));
    assert.equal(home.cwd, "~/work");
    const relative = await registry.create(baseGraph({ name: "relative", cwd: "src/app/" }));
    assert.equal(relative.cwd, "src/app");
    const absolute = await registry.create(baseGraph({ name: "absolute", cwd: "/srv/app/" }));
    assert.equal(absolute.cwd, "/srv/app");
    assert.equal(normaliseGraphCwd("~"), "~");
  } finally {
    await s.cleanup();
  }
});

test("task ids are slugs, unique, and 1–32 tasks are allowed", async () => {
  const s = await scratch();
  try {
    const registry = await openWith(s.file, [], clockAt(T0));
    const withIds = (...ids: string[]) => registry.create(baseGraph({ tasks: ids.map((id) => ({ id, name: `Task ${id}`, prompt: "go", dependsOn: [] })) }));

    await assert.rejects(() => withIds("Build"), /lowercase slug/);
    await assert.rejects(() => withIds("-build"), /lowercase slug/, "no leading punctuation");
    await assert.rejects(() => withIds("a".repeat(33)), /lowercase slug/, "≤32 characters");
    await assert.rejects(() => withIds("ok", "ok"), /is used twice/);
    await assert.rejects(() => registry.create(baseGraph({ tasks: [] })), /1–32 tasks, got 0/);
    const chainOf = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `task-${String(i).padStart(2, "0")}`,
        name: `Task ${i}`,
        prompt: "go",
        dependsOn: i === 0 ? [] : [`task-${String(i - 1).padStart(2, "0")}`],
      }));
    await assert.rejects(() => registry.create(baseGraph({ tasks: chainOf(MAX_TASKS + 1) })), /1–32 tasks, got 33/);
    const capped = await registry.create(baseGraph({ tasks: chainOf(MAX_TASKS) }));
    assert.equal(capped.tasks.length, MAX_TASKS, "the boundary is allowed");
    assert.deepEqual(topoOrder(capped.tasks), capped.tasks.map((task) => task.id), "a chain orders depth-first");
  } finally {
    await s.cleanup();
  }
});

test("task names, prompts and models are validated", async () => {
  const s = await scratch();
  try {
    const registry = await openWith(s.file, [], clockAt(T0));
    const task = (over: Record<string, unknown>) => [{ ...baseTasks()[0], ...over }];
    await assert.rejects(() => registry.create(baseGraph({ tasks: task({ name: "  " }) })), /task "install" needs a name/);
    await assert.rejects(() => registry.create(baseGraph({ tasks: task({ name: "x".repeat(81) }) })), /the limit is 80/);
    await assert.rejects(() => registry.create(baseGraph({ tasks: task({ prompt: "" }) })), /needs a prompt/);
    await assert.rejects(() => registry.create(baseGraph({ tasks: task({ prompt: " ".repeat(10) }) })), /needs a prompt/);
    await assert.rejects(
      () => registry.create(baseGraph({ tasks: task({ prompt: "x".repeat(MAX_TASK_PROMPT_LENGTH + 1) }) })),
      /the limit is 20000/,
    );
    await assert.rejects(() => registry.create(baseGraph({ tasks: task({ model: "zai/glm" }) })), /model must be/);
    await assert.rejects(() => registry.create(baseGraph({ tasks: task({ model: { provider: "zai" } }) })), /modelId/);
    const withModel = await registry.create(
      baseGraph({ tasks: task({ model: { provider: "zai", modelId: "glm-4.7" } }) }),
    );
    assert.deepEqual(withModel.tasks[0].model, { provider: "zai", modelId: "glm-4.7" });
    assert.equal(registry.list().length, 1, "only the valid graph landed");
  } finally {
    await s.cleanup();
  }
});

test("dependsOn: unknown, self-reference and duplicate deps are refused", async () => {
  const s = await scratch();
  try {
    const registry = await openWith(s.file, [], clockAt(T0));
    await assert.rejects(
      () => registry.create(baseGraph({ tasks: [{ id: "a", name: "A", prompt: "a", dependsOn: ["ghost"] }] })),
      /task "a" depends on unknown task "ghost"/,
    );
    await assert.rejects(
      () => registry.create(baseGraph({ tasks: [{ id: "a", name: "A", prompt: "a", dependsOn: ["a"] }] })),
      /cannot depend on itself/,
    );
    await assert.rejects(
      () =>
        registry.create(
          baseGraph({
            tasks: [
              { id: "a", name: "A", prompt: "a", dependsOn: [] },
              { id: "b", name: "B", prompt: "b", dependsOn: ["a", "a"] },
            ],
          }),
        ),
      /lists dependency "a" twice/,
    );
    await assert.rejects(
      () =>
        registry.create(
          baseGraph({
            tasks: [
              { id: "a", name: "A", prompt: "a", dependsOn: [] },
              { id: "b", name: "B", prompt: "b", dependsOn: "a" as never },
            ],
          }),
        ),
      /dependsOn must be a list/,
    );
    assert.deepEqual(registry.list(), [], "nothing was stored by the rejected calls");
  } finally {
    await s.cleanup();
  }
});

test("a cycle is refused, naming the tasks stuck in the ring (a→b→c→a)", async () => {
  const s = await scratch();
  try {
    const registry = await openWith(s.file, [], clockAt(T0));
    await assert.rejects(
      () => registry.create(baseGraph({ tasks: ringTasks() })),
      (error: unknown) =>
        error instanceof GraphError &&
        error.code === "invalid" &&
        error.message.includes("a") &&
        error.message.includes("b") &&
        error.message.includes("c") &&
        error.message.includes("the graph has a cycle (a → b → c → a)"),
      "the ring is named in the message",
    );
    // A cycle downstream of a good task is still a cycle.
    await assert.rejects(
      () =>
        registry.create(
          baseGraph({
            tasks: [
              { id: "root", name: "Root", prompt: "r", dependsOn: [] },
              ...ringTasks().map((task) => ({ ...task, dependsOn: [...task.dependsOn] })),
            ],
          }),
        ),
      /the graph has a cycle/,
    );
    assert.deepEqual(registry.list(), []);
    assert.throws(() => topoOrder(ringTasks()), /the graph has a cycle/);
    assert.throws(
      () => topoOrder([{ id: "a", name: "A", prompt: "a", dependsOn: ["ghost"] }]),
      /depends on unknown task "ghost"/,
    );
  } finally {
    await s.cleanup();
  }
});

test("topoOrder places dependencies first and is deterministic", () => {
  const tasks: GraphTask[] = [
    { id: "b", name: "B", prompt: "b", dependsOn: ["c"] },
    { id: "a", name: "A", prompt: "a", dependsOn: ["b"] },
    { id: "d", name: "D", prompt: "d", dependsOn: [] },
    { id: "c", name: "C", prompt: "c", dependsOn: [] },
  ];
  const order = topoOrder(tasks);
  assert.deepEqual(order, ["c", "b", "a", "d"], "smallest ready id first, dependencies always placed");
  assert.ok(order.indexOf("c") < order.indexOf("b"), "c before the task that needs it");
  assert.ok(order.indexOf("b") < order.indexOf("a"));
  assert.deepEqual(topoOrder(tasks), order, "same input, same order");
  // A diamond (a ← b, a ← c, b+c ← d) has several valid orders; ours is one of them.
  const diamond: GraphTask[] = [
    { id: "a", name: "A", prompt: "a", dependsOn: [] },
    { id: "b", name: "B", prompt: "b", dependsOn: ["a"] },
    { id: "c", name: "C", prompt: "c", dependsOn: ["a"] },
    { id: "d", name: "D", prompt: "d", dependsOn: ["b", "c"] },
  ];
  const diamondOrder = topoOrder(diamond);
  assert.ok(diamondOrder.indexOf("a") < diamondOrder.indexOf("b"));
  assert.ok(diamondOrder.indexOf("b") < diamondOrder.indexOf("d"));
  assert.ok(diamondOrder.indexOf("c") < diamondOrder.indexOf("d"));
});

test("readyTasks: roots only, then dependents after ok, never after failed/running", () => {
  const tasks = baseTasks(); // install ← build ← ship
  const pending: Record<string, { status: "pending" }> = {
    install: { status: "pending" },
    build: { status: "pending" },
    ship: { status: "pending" },
  };
  assert.deepEqual(readyTasks(tasks, pending), ["install"], "only the root is ready");

  const afterInstallOk = { ...pending, install: { status: "ok" as const } };
  assert.deepEqual(readyTasks(tasks, afterInstallOk), ["build"]);
  assert.deepEqual(readyTasks(tasks, { ...afterInstallOk, build: { status: "ok" as const } }), ["ship"]);
  assert.deepEqual(
    readyTasks(tasks, { ...afterInstallOk, build: { status: "ok" as const }, ship: { status: "ok" as const } }),
    [],
    "nothing waits once every task finished",
  );
  assert.deepEqual(readyTasks(tasks, { ...pending, install: { status: "failed" as const } }), [], "a failed dep blocks");
  assert.deepEqual(readyTasks(tasks, { ...pending, install: { status: "running" as const } }), [], "a running dep is not ok yet");
  assert.deepEqual(readyTasks(tasks, {}), [], "a task with no run state is not picked");

  // Mixed roots: two independent roots are both ready, in task-list order.
  const mixed: GraphTask[] = [
    { id: "lint", name: "Lint", prompt: "l", dependsOn: [] },
    { id: "install", name: "Install", prompt: "i", dependsOn: [] },
    { id: "build", name: "Build", prompt: "b", dependsOn: ["install"] },
  ];
  assert.deepEqual(
    readyTasks(mixed, { lint: { status: "pending" }, install: { status: "pending" }, build: { status: "pending" } }),
    ["lint", "install"],
  );
});

test("cascadeSkips recurses past one hop and leaves an unrelated branch untouched", () => {
  const tasks: GraphTask[] = [
    { id: "a", name: "A", prompt: "a", dependsOn: [] },
    { id: "b", name: "B", prompt: "b", dependsOn: ["a"] },
    { id: "c", name: "C", prompt: "c", dependsOn: ["b"] },
    { id: "x", name: "X", prompt: "x", dependsOn: [] },
    { id: "y", name: "Y", prompt: "y", dependsOn: ["x"] },
  ];
  const runs: Record<string, { status: "pending" | "failed" | "skipped" }> = {
    a: { status: "failed" },
    b: { status: "pending" },
    c: { status: "pending" },
    x: { status: "pending" },
    y: { status: "pending" },
  };
  const skipped = cascadeSkips(tasks, runs);
  assert.deepEqual(skipped, ["b", "c"], "b is skipped for a, c for b — in causal order");
  assert.equal(runs.b.status, "skipped");
  assert.equal(runs.c.status, "skipped");
  assert.equal(runs.x.status, "pending", "the unrelated root is untouched");
  assert.equal(runs.y.status, "pending", "and so is its child");
  assert.deepEqual(cascadeSkips(tasks, runs), [], "a second pass reports nothing new");

  // A pending dep still has hope: its dependents are neither skipped nor ready.
  const hopeful: Record<string, { status: "pending" }> = { a: { status: "pending" }, b: { status: "pending" } };
  assert.deepEqual(cascadeSkips([tasks[0], tasks[1]], hopeful), []);
  // A skipped dep cascades exactly like a failed one.
  const runs2: Record<string, { status: "pending" | "skipped" }> = {
    a: { status: "skipped" },
    b: { status: "pending" },
    c: { status: "pending" },
    x: { status: "pending" },
    y: { status: "pending" },
  };
  assert.deepEqual(cascadeSkips(tasks, runs2), ["b", "c"]);
});

test("runComplete: terminal when nothing is pending or running", () => {
  const all = (status: TaskRunStatus): Record<string, TaskRunState> => ({
    a: { status },
    b: { status },
  });
  assert.equal(runComplete(all("ok")), true);
  assert.equal(runComplete({ a: { status: "ok" }, b: { status: "failed" } }), true);
  assert.equal(runComplete(all("skipped")), true);
  assert.equal(runComplete({ a: { status: "ok" }, b: { status: "pending" } }), false);
  assert.equal(runComplete({ a: { status: "ok" }, b: { status: "running" } }), false);
  assert.equal(runComplete({}), true, "an empty record is vacuously complete");
});

test("beginRun snapshots every task pending and keeps at most 20 runs per graph", async () => {
  const s = await scratch();
  try {
    const clock = clockAt(T0);
    const registry = await openWith(s.file, [], clock);
    const graph = await registry.create(baseGraph());
    const other = await registry.create(baseGraph({ name: "Other" }));

    const run = await registry.beginRun(graph.id);
    assert.match(run.id, /^run_\d+_[0-9a-f]{4}$/);
    assert.equal(run.graphId, graph.id);
    assert.equal(run.status, "running");
    assert.equal(run.startedAt, iso(T0));
    assert.equal(run.finishedAt, null);
    assert.deepEqual(
      Object.keys(run.tasks),
      ["install", "build", "ship"],
      "every task has an entry from run start",
    );
    assert.deepEqual(
      Object.values(run.tasks).map((state) => state.status),
      ["pending", "pending", "pending"],
    );
    assert.deepEqual(registry.lastRun(graph.id)?.id, run.id);

    // 20 more runs (each on its own tick so eviction order is deterministic).
    for (let i = 0; i < 20; i += 1) {
      clock.advance(MINUTE);
      await registry.beginRun(graph.id);
    }
    assert.equal(registry.runs(graph.id).length, 20, "the 21st run evicted the oldest");
    assert.ok(
      !registry.runs(graph.id).some((entry) => entry.id === run.id),
      "the very first run is the one dropped",
    );
    const listed = registry.runs(graph.id);
    assert.ok(listed[0].startedAt >= listed[listed.length - 1].startedAt, "newest first");
    assert.equal(registry.runs(other.id).length, 0, "eviction never touches another graph's history");
    assert.equal((await readFileJson(s.file)).runs.length, 20, "the eviction is durable");

    await assert.rejects(
      () => registry.beginRun("grp_0000000000"),
      (error: unknown) => error instanceof GraphError && error.code === "not_found",
    );
  } finally {
    await s.cleanup();
  }
});

test("markTask: ok marks flow downstream, and a fully-ok run closes as ok", async () => {
  const s = await scratch();
  try {
    const clock = clockAt(T0);
    const registry = await openWith(s.file, [], clock);
    const graph = await registry.create(baseGraph());
    const run = await registry.beginRun(graph.id);

    clock.advance(MINUTE);
    const started = await registry.markTask(graph.id, run.id, "install", { status: "running", sessionId: "ses_1" });
    assert.equal(started.tasks.install.startedAt, iso(T0 + MINUTE), "going running stamps startedAt");
    assert.equal(started.tasks.install.sessionId, "ses_1");
    assert.equal(started.status, "running");

    clock.advance(MINUTE);
    const done = await registry.markTask(graph.id, run.id, "install", { status: "ok" });
    assert.equal(done.tasks.install.endedAt, iso(T0 + 2 * MINUTE), "a terminal status stamps endedAt");
    assert.deepEqual(readyTasks(graph.tasks, done.tasks), ["build"], "the next task became ready");

    clock.advance(MINUTE);
    await registry.markTask(graph.id, run.id, "build", { status: "ok", sessionId: "ses_2" });
    clock.advance(MINUTE);
    const last = await registry.markTask(graph.id, run.id, "ship", { status: "ok", sessionId: "ses_3" });
    assert.equal(last.status, "ok", "every task reached ok → the run is ok");
    assert.equal(last.finishedAt, iso(T0 + 4 * MINUTE));
    assert.equal(registry.lastRun(graph.id)?.status, "ok");

    // Not-found / unknown-task guards.
    await assert.rejects(
      () => registry.markTask(graph.id, "run_nope", "install", { status: "ok" }),
      (error: unknown) => error instanceof GraphError && error.code === "not_found",
    );
    await assert.rejects(
      () => registry.markTask("grp_0000000000", run.id, "install", { status: "ok" }),
      (error: unknown) => error instanceof GraphError && error.code === "not_found",
    );
    await assert.rejects(
      () => registry.markTask(graph.id, run.id, "ghost", { status: "ok" }),
      /has no task ghost/,
    );
    await assert.rejects(
      () => registry.markTask(graph.id, run.id, "install", { status: "maybe" as never }),
      /unknown task status/,
    );
  } finally {
    await s.cleanup();
  }
});

test("a failure cascades skips, and any failed OR skipped task closes the run as failed", async () => {
  const s = await scratch();
  try {
    const clock = clockAt(T0);
    const registry = await openWith(s.file, [], clock);
    const tasks: GraphTask[] = [
      { id: "a", name: "A", prompt: "a", dependsOn: [] },
      { id: "b", name: "B", prompt: "b", dependsOn: ["a"] },
      { id: "r", name: "Root", prompt: "r", dependsOn: [] },
    ];
    const graph = await registry.create(baseGraph({ tasks, name: "Mixed" }));
    const run = await registry.beginRun(graph.id);

    const afterFailure = await registry.markTask(graph.id, run.id, "a", {
      status: "failed",
      error: "provider 500",
    });
    assert.equal(afterFailure.tasks.a.status, "failed");
    assert.equal(afterFailure.tasks.b.status, "skipped", "the dependent was skipped by the cascade");
    assert.ok(afterFailure.tasks.b.endedAt, "a skipped task is terminal");
    assert.equal(afterFailure.tasks.r.status, "pending", "the unrelated root is untouched");
    assert.equal(afterFailure.status, "running", "work remains, so the run stays open");

    const closed = await registry.markTask(graph.id, run.id, "r", { status: "ok" });
    assert.equal(closed.status, "failed", "a skipped task counts as a failed outcome for the run");
    assert.ok(closed.finishedAt);

    // Even without a failure: skip-only runs are "failed" outcomes too.
    const skippedRun = await registry.beginRun(graph.id);
    await registry.markTask(graph.id, skippedRun.id, "a", { status: "failed", error: "x" });
    await registry.markTask(graph.id, skippedRun.id, "r", { status: "ok" });
    assert.equal(registry.lastRun(graph.id)?.status, "failed", "ok + skipped still fails the run");
  } finally {
    await s.cleanup();
  }
});

test("markTask truncates the error to 300 characters", async () => {
  const s = await scratch();
  try {
    const registry = await openWith(s.file, [], clockAt(T0));
    const graph = await registry.create(baseGraph({ tasks: [baseTasks()[0]] }));
    const run = await registry.beginRun(graph.id);
    const marked = await registry.markTask(graph.id, run.id, "install", {
      status: "failed",
      error: "x".repeat(400),
    });
    assert.equal(marked.tasks.install.error?.length, 300);
    const cleared = await registry.markTask(graph.id, run.id, "install", { error: "  " });
    assert.equal("error" in cleared.tasks.install, false, "a blank error clears the field");
    await assert.rejects(() => registry.markTask(graph.id, run.id, "install", { error: 5 as never }), /error must be a string/);
  } finally {
    await s.cleanup();
  }
});

test("recoverInterrupted flips running tasks back to pending and closes the run as interrupted", async () => {
  const s = await scratch();
  try {
    const clock = clockAt(T0);
    const registry = await openWith(s.file, [], clock);
    const graph = await registry.create(baseGraph());
    const run = await registry.beginRun(graph.id);
    await registry.markTask(graph.id, run.id, "install", { status: "running", sessionId: "ses_dead", error: "mid-flight" });
    await registry.markTask(graph.id, run.id, "build", { status: "ok" });
    const quiet = await registry.create(baseGraph({ name: "Quiet" }));
    const quietRun = await registry.beginRun(quiet.id);
    for (const task of ["install", "build", "ship"]) {
      await registry.markTask(quiet.id, quietRun.id, task, { status: "ok" });
    }
    assert.equal(registry.lastRun(quiet.id)?.status, "ok", "the control run is closed, not live");

    clock.advance(30 * MINUTE); // the daemon restarts half an hour later
    const recovered = await registry.recoverInterrupted();
    assert.equal(recovered.length, 1, "only the run that was still running");
    assert.equal(recovered[0].id, run.id);
    assert.equal(recovered[0].status, "interrupted");
    assert.equal(recovered[0].finishedAt, iso(T0 + 30 * MINUTE));
    const install = recovered[0].tasks.install;
    assert.equal(install.status, "pending", "the mid-flight task goes back to pending");
    assert.equal("error" in install, false, "the attempt never finished, so it has no verdict");
    assert.equal("startedAt" in install, false, "re-stamped when it runs again");
    assert.equal(recovered[0].tasks.install.sessionId, "ses_dead", "the session link survives: it is history");
    assert.equal(recovered[0].tasks.build.status, "ok", "a finished task keeps its verdict");

    const onDisk = await readFileJson(s.file);
    const stored = onDisk.runs.find((entry: { id: string }) => entry.id === run.id);
    assert.equal(stored.status, "interrupted", "the recovery is durable");

    assert.deepEqual(await registry.recoverInterrupted(), [], "a second boot finds nothing to recover");
  } finally {
    await s.cleanup();
  }
});

test("update uses present-keys semantics: name/cwd/tasks replace-whole when present", async () => {
  const s = await scratch();
  try {
    const clock = clockAt(T0);
    const registry = await openWith(s.file, [], clock);
    const graph = await registry.create(baseGraph());

    clock.advance(MINUTE);
    const renamed = await registry.update(graph.id, { name: "Release flow (v2)" });
    assert.equal(renamed.name, "Release flow (v2)");
    assert.equal(renamed.cwd, "/srv/app", "an absent key is untouched");
    assert.equal(renamed.tasks.length, 3, "an absent tasks key is untouched");
    assert.equal(renamed.createdAt, iso(T0), "createdAt is history and never rewritten");
    assert.equal(renamed.updatedAt, iso(T0 + MINUTE));

    const moved = await registry.update(graph.id, { cwd: "/srv/v2" });
    assert.equal(moved.cwd, "/srv/v2");
    assert.equal(moved.name, "Release flow (v2)");

    const replaced = await registry.update(graph.id, {
      tasks: [
        { id: "lint", name: "Lint", prompt: "npm run lint", dependsOn: [] },
        { id: "test", name: "Test", prompt: "npm test", dependsOn: ["lint"] },
      ],
    });
    assert.deepEqual(
      replaced.tasks.map((task) => task.id),
      ["lint", "test"],
      "tasks replace the whole list",
    );
    await assert.rejects(
      () => registry.update(graph.id, { tasks: ringTasks() }),
      /the graph has a cycle/,
      "a patch is fully re-validated",
    );
    const untouched = await registry.update(graph.id, {});
    assert.deepEqual(
      untouched.tasks.map((task) => task.id),
      ["lint", "test"],
      "an empty patch changes nothing but updatedAt",
    );
  } finally {
    await s.cleanup();
  }
});

test("archive hides the graph, keeps the run history, and unarchive brings it back", async () => {
  const s = await scratch();
  try {
    const clock = clockAt(T0);
    const registry = await openWith(s.file, [], clock);
    const graph = await registry.create(baseGraph());
    await registry.beginRun(graph.id);

    clock.advance(MINUTE);
    const archived = await registry.archive(graph.id);
    assert.equal(archived.archivedAt, iso(T0 + MINUTE));
    assert.deepEqual(registry.list().map((record) => record.id), []);
    assert.equal(registry.list({ includeArchived: true }).length, 1);
    assert.ok(registry.lastRun(graph.id), "the run history survives an archive");

    clock.advance(MINUTE);
    const again = await registry.archive(graph.id);
    assert.equal(again.archivedAt, iso(T0 + MINUTE), "a double archive keeps the first stamp");

    const restored = await registry.unarchive(graph.id);
    assert.equal(restored.archivedAt, null);
    assert.deepEqual(registry.list().map((record) => record.id), [graph.id]);
    assert.equal((await registry.unarchive(graph.id)).archivedAt, null, "unarchive is idempotent");
    await assert.rejects(
      () => registry.archive("grp_0000000000"),
      (error: unknown) => error instanceof GraphError && error.code === "not_found",
    );
  } finally {
    await s.cleanup();
  }
});

test("remove drops the graph and its run history; concurrent creates get unique ids", async () => {
  const s = await scratch();
  try {
    const clock = clockAt(T0);
    const registry = await openWith(s.file, [], clock);
    const graph = await registry.create(baseGraph());
    const keeper = await registry.create(baseGraph({ name: "Keeper" }));
    await registry.beginRun(graph.id);
    clock.advance(MINUTE);
    await registry.beginRun(graph.id);
    await registry.beginRun(keeper.id);

    assert.equal(await registry.remove(graph.id), true);
    assert.deepEqual(registry.runs(graph.id), [], "no orphan runs");
    assert.deepEqual(registry.list().map((record) => record.id), [keeper.id]);
    assert.equal((await readFileJson(s.file)).runs.length, 1, "only the keeper's run on disk");

    const created = await Promise.all(
      Array.from({ length: 6 }, (_, index) => registry.create(baseGraph({ name: `burst ${index}` }))),
    );
    assert.equal(new Set(created.map((record) => record.id)).size, 6, "six ids, no collisions");
    assert.notEqual(newGraphId(), newGraphId());
    assert.match(newRunId(T0), /^run_\d+_[0-9a-f]{4}$/);
  } finally {
    await s.cleanup();
  }
});

test("a corrupt main file falls back to the .bak copy", async () => {
  const s = await scratch();
  try {
    const clock = clockAt(T0);
    const registry = await openWith(s.file, [], clock);
    const keep = await registry.create(baseGraph({ name: "keep" }));
    // The second write copies the first good file to `.bak`.
    await registry.create(baseGraph({ name: "later" }));
    assert.equal((await readFileJson(`${s.file}.bak`)).graphs.length, 1);

    await writeFile(s.file, "{ this is not json", "utf8");

    const warnings: string[] = [];
    const reopened = await openWith(s.file, warnings, clock);
    assert.deepEqual(
      reopened.list().map((record) => record.id),
      [keep.id],
      "the backup's graph came back",
    );
    assert.ok(warnings.some((line) => line.includes("unusable")), `the recovery was reported: ${JSON.stringify(warnings)}`);
    const names = await readdir(s.dataDir);
    assert.ok(names.some((name) => name.startsWith("graphs.json.corrupt-")), "the corrupt file was kept aside, not deleted");
  } finally {
    await s.cleanup();
  }
});

test("main and .bak both corrupt → empty registry, bad file moved aside, next write still works", async () => {
  const s = await scratch();
  try {
    const clock = clockAt(T0);
    const registry = await openWith(s.file, [], clock);
    await registry.create(baseGraph({ name: "gone" }));
    await registry.create(baseGraph({ name: "gone2" }));
    await writeFile(s.file, "garbage", "utf8");
    await writeFile(`${s.file}.bak`, "\u0000\u0001 also garbage", "utf8");

    const warnings: string[] = [];
    const reopened = await openWith(s.file, warnings, clock);
    assert.deepEqual(reopened.list(), []);
    assert.deepEqual(reopened.runs("grp_whatever"), []);
    assert.ok(warnings.some((line) => line.includes("unusable")));
    assert.ok(warnings.some((line) => line.includes("unusable too")));
    const names = await readdir(s.dataDir);
    assert.ok(names.some((name) => name.startsWith("graphs.json.corrupt-")));
    assert.equal(names.includes("graphs.json"), false, "the torn file is no longer the registry");

    // A recovered-from-nothing registry still works, and nothing was written over the bad file.
    const fresh = await reopened.create(baseGraph({ name: "fresh" }));
    assert.equal(reopened.list().length, 1);
    assert.equal((await readFileJson(s.file)).graphs[0].id, fresh.id);
  } finally {
    await s.cleanup();
  }
});

test("every mutation writes atomically with 0600 and leaves no temp file behind", async () => {
  const s = await scratch();
  try {
    const clock = clockAt(T0);
    const registry = await openWith(s.file, [], clock);
    const graph = await registry.create(baseGraph({ name: "secure" }));
    await registry.update(graph.id, { name: "secure v2" });
    const run = await registry.beginRun(graph.id);
    await registry.markTask(graph.id, run.id, "install", { status: "ok" });
    await registry.recoverInterrupted();

    const parsed = await readFileJson(s.file);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.graphs.length, 1);
    assert.equal(parsed.runs.length, 1);
    assert.equal(parsed.runs[0].tasks.install.status, "ok");

    assert.equal(await mode(s.file), 0o600, "registry file is owner-only");
    assert.equal(await mode(s.dataDir), 0o700, "its directory is owner-only");
    assert.equal(await mode(`${s.file}.bak`), 0o600, "the backup is owner-only too");
    assert.deepEqual(
      (await readdir(s.dataDir)).filter((name) => name.includes(".tmp-")),
      [],
      "renames leave no temp files",
    );
  } finally {
    await s.cleanup();
  }
});

test("records and runs are returned as copies, so a caller cannot mutate the cache", async () => {
  const s = await scratch();
  try {
    const registry = await openWith(s.file, [], clockAt(T0));
    const graph = await registry.create(baseGraph());
    const run = await registry.beginRun(graph.id);

    const listed = registry.list()[0]!;
    listed.name = "hacked";
    listed.tasks.push({ id: "evil", name: "Evil", prompt: "x", dependsOn: [] });
    assert.equal(registry.get(graph.id)?.name, "Release flow");
    assert.equal(registry.get(graph.id)?.tasks.length, 3);

    const runCopy = registry.lastRun(graph.id)!;
    runCopy.tasks.install.status = "ok";
    runCopy.status = "ok";
    assert.equal(registry.lastRun(graph.id)?.tasks.install.status, "pending");
    assert.equal(registry.lastRun(graph.id)?.status, "running");
    assert.equal(run.tasks.install.status, "pending", "the value beginRun returned is a copy too");
  } finally {
    await s.cleanup();
  }
});

test("migrate is pure: v0 documents, bare arrays and unknown versions", async () => {
  const s = await scratch();
  try {
    await mkdir(s.dataDir, { recursive: true, mode: 0o700 });
    const record = {
      id: "grp_0123456789",
      name: "Legacy",
      cwd: "/srv/legacy",
      tasks: [{ id: "a", name: "A", prompt: "go", dependsOn: [] }],
      createdAt: iso(T0),
      updatedAt: iso(T0),
    };
    // v0: no version field, runs included.
    await writeFile(s.file, JSON.stringify({ graphs: [record], runs: [{ id: "run_1_aa", graphId: "grp_0123456789", startedAt: iso(T0), finishedAt: null, status: "ok", tasks: { a: { status: "ok" } } }] }), "utf8");
    const warnings: string[] = [];
    const registry = await openWith(s.file, warnings, clockAt(T0 + MINUTE));
    assert.equal(registry.list().length, 1);
    assert.equal(registry.list()[0].id, "grp_0123456789");
    assert.equal(registry.lastRun("grp_0123456789")?.id, "run_1_aa");
    assert.deepEqual(warnings, [], "a clean v0 file is not a warning");
    // The next mutation stamps the versioned document.
    await registry.update("grp_0123456789", { name: "Legacy (kept)" });
    assert.equal((await readFileJson(s.file)).version, 1);

    // migrate() refuses shapes it does not know, rather than guessing.
    assert.throws(() => migrate({ version: 2, graphs: [] }), /unsupported registry version 2/);
    assert.deepEqual(migrate({ version: 1, graphs: [], runs: [] }), { graphs: [], runs: [] });
    assert.deepEqual(migrate(null), { graphs: [], runs: [] });
    assert.equal(migrate([record]).graphs.length, 1, "a bare graph array (paseo's shape) is accepted");
    assert.throws(() => migrate({ graphs: [{ name: "no cwd" }] }), /has no cwd/);
    assert.throws(() => migrate({ graphs: [record], runs: [{ id: "r" }] }), /has no graphId/);
    assert.throws(() => migrate({ graphs: [{ ...record, tasks: ringTasks() }] }), /the graph has a cycle/, "a cyclic hand-edit fails the file, not the registry silently");
  } finally {
    await s.cleanup();
  }
});
