/**
 * Run-12 Unit A — view 5 "ops" (device-ops surfaces): pure render tests for
 * renderOps in the style of views.test.ts. Every line is width-exact and
 * SINGLE-LINE (run-9 invariant, see lf-free-pickers-r9.test.ts): ops data is
 * device-authored (schedule names, env keys/values, sink urls, disk paths), so
 * the builder must collapse/strip before composing chrome rows. Fixtures use
 * the REAL SDK wire types — including eventLoop + gitSpawns, typed in phase 1.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type {
  DeviceUsageReport,
  DeviceVitals,
  EnvFileView,
  EnvVarView,
  NotifySinkView,
  ScheduleView,
} from "../../dpi-sdk/src/api.ts";
import {
  renderOps,
  renderStatusbar,
  renderViewbar,
  VIEW_TABS,
  type OpsData,
} from "../src/views.ts";
import { stripAnsi } from "./harness/strip.ts";

// Fixtures typed with the real SDK shapes (run-12 phase 1: eventLoop/gitSpawns).
const vitals: DeviceVitals = {
  uptime: 3 * 86400 + 4 * 3600 + 12 * 60,
  processUptime: 5 * 3600 + 12 * 60,
  loadavg: [0.42, 0.35, 0.31],
  cpuCount: 8,
  memory: {
    totalBytes: 16 * 1024 ** 3,
    freeBytes: 11 * 1024 ** 3,
    usedBytes: 5 * 1024 ** 3,
    processRssBytes: 180 * 1024 ** 2,
    heapUsedBytes: 120 * 1024 ** 2,
  },
  disk: { path: "/home/bom/.local/share/durable-pi", totalBytes: 512 * 1024 ** 3, freeBytes: 210 * 1024 ** 3, known: true },
  eventLoop: { lagMsLast: 4, lagMsMax1m: 38, samples: 60 },
  gitSpawns: { live: 2, queued: 1, queuedHigh: 3, queuedAged: 0 }, // run-13 f4 gauge
  pid: 4242,
  at: 0,
  counts: { sessions: 7, archived: 3 },
};

const usage: DeviceUsageReport = {
  at: 0,
  totals: { tokens: 1_250_000, cost: 12.5 },
  models: [],
  sessions: [
    { id: "s1", name: "alpha", cwd: "/w/alpha", tokens: 900_000, cost: 9, agents: 2 },
    { id: "s2", name: "beta", cwd: "/w/beta", tokens: 250_000, cost: 2.5, agents: 1 },
    { id: "s3", name: "gamma", cwd: "/w/gamma", tokens: 100_000, cost: 1, agents: 1 },
    { id: "s4", name: "delta (4th — must not make the top 3)", cwd: "/w/delta", tokens: 1, cost: 0, agents: 1 },
  ],
  projects: [],
};

const schedule = (over: Partial<ScheduleView> = {}): ScheduleView => ({
  id: "sch-1",
  name: "nightly-report",
  cwd: "/w/alpha",
  model: { provider: "openrouter", modelId: "echo/echo-mini" },
  prompt: "write the report",
  everyMinutes: 30,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
  nextRunAt: 0,
  running: false,
  ...over,
});

const env: EnvFileView = {
  envFile: "/home/bom/.local/share/durable-pi/device.env",
  exists: true,
  restartRequired: true,
  vars: [
    { key: "DPI_PROVIDER", masked: "faux", secret: false, source: "file", managed: true },
    { key: "OPENROUTER_API_KEY", masked: "sk-or-***", secret: true, source: "file", managed: false },
    { key: "LANG", masked: "en_US.UTF-8", secret: false, source: "process", managed: false },
  ],
};

const sink = (over: Partial<NotifySinkView> = {}): NotifySinkView => ({
  id: "sink-1",
  kind: "webhook",
  url: "https://example.com/hook",
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
  silencedUntil: null,
  ...over,
});

const NOW = 1_700_000_000_000;
const fullData: OpsData = {
  vitals,
  usage,
  schedules: [
    schedule({ nextRunAt: NOW + 42 * 60_000 }),
    schedule({ id: "sch-2", name: "morning-brief", everyMinutes: undefined, dailyAt: "09:00", enabled: false, nextRunAt: NOW - 1000 }),
    schedule({ id: "sch-3", name: "sweep", running: true, nextRunAt: null }),
  ],
  env,
  sinks: [sink(), sink({ id: "sink-2", kind: "ntfy", url: "https://ntfy.sh/topic", enabled: false })],
};

test("renderOps: all five sections render width-exact and LF-free at 80 columns (run-9 invariant)", () => {
  const lines = renderOps(80, fullData, { now: NOW });
  assert.ok(lines.length > 10, "the stacked view has real content");
  for (const line of lines) {
    assert.equal(visibleWidth(line), 80, `width-exact: ${JSON.stringify(line)}`);
    assert.ok(!line.includes("\n"), `raw LF leaked: ${JSON.stringify(line)}`);
  }
  const flat = lines.map(stripAnsi).join("\n");
  assert.match(flat, /VITALS/);
  assert.match(flat, /USAGE/);
  assert.match(flat, /SCHEDULES/);
  assert.match(flat, /ENV/);
  assert.match(flat, /NOTIFY/);
  // other widths stay width-exact too (narrow truncates, wide pads)
  for (const w of [60, 120]) {
    const narrow = renderOps(w, fullData, { now: NOW });
    for (const line of narrow) assert.equal(visibleWidth(line), w, `width ${w}: ${JSON.stringify(line)}`);
  }
});

test("renderOps: vitals carry uptime, mem/disk, event-loop lag and gitSpawns live/queued(+high)", () => {
  const flat = renderOps(120, fullData, { now: NOW }).map(stripAnsi).join("\n");
  assert.match(flat, /up 3d 4h/);
  assert.match(flat, /proc 5h 12m/);
  assert.match(flat, /load 0\.42 0\.35 0\.31/);
  assert.match(flat, /×8/);
  assert.match(flat, /5\.0GiB\/16\.0GiB/);
  assert.match(flat, /210GiB\/512GiB/, "≥100 keeps no decimal (humanBytes)");
  // run-12 phase 1 fields, rendered from the real SDK shape
  assert.match(flat, /evlag 4ms last 38ms max 1m 60 samples/);
  assert.match(flat, /git 2 live · 1 queued · 3 high/);
  assert.match(flat, /sessions 7 archived 3/);
  // the high lane is only shown when waiters sit in it
  const calm = renderOps(
    120,
    { vitals: { ...vitals, gitSpawns: { live: 0, queued: 0, queuedHigh: 0, queuedAged: 0 } } },
    { now: NOW },
  )
    .map(stripAnsi)
    .join("\n");
  assert.match(calm, /git 0 live · 0 queued/);
  assert.doesNotMatch(calm, /high/);
});

test("renderOps: usage totals plus the top 3 sessions by tokens (real DeviceUsageReport shape)", () => {
  const flat = renderOps(120, fullData, { now: NOW }).map(stripAnsi).join("\n");
  assert.match(flat, /1\.3M tokens · \$12\.50 · 4 sessions/);
  assert.match(flat, /alpha 900K · \$9\.00/);
  assert.match(flat, /beta 250K · \$2\.50/);
  assert.match(flat, /gamma 100K · \$1\.00/);
  assert.doesNotMatch(flat, /delta/, "only the top 3 sessions render");
});

test("renderOps: schedules show trigger, device-computed next run and the ●/○ enabled glyph", () => {
  const flat = renderOps(120, fullData, { now: NOW }).map(stripAnsi).join("\n");
  assert.match(flat, /● nightly-report every 30m in 42m/);
  assert.match(flat, /○ morning-brief daily 09:00 due/);
  assert.match(flat, /● sweep every 30m — · running/);
});

test("renderOps: env rows are key=masked with managed/process markers; sinks show kind, target, enabled", () => {
  const flat = renderOps(120, fullData, { now: NOW }).map(stripAnsi).join("\n");
  assert.match(flat, /DPI_PROVIDER=faux \(managed\)/);
  assert.match(flat, /OPENROUTER_API_KEY=sk-or-\*\*\*/);
  assert.match(flat, /LANG=en_US\.UTF-8 \(process\)/);
  assert.match(flat, /restart required/);
  assert.match(flat, /● webhook https:\/\/example\.com\/hook/);
  assert.match(flat, /○ ntfy https:\/\/ntfy\.sh\/topic/);
});

