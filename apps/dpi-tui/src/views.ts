// herdr-style dashboard views (reference: herdr-0.4.0 apps/tui/src/app.ts),
// fed from THIS project's real data: SessionSummary[], DeviceRow[] and the
// App chrome. Pure string builders — no TTY, no timers — so every line is
// unit-testable exactly like the reference's frame(w, h).
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type {
  DeviceUsageReport,
  DeviceVitals,
  EnvFileView,
  NotifySinkView,
  ScheduleView,
  SessionSummary,
} from "../../dpi-sdk/src/api.ts";
import type { GitStatus } from "../../dpi-sdk/src/client.ts";
import type { DeviceRow } from "../../dpi-sdk/src/node/registry.ts";
import { c, STATE_COLOR, STATE_GLYPH, type RowState } from "./theme.ts";
import { oneLine, sanitizeTerminal } from "./sanitize.ts";

export type View = "herd" | "network" | "agent" | "log" | "ops";

export const VIEW_TABS: { id: View; label: string }[] = [
  // Order = the user's journey (and the digit keys): land in the network
  // (hub-first boot), pick a session into the herd dashboard, converse in the
  // agent view, watch the log. Tab cycles the same order. Run-12 adds view 5
  // "ops" — the device-ops surfaces (vitals/usage/schedules/env/notify) the
  // SDK already exposed but no view rendered; digit 5 rides the same tab.
  { id: "network", label: "network" },
  { id: "herd", label: "herd" },
  { id: "agent", label: "agent" },
  { id: "log", label: "log" },
  { id: "ops", label: "ops" },
];

const rep = (ch: string, n: number) => ch.repeat(Math.max(0, n));

/** A one-line component whose text is computed at render time, with the real width. */
export class DynamicLine implements Component {
  constructor(public fn: (width: number) => string) {}
  render(width: number) {
    return [truncateToWidth(this.fn(width), width)];
  }
  invalidate() {}
}

/** A multi-line component whose body is computed at render time, with the real width. */
export class DynamicBlock implements Component {
  constructor(public fn: (width: number) => string[]) {}
  render(width: number) {
    return this.fn(width);
  }
  invalidate() {}
}
const padTo = (s: string, w: number) => s + rep(" ", Math.max(0, w - visibleWidth(s)));
// NOTE (audit run-1): untrusted row DATA is sanitized at the data boundary
// (herdRows/networkRows/… builders), NOT here — styled composites pass through
// fit() and would lose the theme's own SGR colors to the strip.
const fit = (s: string, w: number) =>
  padTo(truncateToWidth(s, Math.max(0, w), "…"), Math.max(0, w));
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const compact = (n: number) =>
  Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
