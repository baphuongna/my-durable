// Run-12 Unit B — the five device-ops command doors (:schedules :env :notify
// :usage :vitals), pinned in the commands.test.ts style: a fake App whose
// client stubs the SDK ops, driven exactly the keys an operator sends. The
// run-9 invariant rides every case: device-authored text (schedule names, sink
// urls, env values) must never split a rendered row, so hostile \n\r fixtures
// are used on purpose and every picker/log line is asserted single-line.
import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { COMMANDS, fmtBytes, fmtDur, runCommand } from "../src/commands.ts";
import { parseScheduleTrigger } from "../src/pickers.ts";
import type { App, DeviceRef } from "../src/app.ts";

/** A name a hostile relay might ride in — the run-9 fixture shape. */
const HOSTILE = "nightly\n DIGEST\r";

/** Just enough App for the ops doors: recording client, prompt queue, overlays. */
function fakeOps(opts: { prompts?: (string | undefined)[] } = {}) {
  const flashes: { text: string; error: boolean }[] = [];
  const logEvents: { glyph: string; text: string }[] = [];
  const overlays: unknown[] = [];
  const pending: (string | null)[] = [];
  const prompts: { label: string; initial: string }[] = [];
  const queue = [...(opts.prompts ?? [])];
  let closes = 0;

  // A live in-memory store: mutations apply, so the remounted picker shows the
  // post-action state exactly the way the device would answer a refetch.
  // (Loose record type on purpose — the wire shape is the SDK's business, the
  // harness only needs the fields the flows read.)
  const schedules: (Record<string, unknown> & { id: string })[] = [
    {
      id: "sch-1",
      name: HOSTILE,
      cwd: "/srv/work",
      model: { provider: "openrouter", modelId: "m" },
      everyMinutes: 30,
      enabled: true,
      nextRunAt: 1_800_000_000_000,
      running: false,
      // r12 review m1 fixtures: the OTHER device-authored fields of the row —
      // lastOutcome and dailyAt — must collapse like the name does.
      lastOutcome: "ok\n but lagged\r",
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: "sch-2",
      name: "morning",
      cwd: "/srv/other",
      model: { provider: "openrouter", modelId: "m" },
      // r12 review m1: hostile dailyAt — the trigger string is device-authored
      // and used to ride the row raw (triggerOf had no oneLine).
      dailyAt: "09:30\n evil\r",
      enabled: false,
      nextRunAt: null,
      running: false,
      createdAt: 0,
      updatedAt: 0,
    },
  ];
  const calls = {
    schedules: 0,
    run: [] as string[],
    update: [] as [string, unknown][],
    remove: [] as string[],
    create: [] as unknown[],
    envView: 0,
    setEnv: [] as [string, string][],
    removeEnv: [] as string[],
    sinks: 0,
    test: 0,
    vitals: 0,
    usage: 0,
    dirs: 0,
  };
  const client = {
    schedules: async () => (calls.schedules++, { schedules }),
    runSchedule: async (id: string) => (calls.run.push(id), schedules.find((s) => s.id === id)),
    updateSchedule: async (id: string, patch: object) => {
      calls.update.push([id, patch]);
      return Object.assign(schedules.find((s) => s.id === id)!, patch);
    },
    removeSchedule: async (id: string) => {
      calls.remove.push(id);
      schedules.splice(
        schedules.findIndex((s) => s.id === id),
        1,
      );
      return { removed: true };
    },
    createSchedule: async (input: Record<string, unknown>) => {
      calls.create.push(input);
      const made = { id: "sch-new", ...input, enabled: true, nextRunAt: 0, running: false, createdAt: 0, updatedAt: 0 };
      schedules.push(made);
      return made;
    },
    envView: async () => (
      calls.envView++,
      {
        envFile: "/opt/dpi/device.env",
        exists: true,
        restartRequired: true,
        vars: [
          { key: "DPI_TOKEN", masked: "dpi_••ab", secret: true, source: "file", managed: true },
          { key: "OPENROUTER_API_KEY", masked: "sk-••9f", secret: true, source: "file", managed: false },
          { key: "PATH", masked: "/usr/bin:…", secret: false, source: "process", managed: false },
          { key: "WORK_DIR", masked: "/srv/work", secret: false, source: "file", managed: false },
        ],
      }
    ),
    setEnvVar: async (key: string, value: string) => (
      calls.setEnv.push([key, value]),
      { key, masked: "•", secret: false, source: "file", managed: false }
    ),
    removeEnvVar: async (key: string) => (calls.removeEnv.push(key), { removed: true }),
    notifySinks: async () => (
      calls.sinks++,
      {
        sinks: [
          {
            id: "sink-1",
            kind: "webhook",
            url: "https://hooks.example/xy\n evil",
            enabled: true,
            createdAt: 0,
            updatedAt: 0,
            silencedUntil: null,
            lastStatus: 200,
          },
          {
            id: "sink-2",
            kind: "ntfy",
            url: "https://ntfy.example/topic",
            enabled: false,
            createdAt: 0,
            updatedAt: 0,
            silencedUntil: null,
            lastError: "404 gone\nbad",
          },
          {
            // r12 review m1: the label path is NEVER LF-normalized by pi-tui —
            // a hostile `kind` (and a string `lastStatus`) must collapse at
            // compose time, not by the description-only normalizer.
            id: "sink-3",
            kind: "web\nhook\r",
            url: "https://ok.example",
            enabled: true,
            createdAt: 0,
            updatedAt: 0,
            silencedUntil: null,
            lastStatus: "20\n0 evil\r" as unknown as number,
          },
        ],
      }
    ),
    testNotifySinks: async () => (
      calls.test++,
      {
        results: [
          { id: "sink-1", kind: "webhook", status: "sent", ms: 120 },
          { id: "sink-2", kind: "ntfy", status: "failed", detail: "404 not found\nretry" },
        ],
      }
    ),
    vitals: async () => (
      calls.vitals++,
      {
        uptime: 183600,
        processUptime: 3600,
        loadavg: [0.5, 0.4, 0.3],
        cpuCount: 8,
        memory: {
          totalBytes: 16 * 1024 ** 3,
          freeBytes: 8 * 1024 ** 3,
          usedBytes: 8 * 1024 ** 3,
          processRssBytes: 512 * 1024 ** 2,
          heapUsedBytes: 256 * 1024 ** 2,
        },
        disk: { path: "/var/lib/dpi", totalBytes: 512 * 1024 ** 3, freeBytes: 210 * 1024 ** 3, known: true },
        eventLoop: { lagMsLast: 2, lagMsMax1m: 14, samples: 60 },
        gitSpawns: { live: 2, queued: 3, queuedHigh: 1 },
        pid: 4242,
        at: 0,
        counts: { sessions: 12, archived: 3 },
      }
    ),
    deviceUsage: async () => (
      calls.usage++,
      {
        at: 1_800_000_000_000,
        totals: { tokens: 1_234_567, cost: 12.34 },
        models: [
          {
            key: "openrouter/m1",
            tokens: 1_000_000,
            cost: 10,
            input: 600_000,
            output: 400_000,
            cacheRead: 100_000,
            cacheWrite: 0,
            inputCost: 6,
            outputCost: 4,
            cacheReadCost: 0,
            cacheWriteCost: 0,
          },
        ],
        sessions: [
          { id: "s1", name: "alpha", cwd: "/srv/work", tokens: 900_000, cost: 9, agents: 3 },
          { id: "s2", name: "beta", cwd: "/srv/other", tokens: 334_567, cost: 3.34, agents: 1 },
        ],
        projects: [{ rootPath: "/srv/work", name: "work", tokens: 900_000, cost: 9, sessions: 1 }],
      }
    ),
    dirs: async () => (calls.dirs++, { path: "/srv/work", parent: null, dirs: [] }),
  };

  const device: DeviceRef = { id: "box", name: "box", url: "http://x", token: "t" };
  const app = {
    device,
    client,
    info: { models: [], defaultModel: "m", startDirs: [], name: "box" },
    handle: undefined,
    sessionId: undefined,
    agentId: undefined,
    cwd: () => undefined,
    model: { state: { agent: {}, entries: [], items: [] } },
    session: { state: { tasks: [], agents: [] } },
    sessionSummary: () => undefined,
    run: async (fn: () => Promise<unknown>) => {
      // Mirrors App.run: a thrown device error becomes a toast, never a crash.
      try {
        await fn();
      } catch (e) {
        flashes.push({ text: (e as Error).message, error: true });
      }
    },
    flash: (text: string, error = false) => flashes.push({ text, error }),
    notify: (text: string, error = false) => flashes.push({ text, error }),
    overlay: (component: unknown) => overlays.push(component),
    closeOverlay: () => {
      closes += 1;
    },
    prompt: async (label: string, initial: string) => {
      prompts.push({ label, initial });
      return queue.length ? queue.shift() : undefined;
    },
    setPending: (text: string | null) => pending.push(text),
    logEvent: (glyph: string, text: string) => logEvents.push({ glyph, text }),
    exit: () => {},
  };
  return {
    app: app as never as App,
    flashes,
    logEvents,
    prompts,
    pending,
    calls,
    schedules,
    settle: (ms = 25) => new Promise((r) => setTimeout(r, ms)),
    mounted: () => overlays.length - closes,
    top: () =>
      overlays[overlays.length - 1] as unknown as {
        render: (w: number) => string[];
        handleInput: (data: string) => void;
        items: () => { value: string; label: string; description?: string }[];
        pick: (item: { value: string; label: string }) => void;
      },
  };
}

