// The TUI, rebuilt on the herdr-0.4.0 template (apps/tui/src/app.ts of the
// owner-supplied reference): a PURE frame(width, height) renderer driven by
// handleInput/tick, four views (herd | network | agent | log), five agent
// tabs, inline message input, in-frame palette/help panels. The data layer is
// this project's real machinery — DpiClient streams, AgentModel/SessionModel,
// the pairing controller — adapted into herdr's shapes.
import {
  ProcessTerminal,
  TuiAltScreen,
  matchesKey,
  type Component,
  type OverlayHandle,
  type TuiInputListenerResult,
} from "@earendil-works/pi-tui";
import { DpiClient, follow, type AgentHandle, type ConnectionState, type GitStatus } from "../../dpi-sdk/src/client.ts";
import { isDpiError } from "../../dpi-sdk/src/errors.ts";
import { AgentModel, SessionModel } from "../../dpi-sdk/src/models.ts";
import { sumUsage } from "../../dpi-sdk/src/transcript.ts";
import {
  THINKING_LEVELS,
  type DeviceInfo,
  type SessionSummary,
  type ThinkingLevel,
  type WhenBusy,
  type WireAssistantMessage,
} from "../../dpi-sdk/src/api.ts";
import type { DeviceRow, NetworkRegistry } from "../../dpi-sdk/src/node/registry.ts";
import { COMMANDS, runCommand } from "./commands.ts";
import { Prompt, SecretPrompt, pickModel, newSession } from "./pickers.ts";
import { renderHeader, renderHerd, renderHerdPanel, renderNetwork, renderStatusbar, renderViewbar, herdRows, joinPanel, networkRows } from "./views.ts";
import { appendFileSync } from "node:fs";
import { fetchHubNetwork } from "./hub-feed.ts";
import { HubMux } from "./hub-mux.ts";
import { box, c, STATE_COLOR, STATE_GLYPH, type RowState } from "./theme.ts";

export interface DeviceRef {
  id: string;
  name: string;
  url: string;
  token: string;
}

type View = "herd" | "network" | "agent" | "log";
type AgentTab = "transcript" | "tasks" | "tools" | "state" | "config";
type InputKind = "message" | "filter" | "palette" | "new" | "kill";

const AGENT_TABS: { id: AgentTab; label: string }[] = [
  { id: "transcript", label: "transcript" },
  { id: "tasks", label: "tasks" },
  { id: "tools", label: "tools" },
  { id: "state", label: "state" },
  { id: "config", label: "config" },
];

const VIEW_TABS: { id: View; label: string }[] = [
  { id: "herd", label: "herd" },
  { id: "network", label: "network" },
  { id: "agent", label: "agent" },
  { id: "log", label: "log" },
];

/**
 * Slash-command autocomplete: the commands whose name extends the typed
 * prefix. Live only before the first space — after that you are typing
 * arguments, not a command.
 */
export function slashSuggestions(
  value: string,
  commands: { name: string }[],
): { names: string[]; prefix: string } | null {
  if (!value.startsWith("/") || value.includes(" ")) return null;
  const prefix = value.slice(1).toLowerCase();
  const names = commands.map((c) => c.name).filter((n) => n.startsWith(prefix));
  return names.length ? { names, prefix } : null;
}

const PALETTE: { name: string; hint: string; run: (a: App) => void }[] = [
  { name: "herd", hint: "session dashboard", run: (a) => a.setView("herd") },
  { name: "network", hint: "devices and sessions", run: (a) => a.setView("network") },
  { name: "agent", hint: "back to the conversation", run: (a) => a.setView("agent") },
  { name: "log", hint: "device events", run: (a) => a.setView("log") },
  { name: "sessions", hint: "switch or create a session", run: (a) => void a.command("sessions") },
  { name: "model", hint: "choose this agent's model", run: (a) => void a.command("model") },
  { name: "fork", hint: "fork at the last reply", run: (a) => void a.command("fork") },
  { name: "compact", hint: "summarize older context", run: (a) => void a.command("compact") },
  { name: "pair", hint: "pair this device with a hub", run: (a) => void a.command("pair") },
  { name: "quit", hint: "exit (the agent keeps running)", run: (a) => a.exit() },
];

