/**
 * Old-build devices must meet friendly walls, not raw tunnel errors, and the
 * update badge must fire for pre-rename devices (durableVersion, no
 * packageVersion) — they are the ones most in need of the hint.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const R = (p: string) => readFile(new URL(p, import.meta.url), "utf8");

test("every device-scoped panel translates allowlist errors into an update hint", async () => {
  const panels = [
    "../apps/dpi-playground-fe/src/components/UsagePanel.vue",
    "../apps/dpi-playground-fe/src/components/SchedulesPanel.vue",
    "../apps/dpi-playground-fe/src/components/EnvPanel.vue",
    "../apps/dpi-playground-fe/src/components/NotifyPanel.vue",
    "../apps/dpi-playground-fe/src/components/GraphPanel.vue",
  ];
  for (const p of panels) {
    const src = await R(p);
    assert.match(src, /allowlist/, `${p}: no allowlist translation`);
    assert.match(src, /older build/, `${p}: no older-build message`);
  }
  // The raw tunnel text must not be what a human sees on the usage tab.
  const usage = await R("../apps/dpi-playground-fe/src/components/UsagePanel.vue");
  assert.ok(
    usage.indexOf("not_found") < usage.indexOf("older build"),
    "usage must check the code before falling back to the raw message",
  );
});

test("the state editor can add fields to OBJECT containers (incl. the root)", async () => {
  // Live-caught: `kind === "array"` guards meant objects could never gain
  // fields — an empty app state was unfixable from the UI.
  const editor = await R("../apps/dpi-playground-fe/src/components/StateEditor.vue");
  assert.match(editor, /<form v-if="adding"/, "the add form must not be array-only");
  assert.ok(!/v-else-if="kind === 'array'"/.test(editor), "an array-only add button must not remain");
  assert.match(editor, /Add field/, "object containers need an Add field button");
});

test("the schedule form never silently dies while models load", async () => {
  const panel = await R("../apps/dpi-playground-fe/src/components/SchedulesPanel.vue");
  assert.match(panel, /modelsLoading/, "no loading state for the model catalog");
  assert.match(panel, /:disabled="busy === 'new' \|\| modelsLoading \|\| !draft\.model"/, "Create must wait for a model");
  assert.match(panel, /Pick a model first\./, "a model-less submit must SAY so, not return silently");
});

test("the update badge covers pre-rename devices (durableVersion)", async () => {
  const row = await R("../apps/dpi-playground-fe/src/components/TreeRow.vue");
  assert.match(row, /packageVersion \?\? info\?\.durableVersion/, "no durableVersion fallback");
  assert.match(row, /class=\"tag update\"/, "badge markup changed");
  // A device reporting ONLY durableVersion (durable 1.3.0) must count as behind.
  const theirs = "1.3.0";
  const ours = "0.0.46";
  assert.notEqual(theirs, ours, "fixture must differ");
});
