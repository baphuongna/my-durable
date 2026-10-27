// R6 fe fix #1 (P2): an App-State draft must never migrate to another device.
// The draft composable resets unconditionally on a device switch (context
// loss), and while a switch settles, a foreign-device draft reads as a
// conflict — Save is disabled, not retargeted at the new device's feed.
// Also covers fix #4 (P4): the draft is pre-validated with the SDK's own
// changeState checks (depth 24, 100k chars, reserved names) so the message
// lands before the Save click.
// Level: unit (vite SSR module graph — the composable is DOM-free).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nextTick, ref } from "vue";
import { createServer } from "vite";

globalThis.window = globalThis.window ?? {
  matchMedia: (q) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }),
};
if (!globalThis.navigator)
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "node-test" },
    configurable: true,
  });

const FE_ROOT = new URL("../apps/dpi-playground-fe/", import.meta.url);
let vite: Awaited<ReturnType<typeof createServer>>;

test.before(async () => {
  vite = await createServer({
    configFile: new URL("vite.config.ts", FE_ROOT).pathname,
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: "custom",
    logLevel: "error",
  });
});
test.after(async () => {
  await vite?.close();
});

const nest = (depth: number) => {
  let v: unknown = { leaf: true };
  for (let i = 0; i < depth; i++) v = { a: v };
  return v;
};

test("draftProblem: the SDK limits surface before save", async () => {
  const { draftProblem } = await vite.ssrLoadModule("/src/client/state-draft.ts");
  assert.equal(draftProblem(JSON.stringify(nest(3))), "", "a shallow object is fine");
  assert.match(
    draftProblem(JSON.stringify(nest(30))),
    /too deeply nested/,
    "30 levels must name the depth limit before save",
  );
  assert.equal(draftProblem(JSON.stringify(nest(20))), "", "20 levels are within the limit");
  assert.match(draftProblem("[]"), /must be a JSON object/, "an array root is rejected");
  assert.match(draftProblem('"text"'), /must be a JSON object/, "a scalar root is rejected");
  assert.notEqual(draftProblem("{"), "", "broken JSON reports a problem");
  assert.match(draftProblem('{"__proto__": 1}'), /Reserved field name/);
  assert.match(
    draftProblem(JSON.stringify({ big: "x".repeat(100_001) })),
    /100,000 characters/,
    "the size limit is pre-validated too",
  );
});

test("state draft: a device switch resets a dirty draft (no cross-device write)", async () => {
  const { useStateDraft } = await vite.ssrLoadModule("/src/client/state-draft.ts");
  const shared = ref<{ value: Record<string, unknown>; revision: number }>();
  const deviceId = ref<string | undefined>();
  const s = useStateDraft(shared, deviceId);
  shared.value = { value: { counter: 1 }, revision: 3 };
  deviceId.value = "dev1";
  await nextTick();
  assert.equal(s.draft.value, JSON.stringify({ counter: 1 }, null, 2), "loads the feed");

  s.draft.value = s.draft.value.replace("1", "2"); // a dirty edit on device A
  assert.ok(s.dirty.value);
  deviceId.value = "dev2"; // switch devices
  await nextTick();
  assert.ok(!s.dirty.value, "a device switch always resets the draft");
  assert.equal(s.draft.value, JSON.stringify({ counter: 1 }, null, 2));
  assert.ok(!s.conflict.value, "clean after the reset: nothing to save anywhere");
});

test("state draft: while a switch settles, a foreign-device draft is a conflict", async () => {
  const { useStateDraft } = await vite.ssrLoadModule("/src/client/state-draft.ts");
  const shared = ref<{ value: Record<string, unknown>; revision: number }>();
  const deviceId = ref<string | undefined>();
  const s = useStateDraft(shared, deviceId);
  shared.value = { value: {}, revision: 3 };
  deviceId.value = "dev1";
  await nextTick();
  s.draft.value = '{\n  "from": "device A"\n}';
  assert.ok(s.dirty.value);
  deviceId.value = "dev2"; // same tick: the reset watcher has not flushed yet
  assert.ok(
    s.conflict.value,
    "a dirty draft from another device reads as a conflict until the reset lands",
  );
  await nextTick();
  assert.ok(!s.dirty.value && !s.conflict.value, "then the reset clears it");
});

test("state draft: a remote revision change while dirty is a conflict", async () => {
  const { useStateDraft } = await vite.ssrLoadModule("/src/client/state-draft.ts");
  const shared = ref<{ value: Record<string, unknown>; revision: number }>();
  const deviceId = ref<string | undefined>();
  const s = useStateDraft(shared, deviceId);
  shared.value = { value: { a: 1 }, revision: 3 };
  deviceId.value = "dev1";
  await nextTick();
  s.draft.value = '{\n  "a": 2\n}';
  shared.value = { value: { a: 9 }, revision: 4 }; // someone else saved
  await nextTick();
  assert.ok(s.conflict.value, "revision moved under a dirty draft");
  s.reset();
  assert.ok(!s.conflict.value && !s.dirty.value, "loading the latest resolves it");
});

test("state draft: typing validates debounced, and a reset clears the problem", async () => {
  const { useStateDraft } = await vite.ssrLoadModule("/src/client/state-draft.ts");
  const shared = ref<{ value: Record<string, unknown>; revision: number }>();
  const deviceId = ref<string | undefined>();
  const s = useStateDraft(shared, deviceId);
  shared.value = { value: {}, revision: 0 };
  deviceId.value = "dev1";
  await nextTick();
  s.draft.value = JSON.stringify(nest(30), null, 2);
  await new Promise((r) => setTimeout(r, 350)); // past the debounce
  assert.match(s.problem.value, /too deeply nested/, "the message shows before any save");
  deviceId.value = "dev2"; // any reset clears it with the draft
  await nextTick();
  assert.equal(s.problem.value, "", "a reset clears the validation problem");
});

test("Inspector wires the draft: Save blocked by conflict or draft problem, limit noted", async () => {
  const src = readFileSync(
    new URL("../apps/dpi-playground-fe/src/components/Inspector.vue", import.meta.url),
    "utf8",
  );
  const flat = src.replace(/\s+/g, " ");
  assert.match(flat, /useStateDraft\(shared, deviceId\)/, "the draft comes from the composable");
  assert.match(
    flat,
    /:disabled="!stateDirty \|\| stateSaving \|\| stateConflict \|\| !!stateProblem"/,
    "Save stays blocked while the draft is invalid",
  );
  assert.match(
    flat,
    /stateSaving\.value \|\| stateConflict\.value \|\| !agentHandle\.value/,
    "saveStateJson refuses to run on a conflict",
  );
  assert.match(flat, /24 levels/, "the depth limit is noted near the editor");
});