const strip = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

/** Run-9 invariant: chrome rows are single lines and fit the terminal. */
const assertRows = (lines: string[]) => {
  for (const line of lines) {
    assert.ok(!line.includes("\n") && !line.includes("\r"), `raw CR/LF leaked into a picker row: ${JSON.stringify(line)}`);
    assert.ok(visibleWidth(line) <= 80, `row exceeds 80 visible cols: ${JSON.stringify(line)}`);
  }
};

test("COMMANDS registers the five run-12 ops doors", () => {
  const names = COMMANDS.map((c) => c.name);
  for (const n of ["schedules", "env", "notify", "usage", "vitals"])
    assert.ok(names.includes(n), `${n} missing from COMMANDS`);
  assert.equal(names.length, 23, "16 existing + 5 run-12 doors + 2 run-13 doors (:export :archive)");
});

test("fmtBytes/fmtDur short forms keep vitals chrome to one line", () => {
  assert.equal(fmtDur(183600), "2d3h");
  assert.equal(fmtDur(5 * 3600 + 60), "5h01m");
  assert.equal(fmtDur(45), "45s");
  assert.equal(fmtBytes(512 * 1024 ** 2), "512M");
  assert.equal(fmtBytes(8 * 1024 ** 3), "8.0G");
  assert.equal(fmtBytes(42), "42B");
});