const newId = () => crypto.randomUUID();
const shellWord = (s: string) => (/^[\w.:@/~-]+$/.test(s) ? s : `'${s}'`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const compactNum = (n: number) => Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const rep = (ch: string, n: number) => ch.repeat(Math.max(0, n));

/** The whole app paints through this single component — herdr's AppView. */
class AppView implements Component {
  constructor(private readonly app: App) {}
  invalidate() {}
  render(width: number): string[] {
    return this.app.frame(width);
  }
}

export class App {
  private readonly procTerminal = new ProcessTerminal();
  readonly tui = new TuiAltScreen(this.procTerminal, false, undefined, {
    scrollToEndIndicator: () => c.muted(" ↓ new output "),
  });
  readonly model = new AgentModel();
  readonly session = new SessionModel();
  sessionId?: string;
  agentId?: number;
  handle?: AgentHandle;
  info: DeviceInfo;

  // herdr app state --------------------------------------------------------
  view: View = "herd";
  tab: AgentTab = "transcript";
  cursor = 0;
  filter = "";
  input: { kind: InputKind; value: string } | null = null;
  helpOpen = false;
  toast = "";
  toastTicks = 0;
  scrollOffset = 0;
  /** ctrl+o: show full tool output instead of the first lines. */
  expand = false;
  /** Slash autocomplete: which suggestion row is selected (0 = first). */
  private suggIndex = 0;
  /** Hub feed (multi-host display parity with the web sidebar). */
  private hub?: { url: string; token: string };
  /** The hub's /api/stream mux — tunnel-device attach (same transport as the web). */
  private mux?: HubMux;
  /** True while the current device is reached through the hub proxy. */
  private viaHub = false;
  private hubRows: DeviceRow[] = [];
  private hubTick = 0;

  /** Sent-message history for ↑ recall (drafts preserved while browsing). */
  private inputHistory: string[] = [];
  private histIndex = -1;
  private inputDraft = "";

  device: DeviceRef;
  client: DpiClient;
  registry?: NetworkRegistry;

  private root = new AppView(this);
  private connection: ConnectionState | "idle" = "idle";
  private streams?: AbortController;
  private overlays: Array<{ handle: OverlayHandle; onClose?: () => void }> = [];
  private ticker?: ReturnType<typeof setInterval>;
  private sessions: SessionSummary[] = [];
  /** Ambient git for the panel: cwd → {at, status}, 30s TTL, fetched as the
   *  cursor moves — the herd and agent header always show ⎇ branch ±dirty. */
  private gitCache = new Map<string, { at: number; s: GitStatus }>();

  private refreshGit(cwd: string | undefined) {
    if (!cwd) return;
    const hit = this.gitCache.get(cwd);
    if (hit && Date.now() - hit.at < 30_000) return;
    void this.client
      .gitStatus(cwd)
      .then((s) => {
        this.gitCache.set(cwd, { at: Date.now(), s });
        this.requestRender();
      })
      .catch(() => {});
  }

  private gitOf(cwd: string | undefined): GitStatus | undefined {
    return cwd ? this.gitCache.get(cwd)?.s : undefined;
  }
  private devicesCache: DeviceRow[] = [];
  private deviceOnline = false;
  private events: { at: string; glyph: string; text: string }[] = [];
  private selectedId?: string;

  constructor(
    device: DeviceRef,
    client: DpiClient,
    info: DeviceInfo,
    registry?: NetworkRegistry,
    hub?: { url: string; token: string },
  ) {
    this.device = device;
    this.client = client;
    this.info = info;
    this.registry = registry;
    this.hub = hub;
    this.tui.addChild(this.root);
    this.tui.setFocus(this.root);
    // herdr render model: every keystroke and every tick repaint, so plain
    // typing (append chars, no explicit notify) is never left off-screen.
    this.tui.addInputListener((data) => {
      const result = this.handleInput(data);
      this.requestRender();
      return result;
    });
    this.model.subscribe(() => this.requestRender());
    this.session.subscribe(() => this.requestRender());
    this.ticker = setInterval(() => this.tick(), 120);
    if (this.hub)
      void fetchHubNetwork(this.hub.url, this.hub.token).then((rows) => {
        if (rows) (this.hubRows = rows), this.requestRender();
      });
    this.tui.start();
    void this.refreshSessions();
    this.requestRender();
  }

  // ------------------------------------------------------------------ streams

  async open(sessionRef?: string, agentRef?: string) {
    if (!sessionRef) return this.setView("herd");
    await this.run(async () => {
      const s = await this.client.session(sessionRef).get();
      const agentId = agentRef
        ? (await this.client.agent(s.id, agentRef).get()).id
        : (s.agents.find((a) => a.kind === "root") ?? s.agents[0])?.id ?? 1;
      await this.attach(s.id, agentId);
    });
  }

  async attach(sessionId: string, agentId: number) {
    this.streams?.abort();
    const streams = (this.streams = new AbortController());
    const sameSession = sessionId === this.sessionId;
    this.sessionId = sessionId;
    this.selectedId = sessionId;
    this.agentId = agentId;
    this.handle = this.client.agent(sessionId, agentId);
    this.model.clear();
    if (!sameSession) this.session.clear();
    this.scrollOffset = 0;
    void this.refreshSessions();
    const handle = this.handle;
    // Hub-routed devices stream through the mux (same upstreams the web rides);
    // direct devices stream straight from the device.
    const agentEvents = (signal: AbortSignal) =>
      this.viaHub && this.mux
        ? this.mux.events(`${this.device.id}/agent/${sessionId}/${agentId}`, signal)
        : handle.events(signal);
    const sessionEvents = (signal: AbortSignal) =>
      this.viaHub && this.mux
        ? this.mux.events(`${this.device.id}/session/${sessionId}`, signal)
        : this.client.session(sessionId).events(signal);
    void follow(
      agentEvents,
      (frame) => this.model.apply(frame),
      (state, error) => {
        this.connection = state;
        if (error && state !== "offline") this.notify(error.message, true);
        this.requestRender();
      },
      streams.signal,
    );
    void follow(
      sessionEvents,
      (frame) => this.session.apply(frame),
      () => {},
      streams.signal,
    );
    this.setView("agent");
    this.logEvent("start", `attached ${sessionId}:${agentId}`);
  }

  async switchDevice(id: string) {
    const row = this.registry?.get(id) ?? this.hubRows.find((d) => d.id === id);
    if (!row) return this.notify(`Unknown device ${id}`, true);
    if (!row.url) {
      // Tunnel device: no LAN endpoint here — reach it through the hub proxy
      // (REST) + the hub's stream mux (events), exactly like the web FE.
      if (!this.hub) return this.notify(`${row.name} is tunnel-only — start the TUI with --hub-url/--hub-token`, true);
      const client = new DpiClient(`${this.hub.url}/api/devices/${row.id}`, this.hub.token);
      this.mux ??= new HubMux(this.hub);
      return void this.run(async () => {
        this.info = await client.device({ timeoutMs: 10_000 });
        this.streams?.abort();
        this.device = { id: row.id, name: row.name, url: client.baseUrl, token: this.hub!.token };
        this.client = client;
        this.viaHub = true;
        this.sessionId = undefined;
        this.agentId = undefined;
        this.handle = undefined;
        this.model.clear();
        this.session.clear();
        this.sessions = [];
        this.notify(`attached ${row.name} through the hub`);
        await this.refreshSessions();
        this.setView("herd");
      });
    }
    if (!row.token) return this.notify(`No token for ${id}. Run: just net register ${id}`, true);
    const client = new DpiClient(row.url, row.token);
    await this.run(async () => {
      this.info = await client.device({ timeoutMs: 8000 });
      this.streams?.abort();
      this.device = { id: row.id, name: row.name, url: row.url!, token: row.token! };
      this.client = client;
      this.viaHub = false;
      this.sessionId = undefined;
      this.agentId = undefined;
      this.handle = undefined;
      this.model.clear();
      this.session.clear();
      this.sessions = [];
      this.setView("herd");
    });
  }

  private async refreshSessions() {
    try {
      this.sessions = (await this.client.tree()).sessions;
      this.deviceOnline = true;
      this.requestRender();
    } catch {
      this.deviceOnline = false;
    }
  }

  /** The open session's working folder — what /git operates on. */
  cwd(): string | undefined {
    return this.sessionSummary()?.cwd ?? undefined;
  }

  sessionSummary(): SessionSummary | undefined {
    const s = this.sessions.find((x) => x.id === this.sessionId);
    return s && this.session.state.ready ? { ...s, agents: this.session.state.agents } : s;
  }

  busy() {
    return this.model.state.running || (this.agentId !== undefined && this.session.foregroundBusy(this.agentId));
  }

  command(name: string) {
    return runCommand(this, `/${name}`);
  }

  // ------------------------------------------------------------------ actions

  setView(view: View) {
    this.view = view;
    this.cursor = 0;
    this.scrollOffset = 0;
    if (view === "herd") void this.refreshSessions();
    if (view === "network") this.devicesCache = this.networkDevices();
    this.requestRender();
  }

  private networkDevices(): DeviceRow[] {
    // The hub feed is the same source the web sidebar renders; fall back to
    // the local registry when no hub is configured or before the first poll.
    let rows = this.hubRows.length ? this.hubRows : this.registry ? this.registry.list() : [];
    // The current device also appears as a hub row (same deviceUid) — drop
    // that one and keep the direct LAN row, but inherit the hub's tree so its
    // sessions still list here.
    const mine = this.info?.uid ? rows.find((r) => r.deviceUid === this.info!.uid) : undefined;
    if (mine) rows = rows.filter((r) => r !== mine);
    if (this.device.id !== "adhoc" || rows.some((r) => r.id === "adhoc")) return rows;
    return [
      ...rows,
      {
        id: this.device.id,
        name: this.info?.name || this.device.name || this.device.id,
        kind: "url",
        transport: "lan",
        url: this.device.url,
        token: this.device.token,
        source: "config",
        position: 0,
        deviceUid: null,
        lastStatus: this.deviceOnline || this.connection === "live" ? "online" : "offline",
        lastError: null,
        lastSeenAt: Date.now(),
        lastInfo: this.info,
        lastTree:
          mine?.lastTree ??
          { uid: this.device.id, name: this.info?.name || this.device.id, sessions: this.sessions, at: Date.now() },
        createdAt: 0,
        updatedAt: 0,
      },
    ];
  }

  /** Herd and network rows share a shape; `kind` tells a header from an entry. */
  private rows(): Array<{
    kind: "group" | "session" | "device";
    sessionId?: string;
    deviceId?: string;
    label: string;
  }> {
    if (this.view === "herd") return herdRows(this.sessions, this.filter);
    if (this.view === "network") return networkRows(this.devicesCache, this.device.id, this.filter);
    return [];
  }

  private openCursor() {
    const rows = this.rows();
    const row = rows[this.cursor] ?? rows.find((r) => r.sessionId);
    if (row?.sessionId) return this.openSession(row.sessionId, row.deviceId);
    // A group header opens its first session — pressing enter on a header used
    // to do literally nothing.
    if (row?.kind === "group") {
      // The next session row after the header belongs to that group.
      const at = rows.indexOf(row);
      const target = rows.slice(at + 1).find((r) => r.kind !== "group");
      if (target?.sessionId) return this.openSession(target.sessionId, target.deviceId);
    }
    if (row?.deviceId && this.view === "network") {
      const target = this.devicesCache.find((d) => d.id === row.deviceId);
      if (!target) return;
      if (target.id === this.device.id) return this.setView("herd");
      if (!target.url && !this.hub)
        return this.notify(
          `${target.name} reaches this machine only through the hub tunnel — start the TUI with --hub-url/--hub-token`,
          true,
        );
      void this.switchDevice(target.id);
      return;
    }
    const first = rows.find((r) => r.sessionId);
    if (first?.sessionId) this.openSession(first.sessionId);
  }

  private openSession(sessionId: string, deviceId?: string) {
    // A network row may name a session on ANOTHER device: switching first is
    // what makes the attach land on the right host (live bug: the session was
    // requested from the current device and the stream answered `gone`).
    const target = deviceId && deviceId !== this.device.id ? deviceId : undefined;
    void this.run(async () => {
      if (target) {
        await this.switchDevice(target);
        if (this.device.id !== target) return; // switch refused (offline/tunnel without hub)
      }
      const summary = this.sessions.find((s) => s.id === sessionId);
      const agentId = summary?.agents.find((a) => a.kind === "root")?.id;
      await this.attach(sessionId, agentId ?? 1);
    });
  }

  /** 1-9 jump: the nth session row of the current view. */
  private jump(n: number) {
    // Digits address sessions, so they work from the agent view as well — that
    // is the fastest way out of a session you no longer want.
    const rows = (this.view === "herd" ? this.rows() : herdRows(this.sessions, this.filter)).filter(
      (r): r is { kind: "session"; sessionId: string; deviceId?: string; label: string } => !!r.sessionId,
    );
    const nth = rows[n - 1];
    if (nth?.sessionId) this.openSession(nth.sessionId, nth.deviceId);
    else this.notify(`no session #${n} in this view`);
  }

  private async submit(text: string, mode?: "followUp") {
    const content = text.trim();
    if (!content) return;
    if (this.inputHistory[this.inputHistory.length - 1] !== content) this.inputHistory.push(content);
    if (this.inputHistory.length > 200) this.inputHistory.shift();
    this.histIndex = -1;
    this.inputDraft = "";
    if (content.startsWith("/") && (await runCommand(this, content))) return;
    if (!this.handle) return this.notify("Pick a session first (g, then ↵).", true);
    const requestId = newId();
    for (let attempt = 1; ; attempt++) {
      try {
        await this.handle.send(content, this.busy() && mode !== "followUp" ? "steer" : "followUp", requestId);
        this.logEvent("turn", `${this.sessionSummary()?.name ?? this.sessionId} ← message`);
        if (this.busy()) this.notify("steering: joins after the current tool round");
        return;
      } catch (e) {
        if (isDpiError(e) && e.code === "offline" && attempt < 3) {
          await sleep(1000 * attempt);
          continue;
        }
        this.notify(isDpiError(e) && e.code === "busy" ? "Agent is busy (reject mode)" : (e as Error).message, true);
        return;
      }
    }
  }

  private async interrupt() {
    await this.run(async () => {
      await this.handle?.abort(false);
      this.notify("Interrupted. Background jobs continue.");
      this.logEvent("compact", `interrupt ${this.sessionSummary()?.name ?? ""} · checkpointed`);
    });
  }

  private async cycleThinking() {
    if (!this.handle) return;
    const current = (this.model.state.agent.thinkingLevel ?? "low") as ThinkingLevel;
    const next = THINKING_LEVELS[(THINKING_LEVELS.indexOf(current) + 1) % THINKING_LEVELS.length];
    await this.run(() => this.handle!.configure({ thinkingLevel: next }));
    this.notify(`thinking: ${next}`);
  }

  // ------------------------------------------------------------------- input

  handleInput(data: string): TuiInputListenerResult {
    // DPI_TUI_KEYS=<file> traces every key the app receives — the fastest way to
    // tell "the terminal never sent it" from "a branch swallowed it".
    if (process.env.DPI_TUI_KEYS)
      try {
        appendFileSync(
          process.env.DPI_TUI_KEYS,
          `${JSON.stringify({ data, view: this.view, tab: this.tab, input: this.input?.kind ?? null, overlays: this.overlays.length })}\n`,
        );
      } catch {
        /* tracing must never break input */
      }
    // pi-tui overlays (welcome screen, pickers, prompts) own the keyboard while
    // open; only ctrl+c still closes them from here.
    if (this.overlays.length) {
      if (matchesKey(data, "ctrl+c")) return this.closeOverlay(), { consume: true };
      return { consume: false };
    }
    // pi chords that work in both modes: model picker + transcript expand.
    if (matchesKey(data, "ctrl+l")) return (void pickModel(this), { consume: true });
    if (matchesKey(data, "ctrl+o")) {
      this.expand = !this.expand;
      this.notify(`expand ${this.expand ? "on — full tool output" : "off"}`);
      return { consume: true };
    }
    if (this.handleTyping(data)) return { consume: true };
    if (this.helpOpen) {
      this.helpOpen = false;
      this.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+c")) {
      if (this.overlays.length) return this.closeOverlay(), { consume: true };
      this.exit();
      return { consume: true };
    }
    if (data === "q") {
      this.exit();
      return { consume: true };
    }
    if (data === "?") (this.helpOpen = true), this.requestRender();
    else if (data === ":") this.beginInput("palette", ": ");
    // "/" seeds the message line (slash-commands live here, pi-style); the
    // herdr filter role rides "f" instead — one keyboard, both flows.
    else if (data === "/") {
      this.beginInput("message", "follow-up ❯ ");
      this.input!.value = "/";
    } else if (data === "f") this.beginInput("filter", "filter ❯ ");
    else if (data === "n") this.beginInput("new", "new session › ");
    else if (data === "x") this.beginInput("kill", `reset ${this.sessionSummary()?.name ?? "context"}? y/n`);
    else if (data === "g") this.setView("herd");
    else if (data === "N") this.setView("network");
    else if (data === "L") this.setView("log");
    else if (data === "j" || matchesKey(data, "down")) this.move(1);
    else if (data === "k" || matchesKey(data, "up")) this.move(-1);
    else if (matchesKey(data, "enter")) this.enter();
    else if (matchesKey(data, "escape")) this.escape();
    else if (data === "i") void this.interrupt();
    else if (data === "F") void this.command("fork");
    else if (data === "c") void this.command("compact");
    else if (data === "y") void this.cycleThinking();
    else if (data === "a" || data === "d") this.notify("nothing is waiting for approval");
    else if (data === "m") this.beginInput("message", "follow-up ❯ ");
    else if (data === "]" || matchesKey(data, "tab")) this.cycleTab(1);
    else if (data === "[" || matchesKey(data, "shift+tab")) this.cycleTab(-1);
    else if (/^[1-9]$/.test(data)) this.jump(Number(data));
    // No catch-all: a stray letter used to jump views or open the composer with
    // itself as the first character. herdr and piggery both require an explicit
    // key (m, / or enter), and so do we now.
    return { consume: true };
  }

  /** True when an inline input consumed the key (herdr's handleTyping). */
  private handleTyping(data: string): boolean {
    const input = this.input;
    if (!input) return false;
    if (matchesKey(data, "escape")) {
      this.input = null;
      this.toast = "";
      // esc aborts the filter line: a half-typed needle must not linger.
      if (input.kind === "filter" && this.filter) {
        this.filter = "";
        this.cursor = 0;
        this.notify("filter cleared");
      }
      return true;
    }
    // The slash suggestion list is a MENU while it is open: ↑/↓ steer it and
    // enter picks — history recall waits until the list is gone. (Reported:
    // "danh sách slash command không điều hướng được, enter không autocomplete".)
    const sugg = input.kind === "message" ? slashSuggestions(input.value, COMMANDS) : null;
    if (sugg && matchesKey(data, "up")) {
      this.suggIndex = Math.max(0, this.suggIndex - 1);
      this.requestRender();
      return true;
    }
    if (sugg && matchesKey(data, "down")) {
      this.suggIndex = Math.min(sugg.names.length - 1, this.suggIndex + 1);
      this.requestRender();
      return true;
    }
    // ↑/↓ recall sent messages; the current draft survives the round-trip.
    if (input.kind === "message" && matchesKey(data, "up")) {
      if (this.inputHistory.length) {
        if (this.histIndex < 0) (this.inputDraft = input.value), (this.histIndex = this.inputHistory.length);
        this.histIndex = Math.max(0, this.histIndex - 1);
        input.value = this.inputHistory[this.histIndex] ?? input.value;
        this.suggIndex = 0;
        this.requestRender();
      }
      return true;
    }
    if (input.kind === "message" && matchesKey(data, "down")) {
      if (this.histIndex >= 0) {
        this.histIndex += 1;
        if (this.histIndex >= this.inputHistory.length) (this.histIndex = -1), (input.value = this.inputDraft);
        else input.value = this.inputHistory[this.histIndex] ?? input.value;
        this.requestRender();
      }
      return true;
    }
    // Tab completes the selected slash suggestion; shift+tab cycles it.
    if (input.kind === "message" && matchesKey(data, "shift+tab")) {
      if (sugg) this.suggIndex = (this.suggIndex + 1) % sugg.names.length;
      this.requestRender();
      return true;
    }
    if (input.kind === "message" && matchesKey(data, "tab")) {
      if (sugg) {
        const pick = sugg.names[this.suggIndex % sugg.names.length]!;
        input.value = `/${pick} `;
        this.suggIndex = 0;
        this.requestRender();
      }
      return true;
    }
    if (matchesKey(data, "alt+enter")) {
      // pi muscle memory: send NOW as a follow-up even mid-turn (enter steers).
      const value = input.value;
      this.input = null;
      this.toast = "";
      void this.submit(value, "followUp");
      return true;
    }
    if (matchesKey(data, "enter")) {
      // Enter completes the highlighted suggestion (the completed text gains a
      // trailing space, the list closes, and the NEXT enter submits). An exact
      // command ("/model") runs immediately instead — completing it would force
      // a pointless second enter.
      // Complete ONLY while the command name itself is being typed — once a
      // space follows, the arguments are on the line and enter must submit,
      // not wipe them back to "/git ". (Caught driving /git worktree new ….)
      if (
        sugg &&
        input.kind === "message" &&
        !input.value.includes(" ") &&
        !COMMANDS.some((c) => `/${c.name}` === input.value)
      ) {
        const pick = sugg.names[this.suggIndex % sugg.names.length]!;
        input.value = `/${pick} `;
        this.suggIndex = 0;
        this.requestRender();
        return true;
      }
      const value = input.value;
      this.input = null;
      this.toast = "";
      if (input.kind === "message") void this.submit(value);
      else if (input.kind === "filter") {
        this.filter = value.trim();
        this.cursor = 0;
        this.notify(this.filter ? `filter: ${this.filter}` : "filter cleared");
      } else if (input.kind === "palette") {
        const cmd = PALETTE.find((p) => p.name.startsWith(value.trim()));
        if (cmd) cmd.run(this);
        else this.notify(`no command “${value.trim()}”`);
      } else if (input.kind === "kill") {
        if (value.trim().toLowerCase().startsWith("y")) void this.command("reset");
        else this.notify("reset cancelled");
      } else if (input.kind === "new") void newSession(this, value);
      return true;
    }
    if (data === "\x7f" || matchesKey(data, "backspace")) (input.value = input.value.slice(0, -1)), (this.suggIndex = 0);
    // Whole chunks append (bracketed paste and multi-byte chars both arrive
    // as long strings — herdr H03's lesson: never filter by data.length === 1).
    // Newlines survive paste (sent through to the agent); the line shows ⏎.
    else {
      const chunk = data.replace(/\r\n?/g, "\n");
      if (chunk >= " " || [...chunk].some((ch) => ch >= " ") || chunk.includes("\n")) (input.value += chunk), (this.suggIndex = 0);
    }
    // The filter narrows the list LIVE, on every keystroke — enter merely
    // closes the line. Waiting for enter made "f" feel dead for a beat.
    if (input.kind === "filter") {
      this.filter = input.value.trim();
      if (!this.filter && this.cursor) this.cursor = 0;
      this.requestRender();
    }
    return true;
  }

  private beginInput(kind: InputKind, prompt: string) {
    this.input = { kind, value: "" };
    this.toast = prompt;
    this.requestRender();
  }

  /**
   * esc is BACK, the way every list/detail client behaves (piggery: "esc back").
   * Interrupting a running turn is a destructive action and keeps its own key
   * (i) — folding it into esc meant "leave this screen" did nothing at all while
   * an agent was idle.
   */
  private escape() {
    if (this.filter) {
      this.filter = "";
      this.notify("filter cleared");
    } else if (this.view === "agent" || this.view === "log") {
      this.setView("herd");
    }
  }

  /**
   * Move the cursor. Group rows ("~/project/ · 3 agents") are headers, not
   * entries: stepping onto one left the marker and the OVERVIEW panel frozen on
   * the previous session, which reads as "navigation is dead". Skip them, the
   * way piggery's list only ever has real rows under the cursor.
   */
  private move(delta: number) {
    if (this.view === "agent" && this.tab === "transcript") {
      // Scroll the transcript instead of moving a cursor (herdr H04's lesson).
      this.scrollOffset = Math.max(0, this.scrollOffset + delta);
      this.requestRender();
      return;
    }
    const rows = this.rows();
    if (!rows.length) return;
    const selectable = (i: number) => !!rows[i] && rows[i].kind !== "group";
    let next = this.cursor;
    for (let step = 0; step < rows.length; step += 1) {
      next += delta;
      if (next < 0 || next >= rows.length) break;
      if (selectable(next)) {
        this.cursor = next;
        this.selectedId = rows[next]!.sessionId ?? this.selectedId;
        this.requestRender();
        return;
      }
    }
    // Nothing selectable in that direction: still clamp to a valid row so the
    // highlight never points past the list.
    if (!selectable(this.cursor)) {
      const first = rows.findIndex((_, i) => selectable(i));
      if (first >= 0) this.cursor = first;
    }
    this.requestRender();
  }

  private enter() {
    if (this.view === "agent" || this.view === "log") return this.setView("herd");
    this.openCursor();
  }

  /**
   * Tab/Shift+Tab cycle whatever tab strip is on screen — pi's exact
   * semantics: the four VIEWS on herd/network/log, the agent's own tabs in
   * the conversation. Before, "tab" outside the agent view did nothing at
   * all, which on the outermost session list reads as "navigation is dead"
   * (reported: "không điều hướng xem tab khác ngoài tab session đầu tiên").
   */
  private cycleTab(delta: number) {
    if (this.view !== "agent") {
      const index = VIEW_TABS.findIndex((t) => t.id === this.view);
      this.setView(VIEW_TABS[(index + delta + VIEW_TABS.length) % VIEW_TABS.length]!.id);
      return;
    }
    const index = AGENT_TABS.findIndex((t) => t.id === this.tab);
    this.tab = AGENT_TABS[(index + delta + AGENT_TABS.length) % AGENT_TABS.length]!.id;
    this.scrollOffset = 0;
    this.requestRender();
  }

  // ------------------------------------------------------------- overlays

  overlay(component: Component, onClose?: () => void) {
    this.overlays.push({
      handle: this.tui.showOverlay(component, { width: "70%", minWidth: 40, maxHeight: "80%" }),
      onClose,
    });
    this.tui.requestRender();
  }

  get overlayCount() {
    return this.overlays.length;
  }

  closeOverlay(exitIfNothing = false) {
    const overlay = this.overlays.pop();
    overlay?.handle.hide();
    overlay?.onClose?.();
    if (!this.overlays.length) this.tui.setFocus(this.root);
    if (exitIfNothing) return this.exit();
    this.tui.requestRender();
  }

  prompt(label: string, initial: string) {
    return new Promise<string | undefined>((done) => {
      this.overlay(
        new Prompt(
          label,
          initial,
          (value) => {
            this.closeOverlay();
            done(value.trim());
          },
          () => {
            this.closeOverlay();
            done(undefined);
          },
        ),
      );
    });
  }

  promptSecret(label: string) {
    return new Promise<string | undefined>((done) => {
      this.overlay(
        new SecretPrompt(
          label,
          (value) => {
            this.closeOverlay();
            done(value.trim());
          },
          () => {
            this.closeOverlay();
            done(undefined);
          },
        ),
      );
    });
  }

  flash(text: string, error = false) {
    this.notify(text, error);
  }

  notify(message: string, error = false) {
    this.toast = (error ? "✗ " : "") + message;
    this.toastTicks = 50;
    this.requestRender();
  }

  /** Git events land in the log view (L) — /git writes through here. */
  logEvent(glyph: string, text: string) {
    const at = new Date().toLocaleTimeString("en-GB", { hour12: false });
    this.events.push({ at, glyph, text });
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
  }

  async run(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      this.notify((e as Error).message, true);
    }
  }

  exit() {
    this.streams?.abort();
    this.mux?.stop();
    clearInterval(this.ticker);
    this.tui.stop();
    const ref = this.reattachRef();
    if (ref) {
      const adhoc = this.device.id === "adhoc";
      const target = adhoc
        ? `--url ${this.device.url} --token <token> -s ${shellWord(ref.session)} -a ${shellWord(ref.agent)}`
        : shellWord(`${this.device.id}:${ref.session}:${ref.agent}`);
      process.stdout.write(
        `\n${c.muted("The agent keeps running on")} ${adhoc ? this.device.name : this.device.id}${c.muted(". Reattach:")}\n  just tui attach ${target}\n\n`,
      );
    }
    process.exit(0);
  }

  private reattachRef() {
    const session = this.sessionSummary();
    const agent = session?.agents.find((a) => a.id === this.agentId);
    if (!session || this.agentId === undefined) return undefined;
    const usable = (name: string) => !name.includes(":") && !name.includes("'");
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const sessionRef =
      usable(session.name) && this.sessions.filter((s) => same(s.name, session.name)).length === 1 ? session.name : session.id;
    const agentRef =
      agent?.named && usable(agent.name) && session.agents.filter((a) => same(a.name, agent.name)).length === 1
        ? agent.name
        : this.agentId === 1
          ? "main"
          : String(this.agentId);
    return { session: sessionRef, agent: agentRef };
  }

  // ------------------------------------------------------------------ tick

  tick() {
    if (this.toastTicks > 0 && --this.toastTicks === 0) this.toast = "";
    // Live network: refresh the hub feed every ~5 s (tick = 120 ms), so a device
    // paired from the CLI shows up while the operator is looking at the list.
    if (this.hub && ++this.hubTick >= 42) {
      this.hubTick = 0;
      void fetchHubNetwork(this.hub.url, this.hub.token).then((rows) => {
        if (rows) {
          this.hubRows = rows;
          if (this.view === "network") this.devicesCache = this.networkDevices();
          this.requestRender();
        }
      });
    }
    this.requestRender();
  }

  private requestRender() {
    this.tui.requestRender();
  }

  // ------------------------------------------------------------------ frame

  frame(width: number): string[] {
    const w = Math.max(20, width);
    const h = Math.max(8, this.procTerminal.rows || 24);
    const lines: string[] = new Array(h).fill("") as string[];
    lines[0] = this.header(w);
    lines[1] = this.viewbar(w);
    const bodyHeight = h - 4;
    const body = this.body(w, bodyHeight);
    for (let i = 0; i < bodyHeight; i += 1) lines[2 + i] = body[i] ?? "";
    lines[h - 2] = this.messageLine(w);
    lines[h - 1] = this.statusbar(w);
    const sugg = this.suggestionLines(w);
    for (let i = 0; i < sugg.length; i += 1) lines[h - 3 - sugg.length + 1 + i] = sugg[i];
    const overlay = this.frameOverlay(w, bodyHeight);
    if (overlay) for (let i = 0; i < overlay.length; i += 1) {
      const row = 2 + i;
      if (row < h - 2) lines[row] = overlay[i]!;
    }
    return lines;
  }

  private header(w: number): string {
    const devices = this.registry ? this.networkDevices() : [];
    return (
      " " +
      renderHeader(w - 2, {
        device: this.device.id,
        sessions: this.sessions.length,
        devicesOnline: devices.filter((d) => d.lastStatus === "online").length,
        devicesTotal: devices.length || undefined,
        conn: this.connection === "live" ? "live" : this.connection === "idle" ? "no agent" : String(this.connection),
        connOk: this.connection === "live",
      })
    );
  }

  private viewbar(w: number): string {
    const session = this.sessions.find((x) => x.id === this.sessionId);
    const right =
      this.view === "agent" && session
        ? `${this.device.id}:${session.name}:${this.agentId ?? 1}`
        : this.view === "agent"
          ? "no workspace"
          : "j/k move · ↵ open";
    return " " + renderViewbar(w - 2, this.view === "log" ? "log" : this.view, right);
  }

  private body(w: number, h: number): string[] {
    if (h <= 0) return [];
    if (this.view === "agent") return this.agentBody(w, h);
    if (this.view === "network") return this.networkBody(w, h);
    if (this.view === "log") return this.logBody(w, h);
    return this.herdBody(w, h);
  }

  // ------------------------------------------------------------------ herd

  private herdBody(w: number, h: number): string[] {
    const rows = herdRows(this.sessions, this.filter);
    const wide = w >= 104;
    const panelW = wide ? Math.min(44, Math.max(34, Math.round(w * 0.32))) : 0;
    const tableW = wide ? w - panelW - 1 : w;
    const table = renderHerd(tableW, rows, this.sessions, {
      selectedId: this.selectedId ?? this.sessionId,
      cursor: this.cursor,
      filter: this.filter,
    }).slice(0, h);
    if (!wide) return table;
    const selected = this.sessions.find((s) => s.id === (this.selectedId ?? this.sessionId));
    if (selected?.cwd) this.refreshGit(selected.cwd);
    const panel = renderHerdPanel(panelW, h, selected, this.contextLeft(), this.device.name, this.gitOf(selected?.cwd));
    return joinPanel(table, panel, tableW, w, h);
  }

  // --------------------------------------------------------------- network

  private networkBody(w: number, h: number): string[] {
    const rows = networkRows(this.devicesCache, this.device.id, this.filter);
    return renderNetwork(w, rows, this.devicesCache, {
      cursor: this.cursor,
      currentSessionId: this.sessionId,
      filter: this.filter,
    }).slice(0, h);
  }

  // ----------------------------------------------------------------- agent

  private agentState(): RowState {
    return this.busy() ? "busy" : "idle";
  }

  private agentBody(w: number, h: number): string[] {
    const session = this.sessionSummary();
    const lines: string[] = [];
    const state = this.agentState();
    const ctx = this.contextLeft();
    const barW = Math.min(40, Math.max(12, Math.round(w * 0.3)));
    const filled = ctx === undefined ? 0 : Math.round((ctx / 100) * barW);
    const g = this.gitOf(session?.cwd);
    if (session?.cwd) this.refreshGit(session.cwd);
    const gitChip = g?.repo ? `  ${c.muted("⎇")} ${c.text(g.branch ?? g.head ?? "")}${(g.staged ?? 0) + (g.unstaged ?? 0) + (g.untracked ?? 0) ? c.warn(` ±${(g.staged ?? 0) + (g.unstaged ?? 0) + (g.untracked ?? 0)}`) : ""}` : "";
    lines.push(
      `${c.muted(this.device.id)} ${c.muted("›")} ${c.text(session?.name ?? "—")} ${c.muted("›")} ${c.bold(`#${this.agentId ?? 1}`)}${gitChip}  ` +
        `${STATE_COLOR[state](STATE_GLYPH[state] + " " + (this.busy() ? "working" : "idle"))}  ` +
        `${c.muted("ctx")} ${ctx === undefined ? c.muted("—") : c.accent(rep("█", filled)) + c.muted(rep("░", barW - filled)) + " " + c.muted(`${ctx}%`)}`,
    );
    lines.push(
      AGENT_TABS.map((t) => (t.id === this.tab ? c.inverse(c.bold(` ${t.label} `)) : c.muted(` ${t.label} `))).join(
        c.muted("│"),
      ) + c.muted(rep(" ", Math.max(0, w - 62))) + c.muted(this.model.state.agent.model?.modelId?.split("/").pop() ?? ""),
    );
    lines.push(c.muted(rep(box.h, w)));
    const inner = h - 3;
    const content = this.agentContent(w);
    const from = Math.max(0, content.length - inner - this.scrollOffset);
    for (const line of content.slice(from, from + inner)) lines.push(line);
    return lines.slice(0, h);
  }

  /** The transcript/tasks/tools/state/config tabs, from the REAL model state. */
  private agentContent(w: number): string[] {
    const s = this.model.state;
    const wrap = (text: string, indent = "  ") =>
      text
        .split("\n")
        .flatMap((l) => (l.length > w - 4 ? [l.slice(0, w - 4), l.slice(w - 4)] : [l]))
        .map((l) => indent + l);
    if (this.tab === "transcript") {
      const lines: string[] = [];
      let turn = 0;
      for (const item of s.items) {
        if (item.kind === "user") {
          lines.push(`${c.user("YOU")}`);
          lines.push(...wrap(item.text));
          lines.push("");
        } else if (item.kind === "assistant") {
          turn += 1;
          lines.push(`${c.accent(`AGENT #${turn}`)}`);
          for (const b of item.blocks) {
            if (b.type === "thinking") lines.push(...wrap(b.text).map((l) => c.dim(c.italic(l))));
            else if (b.type === "text") lines.push(...wrap(b.text));
            else if (b.type === "tool") {
              const glyph = b.call.status === "error" ? c.err("✗") : b.call.status === "running" ? c.warn("◐") : c.ok("✓");
              const args = JSON.stringify(b.call.args ?? {}) || "";
              lines.push(`  ${glyph} ${c.bold(b.call.name)} ${c.muted(this.expand ? args.slice(0, w - 8) : args.slice(0, Math.max(10, w - 20)))}`);
              const out = b.call.output ?? b.call.result ?? "";
              if (typeof out === "string" && out)
                for (const l of (this.expand ? out.split("\n") : out.split("\n").slice(0, 6)))
                  lines.push(`    ${c.muted(l.slice(0, w - 6))}`);
            }
          }
          if (item.error) lines.push(`  ${c.err(item.error.slice(0, w - 4))}`);
          lines.push("");
        }
      }
      if (!lines.length) lines.push(c.muted("  no entries yet — m to send the first message"));
      return lines;
    }
    if (this.tab === "tasks") {
      const lines: string[] = [];
      for (const item of s.inbox)
        lines.push(
          ` ${c.warn("◆")} ${c.text(`${item.mode === "steer" ? "steer" : "queued"}: ${(item.content ?? "context update").replace(/\s+/g, " ").slice(0, w - 20)}`)}`,
        );
      const bg = this.agentId === undefined ? [] : this.session.backgroundTasks(this.agentId);
      for (const t of bg) lines.push(` ${c.accent("◐")} ${c.text(String(t).slice(0, w - 6))}`);
      if (!lines.length) lines.push(c.muted("  no queued or background work"));
      return lines;
    }
    if (this.tab === "tools") {
      const counts = new Map<string, number>();
      for (const item of s.items) {
        if (item.kind !== "assistant") continue;
        for (const b of item.blocks) if (b.type === "tool") counts.set(b.call.name, (counts.get(b.call.name) ?? 0) + 1);
      }
      const lines = [c.muted(` tool calls across this context`), ""];
      const max = Math.max(1, ...counts.values());
      for (const [name, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
        const barW = 16;
        const filled = Math.round((n / max) * barW);
        lines.push(` ${c.text(name.padEnd(14))} ${c.muted(rep("▮", filled))}${c.muted(rep("▯", barW - filled))} ${c.muted(String(n))}`);
      }
      if (!counts.size) lines.push(c.muted("  no tool calls yet"));
      return lines;
    }
    if (this.tab === "state") {
      const u = sumUsage(s.usage);
      const state = {
        device: this.device.id,
        session: this.sessionId,
        agent: this.agentId,
        connection: this.connection,
        running: s.running,
        compactions: s.compactions.length,
        usage: { tokens: u.tokens, cost: u.cost },
        inbox: s.inbox.length,
        notices: s.notices.length,
      };
      const lines = [];
      for (const line of JSON.stringify(state, null, 2).split("\n")) lines.push(` ${c.muted(line)}`);
      lines.push("", ` ${c.muted("Shared with every fork of this session on the device.")}`);
      return lines;
    }
    // config tab
    const model = this.model.state.agent.model;
    const lines = [
      ` ${c.muted("model")}     ${c.text(model?.modelId ?? "—")}`,
      ` ${c.muted("provider")}  ${c.muted(model?.provider ?? "—")}`,
      ` ${c.muted("thinking")}  ${c.text(String(this.model.state.agent.thinkingLevel ?? "low"))} ${c.muted("(y cycles)")}`,
      "",
      ` ${c.muted("device")}    ${c.text(this.device.id)} ${c.muted(this.device.url)}`,
      ` ${c.muted("start dirs")} ${c.muted(this.info.startDirs.join(", ").slice(0, w - 18) || "—")}`,
    ];
    return lines;
  }

  // ------------------------------------------------------------------- log

  private logBody(w: number, h: number): string[] {
    const rows = this.events.filter((e) => !this.filter || e.text.toLowerCase().includes(this.filter.toLowerCase()));
    const lines = [c.muted(` ${this.events.length} events · this client`)];
    const visible = h - 1;
    for (const e of rows.slice(-visible)) lines.push(` ${c.muted(e.at)} ${c.accent(e.glyph)} ${c.text(e.text.slice(0, w - 18))}`);
    return lines;
  }

  // ---------------------------------------------------------------- chrome

  /** In-frame slash autocomplete list, drawn just above the message line. */
  private suggestionLines(w: number): string[] {
    if (!this.input || this.input.kind !== "message") return [];
    const sugg = slashSuggestions(this.input.value, COMMANDS);
    if (!sugg) return [];
    const shown = sugg.names.slice(0, 5);
    const idx = this.suggIndex % shown.length;
    const desc = (name: string) => COMMANDS.find((c) => c.name === name)?.description ?? "";
    const width = Math.min(w - 2, 44);
    return shown.map((name, i) => {
      const row = ` /${name.padEnd(11)} ${desc(name)}`.slice(0, width);
      return i === idx ? " " + c.accentBg(row) : " " + c.muted(row);
    });
  }

  private messageLine(w: number): string {
    if (this.input) {
      const shown = this.input.value.replace(/\n/g, "\u23ce").slice(-(w - 14));
      return " " + `${c.muted(this.toast)}${c.text(shown)}${c.accent("▌")}`.slice(0, w);
    }
    if (this.toast) return " " + `${this.toast.startsWith("✗") ? c.err(this.toast) : c.accent("◆") + " " + c.text(this.toast)}`.slice(0, w);
    if (this.view === "agent") {
      const hint =
        this.tab === "transcript"
          ? "m message · i interrupt · F fork · c compact · y thinking · esc herd"
          : "esc herd · [ ] tabs · m message";
      return " " + c.muted(hint).slice(0, w);
    }
    return " " + c.muted("j/k move · ↵ open · : palette · n new · f filter · / msg · ? help").slice(0, w);
  }

  private statusbar(w: number): string {
    return (
      " " +
      renderStatusbar(w - 2, {
        view: this.view,
        device: this.device.id,
        ctxLeft: this.contextLeft(),
        background: this.agentId === undefined ? 0 : this.session.backgroundTasks(this.agentId).length,
        mode: this.input ? "INSERT" : "NORMAL",
      })
    );
  }

  // -------------------------------------------------------------- overlays

  private frameOverlay(w: number, h: number): string[] | undefined {
    if (this.helpOpen) return this.helpPanel(w, h);
    if (this.input?.kind === "palette") return this.palettePanel(w, h);
    return undefined;
  }

  private palettePanel(w: number, h: number): string[] {
    const query = (this.input?.value ?? "").trim();
    const items = PALETTE.filter((p) => p.name.includes(query) || p.hint.includes(query));
    const width = Math.min(62, w - 4);
    const height = Math.min(items.length + 2, h);
    const x = Math.floor((w - width) / 2);
    const panel = this.panel(width, height, "command palette");
    items.slice(0, height - 2).forEach((item, index) => {
      panel[index + 1] = this.panelLine(width, `${index === 0 ? "▌" : " "} ${item.name.padEnd(10)} ${item.hint}`, index === 0);
    });
    return place(panel, w, h, x, 1);
  }

  private helpPanel(w: number, h: number): string[] {
    const width = Math.min(76, w - 4);
    const rows = [
      `${c.accent("▲")} ${c.bold("dpi keymap (herdr template)")}`,
      "",
      `${c.accent("j k ↑ ↓")}  move/scroll     ${c.accent("1-9")}  jump to session`,
      `${c.accent("↵")}       open           ${c.accent("g N L")}  herd / network / log`,
      `${c.accent("[ ]")}     agent tabs     ${c.accent("m")}    message (enter sends)`,
      `${c.accent("esc")}     back/interrupt ${c.accent("i")}    interrupt ≠ kill`,
      `${c.accent("F")}       fork           ${c.accent("c")}    compact context`,
      `${c.accent("y")}       thinking level ${c.accent("x")}    reset (y/n confirm)`,
      `${c.muted("alt+↵")}     send now, no steer ${c.muted("ctrl+l")}  model picker`,
      `${c.muted("tab")}     complete /command  ${c.muted("↑")}      recall sent`,
      `${c.muted("ctrl+o")}    expand tool output`,
      `${c.accent(":")}       palette        ${c.accent("f")}    filter rows`,
      `${c.accent("n")}       new session    ${c.accent("/")}    message // commands`,
      "",
      c.muted("Durability"),
      `${c.muted("·")} every turn is checkpointed on the device`,
      `${c.muted("·")} interrupt leaves the run resumable; only reset starts fresh`,
      `${c.muted("·")} sends retry by requestId — the device admits each exactly once`,
      `${c.muted("·")} /commands still work: type them in the message line`,
    ];
    const height = Math.min(rows.length + 2, h);
    const panel = this.panel(width, height, "help");
    rows.slice(0, height - 2).forEach((line, index) => {
      panel[index + 1] = this.panelLine(width, ` ${line}`, false);
    });
    const x = Math.floor((w - width) / 2);
    const y = Math.max(0, Math.floor((h - height) / 2));
    return place(panel, w, h, x, y);
  }

  private panel(width: number, height: number, title: string): string[] {
    const inner = Math.max(0, width - title.length - 5);
    const top = c.muted(box.tl + box.h) + c.muted(` ${title} `) + c.muted(rep(box.h, inner) + box.tr);
    const bottom = c.muted(box.bl + rep(box.h, width - 2) + box.br);
    return [
      top,
      ...Array.from({ length: Math.max(0, height - 2) }, () => c.muted(box.v) + rep(" ", width - 2) + c.muted(box.v)),
      bottom,
    ];
  }

  private panelLine(width: number, content: string, active: boolean): string {
    const inner = width - 4;
    let body = content;
    while (body.length > inner) body = body.slice(0, -2); // crude but ANSI-safe enough for short rows
    const padded = body + rep(" ", Math.max(0, inner - body.length));
    return `${c.muted(box.v)} ${active ? c.inverse(padded) : padded} ${c.muted(box.v)}`;
  }

  // ------------------------------------------------------------------ ctx

  /** Context window left, in percent: the last reply's usage against the model's window. */
  private contextLeft(): number | undefined {
    const s = this.model.state;
    const m = s.agent.model;
    const window = this.info.models.find((x) => x.id === m?.modelId && x.provider === m?.provider)?.contextWindow;
    if (!window) return undefined;
    let used = 0;
    for (let i = s.entries.length - 1; i >= 0 && !used; i--) {
      const entry = s.entries[i];
      if (entry.kind !== "pi.assistant") continue;
      const reply = entry.model?.find((x) => x.role === "assistant") as WireAssistantMessage | undefined;
      const u = reply?.usage;
      if (u) used = u.totalTokens || u.input + u.output + u.cacheRead + u.cacheWrite;
    }
    return Math.max(0, Math.min(100, Math.floor(100 * (1 - used / window))));
  }
}

/** Compose full-width body rows with a panel placed at (x, y). */
function place(panel: string[], width: number, height: number, x: number, y: number): string[] {
  const out: string[] = Array.from({ length: height }, () => rep(" ", width));
  panel.forEach((line, index) => {
    const row = y + index;
    if (row < 0 || row >= height) return;
    out[row] = rep(" ", x) + line.slice(0, Math.max(0, width - x));
  });
  return out;
}
