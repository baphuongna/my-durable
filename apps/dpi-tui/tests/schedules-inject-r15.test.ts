// Run-15 Unit A — u3-1 HIGH (terminal injection): triggerOf interpolated the
// wire's `everyMinutes` RAW into the :schedules row (only dailyAt was
// oneLine'd one line below). everyMinutes is typed number by convention only —
// a hostile device/hub can ride a string carrying an OSC payload
// (ESC ] 0 ; pwned BEL — a terminal title-set injection) straight into the
// picker row, and pi-tui writes rows verbatim to stdout.
// RED first: at base 0b629ea the rendered row carries the ESC byte.
// (Control bytes are built with String.fromCharCode so the source stays free
// of literal escape characters — the fixture equals what JSON.parse would
// deliver for the hunter's probe payload.)
import test from "node:test";
import assert from "node:assert/strict";
import { pickSchedules } from "../src/pickers.ts";
import type { App, DeviceRef } from "../src/app.ts";
import type { ScheduleView } from "../../dpi-sdk/src/api.ts";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
/** The OSC title-set payload a hostile relay rides in a string-typed field. */
const OSC_TITLE = ESC + "]0;pwned" + BEL;
/** Theme SGR (ESC [ … m) is trusted chrome — strip only those for the leak
 *  assertions; any OTHER escape sequence (OSC/CSI/DCS) stays exposed. */
const SGR = new RegExp(ESC + "[[][0-9;]*m", "g");
const inert = (line: string) => line.replace(SGR, "");

const schedule = (over: Partial<ScheduleView>): ScheduleView =>
  ({
    id: "sch-x",
    name: "sweep",
    cwd: "/w",
    model: { provider: "openrouter", modelId: "m" },
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    nextRunAt: 0,
    running: false,
    ...over,
  }) as ScheduleView;

/** Just enough App for pickSchedules: overlay stack + prompt queue. */
function fakeSched() {
  const overlays: unknown[] = [];
  let closes = 0;
  const flashes: { text: string; error: boolean }[] = [];
  const client = {
    schedules: async () => ({
      schedules: [
        // run-15 u3-1 fixture: a hostile STRING in the number-typed field —
        // the exact class the hunter probed (OSC title-set injection).
        schedule({ id: "sch-evil", everyMinutes: OSC_TITLE as unknown as number }),
        schedule({ id: "sch-ok", everyMinutes: 45 }),
      ],
    }),
    runSchedule: async (id: string) => ({ id, name: "sweep" }),
    updateSchedule: async () => ({}),
    removeSchedule: async () => ({}),
    createSchedule: async () => ({}),
  };
  const device: DeviceRef = { id: "box", name: "box", url: "http://x", token: "t" };
  const app = {
    device,
    client,
    prompt: async () => undefined,
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
    overlays,
    flashes,
    mounted: () => overlays.length - closes,
    settle: (ms = 25) => new Promise((r) => setTimeout(r, ms)),
    top: () =>
      overlays[overlays.length - 1] as unknown as {
        render: (w: number) => string[];
        items: () => { value: string; label: string; description?: string }[];
      },
  };
}

test("run-15 u3-1: a hostile everyMinutes string never carries ESC into the rendered :schedules row", async () => {
  const t = fakeSched();
  await pickSchedules(t.app);
  await t.settle();
  assert.equal(t.mounted(), 1, "the schedules picker mounted");
  const lines = t.top().render(80);
  for (const line of lines) {
    assert.equal(inert(line).includes(ESC), false, `ESC leaked into a picker row: ${JSON.stringify(line)}`);
  }
  const visible = lines.map(inert).join(" | ");
  assert.doesNotMatch(visible, /pwned/, "the OSC payload text must not reach the row");
  assert.match(visible, /every [?]m/, "a hostile string degrades to `every ?m` (Number-coerce like renderOps)");
  // The legitimate row is untouched.
  assert.match(visible, /every 45m/);
});

test("run-15 u3-1: hostile fields never split a picker row (run-9 invariant holds)", async () => {
  const t = fakeSched();
  await pickSchedules(t.app);
  await t.settle();
  const lines = t.top().render(80);
  const LF = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  for (const line of lines) {
    assert.ok(!line.includes(LF) && !line.includes(CR), `raw CR/LF leaked: ${JSON.stringify(line)}`);
  }
});