test("parseScheduleTrigger accepts the two device triggers and refuses the rest", () => {
  assert.deepEqual(parseScheduleTrigger("every 30"), { everyMinutes: 30 });
  assert.deepEqual(parseScheduleTrigger("  EVERY 45m "), { everyMinutes: 45 });
  assert.deepEqual(parseScheduleTrigger("daily 09:30"), { dailyAt: "09:30" });
  assert.deepEqual(parseScheduleTrigger("Daily 9:05"), { dailyAt: "09:05" });
  for (const bad of ["every 3", "every 1441", "every", "daily 24:00", "daily 09:60", "* * * * *", "cron 5m", ""])
    assert.equal(parseScheduleTrigger(bad), undefined, `"${bad}" must not parse`);
});

test(":schedules lists triggers, next-run and enabled glyphs on single-line rows", async () => {
  const t = fakeOps();
  assert.equal(await runCommand(t.app, "/schedules"), true);
  await t.settle();
  assert.equal(t.mounted(), 1, "the schedules picker mounted");
  const lines = t.top().render(80);
  assertRows(lines);
  const visible = strip(lines);
  assert.match(visible, /Schedules on box/);
  assert.match(visible, /● nightly DIGEST/, "the hostile \\n in the name collapsed (run-9)");
  assert.match(visible, /every 30m/);
  // the 80-col description column truncates — "last ok bu" proves the \n
  // collapsed to a space (raw "ok\n but" would break the row or read "last ok").
  assert.match(visible, /last ok bu/, "r12 m1: hostile lastOutcome collapsed");
  assert.match(visible, /daily 09:30 evil/, "r12 m1: hostile dailyAt collapsed (triggerOf)");
  assert.match(visible, /○ morning/);
  assert.match(visible, /esc close/, "the hint's exit verb survives at 80 cols");
});

test(":schedules enter runs the highlighted schedule now and remounts fresh state", async () => {
  const t = fakeOps();
  await runCommand(t.app, "/schedules");
  await t.settle();
  t.top().handleInput("j"); // off the ＋new row onto the first schedule
  t.top().pick(t.top().items()[1]);
  await t.settle(50);
  assert.deepEqual(t.calls.run, ["sch-1"], "enter ran the schedule through runSchedule");
  assert.ok(t.flashes.some((f) => /nightly DIGEST/.test(f.text) && !f.error), `run toast: ${JSON.stringify(t.flashes)}`);
  assert.ok(t.logEvents.some((e) => e.glyph === "sched" && /triggered by hand/.test(e.text)));
  assert.equal(t.mounted(), 1, "a fresh picker replaced the old one");
  assert.equal(t.calls.schedules, 2, "the replacement refetched the list");
});

