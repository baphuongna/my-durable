/**
 * Wave 3 finale: task-graph DAG — module → store engine → routes → tunnel →
 * client → panel, plus the events the device now emits.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const R = (p: string) => readFile(new URL(p, import.meta.url), "utf8");

test("graph module: validation, pure planning, run bookkeeping", async () => {
  const module = await R("../../dpi-backend/src/graphs.ts");
  assert.match(module, /export function topoOrder/, "no topological order");
  assert.match(module, /export function readyTasks/, "no readiness planning");
  assert.match(module, /export function cascadeSkips/, "no failure cascade");
  assert.match(module, /the graph has a cycle/, "cycles must be refused with the ring named");
  assert.match(module, /recoverInterrupted/, "no restart recovery");
  const tests = await R("../../dpi-backend/tests/graphs.test.ts");
  assert.match(tests, /naming the tasks stuck in the ring/, "no cycle-refusal test");
});

test("graph engine: store drives fresh sessions, sequential topo order", async () => {
  const store = await R("../../dpi-backend/src/store.ts");
  assert.match(store, /runGraphNow/, "no run entry point");
  assert.match(store, /executeGraphRun/, "no engine");
  assert.match(store, /readyTasks\(record\.tasks, run\.tasks\)/, "the engine does not use the planner");
  assert.match(store, /topoOrder\(record\.tasks\)/, "the engine does not respect topological order");
  assert.match(store, /waitForGraphAnswer/, "no bounded wait for a task's turn");
  assert.match(store, /timed out after 30 minutes/, "a task must have a ceiling");
  assert.match(store, /recoverInterrupted\(\)/, "boot and close must recover interrupted runs");
  assert.match(store, /graph\.ok/, "no completion event");
  assert.match(store, /graph\.failed/, "no failure event");
});

test("graph surface: routes → tunnel → client → panel → CLI", async () => {
  const routes = await R("../../dpi-backend/src/routes.ts");
  for (const route of ['r.get("/graphs"', 'r.post("/graphs"', 'r.patch("/graphs/:id"', 'r.delete("/graphs/:id"', 'r.post("/graphs/:id/run"'])
    assert.ok(routes.includes(route), `${route} missing`);
  const allow = await R("../../dpi-sdk/src/protocol/rest-routes.ts");
  for (const route of ['["GET", "/graphs"]', '["POST", "/graphs/:id/run"]'])
    assert.ok(allow.includes(route), `${route} not tunnelled`);
  const client = await R("../../dpi-sdk/src/client.ts");
  for (const m of ["graphs()", "runGraph(", "createGraph("]) assert.ok(client.includes(m), `${m} missing`);
  const panel = await R("../apps/dpi-playground-fe/src/components/GraphPanel.vue");
  assert.match(panel, /runGraph\(g\.id\)/, "no run button");
  assert.match(panel, /watch\(deviceId, load, \{ immediate: true \}\)/, "must load on first paint");
  assert.ok(!/setInterval/.test(panel), "the panel must not poll");
  const insp = await R("../apps/dpi-playground-fe/src/components/Inspector.vue");
  assert.match(insp, /<GraphPanel v-if="ui\.tab === 'dag'" \/>/, "the panel is not rendered");
  const bin = await R("../../../bin/dpi.mjs");
  assert.match(bin, /command === "graph"/, "dpi graph is not wired");
  const notify = await R("../../dpi-backend/src/notify-cli.ts");
  assert.match(notify, /graph\.ok/, "the emitted-events list does not know graph events");
});
