// Command-door wiring pinned live in Round 4 — the palette routes through the
// SAME runCommand doors as typed slash commands, so these cases cover both:
//  - bare /thinking opens the level picker, not the "Levels: …" dead end (R4 #2);
//  - bare /name opens the rename Prompt, not "Usage: /name <name>" (R4 #2);
//  - bare /reset asks the y/n the x key always asked (R4 #4);
//  - /tasks mounts a panel with visible content (R4 #3);
//  - /quit exits (unchanged — quitting stays explicit).
import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { runCommand } from "../src/commands.ts";
import type { App, DeviceRef } from "../src/app.ts";
import type { AgentHandle } from "../../dpi-sdk/src/client.ts";

/** Just enough App for the command cases under test. */
function fakeApp(opts: { promptValue?: string | undefined; handle?: boolean } = {}) {
  const flashes: { text: string; error: boolean }[] = [];
  const prompts: { label: string; initial: string }[] = [];
  const overlays: unknown[] = [];
  let closes = 0;
  let exits = 0;
  const configureCalls: unknown[] = [];
  const renameCalls: string[] = [];
  const resetCalls: (string | undefined)[] = [];
  const handle: Partial<AgentHandle> = {
    configure: async (c) => {
      configureCalls.push(c);
      return c as unknown as Awaited<ReturnType<AgentHandle["configure"]>>;
    },
    rename: async (name: string) => {
      renameCalls.push(name);
      return { id: 1, name, kind: "root", busy: false, background: 0, named: true } as unknown as Awaited<
        ReturnType<AgentHandle["rename"]>
      >;
    },
    reset: async (note?: string) => {
      resetCalls.push(note);
      return { ok: true } as unknown as Awaited<ReturnType<AgentHandle["reset"]>>;
    },
    fork: async () => ({ id: 2, name: "fork" }) as never,
  };
  const device: DeviceRef = { id: "box", name: "box", url: "http://x", token: "t" };
  const app = {
    device,
    client: {},
    info: { models: [], defaultModel: "echo", startDirs: [], name: "box" } as never,
    handle: opts.handle === false ? undefined : (handle as AgentHandle),
    sessionId: "s1",
    agentId: 1,
    model: { state: { agent: { thinkingLevel: "low" }, entries: [], items: [] } } as never,
    session: { state: { tasks: [], agents: [] } } as never,
    sessionSummary: () => ({ id: "s1", name: "alpha", cwd: "/tmp/w", agents: [{ id: 1, name: "scout-agent", kind: "root" as const, busy: false, background: 0, named: true }] }) as never,
    run: async (fn: () => Promise<unknown>) => {
      await fn();
    },
    flash: (text: string, error = false) => flashes.push({ text, error }),
    notify: (text: string, error = false) => flashes.push({ text, error }),
    overlay: (component: unknown) => {
      overlays.push(component);
    },
    closeOverlay: () => {
      closes += 1;
    },
    prompt: async (label: string, initial: string) => {
      prompts.push({ label, initial });
      return opts.promptValue;
    },
    resetContext: async (note?: string) => {
      resetCalls.push(note);
    },
    logEvent: () => {},
    exit: () => {
      exits += 1;
    },
  };
  return {
    app: app as never as App,
    flashes,
    prompts,
    overlays,
    closes: () => closes,
    exits: () => exits,
    configureCalls,
    renameCalls,
    resetCalls,
  };
}

const strip = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

test("bare /thinking opens the level picker (the palette door)", async () => {
  const t = fakeApp();
  // The command promise resolves only when the mounted picker is answered —
  // assert the mounting first, then drive esc (exactly the keys a user sends).
  const running = runCommand(t.app, "/thinking");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.overlays.length, 1, "the thinking picker mounted");
  assert.equal(t.flashes.length, 0, "no dead-end flash");
  const visible = strip((t.overlays[0] as { render: (w: number) => string[] }).render(60));
  assert.match(visible, /Thinking level/);
  assert.match(visible, /off/, "the levels are listed in the picker");
  // esc cancels: picker closes with no configure call.
  (t.overlays[0] as { handleInput: (data: string) => void }).handleInput("\x1b");
  assert.equal(await running, true);
  assert.equal(t.closes(), 1, "esc closed the picker");
  assert.equal(t.configureCalls.length, 0, "cancel configures nothing");
});