test(":schedules t toggles enabled via updateSchedule and the fresh row shows it", async () => {
  const t = fakeOps();
  await runCommand(t.app, "/schedules");
  await t.settle();
  t.top().handleInput("j");
  t.top().handleInput("t");
  await t.settle(50);
  assert.deepEqual(t.calls.update, [["sch-1", { enabled: false }]], "t flipped the enabled flag");
  assert.ok(t.flashes.some((f) => /disabled/.test(f.text) && !f.error));
  assertRows(t.top().render(80));
  assert.match(strip(t.top().render(80)), /○ nightly DIGEST/, "the remounted picker shows the new state");
});

test(":schedules d asks y/n — y deletes and remounts, n keeps everything", async () => {
  const yes = fakeOps({ prompts: ["y"] });
  await runCommand(yes.app, "/schedules");
  await yes.settle();
  yes.top().handleInput("j");
  yes.top().handleInput("d");
  await yes.settle(50);
  assert.match(yes.prompts[0]!.label, /Delete schedule nightly DIGEST\? y\/n/, "the confirm oneLines the hostile name");
  assert.deepEqual(yes.calls.remove, ["sch-1"]);
  assert.equal(yes.schedules.length, 1, "the store dropped the row");

  const no = fakeOps({ prompts: ["n"] });
  await runCommand(no.app, "/schedules");
  await no.settle();
  no.top().handleInput("j");
  no.top().handleInput("d");
  await no.settle(50);
  assert.equal(no.calls.remove.length, 0, "n never deletes");
  assert.equal(no.mounted(), 1, "a cancelled confirm leaves the picker up");
});

test(":schedules n chains name → trigger → cwd (walkDirs) → prompt and creates the schedule", async () => {
  const t = fakeOps({ prompts: ["digest", "every 45m", "summarize the day"] });
  await runCommand(t.app, "/schedules");
  await t.settle();
  t.top().handleInput("n");
  await t.settle(); // name + trigger prompts answer instantly (fake); walkDirs mounts
  assert.ok(t.mounted() >= 1, "the directory walker mounted");
  t.top().pick(t.top().items()[0]); // "✓ Use /srv/work"
  await t.settle(60);
  assert.deepEqual(t.calls.create, [
    { name: "digest", cwd: "/srv/work", prompt: "summarize the day", everyMinutes: 45 },
  ]);
  assert.ok(t.flashes.some((f) => /digest created/.test(f.text) && !f.error), JSON.stringify(t.flashes));
  assert.equal(t.mounted(), 1, "the list remounted");
  assert.match(strip(t.top().render(80)), /every 45m/, "the new schedule appears in the fresh list");
});

test(":env lists key=value with read-only marks; enter edits only file vars", async () => {
  const t = fakeOps({ prompts: ["sk-fresh-2"] });
  await runCommand(t.app, "/env");
  await t.settle();
  const lines = t.top().render(80);
  assertRows(lines);
  const visible = strip(lines);
  assert.match(visible, /OPENROUTER_API_KEY=sk-••9f/);
  assert.match(visible, /read-only/);
  assert.match(visible, /restart the device to apply/, "the restart banner rides the picker subtitle");
  // Editing a secret prefills BLANK (a prefilled mask would overwrite the value).
  t.top().pick(t.top().items()[2]); // OPENROUTER_API_KEY
  await t.settle(50);
  assert.equal(t.prompts[0]!.initial, "", "a secret prefills blank — never its mask");
  assert.deepEqual(t.calls.setEnv, [["OPENROUTER_API_KEY", "sk-fresh-2"]]);

  // A managed key refuses the edit door outright.
  const ro = fakeOps();
  await runCommand(ro.app, "/env");
  await ro.settle();
  ro.top().pick(ro.top().items()[1]); // DPI_TOKEN (managed)
  await ro.settle();
  assert.equal(ro.calls.setEnv.length, 0);
  assert.match(ro.flashes.at(-1)!.text, /DPI_TOKEN is read-only/);

  // An empty submit cancels instead of clearing the variable.
  const empty = fakeOps({ prompts: [""] });
  await runCommand(empty.app, "/env");
  await empty.settle();
  empty.top().pick(empty.top().items()[2]);
  await empty.settle();
  assert.equal(empty.calls.setEnv.length, 0, "an empty submit never writes");
  assert.match(empty.flashes.at(-1)!.text, /cancelled/);
});

