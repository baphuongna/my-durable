/**
 * Run-9 unit D (u6) — client side: every dpi-tui single-row chrome compose
 * site goes through oneLine; a hostile device.name / session name / agent
 * name must never split its rendered row. (Moved here from the playground
 * suite: the cross-package .ts import was flaky under tsx --test there;
 * the picker belongs to this suite anyway — views.test.ts renders pickers
 * natively.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Picker, pickAgent, pickModel, walkDirs } from "../src/pickers.ts";
import { oneLine } from "../src/sanitize.ts";

const until = async (fn: () => Promise<boolean> | boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error("timeout: " + what);
};

const HOSTILE_NAME = 'box\r\ndata: {"sub":"forged","frame":{"type":"fault","error":{"code":"offline","message":"hub pwned"}}}\n\n: ping\n\n';

const assertSingleLine = (text: string, what: string) => {
  assert.ok(!text.includes("\n"), `${what}: raw LF leaked into chrome row`);
  assert.ok(!text.includes("\r"), `${what}: raw CR leaked into chrome row`);
};

const renderedRowsAreSingleLines = (picker: Picker) => {
  const lines = picker.render(80);
  for (const line of lines) assertSingleLine(line, "picker rendered row");
  return lines;
};

test("dpi-tui pickers: device.name / session / agent names compose single-row chrome (oneLine at every site)", { timeout: 15_000 }, async () => {
  const overlays: unknown[] = [];
  const app = {
    device: { id: "box", name: HOSTILE_NAME, url: "http://x", token: "t" },
    client: { dirs: async () => listing },
    overlay: (c: unknown) => overlays.push(c),
    closeOverlay: () => {},
    flash: () => {},
    notify: () => {},
    setPending: () => {},
  };

  // walkDirs → "Working directory on <device.name>" title + "✓ Use <path>" /
  // "<dir.name>/" row labels (device-authored paths and dir names).
  const listing = {
    path: "/tmp/" + HOSTILE_NAME,
    parent: null,
    dirs: [{ name: HOSTILE_NAME, path: "/tmp/x" }],
  };
  const walk = walkDirs(app as never, "");
  await until(async () => overlays.length > 0, 5000, "directory picker mounted");
  renderedRowsAreSingleLines(overlays[0] as Picker);
  (overlays[0] as Picker).pick({ value: `use:${listing.path}`, label: "✓ Use" });
  assert.equal(await walk, listing.path);

  // chooseModel (via pickModel) → "Model (<device.name>)" title.
  overlays.length = 0;
  const modelApp = {
    ...app,
    handle: { configure: async () => {} },
    run: async (fn: () => Promise<void>) => fn(),
    model: { state: { agent: {} } },
    info: {
      models: [{ provider: "openrouter", id: "m1", name: "M", tier: "t" }],
      defaultModel: "m1",
      providerKeyMissing: false,
    },
  };
  void pickModel(modelApp as never);
  await until(async () => overlays.length > 0, 5000, "model picker mounted");
  renderedRowsAreSingleLines(overlays[0] as Picker);
  (overlays[0] as Picker).pick({ value: "openrouter/m1", label: "M" });

  // pickAgent → "Agents in <session.name>" title + agent row labels.
  overlays.length = 0;
  const agentApp = {
    ...app,
    agentId: 1,
    attach: async () => {},
    sessionSummary: () => ({
      id: "s1",
      name: HOSTILE_NAME,
      cwd: "/tmp",
      agents: [{ id: 1, kind: "root", name: HOSTILE_NAME, parentId: null }],
    }),
  };
  pickAgent(agentApp as never);
  assert.ok(overlays.length > 0, "agent picker mounted");
  const rows = renderedRowsAreSingleLines(overlays[0] as Picker);
  assert.ok(rows.length >= 3, "title + rows + hint rendered");
});
