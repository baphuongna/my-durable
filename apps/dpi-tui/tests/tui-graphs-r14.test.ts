// Run-14 Unit A — :graphs (the last uncovered SDK surface) + the r13 NIT
// (pick* promise-hang on externally-dismissed overlays), pinned in the
// tui-export-archive-r13.test.ts style: a fake App whose client stubs the SDK
// ops, driven exactly the keys an operator sends. The run-9/r12-m1 invariant
// rides every case: device-authored text (graph names, cwds, task names, run
// ids) must never split a rendered picker row or a log line, so hostile \n\r
// fixtures are used on purpose and every row/log line is asserted
// single-line. No fs, no network, no production paths — the fake client is
// the whole device.
import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { COMMANDS, runCommand } from "../src/commands.ts";
import { capTranscriptLines, graphDetailLines, pickSession, pickThinking, walkDirs } from "../src/pickers.ts";
import type { App, DeviceRef } from "../src/app.ts";

/** Names a hostile relay might ride in — the run-9/r12 fixture shape. */
const HOSTILE_NAME = "nightly\n DIGEST\r";
const HOSTILE_CWD = "/srv/wor\nk\r";
const HOSTILE_TASK = "summa\n rize\r";

/** Fixture clock: ages are computed against Date.now() at flow time, so ages
 * are chosen with wide margins (90s → "1m" survives 30s of test slack). */
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

/** Graph fixtures, deliberately stored UNSORTED so the tests pin the
 * name-asc sort, with one hostile record (name/cwd/task name) and one
 * never-run record. Loose records — the wire shape is the SDK's business. */
function graphFixtures() {
  const graphs: Record<string, unknown>[] = [
    {
      id: "g2",
      name: "zeta graph",
      cwd: "/srv/z",
      tasks: [{ id: "t1", name: "step", prompt: "do it", dependsOn: [], model: { provider: "openrouter", modelId: "m" } }],
      createdAt: iso(86_400_000),
      updatedAt: iso(3_600_000),
      archivedAt: null,
      lastRun: { id: "r9", graphId: "g2", startedAt: iso(120_000), finishedAt: iso(90_000), status: "ok", tasks: { t1: { status: "ok" } } },
    },
    {
      id: "g1",
      name: HOSTILE_NAME,
      cwd: HOSTILE_CWD,
      tasks: [
        { id: "a", name: HOSTILE_TASK, prompt: "p", dependsOn: [] },
        { id: "b", name: "after", prompt: "p", dependsOn: ["a"], model: { provider: "openrouter", modelId: "big" } },
      ],
      createdAt: iso(200_000_000),
      updatedAt: iso(50_000),
      archivedAt: null,
      lastRun: {
        id: "r8",
        graphId: "g1",
        startedAt: iso(90_000),
        finishedAt: null,
        status: "running",
        tasks: { a: { status: "ok" }, b: { status: "running" } },
      },
    },
    { id: "g3", name: "alpha", cwd: "/srv/a", tasks: [], createdAt: iso(500_000), updatedAt: iso(400_000), archivedAt: null },
  ];
  // 12 runs on g1: the detail must show only the LAST 10.
  const g1Runs = Array.from({ length: 12 }, (_, i) => ({
    id: `run-${i + 1}`,
    graphId: "g1",
    startedAt: iso(1_000_000 - i * 1000),
    finishedAt: iso(999_000 - i * 1000),
    status: i % 3 === 0 ? "failed" : "ok",
    tasks: { a: { status: "ok" }, b: { status: i % 3 === 0 ? "failed" : "ok" } },
  }));
  // 230 tasks: the detail dump exceeds the 200-line cap → leading marker.
  const manyTasks = Array.from({ length: 230 }, (_, i) => ({
    id: `t${i}`,
    name: `task ${i}`,
    prompt: "p",
    dependsOn: i ? [`t${i - 1}`] : [],
  }));
  const runsByGraph: Record<string, unknown[]> = {
    g1: g1Runs,
    g2: [{ id: "r9", graphId: "g2", startedAt: iso(120_000), finishedAt: iso(90_000), status: "ok", tasks: { t1: { status: "ok" } } }],
    "g-many": [],
  };
  graphs.push({
    id: "g-many",
    name: "many tasks",
    cwd: "/srv/many",
    tasks: manyTasks,
    createdAt: iso(500_000),
    updatedAt: iso(400_000),
    archivedAt: null,
    lastRun: undefined,
  });
  return { graphs, runsByGraph };
}

