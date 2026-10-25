/**
 * Wave 3 wiring test: a REAL graph run through a temp store with the faux
 * provider — tasks execute in dependency order, each as its own session, and
 * a failure cascades skips to dependants.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { faux, tempStore } from "./helpers.js";

test("a graph runs top to bottom: roots first, dependants after, fresh session each", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const graph = await store.createGraph({
      name: "E2E",
      cwd: "project",
      tasks: [
        { id: "first", name: "First", prompt: "say one", dependsOn: [], model: faux },
        { id: "second", name: "Second", prompt: "say two", dependsOn: ["first"], model: faux },
      ],
    });
    assert.equal(graph.tasks.length, 2);
    await assert.rejects(
      () =>
        store.createGraph({
          name: "cyclic",
          cwd: "project",
          tasks: [
            { id: "a", name: "A", prompt: "x", dependsOn: ["b"], model: faux },
            { id: "b", name: "B", prompt: "x", dependsOn: ["a"], model: faux },
          ],
        }),
      /cycle/,
    );

    const { run } = await store.runGraphNow(graph.id);
    assert.equal(run.status, "running");
    assert.deepEqual(Object.values(run.tasks).map((s) => s.status), ["pending", "pending"]);

    // The engine runs in the background; poll the registry (bounded).
    const deadline = Date.now() + 60_000;
    let final = run;
    while (Date.now() < deadline) {
      final = store.graphGet(graph.id)!.runs[0]!;
      if (final.status !== "running") break;
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.equal(final.status, "ok", `run should finish ok, got ${JSON.stringify(final.tasks)}`);
    assert.equal(final.tasks.first!.status, "ok");
    assert.equal(final.tasks.second!.status, "ok");
    assert.ok(final.tasks.first!.sessionId, "each task records its session");
    assert.notEqual(final.tasks.first!.sessionId, final.tasks.second!.sessionId, "one fresh session per task");

    // Session names follow the graph.
    const names = store.list().map((r) => r.name);
    assert.ok(names.includes("E2E · First") && names.includes("E2E · Second"), JSON.stringify(names));

    // Order really was first → second.
    const startedFirst = Date.parse(final.tasks.first!.startedAt!);
    const startedSecond = Date.parse(final.tasks.second!.startedAt!);
    assert.ok(startedSecond >= startedFirst, "the dependant must not start before its dependency");
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("a failed task fails the run and skips its dependants", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const graph = await store.createGraph({
      name: "FailCascade",
      cwd: "project",
      tasks: [
        { id: "boom", name: "Boom", prompt: "boom", dependsOn: [], model: faux },
        { id: "after", name: "After", prompt: "later", dependsOn: ["boom"], model: faux },
      ],
    });
    // Sabotage: no such cwd → the session create fails → the task fails.
    const broken = await store.createGraph({
      name: "Broken",
      cwd: "project",
      tasks: [
        { id: "root", name: "Root", prompt: "x", dependsOn: [], model: faux },
        { id: "child", name: "Child", prompt: "x", dependsOn: ["root"], model: faux },
      ],
    });
    // Point one graph at a nonexistent cwd by patching the record directly
    // (the registry keeps human-typed cwd; Store.create resolves it).
    const patched = await store.updateGraph(broken.id, { cwd: "definitely-not-here" });
    assert.equal(patched.cwd.includes("definitely-not-here"), true);

    await store.runGraphNow(graph.id); // boom resolves fine with faux: ok
    const { run: brokenRun } = await store.runGraphNow(broken.id);

    const deadline = Date.now() + 60_000;
    let healthy: { status: string } = brokenRun;
    let wrecked: { status: string; tasks: Record<string, { status: string; error?: string }> } = brokenRun as never;
    while (Date.now() < deadline) {
      healthy = store.graphGet(graph.id)!.runs[0]!;
      wrecked = store.graphGet(broken.id)!.runs[0]!;
      if (healthy.status !== "running" && wrecked.status !== "running") break;
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.equal(healthy.status, "ok", "the healthy graph finishes ok");
    assert.equal(wrecked.status, "failed", "the broken graph's run fails");
    assert.equal(wrecked.tasks.root!.status, "failed");
    assert.match(wrecked.tasks.root!.error ?? "", /cwd/, "the error names the cause");
    assert.equal(wrecked.tasks.child!.status, "skipped", "the dependant is skipped, not left pending");
  } finally {
    await store.close();
    await t.cleanup();
  }
});
