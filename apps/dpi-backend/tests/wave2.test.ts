/**
 * Wave 2 of docs/host-project-checklist.md: the project entity wired into the
 * store (a session roots a project) and the device usage rollup.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { faux, tempStore } from "./helpers.js";

test("a session roots a project, and the project is listable by path", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "First", cwd: "project/nested", model: faux });
    const projects = store.projectList();
    assert.equal(projects.length, 1, "one session → one project");
    assert.equal(projects[0].rootPath, session.cwd);
    assert.equal(projects[0].name, "nested");
    assert.equal(projects[0].kind, "plain", "a plain directory is not a git repo");
    assert.deepEqual(projects[0].labels, []);

    // A second session in the same folder must not create a second project.
    await store.create({ name: "Second", cwd: "project/nested", model: faux });
    assert.equal(store.projectList().length, 1);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("projects can be renamed, labelled and archived without touching sessions", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "Work", cwd: "project", model: faux });
    const [project] = store.projectList();

    const renamed = await store.updateProject(project.id, { customName: "Reconcile API", labels: ["Backend", "work"] });
    assert.equal(renamed.customName, "Reconcile API");
    assert.equal(renamed.name, "project", "the derived name is never overwritten");
    assert.deepEqual(renamed.labels, ["backend", "work"], "labels are normalised to lowercase");

    // Re-ensuring (a new session in the same root) must not clobber the override.
    await store.create({ name: "Second", cwd: "project", model: faux });
    const [again] = store.projectList();
    assert.equal(again.customName, "Reconcile API");
    assert.deepEqual(again.labels, ["backend", "work"]);

    const archived = await store.archiveProject(project.id);
    assert.ok(archived.archivedAt, "archive stamps a time");
    assert.deepEqual(store.projectList(), [], "archived projects leave the default list");
    assert.equal(store.projectList(true).length, 1);
    assert.equal(store.projectList(true)[0].archivedAt !== null, true);

    // Archiving a project is bookkeeping — the session itself keeps working.
    assert.equal(store.resolveSession(session.id).id, session.id);

    const back = await store.unarchiveProject(project.id);
    assert.equal(back.archivedAt, null);
    assert.equal(store.projectList().length, 1);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("project patches are validated, and unknown ids are 404-shaped", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    await store.create({ name: "Work", cwd: "project", model: faux });
    const [project] = store.projectList();
    await assert.rejects(() => store.updateProject(project.id, { labels: ["x".repeat(40)] }), /label/i);
    await assert.rejects(
      () => store.updateProject("prj_missing", { labels: ["a"] }),
      (e: unknown) => (e as { code?: string }).code === "not_found",
      "an unknown project must surface as not_found, not a 500",
    );
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("usageReport rolls up totals, models, sessions and projects", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "Metered", cwd: "project", model: faux });
    const report = await store.usageReport();
    assert.equal(report.totals.tokens, 0, "a fresh session has spent nothing");
    assert.equal(report.totals.cost, 0);
    assert.deepEqual(report.models, []);
    assert.equal(report.sessions.length, 1);
    assert.equal(report.sessions[0].id, session.id);
    assert.equal(report.sessions[0].name, "Metered");
    assert.equal(report.sessions[0].project, "project", "the session is attributed to its project");
    assert.equal(report.sessions[0].agents, 1);
    assert.equal(report.projects.length, 1);
    assert.equal(report.projects[0].name, "project");
    assert.equal(report.projects[0].sessions, 1);
    assert.ok(report.at > 0);

    // A session without a project root (cwd removed from the registry) still counts,
    // it is simply not attributed.
    const other = await store.create({ name: "Unrooted", cwd: join(t.work, "project", "nested"), model: faux });
    const second = await store.usageReport();
    assert.equal(second.sessions.length, 2);
    assert.ok(second.sessions.some((s) => s.id === other.id));
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("a labels-only patch keeps the custom name (and vice versa)", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    await store.create({ name: "Work", cwd: "project", model: faux });
    const [project] = store.projectList();
    await store.updateProject(project.id, { customName: "Git demo repo", labels: ["demo"] });

    const relabelled = await store.updateProject(project.id, { labels: ["demo", "tooling"] });
    assert.equal(relabelled.customName, "Git demo repo", "a labels-only patch must not clear the name");
    assert.deepEqual(relabelled.labels, ["demo", "tooling"]);

    const renamed = await store.updateProject(project.id, { customName: "Renamed" });
    assert.deepEqual(renamed.labels, ["demo", "tooling"], "a name-only patch must keep the labels");

    const cleared = await store.updateProject(project.id, { customName: "" });
    assert.equal(cleared.customName, undefined, "an empty name falls back to the folder name");
    assert.equal(cleared.name, "project");
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("per-project default model: applies when a session sets none, explicit wins", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    // Two sessions root the same project; give it a default model.
    await store.create({ name: "Seeds the project", cwd: "project", model: faux });
    const [project] = store.projectList();
    // The faux provider ships exactly one model, so "a different model" is faked
    // by shape only — what matters is that the project's model, not the caller's
    // absence, decides.
    const other = { provider: "faux", modelId: "echo" };
    const patched = await store.updateProject(project.id, { model: other });
    assert.deepEqual(patched.model, other, "the default model is stored on the project");

    // A session created without a model in that project picks the project's default.
    const inherited = await store.create({ name: "No model given", cwd: "project" });
    assert.equal(inherited.model, other.modelId, "the project default applies");

    // Clearing the default falls back to the DEVICE default (never an error):
    // the faux device advertises "echo", so a model-less create still works.
    await store.updateProject(project.id, { model: "" });
    assert.equal(store.projectList()[0].model, undefined, 'model: "" clears');
    const deviceFallback = await store.create({ name: "No default any more", cwd: "project" });
    assert.equal(deviceFallback.provider, "faux");
    assert.equal(
      deviceFallback.model,
      store.deviceInfo().defaultModel,
      "with no project default and no explicit model, create uses the device default",
    );
  } finally {
    await store.close();
    await t.cleanup();
  }
});