test("renderOps: missing sections degrade to ◌/— placeholders and per-section ✗ errors — never a blank view", () => {
  const partial = renderOps(
    80,
    { vitals },
    { now: NOW, loading: true, errors: { schedules: "connect ECONNREFUSED\nretry" } },
  );
  const flat = partial.map(stripAnsi).join("\n");
  assert.match(flat, /VITALS/, "the loaded section still renders");
  assert.match(flat, /✗ connect ECONNREFUSED retry/, "an error is single-line too");
  assert.match(flat, /◌ loading…/, "unset sections show loading while a fetch is in flight");
  for (const line of partial) {
    assert.equal(visibleWidth(line), 80);
    assert.ok(!line.includes("\n"));
  }
  const idle = renderOps(80, {}, { now: NOW }).map(stripAnsi).join("\n");
  assert.match(idle, /— no data/, "not loading and not fetched reads differently from loading");
  // Empty (fetched, zero rows) sections speak instead of silence
  const empties = renderOps(80, { schedules: [], env: { ...env, vars: [] as EnvVarView[], restartRequired: false }, sinks: [] }, { now: NOW })
    .map(stripAnsi)
    .join("\n");
  assert.match(empties, /no schedules — :schedules to manage/);
  assert.match(empties, /no env vars/);
  assert.match(empties, /no sinks — :notify to test/);
});

