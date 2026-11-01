// Run-15 Unit A — u3-3 MED (render crash): the /find Panel closure read the
// search response with bare derefs — result.matches.slice/length and
// m.where.includes threw on hostile wire shapes (the SSE/REST payload is a
// JSON.parse cast; `matches` missing and `where` missing are both reachable).
// The Panel body re-runs on EVERY render, so the crash looped the whole TUI.
// RED first at base 0b629ea.
import test from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "../src/commands.ts";
import type { App, DeviceRef } from "../src/app.ts";

/** Just enough App for /find: a recording client + overlay stack. */
function fakeFind(response: unknown) {
  const overlays: unknown[] = [];
  let closes = 0;
  const flashes: { text: string; error: boolean }[] = [];
  const client = { searchSessions: async () => response };
  const device: DeviceRef = { id: "box", name: "box", url: "http://x", token: "t" };
  const app = {
    device,
    client,
    overlay: (component: unknown) => overlays.push(component),
    closeOverlay: () => (closes += 1),
    flash: (text: string, error = false) => flashes.push({ text, error }),
    notify: (text: string, error = false) => flashes.push({ text, error }),
    setPending: () => {},
    logEvent: () => {},
    // Mirror App.run: a thrown device error becomes a toast, never a crash —
    // but the PANEL must not depend on that net either (it renders later).
    run: async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        flashes.push({ text: (e as Error).message, error: true });
      }
    },
  };
  return {
    app: app as never as App,
    overlays,
    flashes,
    mounted: () => overlays.length - closes,
    settle: (ms = 25) => new Promise((r) => setTimeout(r, ms)),
    top: () => overlays[overlays.length - 1] as unknown as { render: (w: number) => string[] },
  };
}

const strip = (lines: string[]) => lines.map((l) => l.replace(/\[[0-9;]*m/g, "").replace(new RegExp(String.fromCharCode(27), "g"), "")).join(String.fromCharCode(10));

const match = (over: Record<string, unknown>) => ({
  id: "s1",
  name: "alpha",
  cwd: "/w/alpha",
  model: "m",
  createdAt: 0,
  dbPath: "/d",
  ...over,
});

test("run-15 u3-3: a response with NO matches array renders the 'No matches' line instead of crashing", async () => {
  const t = fakeFind({ query: "needle" }); // matches key absent entirely
  await runCommand(t.app, "/find needle");
  await t.settle();
  assert.equal(t.mounted(), 1, "the results panel mounted (no crash, no error toast)");
  assert.equal(t.flashes.length, 0, `no toast: ${JSON.stringify(t.flashes)}`);
  const flat = strip(t.top().render(80));
  assert.match(flat, /No matches/, "the empty result is announced in words");
  assert.match(flat, /0 sessions?/, "the header counts zero sessions");
});

test("run-15 u3-3: a match with a missing `where` renders without the transcript marker, no throw", async () => {
  const t = fakeFind({
    query: "needle",
    matches: [match({ where: undefined }), match({ where: null })],
  });
  await runCommand(t.app, "/find needle");
  await t.settle();
  assert.equal(t.mounted(), 1, "the results panel mounted");
  const flat = strip(t.top().render(80));
  assert.doesNotMatch(flat, /transcript/, "no marker without a where array");
  assert.match(flat, /alpha/, "the match row still renders");
});

test("run-15 u3-3: a healthy response keeps the marker, hit lines and count", async () => {
  const t = fakeFind({
    query: "needle",
    matches: [
      match({
        where: ["name", "transcript"],
        hits: [{ agent: "root", entry: 3, kind: "text", text: "found needle here" }],
      }),
    ],
    scanned: { sessions: 4, entries: 90, truncated: true },
  });
  await runCommand(t.app, "/find needle");
  await t.settle();
  assert.equal(t.mounted(), 1);
  const flat = strip(t.top().render(80));
  assert.match(flat, /1 session/, "the header counts one session");
  assert.match(flat, /transcript/, "the transcript marker renders for a real hit");
  assert.match(flat, /found needle here/, "the hit line survives");
  assert.match(flat, /scan budget reached/, "the truncation note survives");
});

test("run-15 u3-3: matches as a non-array (string/number/null) degrades to No matches", async () => {
  for (const bad of ["nope", 42, null]) {
    const t = fakeFind({ query: "needle", matches: bad });
    await runCommand(t.app, "/find needle");
    await t.settle();
    assert.equal(t.mounted(), 1, `panel still mounts for matches=${JSON.stringify(bad)}`);
    assert.equal(t.flashes.length, 0, `no toast for matches=${JSON.stringify(bad)}`);
    assert.match(strip(t.top().render(80)), /No matches/);
  }
});