test(":env d removes with confirm; n sets a brand-new key", async () => {
  const t = fakeOps({ prompts: ["y", "MY_TOOL_TOKEN", "tok-123"] });
  await runCommand(t.app, "/env");
  await t.settle();
  // items: [＋new, DPI_TOKEN, OPENROUTER_API_KEY, PATH, WORK_DIR] — four downs
  // land on WORK_DIR, the one editable non-secret row.
  for (let i = 0; i < 4; i++) t.top().handleInput("j");
  t.top().handleInput("d");
  await t.settle(50);
  assert.match(t.prompts[0]!.label, /Remove WORK_DIR from the env file\? y\/n/);
  assert.deepEqual(t.calls.removeEnv, ["WORK_DIR"]);
  // n → key → value → one setEnvVar
  t.top().handleInput("n");
  await t.settle(60);
  assert.deepEqual(t.calls.setEnv, [["MY_TOOL_TOKEN", "tok-123"]]);
  assert.ok(t.flashes.some((f) => /MY_TOOL_TOKEN saved/.test(f.text) && !f.error));
});

test(":notify lists sinks single-line; t fires the test and toasts the tally — no CRUD door", async () => {
  const t = fakeOps();
  await runCommand(t.app, "/notify");
  await t.settle();
  assert.equal(t.mounted(), 1);
  const lines = t.top().render(80);
  assertRows(lines);
  const visible = strip(lines);
  assert.match(visible, /● webhook/);
  assert.match(visible, /hooks\.example\/xy evil/, "the hostile \\n in the url collapsed (run-9)");
  assert.match(visible, /○ ntfy/);
  assert.match(visible, /● web hook/, "r12 m1: hostile kind collapsed in the LABEL path");
  assert.match(visible, /last 20 0 evil/, "r12 m1: hostile string lastStatus collapsed");
  assert.ok(!visible.includes("d delete") && !visible.includes("n new"), "no CRUD hotkeys are advertised");
  t.top().handleInput("t");
  await t.settle(50);
  assert.equal(t.calls.test, 1, "t fired testNotifySinks once");
  assert.ok(
    t.flashes.some((f) => /1 sent/.test(f.text) && /1 failed/.test(f.text) && !f.error),
    `tally toast: ${JSON.stringify(t.flashes)}`,
  );
  assert.ok(t.logEvents.filter((e) => e.glyph === "notify").length >= 2, "one log line per sink result");
  assert.equal(t.mounted(), 1, "testing is read-only — the list stays up");
});

test(":vitals and :usage toast one line and dump single-line detail into the log view", async () => {
  const t = fakeOps();
  await runCommand(t.app, "/vitals");
  assert.equal(t.calls.vitals, 1);
  assert.ok(
    t.flashes.some((f) => /up 2d3h/.test(f.text) && /lag 14ms/.test(f.text) && !f.error),
    `vitals toast: ${JSON.stringify(t.flashes)}`,
  );
  const v = t.logEvents.filter((e) => e.glyph === "vitals");
  assert.ok(v.length >= 6, "the full report lands in the log view");
  assert.ok(v.some((e) => /git spawns 2 live · 3 queued · 1 queued-high/.test(e.text)), "gitSpawns made the dump");
  assert.ok(v.some((e) => /event-loop lag 2ms last · 14ms max\/1m/.test(e.text)));

  await runCommand(t.app, "/usage");
  assert.equal(t.calls.usage, 1);
  assert.ok(
    t.flashes.some((f) => /1,234,567 tokens/.test(f.text) && /\$12\.34/.test(f.text) && !f.error),
    `usage toast: ${JSON.stringify(t.flashes)}`,
  );
  const u = t.logEvents.filter((e) => e.glyph === "usage");
  assert.ok(u.some((e) => /openrouter\/m1/.test(e.text) && /1,000,000 tok/.test(e.text)));
  assert.ok(u.some((e) => /alpha/.test(e.text) && /3 agents/.test(e.text)));
  for (const e of [...v, ...u]) {
    assert.ok(!e.text.includes("\n") && !e.text.includes("\r"), `log line split its row: ${JSON.stringify(e.text)}`);
  }
});