test("renderOps: hostile device-authored strings never split a row or leak escapes (run-9)", () => {
  const hostile = "triage\n  ✗ repo compromised\x1b]52;c,aGVsbG8=\x07 — run /git fix";
  const lines = renderOps(
    80,
    {
      vitals: { ...vitals, disk: { ...vitals.disk, path: hostile } },
      schedules: [schedule({ name: hostile })],
      env: { ...env, vars: [{ key: "EVIL_KEY", masked: hostile, secret: false, source: "file", managed: false }] },
      sinks: [sink({ url: hostile })],
    },
    { now: NOW, errors: { usage: hostile } },
  );
  for (const line of lines) {
    assert.equal(visibleWidth(line), 80, `width-exact: ${JSON.stringify(line)}`);
    assert.ok(!line.includes("\n"), `raw LF leaked: ${JSON.stringify(line)}`);
    assert.ok(!line.includes("\r"), `raw CR leaked: ${JSON.stringify(line)}`);
  }
  const flat = lines.map(stripAnsi).join("\n");
  assert.ok(!flat.includes("\x1b"), "an escape payload survived into the render");
  // The honest first line survives the collapse (same contract as herdRows).
  assert.match(flat, /triage/);
});

test("view 5 wiring: VIEW_TABS appends ops, the viewbar carries \"5 ops\", the ops statusbar teaches its keymap", () => {
  assert.equal(VIEW_TABS[4]!.id, "ops");
  const bar = stripAnsi(renderViewbar(120, "ops", ""));
  assert.match(bar, /1 network.*2 herd.*3 agent.*4 log.*5 ops/, "the viewbar numbers all five tabs");
  const status = renderStatusbar(100, { view: "ops", device: "box-one", ctxLeft: 42 });
  assert.equal(visibleWidth(status), 100);
  const plain = stripAnsi(status);
  assert.match(plain, /j\/k scroll.*R refresh.*1-5 views/, "ops has its own keymap line");
  assert.match(plain, /NORMAL/);
  // The four existing views keep their keymap untouched.
  assert.match(
    stripAnsi(renderStatusbar(100, { view: "herd", device: "d" })),
    /j\/k move.*1-5 views/,
    "herd keymap unchanged",
  );
});
