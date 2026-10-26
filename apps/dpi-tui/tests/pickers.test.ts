// Picker/Panel rendering contracts pinned live in Round 4:
//  - Panel (help/tasks): ALWAYS renders visible content — an invisible overlay
//    used to swallow input (R4 finding 3);
//  - Picker: the hint's operative verb (`esc close`) survives a bare 80-col
//    terminal, and no line ever exceeds 80 visible cols (R4 finding 7);
//  - walkDirs: the dirs() dead-air holds a busy note, a failed listing resolves
//    null (error flashed, NO unrelated dialog) and esc resolves undefined
//    (R4 finding 8).
import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Panel, Picker, walkDirs } from "../src/pickers.ts";
import type { App } from "../src/app.ts";

test("Panel renders non-empty visible output (tasks + help shapes, R4 finding 3)", () => {
  // Exactly the shapes commands.ts mounts: the tasks panel (empty + populated)
  // and the help panel. A Panel that renders zero visible lines is the bug —
  // the overlay stayed mounted, swallowed every key, and showed nothing.
  const tasksEmpty = new Panel(
    () => ["Live tasks in r4fix", "", "No live tasks.", "", "esc close"].map((l, i) => (i === 0 ? l : l)),
    () => {},
  );
  const tasksBusy = new Panel(
    () => [
      "Live tasks in r4fix",
      "",
      "● fg #7 message agent #1 │ running/thinking",
      "◌ bg #6 bash agent #2 │ done",
      "",
      "esc close",
    ],
    () => {},
  );
  const help = new Panel(
    () => ["dpi-tui", "adhoc │ http://127.0.0.1:4850", "", "/sessions  switch or create a session on this device", "", "esc to close."],
    () => {},
  );
  for (const [name, panel] of [
    ["tasks (empty)", tasksEmpty],
    ["tasks (busy)", tasksBusy],
    ["help", help],
  ] as const) {
    for (const width of [60, 80, 120]) {
      const lines = panel.render(width);
      const visible = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
      assert.ok(lines.length >= 4, `${name} panel renders lines at ${width}`);
      assert.ok(visible.trim().length > 10, `${name} panel has visible text at ${width}`);
      assert.match(visible, /esc close|esc to close/, `${name} panel shows its close hint at ${width}`);
    }
  }
  // The empty-tasks panel says so in words (the auditor's "No live tasks."):
  const emptyText = tasksEmpty.render(80).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join(" ");
  assert.match(emptyText, /No live tasks\./, "empty task list is announced, not blank");
});

test("Picker hint fits the overlay floor: `esc close` fully visible at 80 cols, nothing overflows (R4 finding 7)", () => {
  const picker = new Picker("Sessions on box", [{ value: "s1", label: "one" }], () => {}, () => {});
  // The overlay floor is minWidth 60 (app.ts); the widest default hint is 55
  // visible cols + 2 padding, so every picker line must fit 60 and, a fortiori,
  // the 80-col terminal discipline holds.
  for (const width of [60, 80, 100]) {
    const lines = picker.render(width);
    assert.ok(lines.length > 0, `picker renders at ${width}`);
    for (const line of lines)
      assert.ok(visibleWidth(line) <= width, `picker line ${visibleWidth(line)} > ${width}: ${JSON.stringify(line).slice(0, 80)}`);
  }
  const at80 = picker.render(80).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  const hintLine = at80.find((l) => l.includes("esc")) ?? "";
  assert.match(hintLine, /esc close/, `hint truncated at 80 cols: ${JSON.stringify(hintLine)}`);
  assert.ok(at80.every((l) => visibleWidth(l) <= 80), "0 lines exceed 80 visible cols");
});

// -- walkDirs busy note + failure/cancel sentinels (R4 finding 8) -------------

/** Just enough App for walkDirs: captures overlays, pending notes and flashes. */
function fakeWalkApp(dirs: (at: string) => Promise<unknown>) {
  const flashes: { text: string; error: boolean }[] = [];
  const pending: (string | null)[] = [];
  const overlays: unknown[] = [];
  const app = {
    device: { id: "box", name: "box", url: "http://x", token: "t" },
    client: { dirs },
    overlay: (component: unknown) => {
      overlays.push(component);
    },
    closeOverlay: () => {},
    flash: (text: string, error = false) => flashes.push({ text, error }),
    notify: (text: string, error = false) => flashes.push({ text, error }),
    setPending: (text: string | null) => pending.push(text),
  };
  return { app: app as never as App, flashes, pending, overlays };
}

/** Drive the mounted Picker the way a click on an item would. */
const pickItem = (picker: unknown, item: { value: string; label: string }) =>
  (picker as { pick: (item: { value: string; label: string }) => void }).pick(item);

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test("walkDirs holds a busy note during dirs() and clears it when the listing lands", async () => {
  let release: (v: unknown) => void = () => {};
  const gate = new Promise((r) => (release = r));
  const t = fakeWalkApp(async () => {
    await gate;
    return { path: "/tmp/r4tuifix/work", parent: null, dirs: [{ name: "project", path: "/tmp/r4tuifix/work/project" }] };
  });
  const done = walkDirs(t.app, "");
  await settle();
  assert.ok(t.pending.at(-1)?.includes("listing"), `no busy note while dirs() is in flight: ${JSON.stringify(t.pending)}`);
  release(undefined);
  await settle();
  assert.equal(t.pending.at(-1), null, "the busy note clears when the picker opens");
  assert.equal(t.overlays.length, 1, "exactly the directory picker is mounted");
  pickItem(t.overlays[0], { value: "use:/tmp/r4tuifix/work", label: "✓ Use /tmp/r4tuifix/work" });
  assert.equal(await done, "/tmp/r4tuifix/work", "the walk resolves the chosen directory");
});

test("walkDirs failure flashes the error and resolves null — never swaps to another dialog", async () => {
  const t = fakeWalkApp(async () => {
    throw new Error("tunnel to box is down");
  });
  const cwd = await walkDirs(t.app, "");
  assert.equal(cwd, null, "a failed listing resolves null (distinct from esc/undefined)");
  assert.deepEqual(t.flashes, [{ text: "tunnel to box is down", error: true }], "the device error reaches the screen");
  assert.equal(t.overlays.length, 0, "no fallback dialog replaces the failed walk");
  assert.equal(t.pending.at(-1), null, "the busy note clears on failure");
});

test("walkDirs cancel (esc) resolves undefined — the flow's own back door", async () => {
  const t = fakeWalkApp(async () => ({ path: "/tmp/r4tuifix/work", parent: null, dirs: [] }));
  const done = walkDirs(t.app, "");
  await settle();
  assert.equal(t.overlays.length, 1, "the directory picker mounted");
  (t.overlays[0] as { handleInput: (data: string) => void }).handleInput("\x1b"); // esc
  const cwd = await done;
  assert.equal(cwd, undefined, "esc resolves undefined, distinct from a failure");
  assert.equal(t.flashes.length, 0, "cancel flashes nothing");
});
