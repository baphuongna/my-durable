/**
 * Wave 2 of docs/host-project-checklist.md: the project entity end to end
 * (device registry → tunnel → tree chips) and the usage dashboard wiring.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const R = (p: string) => readFile(new URL(p, import.meta.url), "utf8");

test("projects: registry is wired into the store, routes and the tunnel allowlist", async () => {
  const store = await R("../../dpi-backend/src/store.ts");
  assert.match(store, /ProjectRegistry\.open/, "the registry is not opened with the store");
  assert.match(store, /projects\s*\n?\s*\.ensure\(\{ rootPath/, "sessions do not root projects");
  assert.match(store, /projectList\(/, "no project list on the store");
  const routes = await R("../../dpi-backend/src/routes.ts");
  for (const route of [
    'r.get("/projects"',
    'r.patch("/projects/:id"',
    'r.post("/projects/:id/archive"',
    'r.post("/projects/:id/unarchive"',
  ])
    assert.ok(routes.includes(route), `${route} missing`);
  const allow = await R("../../dpi-sdk/src/protocol/rest-routes.ts");
  assert.match(allow, /\["GET", "\/projects"\]/, "projects are not tunnelled");
  assert.match(allow, /\["PATCH", "\/projects\/:id"\]/, "project patch is not tunnelled");
  const client = await R("../../dpi-sdk/src/client.ts");
  for (const method of ["projects(includeArchived", "updateProject(", "archiveProject(", "unarchiveProject("])
    assert.ok(client.includes(method), `${method} missing from the client`);
});

test("usage: the device route, the client and the panel exist and stay lazy", async () => {
  const routes = await R("../../dpi-backend/src/routes.ts");
  assert.match(routes, /r\.get\("\/device\/usage"/, "usage route missing");
  const allow = await R("../../dpi-sdk/src/protocol/rest-routes.ts");
  assert.match(allow, /\["GET", "\/device\/usage"\]/, "usage not tunnelled");
  const store = await R("../../dpi-backend/src/store.ts");
  assert.match(store, /async usageReport\(\)/, "no rollup on the store");
  assert.match(store, /sumUsage\(/, "the rollup must reuse the transcript sum");
  const panel = await R("../apps/dpi-playground-fe/src/components/UsagePanel.vue");
  assert.match(panel, /deviceUsage\(\)/, "panel does not call the device");
  assert.match(panel, /immediate: true/, "panel must load on first paint");
  assert.ok(!/setInterval|setTimeout\(.*load/.test(panel), "the panel must not poll");
  const insp = await R("../apps/dpi-playground-fe/src/components/Inspector.vue");
  assert.match(insp, /<UsagePanel v-if="ui\.tab === 'usage'" \/>/, "UsagePanel is not rendered");
});

test("project chips filter the tree and can be renamed/labelled/archived", async () => {
  const bar = await R("../apps/dpi-playground-fe/src/components/ProjectBar.vue");
  assert.match(bar, /defineModel<\{ deviceId: string; rootPath: string \}/, "the filter must be a model");
  assert.match(bar, /updateProject\(/, "rename/labels do not reach the device");
  assert.match(bar, /archiveProject\(|archiveAt\(/, "archive does not reach the device");
  assert.match(bar, /kind: "prompt"/, "project edits must use the app-styled dialog");
  const sidebar = await R("../apps/dpi-playground-fe/src/components/NetworkSidebar.vue");
  assert.match(sidebar, /<ProjectBar v-model:active="projectFilter" \/>/, "the bar is not wired");
  assert.match(sidebar, /startsWith\(`\$\{projectFilter\.value\.rootPath\}\/`\)/, "cwd prefix filter missing");
});