export const ageOf = (createdAt: number, now = Date.now()) => {
  const s = Math.max(0, Math.floor((now - createdAt) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

export const sessionState = (s: SessionSummary): RowState =>
  s.error ? "error" : s.busy ? "busy" : "idle";

/**
 * The state suffix the /git toast and the agent-header chip append after
 * branch ±dirty (R5 finding 4): a merge in progress and a detached HEAD used
 * to be invisible in the TUI while the backend already reported both — the
 * web's GitPanel has carried a merge banner all along. Mirrors the FE text.
 */
export function gitStateSuffix(g: Pick<GitStatus, "merge" | "conflicts" | "detached">): string {
  if (g.merge) return ` · merging (${Number(g.conflicts) || 0} conflicts)`;
  if (g.detached) return " (detached)";
  return "";
}
export const deviceState = (d: DeviceRow): RowState =>
  d.lastStatus === "online"
    ? "busy"
    : d.lastStatus === "checking"
      ? "idle"
      : d.lastStatus === "offline"
        ? "idle"
        : "error";

export interface HerdRow {
  kind: "group" | "session";
  label: string;
  sessionId?: string;
  /** ⎇ branch of the session's cwd, when the batch fetch knows it. */
  branch?: string;
}

/** Group sessions by working directory (herdr groups by repo) and apply the / filter. */
export function herdRows(sessions: SessionSummary[], filter = "", branchOf?: (cwd: string) => string | undefined): HerdRow[] {
  const needle = filter.trim().toLowerCase();
  const kept = needle
    ? sessions.filter((s) =>
        [s.name, s.cwd, s.model, s.busy ? "busy" : "idle"].some((v) =>
          v.toLowerCase().includes(needle),
        ),
      )
    : sessions;
  const out: HerdRow[] = [];
  const groups = new Map<string, SessionSummary[]>();
  for (const s of kept) {
    const key = basename(String(s.cwd ?? ""));
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  for (const [dir, list] of groups) {
    out.push({ kind: "group", label: oneLine(String(dir ?? "")) });
    for (const s of list)
      out.push({
        kind: "session",
        label: oneLine(String(s.name ?? "")),
        sessionId: s.id,
        branch: branchOf ? oneLine(String(branchOf(String(s.cwd ?? "")) ?? "")) || undefined : undefined,
      });
  }
  return out;
}

/** The herd table: NAME · STATE · MODEL · AGENTS · AGE, grouped by directory. */
export function renderHerd(
  w: number,
  rows: HerdRow[],
  sessions: SessionSummary[],
  opts: { selectedId?: string; cursor?: number; filter?: string } = {},
): string[] {
  const showAge = w >= 72;
  const showModel = w >= 84;
  const cols = {
    name: clamp(w - (showModel ? 44 : 34) - (showAge ? 8 : 0), 12, 30),
    state: 9,
    model: 18,
    agents: 7,
    age: 6,
  };
  const lines: string[] = [
    c.muted(
      `  ${fit("NAME", cols.name)}  ${fit("STATE", cols.state)}` +
        (showModel ? `  ${fit("MODEL", cols.model)}` : "") +
        `  ${fit("AGENTS", cols.agents)}` +
        (showAge ? `  ${fit("AGE", cols.age)}` : ""),
    ),
  ];
  const cursorRow = rows[opts.cursor ?? 0];
  for (const row of rows) {
    if (row.kind === "group") {
      const group = sessions.filter((s) => oneLine(String(basename(String(s.cwd ?? "")) ?? "")) === row.label);
      const busy = group.filter((s) => s.busy).length;
      const header = `${c.muted("~/")}${c.text(row.label)}${c.muted("/")}  ${c.muted(`· ${group.length} agent${group.length === 1 ? "" : "s"} · ${busy} busy`)}`;
      // The cursor is drawn on headers too: a keypress must always be visible,
      // even though j/k skips them (they are not selectable entries).
      lines.push(cursorRow === row ? c.inverse(fit(header, w)) : fit(header, w));
      continue;
    }
    const s = sessions.find((x) => x.id === row.sessionId);
    if (!s) continue;
    const selected = s.id === opts.selectedId;
    const atCursor = cursorRow?.sessionId === s.id;
    const marker = selected ? c.accent("▌ ") : "  ";
    const state = `${STATE_COLOR[sessionState(s)](STATE_GLYPH[sessionState(s)])} ${c.muted(fit(sessionState(s), 7))}`;
    const forks = s.agents.filter((a) => a.kind === "fork").length;
    const subs = s.agents.filter((a) => a.kind === "subagent").length;
    const agents = `${s.agents.length}${forks ? `⑂${forks}` : ""}${subs ? `↳${subs}` : ""}`;
    const branch = row.branch ? ` ${c.muted(`⎇ ${fit(row.branch, 10)}`)}` : "";
    let line =
      `${marker}${fit(selected ? c.bold(row.label) : row.label, cols.name - visibleWidth(branch))}${branch}  ${fit(state, cols.state)}` +
      (showModel ? `  ${fit(c.muted(oneLine(String((basename(String(s.model ?? "")) || s.model) ?? ""))), cols.model)}` : "") +
      `  ${fit(c.muted(agents), cols.agents)}`;
    if (showAge) line += `  ${fit(c.muted(ageOf(s.createdAt)), cols.age)}`;
    lines.push(atCursor && !selected ? c.inverse(fit(line, w)) : fit(line, w));
  }
  if (!rows.length && opts.filter) {
    // A filter that matches nothing must say so: 0 rows alone reads as
    // "the sessions vanished", not "your filter is hiding them".
    lines.push("", `  ${c.muted(`no sessions match “${opts.filter}” — esc clears`)}`);
  } else if (!rows.length) {
    // herdr never shows a bare header over nothing: the empty state points at
    // the next move instead of a wall of blank rows.
    lines.push(
      "",
      `  ${c.muted("no sessions yet on this device")}`,
      "",
      `  ${c.accent("n")} ${c.muted("new session")}   ${c.accent(":")} ${c.muted("palette")}   ${c.accent("N")} ${c.muted("network view")}`,
    );
  }
  if (opts.filter) lines.push(c.warn(`filter: ${opts.filter}`));
  // herdr frames pad EVERY line to the exact width — the caller paints rows as-is.
  return lines.map((l) => fit(l, w));
}

export interface NetRow {
  kind: "device" | "session";
  label: string;
  deviceId?: string;
  sessionId?: string;
  current?: boolean;
}

/** The network tree: every registry device, its sessions underneath (herdr: device › repo › agent). */
export function networkRows(devices: DeviceRow[], currentDeviceId: string, filter = ""): NetRow[] {
  const needle = filter.trim().toLowerCase();
  const out: NetRow[] = [];
  for (const d of devices) {
    if (needle && !`${d.name} ${d.id} ${d.kind} ${d.transport}`.toLowerCase().includes(needle))
      continue;
    out.push({
      kind: "device",
      label: oneLine(String(d.name || d.id)),
      deviceId: d.id,
      current: d.id === currentDeviceId,
    });
    for (const s of (Array.isArray(d.lastTree?.sessions) ? d.lastTree!.sessions : []))
      out.push({ kind: "session", label: oneLine(String(s.name ?? "")), deviceId: d.id, sessionId: s.id });
  }
  return out;
}

export function renderNetwork(
  w: number,
  rows: NetRow[],
  devices: DeviceRow[],
  opts: { cursor?: number; currentSessionId?: string; filter?: string } = {},
): string[] {
  const lines: string[] = [];
  for (const [index, row] of rows.entries()) {
    const atCursor = index === (opts.cursor ?? 0);
    let label: string;
    if (row.kind === "device") {
      const d = devices.find((x) => x.id === row.deviceId)!;
      const dot =
        d.lastStatus === "online"
          ? c.ok("●")
          : d.lastStatus === "checking"
            ? c.warn("◌")
            : c.muted("○");
      const seen = d.lastSeenAt ? ageOf(d.lastSeenAt) : "never";
      label =
        `${dot} ${c.bold(row.label)}${row.current ? c.accent(" ▌") : ""} ${c.muted(`[${d.kind}]`)} ` +
        `${c.muted(d.transport === "tunnel" ? "tunnel" : "lan")} ${c.muted(d.lastStatus === "online" ? seen : `${oneLine(d.lastStatus)} · ${seen}`)}`;
    } else {
      const selected = row.sessionId === opts.currentSessionId;
      const marker = selected ? c.accent("▌") : " ";
      const session = devices
        .find((d) => d.id === row.deviceId)
        ?.lastTree?.sessions.find((s) => s.id === row.sessionId);
      const glyph = session?.busy ? c.accent("●") : c.muted("·");
      label = `   ${c.muted("└─")} ${marker} ${glyph} ${fit(row.label, Math.max(8, w - 30))}`;
    }
    lines.push(atCursor ? c.inverse(fit(label, w)) : fit(label, w));
  }
  if (opts.filter) lines.push(c.warn(`filter: ${opts.filter}`));
  return lines.map((l) => fit(l, w));
}

/**
 * The one-line viewbar under the header: active tab inverse + a right-aligned
 * hint. Every view carries its digit (1 network · 2 herd · 3 agent · 4 log ·
 * 5 ops) — the digit keys work EVERYWHERE, so view switching is one glance
 * away instead of three mnemonics (g/N/L) to memorize.
 */
export function renderViewbar(w: number, view: View, right: string): string {
  const tabs = VIEW_TABS.map((t, i) =>
    t.id === view ? c.inverse(c.bold(` ${i + 1} ${t.label} `)) : c.muted(` ${i + 1} ${t.label} `),
  ).join(c.muted("│"));
  const gap = Math.max(1, w - visibleWidth(tabs) - visibleWidth(right) - 1);
  return fit(`${tabs}${rep(" ", gap)}${c.muted(right)}`, w);
}

/** The inverse status bar: mode chip + per-view keymap + right context. */
export function renderStatusbar(
  w: number,
  opts: { view: View; device: string; ctxLeft?: number; background?: number; mode?: "NORMAL" | "INSERT" },
): string {
  const insert = opts.mode === "INSERT";
  const chip = insert ? c.warn(" INSERT ") : c.accentBg(c.bold(" NORMAL "));
  const keys = insert
    ? ["tab complete", "↑ history", "enter send", "esc cancel"]
    : opts.view === "agent"
      ? ["g herd", "N network", "L log", "[ ] tabs", "m message"]
      : opts.view === "ops"
        ? ["j/k scroll", "R refresh", "1-5 views", ": palette", "esc herd"]
        : ["j/k move", "↵ open", "1-5 views", "⇥ tabs", "esc agent"];
  // Catalog miss degrades to "?" (R5 finding 5): "—" read as "no usage yet",
  // when it actually means the window is unknown — a different problem.
  const right = `${c.muted("ctx")} ${opts.ctxLeft === undefined ? c.muted("?") : c.text(`${opts.ctxLeft}%`)}${opts.background ? c.muted(` · ${opts.background} bg`) : ""}  ${c.muted("dev")} ${c.text(fit(oneLine(String(opts.device ?? "")), 18))}`;
  const left = `${chip} ${keys.map((k) => c.muted(k)).join(c.muted(" • "))}`;
  const gap = Math.max(1, w - visibleWidth(left) - visibleWidth(right));
  return c.inverse(padTo(fit(`${left}${rep(" ", gap)}${right}`, w), w));
}

/** The top header line: brand + device + counters + connection, right-aligned hints. */
export function renderHeader(
  w: number,
  opts: {
    device: string;
    sessions: number;
    devicesOnline?: number;
    devicesTotal?: number;
    conn: string;
    connOk: boolean;
    /**
     * run-14 (hub resilience): a countdown to the next reconnect attempt
     * (`↻12s`), appended to the conn chip while the hub is OFFLINE so the
     * operator sees WHEN the retry fires instead of a dead `hub offline`.
     * Absent (live, connecting, direct devices) → byte-identical to the
     * pre-run-14 render — the r12/r13 header tests pin those bytes.
     */
    retry?: string;
  },
): string {
  const left = [
    `${c.accent("▲")} ${c.bold("dpi")}`,
    c.muted("tui"),
    c.muted("│"),
    `${opts.connOk ? c.ok("●") : c.err("○")} ${c.text(opts.conn)}${opts.retry ? c.muted(` · ${opts.retry}`) : ""}`,
    c.muted(`${opts.sessions} session${opts.sessions === 1 ? "" : "s"}`),
    opts.devicesTotal !== undefined
      ? c.muted(`${opts.devicesOnline ?? 0}/${opts.devicesTotal} devices`)
      : "",
  ]
    .filter(Boolean)
    .join("  ");
  const right = c.muted("? help  : palette  q quit");
  const gap = Math.max(1, w - visibleWidth(left) - visibleWidth(right));
  return fit(`${left}${rep(" ", gap)}${right}`, w);
}

/** The herd overview panel (wide terminals): selected session at a glance. */
export function renderHerdPanel(
  w: number,
  h: number,
  s: SessionSummary | undefined,
  ctxLeft?: number,
  device?: string,
  git?: { repo: boolean; branch?: string; head?: string; staged?: number; unstaged?: number; untracked?: number; ahead?: number; behind?: number; worktreeOf?: string },
  /** The device's advertised default model id — a session on it is "(default)". */
  defaultModel?: string,
): string[] {
  // No session selected: a blank panel next to the divider is what made the
  // wide layout look broken — herdr's panel always carries a device header.
  if (!s) {
    const lines = [
      c.muted(" OVERVIEW"),
      ` ${c.bold(sanitizeTerminal(device ?? "device"))}`,
      ` ${c.muted("no session selected")}`,
      "",
      ` ${c.muted("n")}        ${c.text("new session")}`,
      ` ${c.muted("↵")}        ${c.text("open the cursor row")}`,
      ` ${c.muted("j/k")}      ${c.text("move")}`,
      ` ${c.muted(":")}        ${c.text("palette")}`,
    ];
    return lines.slice(0, h).map((l) => fit(l, w));
  }
  // R14 cold review: the panel renders the SAME device-sourced fields as the
  // table — name, cwd basename, model, agent names — so it sanitizes them at
  // the data boundary exactly like herdRows/renderHerd do.
  const agents = s.agents.map((a) =>
    a.kind === "fork" ? `⑂ ${sanitizeTerminal(a.name)}` : a.kind === "subagent" ? `↳ ${sanitizeTerminal(a.name)}` : `● ${sanitizeTerminal(a.name)}`,
  );
  // A session on exactly the device's default model says so, muted — the same
  // signal the web dialog's "(device default)" row carries.
  const onDefault = defaultModel !== undefined && s.model === defaultModel;
  const lines = [
    c.muted(" OVERVIEW"),
    ` ${c.bold(oneLine(String(s.name ?? "")))}`,
    ` ${c.muted(oneLine(String(basename(String(s.cwd ?? "")) ?? "")))} ${c.muted("·")} ${c.text(oneLine(String((basename(String(s.model ?? "")) || s.model) ?? "")))}${onDefault ? c.muted(" (default)") : ""}`,
    git?.repo
      ? ` ${c.muted("⎇")} ${c.text(oneLine(String(git.branch ?? git.head ?? "?")))}${c.muted("±")}${c.text(String((Number(git.staged) || 0) + (Number(git.unstaged) || 0) + (Number(git.untracked) || 0)))}${Number(git.ahead) > 0 ? c.text(` ↑${Number(git.ahead)}`) : ""}${Number(git.behind) > 0 ? c.text(` ↓${Number(git.behind)}`) : ""}${git.worktreeOf ? c.muted(" · worktree") : ""}`
      : "",
    "",
    ` ${c.muted("state")}   ${STATE_COLOR[sessionState(s)](sessionState(s))}`,
    ` ${c.muted("agents")}  ${agents.length ? agents[0] : "—"}`,
    ...agents.slice(1, 8).map((a) => `          ${c.muted(a)}`),
    "",
    ` ${c.muted("ctx")}     ${ctxLeft === undefined ? c.muted("?") : c.text(`${ctxLeft}% left`)}`,
    ` ${c.muted("age")}     ${c.muted(ageOf(s.createdAt))}`,
    ` ${c.muted("tokens")}  ${c.muted(compact(s.agents.reduce((n, a) => n + a.background, 0)) + " bg")}`,
  ];
  return lines.slice(0, h).map((l) => fit(l, w));
}

/** Join table + panel columns herdr-style: `table │ panel` — tableW is the table column's exact width. */
export function joinPanel(
  table: string[],
  panel: string[],
  tableW: number,
  w: number,
  h: number,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < h; i += 1)
    out.push(
      `${padTo(table[i] ?? "", tableW)}${c.muted("│")}${panel[i] ?? rep(" ", Math.max(0, w - tableW - 1))}`,
    );
  return out;
}

// ------------------------------------------------------------------- ops

/**
 * View 5 "ops" data (run-12): the five device-ops reads the SDK client
 * already exposed (vitals/deviceUsage/schedules/envView/notifySinks) but no
 * TUI surface rendered. Each section is optional and fails ALONE — a 500 on
 * /v1/schedules must not blank vitals — so the app fetches them
 * independently and renderOps degrades per section.
 */
export interface OpsData {
  vitals?: DeviceVitals;
  usage?: DeviceUsageReport;
  schedules?: ScheduleView[];
  env?: EnvFileView;
  sinks?: NotifySinkView[];
}

/** Per-section fetch failures (run-12): keyed like OpsData, shown inline. */
export type OpsErrors = Partial<Record<keyof OpsData, string>>;

/** Host-health seconds → "3d 4h" / "5h 12m" / "42m" — compact, like ageOf. */
const uptimeOf = (seconds: number) => {
  const t = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(t / 86400);
  const h = Math.floor((t % 86400) / 3600);
  const m = Math.floor((t % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
};

/** Bytes → "512MiB"-style, 1 decimal under 100 (the vitals mem/disk rows). */
const humanBytes = (n: number) => {
  let v = Math.max(0, Number(n) || 0);
  let u = 0;
  while (v >= 1024 && u < 4) {
    v /= 1024;
    u += 1;
  }
  return `${u === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)}${["B", "KiB", "MiB", "GiB", "TiB"][u]}`;
};

/** The schedule clock the device computed → "in 42m" / "due" / "—". */
const nextIn = (at: number | null | undefined, now: number) => {
  if (at === null || at === undefined) return "—";
  const s = Math.floor((at - now) / 1000);
  if (s <= 0) return "due";
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.floor(s / 60)}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h`;
  return `in ${Math.floor(s / 86400)}d`;
};

/**
 * The ops view body (run-12): stacked compact sections — VITALS (uptime ·
 * mem/disk · event-loop lag · gitSpawns live/queued+high), USAGE, SCHEDULES
 * (●/○ enabled glyph, device-computed next run), ENV (key=masked, truncated
 * to width), NOTIFY sinks. Section headers ride the theme accent like the
 * herd panel's OVERVIEW. Pure builder like every other render* here: every
 * line is width-exact and SINGLE-LINE (run-9 invariant) — device-authored
 * fields (schedule names, env keys/values, sink urls, disk paths) pass
 * oneLine at this data boundary exactly like herdRows/networkRows do.
 */
export function renderOps(
  w: number,
  data: OpsData,
  opts: { errors?: OpsErrors; loading?: boolean; now?: number } = {},
): string[] {
  const now = opts.now ?? Date.now();
  const lines: string[] = [];
  const section = (title: string, key: keyof OpsData, rows: () => string[]) => {
    lines.push(` ${c.accent(title)}`);
    const err = opts.errors?.[key];
    if (err !== undefined) lines.push(`  ${c.err(`✗ ${oneLine(String(err ?? ""))}`)}`);
    else if (data[key] === undefined)
      // Missing ≠ empty: an unset section is still loading (or never fetched);
      // an empty one says so in its own rows below.
      lines.push(`  ${c.muted(opts.loading ? "◌ loading…" : "— no data")}`);
    else lines.push(...rows());
    lines.push("");
  };

  section("VITALS", "vitals", () => {
    const v = data.vitals!;
    const out = [
      `  ${c.muted("up")} ${c.text(uptimeOf(v.uptime))} ${c.muted("proc")} ${c.text(uptimeOf(v.processUptime))} ${c.muted("load")} ${c.text(v.loadavg.map((n) => (Number(n) || 0).toFixed(2)).join(" "))} ${c.muted(`×${Number(v.cpuCount) || 0}`)}`,
      `  ${c.muted("mem")} ${c.text(`${humanBytes(v.memory.usedBytes)}/${humanBytes(v.memory.totalBytes)}`)} ${c.muted("free")} ${c.text(humanBytes(v.memory.freeBytes))} ${c.muted("rss")} ${c.text(humanBytes(v.memory.processRssBytes))} ${c.muted("heap")} ${c.text(humanBytes(v.memory.heapUsedBytes))}`,
      `  ${c.muted("disk")} ${v.disk.known ? `${c.text(`${humanBytes(v.disk.freeBytes)}/${humanBytes(v.disk.totalBytes)}`)} ${c.muted("free")} ${c.muted(oneLine(String(v.disk.path ?? "")))}` : c.muted("unknown")}`,
      // run-12 phase 1 typed these into the SDK: event-loop lag is the stall
      // loadavg cannot express, and gitSpawns' queued(+high) is the number
      // that says "a status fan-out is stalling the panel" (run-11 h2-2).
      `  ${c.muted("evlag")} ${c.text(`${Math.round(Number(v.eventLoop?.lagMsLast) || 0)}ms`)} ${c.muted("last")} ${c.text(`${Math.round(Number(v.eventLoop?.lagMsMax1m) || 0)}ms`)} ${c.muted("max 1m")} ${c.muted(`${Number(v.eventLoop?.samples) || 0} samples`)}`,
      `  ${c.muted("git")} ${c.text(`${Number(v.gitSpawns?.live) || 0} live`)} ${c.muted("·")} ${c.text(`${Number(v.gitSpawns?.queued) || 0} queued`)}${Number(v.gitSpawns?.queuedHigh) > 0 ? c.warn(` · ${Number(v.gitSpawns.queuedHigh)} high`) : ""}${Number(v.gitSpawns?.queuedAged) > 0 ? c.warn(` · ${Number(v.gitSpawns.queuedAged)} aged`) : ""}`,
    ];
    if (v.counts)
      out.push(
        `  ${c.muted("sessions")} ${c.text(String(Number(v.counts.sessions) || 0))} ${c.muted("archived")} ${c.text(String(Number(v.counts.archived) || 0))}`,
      );
    return out;
  });

  section("USAGE", "usage", () => {
    const u = data.usage!;
    const sessions = Array.isArray(u.sessions) ? u.sessions : [];
    const out = [
      `  ${c.text(`${compact(Number(u.totals?.tokens) || 0)} tokens`)} ${c.muted("·")} ${c.text(`$${(Number(u.totals?.cost) || 0).toFixed(2)}`)} ${c.muted(`· ${sessions.length} session${sessions.length === 1 ? "" : "s"}`)}`,
    ];
    for (const s of [...sessions].sort((a, b) => (Number(b.tokens) || 0) - (Number(a.tokens) || 0)).slice(0, 3))
      out.push(
        `  ${c.text(oneLine(String(s.name ?? s.id ?? "")))} ${c.muted(`${compact(Number(s.tokens) || 0)} · $${(Number(s.cost) || 0).toFixed(2)}`)}`,
      );
    return out;
  });

  section("SCHEDULES", "schedules", () => {
    const list = Array.isArray(data.schedules) ? data.schedules : [];
    if (!list.length) return [`  ${c.muted("no schedules — :schedules to manage")}`];
    return list.map((s) => {
      // Exactly one trigger is set (ScheduleRecord); hostile wire data falls
      // back to "daily ?" instead of throwing.
      const trigger = s.everyMinutes
        ? `every ${Number(s.everyMinutes)}m`
        : `daily ${oneLine(String(s.dailyAt ?? "?"))}`;
      const glyph = s.enabled ? c.ok("●") : c.muted("○");
      return `  ${glyph} ${c.text(oneLine(String(s.name ?? s.id)))} ${c.muted(trigger)} ${c.muted(nextIn(s.nextRunAt, now))}${s.running ? c.warn(" · running") : ""}`;
    });
  });

  section("ENV", "env", () => {
    const e = data.env!;
    const out = [
      `  ${c.muted(oneLine(String(e.envFile ?? "")))}${e.restartRequired ? c.warn(" · restart required") : ""}`,
    ];
    const vars = Array.isArray(e.vars) ? e.vars : [];
    if (!vars.length) out.push(`  ${c.muted("no env vars")}`);
    // Values arrive MASKED from the device (EnvVarView); the operator trusts
    // their own terminal, so the masked form renders as-is, truncated to width.
    for (const v of vars)
      out.push(
        `  ${c.text(oneLine(String(v.key ?? "")))}${c.muted("=")}${c.text(oneLine(String(v.masked ?? "")))}${v.managed ? c.muted(" (managed)") : ""}${v.source === "process" ? c.muted(" (process)") : ""}`,
      );
    return out;
  });

  section("NOTIFY", "sinks", () => {
    const list = Array.isArray(data.sinks) ? data.sinks : [];
    if (!list.length) return [`  ${c.muted("no sinks — :notify to test")}`];
    return list.map((s) => {
      const glyph = s.enabled ? c.ok("●") : c.muted("○");
      return `  ${glyph} ${c.muted(oneLine(String(s.kind ?? "")))} ${c.text(oneLine(String(s.url ?? "")))}${s.silencedUntil && s.silencedUntil > now ? c.warn(" · silenced") : ""}`;
    });
  });

  return lines.map((l) => fit(l, w));
}
