/**
 * herdr-style dashboard views (gap: "tui ui khác xa herdr-0.4.0"): pure
 * string builders fed from SessionSummary[]/DeviceRow[] — every line is
 * width-exact (visibleWidth === w) and ANSI-safe under truncation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SessionSummary, AgentSummary } from "../../dpi-sdk/src/api.ts";
import type { DeviceRow } from "../../dpi-sdk/src/node/registry.ts";
import { Picker } from "../src/pickers.ts";
import { slashSuggestions } from "../src/app.ts";
import {
  ageOf,
  gitStateSuffix,
  herdRows,
  networkRows,
  renderHeader,
  renderHerd,
  renderHerdPanel,
  renderNetwork,
  renderStatusbar,
  renderViewbar,
} from "../src/views.ts";
import { stripAnsi } from "./harness/strip.ts";

const agent = (id: number, kind: AgentSummary["kind"], name: string): AgentSummary => ({
  id,
  name,
  named: true,
  kind,
  busy: false,
  background: 0,
});

const session = (id: string, name: string, cwd: string, busy = false): SessionSummary => ({
  id,
  name,
  cwd,
  model: "echo/echo-mini",
  provider: "openrouter",
  createdAt: Date.now() - 90_000,
  dbPath: `/tmp/${id}.db`,
  busy,
  agents: [agent(1, "root", "main"), agent(2, "fork", "fork-1"), agent(3, "subagent", "sub-1")],
});

const sessions = [
  session("s1", "alpha", "/home/bom/source/my-durable", true),
  session("s2", "beta", "/home/bom/source/my-durable"),
  session("s3", "gamma", "/home/bom/other"),
];

const device = (
  id: string,
  name: string,
  status: DeviceRow["lastStatus"],
  tree?: SessionSummary[],
): DeviceRow => ({
  id,
  name,
  kind: "local",
  transport: id === "t1" ? "tunnel" : "lan",
  url: id === "t1" ? null : `http://${id}.local:4780`,
  token: id === "t1" ? null : "tok",
  source: "config",
  position: 0,
  deviceUid: null,
  lastStatus: status,
  lastError: null,
  lastSeenAt: Date.now() - 5_000,
  lastInfo: null,
  lastTree: tree ? { uid: id, name, sessions: tree, at: 0 } : null,
  createdAt: 0,
  updatedAt: 0,
});

test("herdRows: groups by cwd directory, filter narrows to matching sessions only", () => {
  const rows = herdRows(sessions);
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["group", "session", "session", "group", "session"],
  );
  assert.equal(rows[0].label, "my-durable");
  const filtered = herdRows(sessions, "alpha");
  assert.deepEqual(
    filtered.map((r) => r.label),
    ["my-durable", "alpha"],
  );
  assert.equal(herdRows(sessions, "zzz").length, 0);
});

test("renderHerd: header columns, selection marker, group counts — every line width-exact", () => {
  const rows = herdRows(sessions);
  for (const w of [56, 80, 120]) {
    const lines = renderHerd(w, rows, sessions, { selectedId: "s1", cursor: 0, filter: "" });
    for (const line of lines) assert.equal(visibleWidth(line), w, `width ${w}`);
    const plain = lines.map(stripAnsi);
    if (w >= 84) assert.match(plain[0], /NAME.*STATE.*MODEL.*AGENTS.*AGE/);
    assert.match(plain[1], /my-durable.*2 agents.*1 busy/);
    assert.match(plain[2], /alpha.*busy/);
    assert.match(plain[2], /▌/);
    assert.match(plain[2], /3⑂1↳1/, "agent counts carry fork/subagent glyphs");
  }
  const filtered = renderHerd(80, herdRows(sessions, "nope"), sessions, { filter: "nope" });
  assert.match(filtered.map(stripAnsi).at(-1)!, /filter: nope/);
  // A filter matching nothing must explain itself instead of 0 silent rows.
  assert.match(filtered.map(stripAnsi).join("\n"), /no sessions match .*nope.* — esc clears/);
  assert.doesNotMatch(filtered.map(stripAnsi).join("\n"), /no sessions yet on this device/);
});

test("networkRows + renderNetwork: devices with status dots, sessions nested, current device marked", () => {
  const devices = [
    device("d1", "box-one", "online", [session("s1", "alpha", "/w")]),
    device("t1", "tunnel-box", "offline"),
  ];
  const rows = networkRows(devices, "d1");
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["device", "session", "device"],
  );
  assert.equal(rows[0].current, true);
  for (const w of [56, 96]) {
    const lines = renderNetwork(w, rows, devices, { cursor: 0, currentSessionId: "s1" });
    for (const line of lines) assert.equal(visibleWidth(line), w, `width ${w}`);
    const plain = lines.map(stripAnsi);
    assert.match(plain[0], /box-one.*\[local\].*lan/);
    assert.match(plain[0], /▌/);
    assert.match(plain[1], /└─.*alpha/);
    assert.match(plain[2], /tunnel-box.*tunnel/);
  }
  const only = networkRows(devices, "d1", "tunnel");
  assert.deepEqual(
    only.map((r) => r.label),
    ["tunnel-box"],
  );
});

test("renderViewbar: the active tab is inverse; hint rides the right edge width-exact", () => {
  for (const view of ["herd", "network", "agent"] as const) {
    const line = renderViewbar(80, view, "j/k move · ↵ open");
    assert.equal(visibleWidth(line), 80);
    const plain = stripAnsi(line);
    assert.match(plain, /network.*herd.*agent/);
    assert.match(plain, /j\/k move · ↵ open/);
  }
  // narrow terminals still fit: the hint is truncated, never wrapped
  const narrow = renderViewbar(30, "herd", "a very long hint that will not fit");
  assert.equal(visibleWidth(narrow), 30);
});

test("renderStatusbar: NORMAL chip, per-view keymap, ctx + device on the right", () => {
  for (const view of ["herd", "agent"] as const) {
    const line = renderStatusbar(100, { view, device: "box-one", ctxLeft: 42, background: 2 });
    assert.equal(visibleWidth(line), 100);
    const plain = stripAnsi(line);
    assert.match(plain, /NORMAL/);
    assert.match(plain, /42%/);
    assert.match(plain, /box-one/);
    assert.match(plain, /2 bg/);
  }
  assert.match(
    stripAnsi(renderStatusbar(100, { view: "herd", device: "d" })),
    /j\/k move.*1-4 views/,
    "herd keymap on the dashboard",
  );
  // Usability pass: the viewbar TEACHES the digit keys — active or not, every
  // view carries its number.
  assert.match(
    stripAnsi(renderViewbar(100, "herd", "")),
    /1 network.*2 herd.*3 agent.*4 log/,
    "viewbar numbers the views",
  );
});

test("renderHeader: brand, connection, session/device counters, right-aligned hints", () => {
  const line = renderHeader(90, {
    device: "box-one",
    sessions: 3,
    devicesOnline: 2,
    devicesTotal: 5,
    conn: "live",
    connOk: true,
  });
  assert.equal(visibleWidth(line), 90);
  const plain = stripAnsi(line);
  assert.match(plain, /dpi/);
  assert.match(plain, /live/);
  assert.match(plain, /3 sessions/);
  assert.match(plain, /2\/5 devices/);
  assert.match(plain, /\? help.*: palette.*q quit/);
});

test("ageOf: compact human ages", () => {
  const now = Date.now();
  assert.equal(ageOf(now - 5_000, now), "5s");
  assert.equal(ageOf(now - 65_000, now), "1m");
  assert.equal(ageOf(now - 7_200_000, now), "2h");
  assert.equal(ageOf(now - 90_000_000, now), "1d");
});

test("renderHerdPanel: the model carries a muted (default) tag only when it IS the device default", () => {
  const s = session("s1", "alpha", "/home/bom/source/my-durable");
  const flat = (lines: string[]) => lines.map(stripAnsi).join("\n");
  // The session's model id equals the device's advertised default → annotated.
  const onDefault = renderHerdPanel(44, 20, s, 40, "box-one", undefined, "echo/echo-mini");
  for (const line of onDefault) assert.equal(visibleWidth(line), 44, "panel lines stay width-exact");
  assert.match(flat(onDefault), /echo-mini \(default\)/, "default model is tagged");
  // Any other model → no tag.
  const other = renderHerdPanel(44, 20, s, 40, "box-one", undefined, "anthropic/claude-sonnet-5.5");
  assert.doesNotMatch(flat(other), /\(default\)/, "non-default model is not tagged");
  // No default known (older device info) → never annotate.
  const unknown = renderHerdPanel(44, 20, s, 40, "box-one");
  assert.doesNotMatch(flat(unknown), /\(default\)/, "no device default → no tag");
});

// ---------- slashSuggestions ----------

test("slashSuggestions: prefix filters command names", () => {
  const cmds = [{ name: "pair" }, { name: "sessions" }, { name: "compact" }];
  assert.deepEqual(slashSuggestions("/p", cmds)?.names, ["pair"]);
  assert.deepEqual(slashSuggestions("/", cmds)?.names, ["pair", "sessions", "compact"]);
});

test("slashSuggestions: null outside slash context — args, plain text, unknown prefix", () => {
  const cmds = [{ name: "pair" }];
  assert.equal(slashSuggestions("/pair http://x", cmds), null); // after a space you type args
  assert.equal(slashSuggestions("hello", cmds), null);
  assert.equal(slashSuggestions("/zzz", cmds), null);
});

test("slashSuggestions: matching is case-insensitive on the prefix", () => {
  assert.deepEqual(slashSuggestions("/PA", [{ name: "pair" }])?.names, ["pair"]);
});

// ---------- hub-feed: multi-host display parity ----------

test("toDeviceRows maps the hub's NetworkDevice list into network-view rows", async () => {
  const { toDeviceRows } = await import("../src/hub-feed.ts");
  const rows = toDeviceRows([
    {
      id: "laptop-win",
      name: "PhuongNB-Laptop",
      kind: "url",
      transport: "tunnel",
      url: null,
      source: "ui",
      status: "online",
      tree: { sessions: [{ id: "s1", name: "demo" }] },
    },
    {
      id: "srv",
      name: "build-box",
      kind: "url",
      transport: "lan",
      url: "http://10.0.0.4:4780",
      source: "ui",
      status: "offline",
      error: "connect timeout",
    },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.transport, "tunnel");
  assert.equal(rows[0]!.url, null);
  assert.equal(rows[0]!.lastStatus, "online");
  assert.equal(rows[0]!.lastTree?.sessions[0]!.name, "demo");
  assert.equal(rows[1]!.transport, "lan");
  assert.equal(rows[1]!.url, "http://10.0.0.4:4780");
  assert.equal(rows[1]!.lastStatus, "offline");
  // networkRows renders both devices and the tunnel device's session
  const net = networkRows(rows, "adhoc");
  assert.equal(net.filter((r) => r.kind === "device").length, 2);
  assert.ok(net.some((r) => r.kind === "session" && r.sessionId === "s1"));
});

test("Picker: filters on the LABEL (substring), j/k move — never swallowed as filter text", () => {
  const items = [
    { value: "use:/tmp/work", label: "✓ Use /tmp/work" },
    { value: "/tmp/work/project", label: "project/" },
    { value: "/tmp/work/notes", label: "notes/" },
  ];
  const p = new Picker("Working directory", items, () => {}, () => {});
  // "pro" must find "project/" even though its VALUE starts with "/tmp/…".
  p.handleInput("p");
  p.handleInput("r");
  p.handleInput("o");
  assert.match(p.render(60).join("\n"), /project\//);
  assert.doesNotMatch(p.render(60).join("\n"), /notes\//);
  // The empty message speaks the picker's language, naming the filter.
  p.handleInput("z");
  assert.match(p.render(60).join("\n"), /no match for “proz”/);
  // j/k move the selection, they never extend the filter.
  const q = new Picker("List", items, () => {}, () => {});
  q.handleInput("j");
  assert.equal(q.list.getSelectedItem()?.label, "project/");
  q.handleInput("k");
  assert.equal(q.list.getSelectedItem()?.label, "✓ Use /tmp/work");
});

test("Picker: enter on a ZERO-match list closes via onCancel — not a silent no-op (R5 finding 6)", () => {
  const items = [
    { value: "a", label: "alpha" },
    { value: "b", label: "beta" },
  ];
  let closed = false;
  let picked: string | undefined;
  const p = new Picker("List", items, (i) => (picked = i.value), () => (closed = true));
  p.handleInput("z"); // filter matches nothing
  assert.doesNotMatch(p.render(60).join("\n"), /alpha/);
  p.handleInput("\r"); // enter
  assert.ok(closed, "enter on an empty result did not close the picker");
  assert.equal(picked, undefined, "enter on an empty result picked an item");
  // Non-empty lists still pick through the same key.
  let okPick: string | undefined;
  const q = new Picker("List", items, (i) => (okPick = i.value), () => {});
  q.handleInput("\r");
  assert.equal(okPick, "a");
});

test("gitStateSuffix: merge conflicts and detached HEAD surface in the toast/chip suffix (R5 finding 4)", () => {
  assert.equal(gitStateSuffix({ merge: true, conflicts: 1 }), " · merging (1 conflicts)");
  assert.equal(gitStateSuffix({ merge: true, conflicts: 3 }), " · merging (3 conflicts)");
  assert.equal(gitStateSuffix({ merge: true }), " · merging (0 conflicts)", "missing count must not read undefined");
  assert.equal(gitStateSuffix({ detached: true }), " (detached)");
  assert.equal(gitStateSuffix({}), "", "a clean branch adds no suffix");
  assert.equal(gitStateSuffix({ merge: false, detached: false }), "");
});

test("ctx degrade: an unknown catalog window renders '?' in the statusbar and panel, never '—' (R5 finding 5)", () => {
  const bar = renderStatusbar(100, { view: "agent", device: "box-one" });
  const plain = stripAnsi(bar);
  assert.match(plain, /ctx \?/, `no '?' in the statusbar: ${plain}`);
  assert.doesNotMatch(plain, /ctx —/);
  // With a known window the percent still renders.
  assert.match(stripAnsi(renderStatusbar(100, { view: "agent", device: "d", ctxLeft: 42 })), /ctx 42%/);
  const s = sessions[0]!;
  const panel = stripAnsi(renderHerdPanel(60, 24, s, undefined, "box-one").join("\n"));
  assert.match(panel, /ctx\s+\?/, `no '?' in the OVERVIEW panel:\n${panel}`);
});
