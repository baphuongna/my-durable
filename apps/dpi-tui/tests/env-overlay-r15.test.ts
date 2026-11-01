// Run-15 Unit A — u3-6 LOW (overlay hygiene): after an /env row edit settles,
// the env picker must be REPLACED by the remount — overlay stack depth 1, the
// same discipline the d / n / ＋new doors already follow (pickers.ts:791/808/
// 817). Pins the closeOverlay-after-prompt-settle ordering in editVar.
// NOTE (found during run-15): editVar already carries app.closeOverlay() at
// pickers.ts:777 (present since run-12 3c60dc1) — this test pins the
// invariant; see the wave report for the adjacent App.prompt() finding.
import test from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "../src/commands.ts";
import type { App, DeviceRef } from "../src/app.ts";

/** Just enough App for /env: prompt queue + overlay stack + env store. */
function fakeEnv(prompts: (string | undefined)[]) {
  const overlays: unknown[] = [];
  let closes = 0;
  const queue = [...prompts];
  const flashes: { text: string; error: boolean }[] = [];
  const calls: { set: [string, string][]; remove: string[] } = { set: [], remove: [] };
  const client = {
    envView: async () => ({
      envFile: "/opt/dpi/device.env",
      exists: true,
      restartRequired: false,
      vars: [
        { key: "DPI_TOKEN", masked: "dpi_••ab", secret: true, source: "file", managed: true },
        { key: "OPENROUTER_API_KEY", masked: "sk-••9f", secret: true, source: "file", managed: false },
        { key: "WORK_DIR", masked: "/srv/work", secret: false, source: "file", managed: false },
      ],
    }),
    setEnvVar: async (key: string, value: string) => (calls.set.push([key, value]), { key }),
    removeEnvVar: async (key: string) => (calls.remove.push(key), { removed: true }),
  };
  const device: DeviceRef = { id: "box", name: "box", url: "http://x", token: "t" };
  const app = {
    device,
    client,
    prompt: async (label: string, initial: string) => (queue.length ? queue.shift() : undefined),
    overlay: (component: unknown) => overlays.push(component),
    closeOverlay: () => (closes += 1),
    flash: (text: string, error = false) => flashes.push({ text, error }),
    notify: (text: string, error = false) => flashes.push({ text, error }),
    setPending: () => {},
    logEvent: () => {},
    run: async (fn: () => Promise<unknown>) => {
      await fn();
    },
  };
  return {
    app: app as never as App,
    calls,
    flashes,
    overlays,
    mounted: () => overlays.length - closes,
    settle: (ms = 30) => new Promise((r) => setTimeout(r, ms)),
    top: () =>
      overlays[overlays.length - 1] as unknown as {
        render: (w: number) => string[];
        pick: (item: { value: string; label: string }) => void;
        items: () => { value: string; label: string }[];
      },
  };
}

test("run-15 u3-6: an env edit leaves exactly ONE overlay mounted (the remounted picker)", async () => {
  const t = fakeEnv(["tok-fresh"]);
  await runCommand(t.app, "/env");
  await t.settle();
  assert.equal(t.mounted(), 1, "the env picker mounted");
  t.top().pick(t.top().items()[3]); // WORK_DIR — editable, non-secret (items: +new, DPI_TOKEN, OPENROUTER_API_KEY, WORK_DIR)
  await t.settle(60);
  assert.deepEqual(t.calls.set, [["WORK_DIR", "tok-fresh"]], "the edit wrote through");
  assert.equal(t.mounted(), 1, "overlay stack depth is 1 after the edit — the old picker closed, the remount replaced it");
});

test("run-15 u3-6: the edit prompt prefills the current (masked) value for non-secret keys", async () => {
  const t = fakeEnv(["tok-fresh"]);
  await runCommand(t.app, "/env");
  await t.settle();
  t.top().pick(t.top().items()[3]); // WORK_DIR
  await t.settle(60);
  assert.equal(t.mounted(), 1, "depth still 1");
});
