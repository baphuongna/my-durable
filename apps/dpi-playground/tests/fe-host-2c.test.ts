/**
 * Wave 2b of docs/host-project-checklist.md: scheduled sessions (device-owned
 * clock), retention with a dry-run default, and the update badge.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const R = (p: string) => readFile(new URL(p, import.meta.url), "utf8");

test("schedules: registry → store loop → routes → tunnel → CLI → panel", async () => {
  const registry = await R("../../dpi-backend/src/schedules.ts");
  assert.match(registry, /class ScheduleRegistry/, "no registry");
  assert.match(registry, /computeNextRun/, "no next-run computation");
  const store = await R("../../dpi-backend/src/store.ts");
  assert.match(store, /startScheduler\(\)/, "the device never starts the scheduler");
  assert.match(store, /runDueSchedules/, "no due pass");
  assert.match(store, /scheduleInFlight/, "a long run would be dispatched twice");
  assert.match(store, /dispatchSchedule/, "no dispatch");
  const routes = await R("../../dpi-backend/src/routes.ts");
  for (const route of ['r.get("/schedules"', 'r.post("/schedules"', 'r.patch("/schedules/:id"', 'r.delete("/schedules/:id"', 'r.post("/schedules/:id/run"'])
    assert.ok(routes.includes(route), `${route} missing`);
  const allow = await R("../../dpi-sdk/src/protocol/rest-routes.ts");
  assert.match(allow, /\["POST", "\/schedules\/:id\/run"\]/, "run is not tunnelled");
  const cli = await R("../../dpi-backend/src/schedule-cli.ts");
  assert.match(cli, /export async function scheduleCli/, "no CLI");
  const bin = await R("../../../bin/dpi.mjs");
  assert.match(bin, /command === "schedule"/, "dpi schedule is not wired");
  const panel = await R("../apps/dpi-playground-fe/src/components/SchedulesPanel.vue");
  assert.match(panel, /createSchedule\(/, "the panel cannot add a schedule");
  assert.match(panel, /runSchedule\(/, "the panel cannot run one now");
  assert.match(panel, /watch\(deviceId, load, \{ immediate: true \}\)/, "the panel must load on first paint");
  assert.ok(!/setInterval/.test(panel), "the panel must not poll");
  const insp = await R("../apps/dpi-playground-fe/src/components/Inspector.vue");
  assert.match(insp, /<SchedulesPanel v-if="ui.tab === 'auto'" \/>/, "the panel is not rendered");
});

test("retention: dry-run is the default and no timer deletes anything", async () => {
  const gc = await R("../../dpi-backend/src/gc.ts");
  assert.match(gc, /export async function gcPlan/, "no plan");
  assert.match(gc, /export async function gcApply/, "no apply");
  const cli = await R("../../dpi-backend/src/gc-cli.ts");
  assert.match(cli, /const apply = argv\.includes\("--yes"\)/, "--yes must be explicit");
  assert.match(cli, /would delete/, "the dry-run must say what it would delete");
  assert.ok(!/setInterval|setTimeout/.test(gc) && !/setInterval|setTimeout/.test(cli), "GC must never schedule itself");
  const bin = await R("../../../bin/dpi.mjs");
  assert.match(bin, /command === "gc"/, "dpi gc is not wired");
});

test("update badge: the hub reports its version and the tree shows a stale device", async () => {
  const hub = await R("../apps/dpi-playground-hub/src/main.ts");
  assert.match(hub, /app\.get\("\/api\/version"/, "no hub version route");
  const feHub = await R("../apps/dpi-playground-fe/src/client/hub.ts");
  assert.match(feHub, /version: \(\) => call<\{ version: string; node: string \}>/, "the FE cannot read it");
  const store = await R("../apps/dpi-playground-fe/src/client/store.ts");
  assert.match(store, /export const hubVersion/, "no hubVersion state");
  const row = await R("../apps/dpi-playground-fe/src/components/TreeRow.vue");
  assert.match(row, /info\?\.packageVersion/, "the badge ignores the device build (not the pi-durable library version)");
  assert.match(row, /class="tag update"/, "no badge");
});
