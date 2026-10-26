import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { tempStore } from "./helpers.js";

/**
 * The create() model ladder is explicit → project default → DEVICE default →
 * error. The device default is what `GET /v1/device` advertises as
 * `defaultModel` — the value every client dialog prefills — and a create with
 * neither an explicit model nor a project default used to 400 instead of
 * honouring it (live-caught from the web New Session dialog).
 *
 * A keyless OpenRouter device is the only store shape that can show the whole
 * ladder: its catalog is the built-in list (several distinct models), while the
 * faux provider ships a single "echo" that is both the device and any project
 * default. No credential anywhere (empty PI_AGENT_DIR, no
 * OPENROUTER_API_KEY) is exactly the Windows-ish shape that hit the bug.
 */
async function keylessStore() {
  const t = await tempStore();
  const emptyPi = await mkdtemp(join(tmpdir(), "dpi-nopi-"));
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousPi = process.env.PI_AGENT_DIR;
  delete process.env.OPENROUTER_API_KEY;
  process.env.PI_AGENT_DIR = emptyPi;
  const store = await Store.open({ ...t.options, provider: "openrouter" });
  const info = store.deviceInfo();
  assert.ok(info.models.length >= 3, `the keyless catalog must distinguish the ladder, got ${info.models.length}`);
  return {
    info,
    store,
    work: t.work,
    cleanup: async () => {
      await store.close();
      if (previousKey !== undefined) process.env.OPENROUTER_API_KEY = previousKey;
      if (previousPi !== undefined) process.env.PI_AGENT_DIR = previousPi;
      else delete process.env.PI_AGENT_DIR;
      await rm(emptyPi, { recursive: true, force: true });
      await t.cleanup();
    },
  };
}

const ref = (m: { provider: string; id: string }) => ({ provider: m.provider, modelId: m.id });

test("create without a model falls back to the device default", async () => {
  const t = await keylessStore();
  try {
    const session = await t.store.create({ name: "No model given", cwd: t.work });
    assert.equal(
      `${session.provider}/${session.model}`,
      t.info.defaultModel,
      "the device's advertised defaultModel is what create uses",
    );
  } finally {
    await t.cleanup();
  }
});

test("an explicit model still wins over the device default", async () => {
  const t = await keylessStore();
  try {
    const chosen = t.info.models[1];
    const session = await t.store.create({ name: "Explicit", cwd: t.work, model: ref(chosen) });
    assert.equal(session.provider, chosen.provider);
    assert.equal(session.model, chosen.id);
    assert.notEqual(`${session.provider}/${session.model}`, t.info.defaultModel, "the caller's model, not the device default");
  } finally {
    await t.cleanup();
  }
});

test("a project default still wins over the device default", async () => {
  const t = await keylessStore();
  try {
    // Seed the project (a session with a cwd roots it), then give it its own default.
    await t.store.create({ name: "Seeds the project", cwd: t.work, model: ref(t.info.models[1]) });
    const [project] = t.store.projectList();
    const projectModel = t.info.models[2];
    await t.store.updateProject(project.id, { model: ref(projectModel) });

    const session = await t.store.create({ name: "Project default", cwd: t.work });
    assert.equal(session.provider, projectModel.provider, "the project default outranks the device default");
    assert.equal(session.model, projectModel.id);
    assert.notEqual(`${session.provider}/${session.model}`, t.info.defaultModel);
  } finally {
    await t.cleanup();
  }
});

test("an unknown explicit model is still rejected even though a device default exists", async () => {
  const t = await keylessStore();
  try {
    await assert.rejects(
      () => t.store.create({ name: "Bad", cwd: t.work, model: { provider: "nope", modelId: "nope" } }),
      /Unknown model/,
      "an explicit choice is never silently replaced by the device default",
    );
  } finally {
    await t.cleanup();
  }
});

test("the faux device's advertised default also backs a model-less create", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const info = store.deviceInfo();
    assert.equal(info.defaultModel, "echo", "faux advertises its single model");
    const session = await store.create({ name: "No model given", cwd: t.work });
    assert.equal(session.provider, "faux");
    assert.equal(session.model, info.defaultModel);
  } finally {
    await store.close();
    await t.cleanup();
  }
});
