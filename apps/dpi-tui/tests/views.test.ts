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
import {
  ageOf,
  herdRows,
  networkRows,
  renderHeader,
  renderHerd,
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
    assert.match(plain, /herd.*network.*agent/);
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
    /j\/k move.*1-9 jump/,
    "herd keymap on the dashboard",
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