test("/thinking <level> still sets directly, and a missing session explains itself", async () => {
  const t = fakeApp();
  assert.equal(await runCommand(t.app, "/thinking high"), true);
  assert.deepEqual(t.configureCalls, [{ thinkingLevel: "high" }]);
  assert.equal(t.overlays.length, 0, "no picker for an explicit level");

  const none = fakeApp({ handle: false });
  assert.equal(await runCommand(none.app, "/thinking high"), true);
  assert.match(none.flashes[0]!.text, /Pick a session first/);
  assert.equal(none.configureCalls.length, 0);
});

test("bare /name opens the rename Prompt; submitting renames, empty cancels", async () => {
  const t = fakeApp({ promptValue: "  scout  " });
  assert.equal(await runCommand(t.app, "/name"), true);
  assert.deepEqual(t.prompts, [{ label: "Agent name", initial: "scout-agent" }], "the Prompt preseeds the current name");
  assert.deepEqual(t.renameCalls, ["scout"], "the trimmed prompt value reached rename");
  assert.equal(t.overlays.length, 0, "app.prompt is the overlay — nothing else mounted");

  const cancelled = fakeApp({ promptValue: undefined });
  assert.equal(await runCommand(cancelled.app, "/name"), true);
  assert.match(cancelled.flashes.at(-1)!.text, /rename cancelled/);
  assert.equal(cancelled.renameCalls.length, 0);

  const empty = fakeApp({ promptValue: "   " });
  assert.equal(await runCommand(empty.app, "/name"), true);
  assert.match(empty.flashes.at(-1)!.text, /rename cancelled/);

  const direct = fakeApp();
  assert.equal(await runCommand(direct.app, "/name bob"), true);
  assert.deepEqual(direct.renameCalls, ["bob"], "an explicit /name argument skips the Prompt");
});

test("bare /reset asks y/n; y resets, n cancels, a handoff note skips the gate", async () => {
  const yes = fakeApp({ promptValue: "y" });
  assert.equal(await runCommand(yes.app, "/reset"), true);
  assert.match(yes.prompts[0]!.label, /reset .*y\/n/i, "the confirm names the session and offers y/n");
  assert.deepEqual(yes.resetCalls, [undefined], "y runs the shared reset tail");

  const no = fakeApp({ promptValue: "n" });
  assert.equal(await runCommand(no.app, "/reset"), true);
  assert.match(no.flashes.at(-1)!.text, /reset cancelled/);
  assert.equal(no.resetCalls.length, 0, "n never wipes the context");

  const esc = fakeApp({ promptValue: undefined });
  assert.equal(await runCommand(esc.app, "/reset"), true);
  assert.equal(esc.resetCalls.length, 0, "esc at the confirm cancels");

  const note = fakeApp();
  assert.equal(await runCommand(note.app, "/reset fresh start"), true);
  assert.equal(note.prompts.length, 0, "a typed handoff note carries its own intent");
  assert.deepEqual(note.resetCalls, ["fresh start"]);
});

test("/tasks mounts a panel with visible content at 80 cols", async () => {
  const t = fakeApp();
  assert.equal(await runCommand(t.app, "/tasks"), true);
  assert.equal(t.overlays.length, 1, "the tasks panel mounted");
  const lines = (t.overlays[0] as { render: (w: number) => string[] }).render(80);
  const visible = strip(lines);
  assert.ok(lines.length > 0, "the panel is not empty");
  assert.ok(visible.trim().length > 10, "the panel shows visible text");
  assert.match(visible, /Live tasks in alpha/);
  assert.match(visible, /No live tasks\./, "an empty task list is announced");
  assert.match(visible, /esc close/, "the panel teaches its close key");
  for (const line of lines) assert.ok(visibleWidth(line) <= 80, "no tasks-panel line exceeds 80 visible cols");
});

test("/quit exits the app (the one explicit exit on the command door)", async () => {
  const t = fakeApp();
  assert.equal(await runCommand(t.app, "/quit"), true);
  assert.equal(t.exits(), 1);
});