/**
 * Just enough App for the run-14 doors: recording client, prompt queue and
 * overlays. The overlay pair MIRRORS the real App (app.ts:1037/1059):
 * closeOverlay pops the top overlay and fires ITS onClose — never the
 * component's onCancel. That asymmetry is the whole r13 NIT: an app-level
 * ctrl+c used to leave pick* promises pending forever.
 */
function fakeGraphs(opts: { prompts?: (string | undefined)[] } = {}) {
  const flashes: { text: string; error: boolean }[] = [];
  const logEvents: { glyph: string; text: string }[] = [];
  const prompts: { label: string; initial: string }[] = [];
  const queue = [...(opts.prompts ?? [])];
  const attached: [string, number][] = [];
  const overlays: { component: unknown; onClose?: () => void }[] = [];
  const { graphs, runsByGraph } = graphFixtures();

  const sessions = [
    { id: "s1", name: HOSTILE_NAME, cwd: HOSTILE_CWD, busy: false, agents: [{ id: 1, kind: "root" }] },
    { id: "s2", name: "plain", cwd: "/srv/plain", busy: false, agents: [{ id: 7, kind: "root" }] },
  ];
  const dirsByPath: Record<string, { path: string; parent: string; dirs: { name: string; path: string }[] }> = {
    "": { path: "/srv", parent: "", dirs: [{ name: "sub", path: "/srv/sub" }] },
    "/srv/sub": { path: "/srv/sub", parent: "/srv", dirs: [] },
  };

  const calls = {
    graphs: 0,
    graph: [] as string[],
    run: [] as string[],
    remove: [] as string[],
    tree: 0,
    dirs: [] as string[],
  };
  const client = {
    tree: async () => (calls.tree++, { uid: "u", name: "box", sessions, at: 0 }),
    dirs: async (at: string) => (calls.dirs.push(at), dirsByPath[at] ?? { path: "", parent: "", dirs: [] }),
    graphs: async () => (calls.graphs++, { graphs: [...graphs] }),
    graph: async (id: string) => {
      calls.graph.push(id);
      if (id === "boom") throw new Error("device refused: graph locked");
      return { graph: graphs.find((g) => g.id === id), runs: [...(runsByGraph[id] ?? [])] };
    },
    runGraph: async (id: string) => {
      calls.run.push(id);
      return { run: { id: "r-new", graphId: id, startedAt: new Date().toISOString(), finishedAt: null, status: "running", tasks: {} } };
    },
    removeGraph: async (id: string) => {
      calls.remove.push(id);
      const i = graphs.findIndex((g) => g.id === id);
      if (i >= 0) graphs.splice(i, 1);
      return { removed: true };
    },
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
    attach: async (sessionId: string, agentId: number) => {
      attached.push([sessionId, agentId]);
    },
    flash: (text: string, error = false) => flashes.push({ text, error }),
    notify: (text: string, error = false) => flashes.push({ text, error }),
    overlay: (component: unknown, onClose?: () => void) => overlays.push({ component, onClose }),
    closeOverlay: () => {
      // The REAL close path (app.ts:1059): pop + fire the overlay's onClose,
      // WITHOUT the component's onCancel — i.e. exactly what app-level ctrl+c
      // does to a picker.
      overlays.pop()?.onClose?.();
    },
    prompt: async (label: string, initial: string) => {
      prompts.push({ label, initial });
      return queue.length ? queue.shift() : undefined;
    },
    setPending: (_text: string | null) => {},
    logEvent: (glyph: string, text: string) => logEvents.push({ glyph, text }),
    exit: () => {},
  };
  return {
    app: app as never as App,
    flashes,
    logEvents,
    prompts,
    attached,
    calls,
    graphs,
    settle: (ms = 25) => new Promise((r) => setTimeout(r, ms)),
    mounted: () => overlays.length,
    top: () =>
      overlays[overlays.length - 1]!.component as unknown as {
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

/** Every log line the flows wrote is single-line too (logEvent has no
 * normalizer downstream — the helpers own that invariant). */
const assertLogLines = (events: { text: string }[]) => {
  for (const e of events)
    assert.ok(
      !e.text.includes("\n") && !e.text.includes("\r") && !e.text.includes("\x1b"),
      `log line carries control chars: ${JSON.stringify(e.text)}`,
    );
};

/** A pick* promise that hangs would stall the suite — race it, fail loud. */
const orHang = <T,>(p: Promise<T>, what: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} hung — r13 NIT regression`)), 500)),
  ]);

// ---------------------------------------------------------------- :graphs

test("COMMANDS registers :graphs — description only, no create door to complete", () => {
  const cmd = COMMANDS.find((c) => c.name === "graphs");
  assert.ok(cmd, ":graphs missing from COMMANDS");
  assert.ok(cmd.description!.length > 0);
  assert.equal(cmd.argumentHint, undefined, "no argument — the picker is the whole door");
  assert.match(cmd.description!, /web FE/, "the description names where DAG editing lives");
});

test(":graphs lists hostile rows single-line, sorted by name, with task count · cwd · lastRun state+age", async () => {
  const t = fakeGraphs();
  assert.equal(await runCommand(t.app, "/graphs"), true);
  await t.settle();
  assert.equal(t.mounted(), 1, "the graphs picker mounted");
  assert.equal(t.calls.graphs, 1);
  const lines = t.top().render(80);
  assertRows(lines);
  const visible = strip(lines);
  assert.match(visible, /Graphs on box/);
  // Sorted by name: alpha < "many tasks" < "nightly DIGEST" < zeta graph.
  assert.deepEqual(
    t.top().items().map((i) => i.value),
    ["g3", "g-many", "g1", "g2"],
    "rows sort by name asc",
  );
  // r12 m1: the name and cwd are device-authored AND land in label/description
  // paths pi-tui never LF-normalizes — both must collapse at compose time.
  assert.match(visible, /● nightly DIGEST/, "the hostile \\n in the name collapsed (label path) and running gets its glyph");
  assert.match(t.top().items()[2]!.description!, /\/srv\/wor k/, "the hostile \\r\\n in the cwd collapsed");
  assert.match(t.top().items()[2]!.description!, /2 tasks/);
  assert.match(t.top().items()[2]!.description!, /last running 1m ago/, "running age rides the unfinished startedAt");
  assert.match(t.top().items()[3]!.description!, /1 task · \/srv\/z · last ok 1m ago/, "ok age rides finishedAt");
  assert.match(t.top().items()[0]!.description!, /0 tasks · \/srv\/a · last never run/, "a never-run graph says so, no glyph crash");
  assert.match(visible, /r run/, "the run hotkey is advertised");
  assert.match(visible, /enter detail · r run · d delete · esc close/, "the hint names every door");
  assert.ok(!visible.toLowerCase().includes("n new") && !visible.toLowerCase().includes("n create"), "no create door is invented (run-14 scope: the web FE owns authoring)");
});

test("graphDetailLines is pure: hostile fields fold, ages come from the injected now, only the last ≤10 runs show", () => {
  const { graphs, runsByGraph } = graphFixtures();
  const g1 = graphs.find((g) => g.id === "g1") as never as Parameters<typeof graphDetailLines>[0];
  const lines = graphDetailLines(g1, runsByGraph.g1 as never as Parameters<typeof graphDetailLines>[1], NOW);
  assert.ok(lines.every((l) => !l.includes("\n") && !l.includes("\r")), "hostile task names never split a detail line");
  assert.match(lines[0]!, /nightly DIGEST — 2 tasks · \/srv\/wor k/);
  assert.match(lines[1]!, /created 2d7h ago · updated 50s ago/);
  assert.ok(lines.some((l) => /a summa rize · deps \[\]/.test(l)), "the hostile task name folded and deps render empty");
  assert.ok(lines.some((l) => /b after · deps \[a\] · openrouter\/big/.test(l)), "deps and model ride the task line");
  assert.ok(lines.some((l) => /last 10 runs:/.test(l)), "exactly the last 10 runs are dumped");
  const runLines = lines.filter((l) => l.startsWith("  run "));
  assert.equal(runLines.length, 10, "12 device runs → 10 detail lines");
  assert.ok(runLines[0]!.startsWith("  run run-3"), "the OLDEST two runs are the ones cut");
  // NB: exact-prefix match — "run-1" is a substring of "run-10", so a bare
  // includes() would false-positive on the runs that DID make the cut.
  assert.ok(!lines.some((l) => /^  run run-(1|2)( |$)/.test(l)), "run-1/run-2 never render");
  assert.ok(runLines.some((l) => /1\/2 ok · 1 failed/.test(l)), "per-run ok/failed counts render");
  // A graph with no runs says so honestly.
  const g3 = graphs.find((g) => g.id === "g3") as never as Parameters<typeof graphDetailLines>[0];
  assert.ok(graphDetailLines(g3, [], NOW).includes("no runs yet"));
});

test(":graphs enter dumps the detail to the log view — capped ≤200 body lines, marker leads, rows stay up", async () => {
  const t = fakeGraphs();
  await runCommand(t.app, "/graphs");
  await t.settle();
  // g1 (hostile name, 12 runs) is the third row under the name sort.
  t.top().pick(t.top().items()[2]);
  await t.settle(80);
  assert.deepEqual(t.calls.graph, ["g1"], "detail fetches exactly the picked graph");
  const dump = t.logEvents.filter((e) => e.glyph === "graph");
  assert.ok(dump.length > 5 && dump.length <= 201, `detail is small for a 2-task graph: ${dump.length}`);
  assertLogLines(dump);
  assert.ok(dump.some((e) => /nightly DIGEST — 2 tasks/.test(e.text)), "graph meta leads the dump");
  assert.ok(dump.some((e) => /last 10 runs:/.test(e.text)));
  assert.ok(!dump.some((e) => e.text.includes("... truncated")), "no marker under the cap");
  assert.ok(t.flashes.some((f) => /detail/.test(f.text) && /log view: L/.test(f.text) && !f.error));
  assert.equal(t.mounted(), 1, "reading is read-only — the list stays up (pickArchived pattern)");

  // g-many: 230 tasks → 234 detail lines → capped at 200 + the leading marker.
  t.top().pick(t.top().items()[1]);
  await t.settle(80);
  const capped = t.logEvents.filter((e) => e.glyph === "graph").slice(-201);
  assert.equal(capped.length, 201, "marker + 200 body lines, never the whole dump");
  assert.equal(capped[0]!.text, "... truncated (34 lines)", "the marker LEADS the dump (r13 pattern, same format)");
  assert.equal(capped[1]!.text, "many tasks — 230 tasks · /srv/many");
  assert.ok(capped[200]!.text.startsWith("  t197 "), "the body stops at the 200-line bound (marker + 200)");
  assertLogLines(capped);
});

test("capTranscriptLines keeps its r13 defaults while :graphs passes the tighter 200 budget", () => {
  // Defaults byte-for-byte: 401 lines → marker + 400 (pinned by r13, restated
  // here so the opts param can never silently shift the :archive contract).
  const many = capTranscriptLines(Array.from({ length: 401 }, (_, i) => `l${i}`).join("\n"));
  assert.equal(many.length, 401);
  assert.equal(many[0], "... truncated (1 line)");
  assert.deepEqual(capTranscriptLines("a\nb\nc"), ["a", "b", "c"], "under the cap: verbatim, no marker");
  // The run-14 budget: 201+ lines → marker + 200.
  const tight = capTranscriptLines(Array.from({ length: 205 }, (_, i) => `x${i}`).join("\n"), { maxLines: 200 });
  assert.equal(tight.length, 201);
  assert.equal(tight[0], "... truncated (5 lines)");
  assert.equal(tight.at(-1), "x199");
  // Hostile control chars still die at the chokepoint (logEvent is verbatim).
  assert.deepEqual(capTranscriptLines("run \r 1\nokay \x1b[31mRED\x1b[0m", { maxLines: 200 }), ["run  1", "okay RED"]);
});

test(":graphs r is fire-and-forget: one runGraph call, toast `graph <name> started`, list refetches", async () => {
  const t = fakeGraphs();
  await runCommand(t.app, "/graphs");
  await t.settle();
  t.top().handleInput("r"); // fires on the highlighted row (alpha, first under the sort)
  await t.settle(80);
  assert.deepEqual(t.calls.run, ["g3"], "runGraph fired exactly once with the row's id");
  assert.deepEqual(t.calls.graph, [], "fire-and-forget does NOT auto-open detail or poll");
  assert.ok(t.flashes.some((f) => !f.error && f.text === "graph alpha started"), `started toast: ${JSON.stringify(t.flashes)}`);
  assert.ok(t.logEvents.some((e) => e.glyph === "graph" && /alpha run fired by hand/.test(e.text)));
  assert.equal(t.calls.graphs, 2, "the list refetched — the row now shows the running lastRun");
  assert.equal(t.mounted(), 1);
  assertRows(t.top().render(80));
});

test(":graphs d gates remove on y/n: the confirm oneLines a hostile name, y removes + refetches, n keeps it", async () => {
  const yes = fakeGraphs({ prompts: ["y"] });
  await runCommand(yes.app, "/graphs");
  await yes.settle();
  yes.top().handleInput("j"); // g-many
  yes.top().handleInput("j"); // g1 — the hostile name rides the confirm label
  yes.top().handleInput("d");
  await yes.settle(80);
  assert.match(yes.prompts[0]!.label, /Remove graph nightly DIGEST\? y\/n/, "the confirm folds the \\n\\r (prompt labels render verbatim)");
  assert.deepEqual(yes.calls.remove, ["g1"], "y ran removeGraph on the highlighted row");
  assert.ok(yes.flashes.some((f) => /removed nightly DIGEST/.test(f.text) && !f.error), JSON.stringify(yes.flashes));
  assert.equal(yes.calls.graphs, 2, "the list refetched without the removed row");
  assert.equal(yes.mounted(), 1);
  assert.ok(!yes.top().items().some((i) => i.value === "g1"), "the removed graph left the list");
  assertRows(yes.top().render(80));

  const no = fakeGraphs({ prompts: ["n"] });
  await runCommand(no.app, "/graphs");
  await no.settle();
  no.top().handleInput("d");
  await no.settle(80);
  assert.equal(no.calls.remove.length, 0, "n never removes");
  assert.equal(no.calls.graphs, 1, "a cancelled confirm does not refetch");
  assert.ok(no.flashes.some((f) => /remove cancelled/.test(f.text) && !f.error));
  assert.equal(no.mounted(), 1, "a cancelled confirm leaves the picker up");
});

test(":graphs empty list and fetch failure are honest toasts, not dead overlays", async () => {
  const empty = fakeGraphs();
  empty.graphs.length = 0;
  await runCommand(empty.app, "/graphs");
  await empty.settle();
  assert.equal(empty.mounted(), 0, "an empty graph list does not mount an empty picker");
  assert.ok(empty.flashes.some((f) => /no task-graphs on this device — create one in the web FE/.test(f.text) && !f.error));

  const down = fakeGraphs();
  (down.app as never as { client: { graphs: () => Promise<never> } }).client.graphs = async () => {
    throw new Error("device unreachable\nat tunnel");
  };
  await runCommand(down.app, "/graphs");
  await down.settle();
  assert.equal(down.mounted(), 0);
  assert.ok(down.flashes.some((f) => f.error && /graphs: device unreachable/.test(f.text)), JSON.stringify(down.flashes));
});

test(":graphs detail failure toasts the device error and keeps the list up", async () => {
  const t = fakeGraphs();
  await runCommand(t.app, "/graphs");
  await t.settle();
  (t.app as never as { client: { graph: (id: string) => Promise<never> } }).client.graph = async () => {
    throw new Error("device refused: graph locked");
  };
  t.top().pick(t.top().items()[0]);
  await t.settle(80);
  assert.ok(t.flashes.some((f) => f.error && /graph: device refused/.test(f.text)), JSON.stringify(t.flashes));
  assert.equal(t.mounted(), 1, "a failed detail fetch keeps the picker up");
});

// ------------------------------------------------- r13 NIT: pick* promise hang

test("r13 NIT: an externally-dismissed pickSession resolves undefined instead of hanging (and a pick still wins the race)", async () => {
  // The app-level ctrl+c path: closeOverlay fires the overlay's onClose and
  // never the picker's onCancel (app.ts:747/1059) — pre-run-14 the promise
  // below stayed pending forever.
  const dismissed = fakeGraphs();
  const hung = pickSession(dismissed.app);
  await dismissed.settle();
  assert.equal(dismissed.mounted(), 1, "the session picker mounted");
  dismissed.app.closeOverlay(); // external dismissal — no onCancel involved
  assert.equal(await orHang(hung, "pickSession"), undefined);

  // Ordering pin: the picked id must settle BEFORE the close's onClose
  // undefined (first-wins resolution) — /export depends on the real value.
  const picked = fakeGraphs();
  const value = pickSession(picked.app);
  await picked.settle();
  picked.top().pick(picked.top().items()[2]); // ＋new, s1(hostile), s2
  assert.equal(await orHang(value, "pickSession pick path"), "s2");
  await picked.settle(50);
  assert.deepEqual(picked.attached, [["s2", 7]], "attach-on-pick is unchanged");
});

test("r13 NIT: walkDirs survives external dismissal mid-walk — stepping down stays pending, `use:` still resolves the path", async () => {
  // Stepping INTO a subdirectory closes this step's overlay to mount the
  // next; that close must NOT settle the walk (the handoff case).
  const t = fakeGraphs();
  const walk = walkDirs(t.app, "");
  let settledFlag = false;
  void walk.then(() => {
    settledFlag = true;
  });
  await t.settle();
  assert.deepEqual(t.calls.dirs, [""]);
  t.top().pick(t.top().items()[2]); // "sub/" — step down, no resolve
  await t.settle();
  assert.deepEqual(t.calls.dirs, ["", "/srv/sub"], "the walk descended");
  assert.equal(t.mounted(), 1, "a fresh overlay took over");
  assert.equal(settledFlag, false, "stepping down must not settle the walk");
  t.app.closeOverlay(); // external dismissal of the SECOND step
  assert.equal(await orHang(walk, "walkDirs after step-down"), undefined);

  // The happy path is intact: `✓ Use` resolves the picked directory.
  const ok = fakeGraphs();
  const done = walkDirs(ok.app, "");
  await ok.settle();
  ok.top().pick(ok.top().items()[0]); // ✓ Use /srv
  assert.equal(await orHang(done, "walkDirs use path"), "/srv");
});

test("r13 NIT: an externally-dismissed pickThinking resolves undefined instead of hanging", async () => {
  const t = fakeGraphs();
  const level = pickThinking(t.app, "low");
  await t.settle();
  assert.equal(t.mounted(), 1);
  t.app.closeOverlay();
  assert.equal(await orHang(level, "pickThinking"), undefined);
  // chooseModel shares pickThinking's exact settle-before-close wiring (it is
  // not exported; pickModel/newSession drive it) — this pin covers the pattern.
});
