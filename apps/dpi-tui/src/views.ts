// herdr-style dashboard views (reference: herdr-0.4.0 apps/tui/src/app.ts),
// fed from THIS project's real data: SessionSummary[], DeviceRow[] and the
// App chrome. Pure string builders — no TTY, no timers — so every line is
// unit-testable exactly like the reference's frame(w, h).
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { SessionSummary } from "../../dpi-sdk/src/api.ts";
import type { DeviceRow } from "../../dpi-sdk/src/node/registry.ts";
import { c, STATE_COLOR, STATE_GLYPH, type RowState } from "./theme.ts";

export type View = "herd" | "network" | "agent";

export const VIEW_TABS: { id: View; label: string }[] = [
  { id: "herd", label: "herd" },
  { id: "network", label: "network" },
  { id: "agent", label: "agent" },
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
}

/** Group sessions by working directory (herdr groups by repo) and apply the / filter. */
export function herdRows(sessions: SessionSummary[], filter = ""): HerdRow[] {
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
    const key = basename(s.cwd);
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  for (const [dir, list] of groups) {
    out.push({ kind: "group", label: dir });
    for (const s of list) out.push({ kind: "session", label: s.name, sessionId: s.id });
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
      const group = sessions.filter((s) => basename(s.cwd) === row.label);
      const busy = group.filter((s) => s.busy).length;
      lines.push(
        `${c.muted("~/")}${c.text(row.label)}${c.muted("/")}  ${c.muted(`· ${group.length} agent${group.length === 1 ? "" : "s"} · ${busy} busy`)}`,
      );
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
    let line =
      `${marker}${fit(selected ? c.bold(s.name) : s.name, cols.name)}  ${fit(state, cols.state)}` +
      (showModel ? `  ${fit(c.muted(basename(s.model) || s.model), cols.model)}` : "") +
      `  ${fit(c.muted(agents), cols.agents)}`;
    if (showAge) line += `  ${fit(c.muted(ageOf(s.createdAt)), cols.age)}`;
    lines.push(atCursor && !selected ? c.inverse(fit(line, w)) : fit(line, w));
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
      label: d.name || d.id,
      deviceId: d.id,
      current: d.id === currentDeviceId,
    });
    for (const s of d.lastTree?.sessions ?? [])
      out.push({ kind: "session", label: s.name, deviceId: d.id, sessionId: s.id });
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
        `${c.muted(d.transport === "tunnel" ? "tunnel" : "lan")} ${c.muted(d.lastStatus === "online" ? seen : `${d.lastStatus} · ${seen}`)}`;
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

/** The one-line viewbar under the header: active tab inverse + a right-aligned hint. */
export function renderViewbar(w: number, view: View, right: string): string {
  const tabs = VIEW_TABS.map((t) =>
    t.id === view ? c.inverse(c.bold(` ${t.label} `)) : c.muted(` ${t.label} `),
  ).join(c.muted("│"));
  const gap = Math.max(1, w - visibleWidth(tabs) - visibleWidth(right) - 1);
  return fit(`${tabs}${rep(" ", gap)}${c.muted(right)}`, w);
}

/** The inverse status bar: mode chip + per-view keymap + right context. */
export function renderStatusbar(
  w: number,
  opts: { view: View; device: string; ctxLeft?: number; background?: number },
): string {
  const chip = c.accentBg(c.bold(" NORMAL "));
  const keys =
    opts.view === "agent"
      ? ["g herd", "N network", "a agents", "esc interrupt", "/cmd"]
      : ["j/k move", "↵ open", "1-9 jump", "g/N views", "esc agent"];
  const right = `${c.muted("ctx")} ${opts.ctxLeft === undefined ? c.muted("—") : c.text(`${opts.ctxLeft}%`)}${opts.background ? c.muted(` · ${opts.background} bg`) : ""}  ${c.muted("dev")} ${c.text(fit(opts.device, 18))}`;
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
  },
): string {
  const left = [
    `${c.accent("▲")} ${c.bold("dpi")}`,
    c.muted("tui"),
    c.muted("│"),
    `${opts.connOk ? c.ok("●") : c.err("○")} ${c.text(opts.conn)}`,
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
): string[] {
  if (!s) return Array.from({ length: Math.max(0, h) }, () => rep(" ", w));
  const agents = s.agents.map((a) =>
    a.kind === "fork" ? `⑂ ${a.name}` : a.kind === "subagent" ? `↳ ${a.name}` : `● ${a.name}`,
  );
  const lines = [
    c.muted(" OVERVIEW"),
    ` ${c.bold(s.name)}`,
    ` ${c.muted(basename(s.cwd))} ${c.muted("·")} ${c.text(basename(s.model) || s.model)}`,
    "",
    ` ${c.muted("state")}   ${STATE_COLOR[sessionState(s)](sessionState(s))}`,
    ` ${c.muted("agents")}  ${agents.length ? agents[0] : "—"}`,
    ...agents.slice(1, 8).map((a) => `          ${c.muted(a)}`),
    "",
    ` ${c.muted("ctx")}     ${ctxLeft === undefined ? c.muted("—") : c.text(`${ctxLeft}% left`)}`,
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
