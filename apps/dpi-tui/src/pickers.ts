// Overlays: pick a session, agent, model or device; walk a remote directory; type a name.
import {
  Box,
  Container,
  Input,
  matchesKey,
  renderFakeCursor,
  SelectList,
  truncateToWidth,
  type Component,
  type Focusable,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { THINKING_LEVELS, type ThinkingLevel } from "../../dpi-sdk/src/api.ts";
import type { ArchivedView, DeviceTree, EnvFileView, NotifySinkView, ScheduleView } from "../../dpi-sdk/src/api.ts";
import { agentTree, type TreeNode } from "../../dpi-sdk/src/models.ts";
import { fmtBytes, fmtDur } from "./commands.ts";
import { oneLine, sanitizeTerminal } from "./sanitize.ts";
import type { App } from "./app.ts";
import { c, selectTheme } from "./theme.ts";

const panelBg = (s: string) => `\x1b[48;2;37;26;27m${s}\x1b[49m`;

class Title implements Component {
  constructor(public text: string) {}
  render(width: number) {
    return [truncateToWidth(this.text, width)];
  }
  invalidate() {}
}

/**
 * A titled list with local filtering. Two deliberate departures from pi-tui's
 * SelectList defaults, both found by driving the real picker:
 *  - it filters on `value.startsWith`, so typing "pro" found nothing in a
 *    directory named "project/"; we filter on the LABEL (substring), which is
 *    what the user reads;
 *  - its empty message is "No matching commands" — the wrong vocabulary for a
 *    directory or model list, so the theme names the filter instead.
 * j/k move (as the app advertises) instead of being swallowed as filter text.
 */
export class Picker extends Box {
  list: SelectList;
  // run-12: protected so ActionPicker can tell "no filter yet" from "typed
  // something" — its row hotkeys (t/d/n) must yield to an active filter.
  protected filter = "";
  private title: Title;
  private readonly hintText: string;
  constructor(
    private label: string,
    private readonly allItems: SelectItem[],
    private onPick: (item: SelectItem) => void,
    private readonly onCancel: () => void,
    hint = "↑↓/j/k move │ enter select │ type to filter │ esc close",
    private readonly subtitle?: string,
  ) {
    super(1, 0, panelBg);
    this.hintText = hint;
    this.title = new Title(c.bold(c.accent(label)));
    this.list = this.makeList(this.allItems);
    this.rebuild();
  }
  private makeList(items: SelectItem[]): SelectList {
    const theme = {
      ...selectTheme,
      // Name the filter: "no match for “pro”" beats a command-palette phrase.
      noMatch: (s: string) => c.muted(this.filter ? `  no match for “${this.filter}”` : s),
    };
    const list = new SelectList(items, Math.max(1, Math.min(14, items.length)), theme);
    list.onSelect = this.onPick;
    list.onCancel = this.onCancel;
    return list;
  }
  /** Rebuild typing the children in order — the filter changes the item set. */
  private rebuild() {
    this.clear();
    this.addChild(this.title);
    if (this.subtitle) this.addChild(new Title(this.subtitle));
    this.addChild(this.list);
    this.addChild(new Title(c.muted(this.hintText)));
    this.invalidate();
  }
  /** Every item this picker was built with (shortcut lookups need the whole set). */
  items(): SelectItem[] {
    return this.allItems;
  }
  /** Run the same path a click/enter takes. */
  pick(item: SelectItem) {
    this.onPick(item);
  }
  private applyFilter() {
    const needle = this.filter.toLowerCase();
    const items = needle
      ? this.allItems.filter((i) => `${i.label} ${i.description ?? ""}`.toLowerCase().includes(needle))
      : this.allItems;
    this.list = this.makeList(items);
    this.title.text =
      c.bold(c.accent(this.label)) + (this.filter ? c.muted(`  /${this.filter}`) : "");
    this.rebuild();
  }
  handleInput(data: string) {
    // Navigation first: j/k are movement everywhere else in the app, so a list
    // must not swallow them as filter characters.
    // SelectList only knows arrows/enter/esc, so vim keys are translated to the
    // arrow sequences it already understands.
    if (data === "j") return this.list.handleInput("\x1b[B");
    if (data === "k") return this.list.handleInput("\x1b[A");
    // Enter on a ZERO-match list closes the picker (R5 finding 6): SelectList
    // drops the key when nothing is selected — a silent no-op that stranded
    // the user on a dead overlay with only esc as a way out.
    if (matchesKey(data, "enter") && !this.list.getSelectedItem()) return this.onCancel();
    if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "enter") || matchesKey(data, "escape"))
      return this.list.handleInput(data);
    if (matchesKey(data, "backspace")) {
      this.filter = this.filter.slice(0, -1);
      return this.applyFilter();
    }
    if (data.length === 1 && data >= " " && data !== "\x7f") {
      this.filter += data;
      return this.applyFilter();
    }
    this.list.handleInput(data);
  }
}

/** A picker whose rows take action hotkeys (run-12 ops surfaces: t/d/n on
 * /schedules and /env). The hotkey fires on the highlighted row only, and it
 * yields to an active filter — once the user has typed anything, letters
 * belong to the filter until backspace empties it, so "find the schedule
 * whose name has a t in it" still works. */
export class ActionPicker extends Picker {
  constructor(
    label: string,
    items: SelectItem[],
    onPick: (item: SelectItem) => void,
    onCancel: () => void,
    hint: string,
    private readonly hotkeys: Record<string, (item: SelectItem) => void>,
    subtitle?: string,
  ) {
    super(label, items, onPick, onCancel, hint, subtitle);
  }
  handleInput(data: string) {
    const act = data.length === 1 ? this.hotkeys[data] : undefined;
    if (act && !this.filter) {
      // SelectList reports "nothing selected" as null (empty list) — a
      // hotkey with no row is a no-op, not a crash.
      const item = this.list.getSelectedItem();
      if (item) act(item);
      return;
    }
    super.handleInput(data);
  }
}

/** One line of text input. */
export class Prompt extends Box implements Focusable {
  readonly input = new Input();
  private _focused = false;
  get focused() {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }
  constructor(label: string, initial: string, onSubmit: (value: string) => void, onCancel: () => void) {
    super(1, 0, panelBg);
    this.addChild(new Title(c.bold(c.accent(label))));
    this.input.setValue(initial);
    this.input.onSubmit = onSubmit;
    this.input.onEscape = onCancel;
    this.addChild(this.input);
    this.addChild(new Title(c.muted("enter confirm │ esc cancel")));
  }
  handleInput(data: string) {
    this.input.handleInput(data);
  }
}

/** A single-line input that never renders its value — for tokens. */
export class SecretInput implements Component, Focusable {
  private value = "";
  private cursor = 0;
  private pasteBuffer?: string;
  focused = false;
  onSubmit?: (value: string) => void;
  onEscape?: () => void;
  getValue() {
    return this.value;
  }
  handleInput(data: string) {
    if (this.pasteBuffer !== undefined) {
      this.pasteBuffer += data;
      const end = this.pasteBuffer.indexOf("\x1b[201~");
      if (end === -1) return;
      const pasted = this.pasteBuffer.slice(0, end);
      const rest = this.pasteBuffer.slice(end + 6);
      this.pasteBuffer = undefined;
      if (pasted) this.insert(pasted);
      if (rest) this.handleInput(rest);
      return;
    }
    if (data.startsWith("\x1b[200~")) {
      const end = data.indexOf("\x1b[201~");
      if (end === -1) {
        this.pasteBuffer = data.slice(6);
        return;
      }
      const pasted = data.slice(6, end);
      const rest = data.slice(end + 6);
      if (pasted) this.insert(pasted);
      if (rest) this.handleInput(rest);
      return;
    }
    if (matchesKey(data, "escape")) return this.onEscape?.();
    if (data === "\n" || matchesKey(data, "enter")) return this.onSubmit?.(this.value);
    if (matchesKey(data, "backspace")) {
      if (this.cursor > 0) this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor--);
      return;
    }
    if (matchesKey(data, "delete")) {
      this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
      return;
    }
    if (matchesKey(data, "left")) return (this.cursor = Math.max(0, this.cursor - 1));
    if (matchesKey(data, "right")) return (this.cursor = Math.min(this.value.length, this.cursor + 1));
    if (matchesKey(data, "home") || data === "\x01") return (this.cursor = 0);
    if (matchesKey(data, "end") || data === "\x05") return (this.cursor = this.value.length);
    if (data === "\x15") {
      this.value = "";
      this.cursor = 0;
      return;
    }
    this.insert(data);
  }
  private insert(text: string) {
    let clean = "";
    for (const ch of text) if (ch >= " " && ch !== "\x7f") clean += ch;
    if (!clean) return;
    this.value = this.value.slice(0, this.cursor) + clean + this.value.slice(this.cursor);
    this.cursor += clean.length;
  }
  render(width: number): string[] {
    const bullets = "•".repeat(this.value.length);
    const at = this.focused ? renderFakeCursor(bullets.slice(this.cursor, this.cursor + 1) || " ") : bullets.slice(this.cursor, this.cursor + 1) || " ";
    return [truncateToWidth(bullets.slice(0, this.cursor) + at + bullets.slice(this.cursor + 1), width)];
  }
  invalidate() {}
}

/** Like Prompt, but the typed value is only ever shown as bullets. */
export class SecretPrompt extends Box implements Focusable {
  readonly input = new SecretInput();
  private _focused = false;
  get focused() {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }
  constructor(label: string, onSubmit: (value: string) => void, onCancel: () => void) {
    super(1, 0, panelBg);
    this.addChild(new Title(c.bold(c.accent(label))));
    this.input.onSubmit = onSubmit;
    this.input.onEscape = onCancel;
    this.addChild(this.input);
    this.addChild(new Title(c.muted("paste or type the token │ enter confirm │ esc cancel")));
  }
  handleInput(data: string) {
    this.input.handleInput(data);
  }
}

/** A read-only panel that closes on Esc or Enter (help, tasks). */
export class Panel extends Box {
  private body = new Container();
  constructor(
    private render_: (width: number) => string[],
    private onClose: () => void,
  ) {
    super(1, 0, panelBg);
    this.addChild({ render: (w: number) => this.render_(w).map((l) => truncateToWidth(l, w)), invalidate() {} });
    this.addChild(this.body);
  }
  handleInput(data: string) {
    if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "q") this.onClose();
  }
}

// ------------------------------------------------------------------ flows

/**
 * The session picker. run-13: resolves with the picked session's id
 * (undefined on esc or ＋New) so /export can reuse this same door — every
 * existing caller ignores the value, and attach-on-pick is unchanged. A
 * failed tree() now lands in an error toast like the other ops pickers
 * (through /sessions it used to surface as an unhandled rejection).
 */
export function pickSession(app: App): Promise<string | undefined> {
  return new Promise((done) => {
    void (async () => {
      let tree: DeviceTree;
      try {
        tree = await app.client.tree();
      } catch (e) {
        app.notify(`sessions: ${(e as Error).message.slice(0, 80)}`, true);
        return done(undefined);
      }
      const items: SelectItem[] = [
        { value: "+new", label: "＋ New session", description: `choose a directory on ${oneLine(app.device.id)}` },
        ...tree.sessions.map((s) => {
          const agents = Array.isArray(s.agents) ? s.agents : [];
          return {
            value: s.id,
            label: oneLine(String(s.name ?? "")),
            description: `${oneLine(String(s.cwd ?? "").split("/").slice(-2).join("/"))} │ ${agents.length} agent${agents.length === 1 ? "" : "s"}${s.busy ? " │ working" : ""}`,
          };
        }),
      ];
      app.overlay(
        new Picker(`Sessions on ${oneLine(app.device.id)}`, items, (item) => {
          app.closeOverlay();
          // ＋New hands the flow to the new-session chain — resolve undefined so
          // a waiting /export stays quiet instead of flashing "cancelled" over
          // a flow that is telling its own story.
          if (item.value === "+new") {
            done(undefined);
            return void newSession(app);
          }
          const s = tree.sessions.find((x) => x.id === item.value)!;
          const root = s.agents.find((a) => a.kind === "root") ?? s.agents[0];
          void app.attach(s.id, root?.id ?? 1);
          done(s.id);
        }, () => {
          // Esc must never surprise-quit (0.0.52): with no attached session the
          // cancel used to pass exitIfNothing=true and picker→Esc→Esc killed the
          // whole process (R4 finding 1). Landing in the herd/network view is the
          // honest cancel; quitting stays on q / ctrl+c / /quit.
          app.closeOverlay();
          done(undefined);
        }),
      );
    })();
  });
}

export async function newSession(app: App, presetName?: string) {
  // The `n` input line already carries the typed name — never re-ask for it.
  const name = presetName !== undefined ? presetName : await app.prompt("Session name", "");
  if (name === undefined) return app.sessionId ? undefined : pickSession(app);
  const cwd = await walkDirs(app, "");
  // undefined = esc (back to the sessions picker when detached); null = the
  // device could not list directories — the error is already flashed, so
  // dead-end HERE instead of silently swapping to the unrelated "Sessions on…"
  // picker (R4 finding 8).
  if (cwd === undefined) return app.sessionId ? undefined : pickSession(app);
  if (cwd === null) return;
  // A device without a provider key (the Windows default) lists ZERO models —
  // the picker would be empty and creation dead-ends. Fall back to the device's
  // own default exactly like the web dialog's "(device default)" option.
  const models = app.info.models;
  const model = models.length
    ? await chooseModel(app, app.info.defaultModel)
    : { provider: (app.info as { provider?: string }).provider ?? "openrouter", id: app.info.defaultModel, name: "(device default)" };
  if (!model) return;
  // Thinking rides the create call: pick a level up front instead of paying
  // for "high" on a scratch session the device default never asked for.
  const thinking = await pickThinking(app);
  if (!thinking) return;
  await app.run(async () => {
    // The create+attach round-trip is the silent 2-20s dead-air on a cold
    // tunnel (R4 finding 8) — hold the message line while it flies.
    app.setPending(`creating ${name || "New session"} on ${app.device.name}…`);
    try {
      const s = await app.client.createSession({
        name: name || "New session",
        cwd,
        model: { provider: model.provider, modelId: model.id },
        thinkingLevel: thinking,
      });
      await app.attach(s.id, s.agents.find((a) => a.kind === "root")?.id ?? 1);
      app.flash(`Session created in ${cwd}`);
      if (!models.length) app.flash(`no model catalog on the device — using its default (${app.info.defaultModel})`);
    } finally {
      app.setPending(null);
    }
  });
}

/**
 * The directory walk for a new session's working folder. Resolves:
 *   string      — the chosen directory;
 *   undefined   — the user canceled (esc);
 *   null        — the device RPC failed (the error is already flashed).
 * Exported for the busy-note / failure-path unit tests.
 */
export function walkDirs(app: App, path: string): Promise<string | undefined | null> {
  return new Promise((done) => {
    const step = async (at: string) => {
      // A cold tunnel lists in 2-20s — hold the message line so the silence
      // never reads as a dead app (R4 finding 8).
      app.setPending(`listing ${at || "start dirs"} on ${app.device.name}…`);
      const listing = await app.client.dirs(at).catch((e: Error) => (app.flash(e.message, true), undefined));
      app.setPending(null);
      if (!listing) return done(null);
      const items: SelectItem[] = [
        ...(listing.path ? [{ value: `use:${listing.path}`, label: `✓ Use ${oneLine(String(listing.path ?? ""))}` }] : []),
        ...(listing.path ? [{ value: listing.parent ?? "", label: listing.parent ? ".." : "⌂ start dirs" }] : []),
        ...listing.dirs.map((d) => ({ value: d.path, label: `${oneLine(String(d.name ?? ""))}/` })),
      ];
      app.overlay(
        new Picker(`Working directory on ${oneLine(String(app.device.name ?? ""))}`, items, (item) => {
          app.closeOverlay();
          if (item.value.startsWith("use:")) done(item.value.slice(4));
          else void step(item.value);
        }, () => {
          app.closeOverlay();
          done(undefined);
        }),
      );
    };
    void step(path);
  });
}

function chooseModel(app: App, current?: string) {
  return new Promise<(typeof app.info.models)[number] | undefined>((done) => {
    const models = app.info.models;
    const picker = new Picker(
      `Model (${oneLine(String(app.device.name ?? ""))})`,
      models.map((m) => ({ value: `${m.provider}/${m.id}`, label: oneLine(String(m.name ?? "")), description: `${oneLine(String(m.tier ?? ""))} │ ${oneLine(String(m.provider ?? ""))}` })),
      (item) => {
        app.closeOverlay();
        done(models.find((m) => `${m.provider}/${m.id}` === item.value));
      },
      () => {
        app.closeOverlay();
        done(undefined);
      },
      undefined,
      // The keyless device still lists the built-in catalog — say why chat
      // will fail, instead of letting the first request be the messenger.
      (app.info as { providerKeyMissing?: boolean }).providerKeyMissing
        ? "no API key on this device — chat needs OPENROUTER_API_KEY in its env file"
        : undefined,
    );
    const index = models.findIndex((m) => m.id === current);
    if (index >= 0) picker.list.setSelectedIndex(index);
    app.overlay(picker);
  });
}

/**
 * The thinking-level picker: the new-session step AND the /thinking command
 * door (R4 finding 2 — the palette entry used to dead-end in a usage flash).
 * Preselects the agent's current level, else the backend create default.
 */
export function pickThinking(app: App, current?: string) {
  return new Promise<ThinkingLevel | undefined>((done) => {
    const picker = new Picker(
      "Thinking level",
      THINKING_LEVELS.map((level) => ({ value: level, label: level })),
      (item) => {
        app.closeOverlay();
        done(item.value as ThinkingLevel);
      },
      () => {
        app.closeOverlay();
        done(undefined);
      },
    );
    const wanted = current && THINKING_LEVELS.includes(current as ThinkingLevel) ? current : "medium";
    const index = THINKING_LEVELS.indexOf(wanted as ThinkingLevel);
    if (index >= 0) picker.list.setSelectedIndex(index);
    app.overlay(picker);
  });
}

export async function pickModel(app: App) {
  if (!app.handle) return;
  const model = await chooseModel(app, app.model.state.agent.model?.modelId);
  if (!model) return;
  await app.run(async () => {
    await app.handle!.configure({ model: { provider: model.provider, modelId: model.id } });
    app.flash(`Model: ${model.name} (next turn)`);
  });
}

export function pickAgent(app: App) {
  const summary = app.sessionSummary();
  if (!summary) return;
  const rows: SelectItem[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const node of nodes) {
      if (node.type !== "agent") continue;
      const a = node.agent;
      const icon = a.kind === "fork" ? "⑂" : a.kind === "subagent" ? "↳" : "◆";
      rows.push({
        value: String(a.id),
        label: `${"  ".repeat(depth)}${icon} ${oneLine(String(a.name ?? ""))}${a.busy ? " ●" : ""}`,
        description: [a.kind === "fork" ? `fork @ #${oneLine(String(a.forkedAt ?? ""))}` : oneLine(String(a.kind ?? "")), a.background ? `${oneLine(String(a.background))} bg` : ""]
          .filter(Boolean)
          .join(" │ "),
      });
      walk(node.children, depth + 1);
    }
  };
  walk(agentTree(app.device.id, summary, false), 0);
  const picker = new Picker(`Agents in ${oneLine(String(summary.name ?? ""))}`, rows, (item) => {
    app.closeOverlay();
    void app.attach(summary.id, Number(item.value));
  }, () => app.closeOverlay());
  const index = rows.findIndex((r) => r.value === String(app.agentId));
  if (index >= 0) picker.list.setSelectedIndex(index);
  app.overlay(picker);
}

export function pickDevice(app: App) {
  const devices = app.registry?.list() ?? [];
  if (!devices.length) return app.flash("No saved devices. Use --url/--token --save <id>.", true);
  app.overlay(
    new Picker(
      "Devices",
      devices.map((d) => ({
        value: d.id,
        label: `${d.id === app.device.id ? "● " : "  "}${d.id}`,
        description: `${d.kind} │ ${d.url}${d.token ? "" : " │ no token"}`,
      })),
      (item) => {
        app.closeOverlay();
        void app.switchDevice(item.value);
      },
      () => app.closeOverlay(),
    ),
  );
}

// --------------------------------------------- run-12: device-ops pickers
// The SDK already spoke schedules/env/notify (and the FE already had panels
// for them) — run-12 gives the SSH operator the same doors from the palette.
// Every row is composed through oneLine: names, urls, errors and paths below
// are device-authored and must never split their rendered row (run-9).

/** Wall clock for schedule rows — the device computed the epoch, the operator
 * reads it in the terminal's own timezone. */
const fmtClock = (ms: number) => {
  const d = new Date(ms);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${d.getDate()} ${d.toLocaleString("en", { month: "short" })} ${hhmm}`;
};

/** The trigger half of a schedule row: "every 30m" or "daily 09:30".
 *  dailyAt is device-authored — oneLine at this compose boundary (r12
 *  review m1: LF here would split the picker row). */
const triggerOf = (s: Pick<ScheduleView, "everyMinutes" | "dailyAt">) =>
  s.everyMinutes != null
    ? `every ${s.everyMinutes}m`
    : s.dailyAt
      ? `daily ${oneLine(s.dailyAt)}`
      : "no trigger";

/**
 * The /schedules n trigger grammar (run-12): the device clock supports exactly
 * two triggers — `every <minutes>` (5–1440) and `daily HH:MM` local time. A
 * cron expression is deliberately NOT accepted: the device would refuse it
 * anyway, so the palette refuses it first with a re-ask instead of a lost
 * create call. Exported for unit tests.
 */
export function parseScheduleTrigger(text: string): { everyMinutes: number } | { dailyAt: string } | undefined {
  const t = text.trim().toLowerCase();
  const every = t.match(/^every\s+(\d+)\s*m?(?:in)?s?$/);
  if (every) {
    const n = Number(every[1]);
    return n >= 5 && n <= 1440 ? { everyMinutes: n } : undefined;
  }
  const daily = t.match(/^daily\s+(\d{1,2}):(\d{2})$/);
  if (daily) {
    const h = Number(daily[1]);
    const m = Number(daily[2]);
    if (h <= 23 && m <= 59) return { dailyAt: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` };
  }
  return undefined;
}

/** Prompts until the text parses as a trigger; esc (undefined) cancels the
 * whole new-schedule chain. A bad answer re-asks instead of dead-ending. */
async function promptScheduleTrigger(app: App) {
  for (;;) {
    const text = await app.prompt("Trigger — `every <minutes>` (5-1440) or `daily HH:MM`", "");
    if (text === undefined) return undefined;
    const parsed = parseScheduleTrigger(text);
    if (parsed) return parsed;
    app.flash("trigger must be `every <minutes>` (5-1440) or `daily HH:MM`", true);
  }
}

/**
 * The /schedules n chain (run-12): name → trigger → cwd (the SAME walkDirs the
 * new-session flow uses) → prompt text, then one createSchedule call. Model
 * and retention stay on their device defaults — the palette is a keyboard,
 * not a form (run-12 Unit B scope).
 */
async function newScheduleFlow(app: App) {
  const name = ((await app.prompt("Schedule name", "")) ?? "").trim();
  if (!name) return app.flash("new schedule cancelled"), undefined;
  const trigger = await promptScheduleTrigger(app);
  if (!trigger) return app.flash("new schedule cancelled"), undefined;
  const cwd = await walkDirs(app, "");
  // undefined = esc, null = the device listing failed (already flashed — R4
  // finding 8 sentinels). Either way the chain stops HERE, honestly.
  if (cwd === undefined) return app.flash("new schedule cancelled"), undefined;
  if (cwd === null) return;
  const text = (await app.prompt("Prompt text for each run", ""))?.trim();
  if (!text) return app.flash("new schedule cancelled"), undefined;
  await app.run(async () => {
    app.setPending(`creating schedule ${name}…`);
    try {
      const s = await app.client.createSchedule({ name, cwd, prompt: text, ...trigger });
      app.flash(`schedule ${oneLine(s.name)} created — ${triggerOf(s)}`);
      app.logEvent("sched", `created ${oneLine(s.name)} · ${triggerOf(s)} · ${oneLine(cwd)}`);
    } finally {
      app.setPending(null);
    }
  });
}

/** /schedules (run-12): list · enter run now · t toggle · d delete · n new. */
export async function pickSchedules(app: App) {
  let list: ScheduleView[];
  try {
    list = (await app.client.schedules()).schedules;
  } catch (e) {
    return app.notify(`schedules: ${(e as Error).message.slice(0, 80)}`, true);
  }
  const items: SelectItem[] = [
    { value: "+new", label: "＋ New schedule", description: "the device runs each one on its own clock" },
    ...list.map((s) => ({
      value: s.id,
      label: `${s.enabled ? "●" : "○"} ${oneLine(s.name)}`,
      description: `${triggerOf(s)} · next ${s.nextRunAt ? fmtClock(s.nextRunAt) : "—"}${s.running ? " · running now" : ""}${s.lastOutcome ? ` · last ${oneLine(String(s.lastOutcome))}` : ""}`,
    })),
  ];
  app.overlay(
    new ActionPicker(
      `Schedules on ${oneLine(app.device.id)}`,
      items,
      async (item) => {
        app.closeOverlay();
        if (item.value === "+new") {
          await newScheduleFlow(app);
          return void pickSchedules(app);
        }
        const s = list.find((x) => x.id === item.value)!;
        await app.run(async () => {
          const after = await app.client.runSchedule(s.id);
          app.notify(`▶ ${oneLine(after.name)} — session started (log view: L)`);
          app.logEvent("sched", `${oneLine(after.name)} triggered by hand · ${triggerOf(after)}`);
        });
        // next/last changed — reopen on fresh state rather than showing a stale row.
        void pickSchedules(app);
      },
      () => app.closeOverlay(),
      "enter run now · t on/off · d delete · n new · esc close",
      {
        t: async (item) => {
          if (item.value === "+new") return;
          const s = list.find((x) => x.id === item.value)!;
          app.closeOverlay();
          await app.run(async () => {
            const after = await app.client.updateSchedule(s.id, { enabled: !s.enabled });
            app.notify(`${oneLine(after.name)} ${after.enabled ? "enabled ●" : "disabled ○"}`);
            app.logEvent("sched", `${oneLine(after.name)} ${after.enabled ? "enabled" : "disabled"}`);
          });
          void pickSchedules(app);
        },
        d: async (item) => {
          if (item.value === "+new") return;
          const s = list.find((x) => x.id === item.value)!;
          // The same y/n gate /reset asks (R4 finding 4): a destructive door
          // confirms; esc or anything not starting with y keeps the schedule.
          const ok = await app.prompt(`Delete schedule ${oneLine(s.name)}? y/n`, "");
          if (ok === undefined || !ok.trim().toLowerCase().startsWith("y"))
            return app.flash("delete cancelled"), undefined;
          app.closeOverlay();
          await app.run(async () => {
            await app.client.removeSchedule(s.id);
            app.notify(`deleted ${oneLine(s.name)}`);
            app.logEvent("sched", `deleted ${oneLine(s.name)} · ${triggerOf(s)}`);
          });
          void pickSchedules(app);
        },
        n: async () => {
          app.closeOverlay();
          await newScheduleFlow(app);
          void pickSchedules(app);
        },
      },
    ),
  );
}

/** /env (run-12): the device's env file — list, edit, set, remove. Secrets
 * arrive masked from the backend and are never round-tripped: editing a
 * secret prefills BLANK (a prefilled mask would overwrite the real value). */
export async function pickEnv(app: App) {
  let view: EnvFileView;
  try {
    view = await app.client.envView();
  } catch (e) {
    return app.notify(`env: ${(e as Error).message.slice(0, 80)}`, true);
  }
  const items: SelectItem[] = [
    { value: "+new", label: "＋ Set variable", description: "add or overwrite one key in the env file" },
    ...view.vars.map((v) => ({
      value: v.key,
      label: `${oneLine(v.key)}=${oneLine(v.masked)}`,
      description: v.source === "process" || v.managed ? "read-only" : "file · editable",
    })),
  ];
  const editable = (v: { source: string; managed: boolean }) => !(v.source === "process" || v.managed);
  const editVar = async (key: string) => {
    const v = view.vars.find((x) => x.key === key);
    if (!v) return;
    if (!editable(v))
      return app.notify(
        `${oneLine(v.key)} is read-only (${v.managed ? "managed by the device" : "inherited from the process env"})`,
      );
    const value = await app.prompt(
      `Value for ${oneLine(v.key)}${v.secret ? " (secret — the file keeps it masked)" : ""}`,
      v.secret ? "" : oneLine(v.masked),
    );
    if (value === undefined) return app.flash("edit cancelled"), undefined;
    // An empty submit on a masked row is far more likely a stray enter than an
    // intent to blank the variable — removing has its own confirmed door (d).
    if (!value) return app.flash("cancelled — an empty value would clear the variable (d removes)"), undefined;
    app.closeOverlay();
    await app.run(async () => {
      await app.client.setEnvVar(v.key, value);
      app.notify(`${oneLine(v.key)} saved`);
      app.logEvent("env", `set ${oneLine(v.key)}`);
    });
    void pickEnv(app);
  };
  app.overlay(
    new ActionPicker(
      `Device env${view.envFile ? ` — ${oneLine(view.envFile)}` : ""}`,
      items,
      (item) => {
        if (item.value === "+new") {
          app.closeOverlay();
          void setNewVar(app).then(() => pickEnv(app));
          return;
        }
        void editVar(item.value);
      },
      () => app.closeOverlay(),
      "enter edit · d remove · n set new · esc close",
      {
        d: async (item) => {
          if (item.value === "+new") return;
          const v = view.vars.find((x) => x.key === item.value);
          if (!v) return;
          if (!editable(v)) return app.notify(`${oneLine(v.key)} is read-only`);
          const ok = await app.prompt(`Remove ${oneLine(v.key)} from the env file? y/n`, "");
          if (ok === undefined || !ok.trim().toLowerCase().startsWith("y"))
            return app.flash("remove cancelled"), undefined;
          app.closeOverlay();
          await app.run(async () => {
            await app.client.removeEnvVar(v.key);
            app.notify(`removed ${oneLine(v.key)}`);
            app.logEvent("env", `removed ${oneLine(v.key)}`);
          });
          void pickEnv(app);
        },
        n: async () => {
          app.closeOverlay();
          await setNewVar(app);
          void pickEnv(app);
        },
      },
      // The backend flags this — surfacing it where the edit happens beats a
      // separate "did my change apply?" trip to the FE.
      view.restartRequired ? "changed since boot — restart the device to apply" : undefined,
    ),
  );
}

/** The /env n chain: key → value → one setEnvVar call. Re-asks on a key that
 * could not live in an env file, mirroring promptScheduleTrigger. */
async function setNewVar(app: App) {
  let key = "";
  for (;;) {
    key = ((await app.prompt("Key (letters, digits, _ — e.g. MY_TOOL_TOKEN)", "")) ?? "").trim();
    if (!key) return app.flash("set cancelled"), undefined;
    if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) break;
    app.flash("keys start with a letter or _ and carry letters, digits, _ and . only", true);
  }
  const value = (await app.prompt(`Value for ${oneLine(key)}`, ""))?.trim();
  if (!value) return app.flash("set cancelled"), undefined;
  await app.run(async () => {
    await app.client.setEnvVar(key, value);
    app.notify(`${oneLine(key)} saved`);
    app.logEvent("env", `set ${oneLine(key)}`);
  });
}

/** /notify (run-12): list the sinks and fire a test event. NO sink CRUD from
 * the TUI — sinks hold credentials (webhook URLs, ntfy topics), and the web
 * FE is their managed home; the palette only proves the pipe works. */
export async function pickNotify(app: App) {
  let sinks: NotifySinkView[];
  try {
    sinks = (await app.client.notifySinks()).sinks;
  } catch (e) {
    return app.notify(`notify: ${(e as Error).message.slice(0, 80)}`, true);
  }
  if (!sinks.length)
    return app.notify("no notify sinks on this device — manage them in the web FE (they hold credentials)");
  const test = async () => {
    try {
      const { results } = await app.client.testNotifySinks();
      const sent = results.filter((r) => r.status === "sent").length;
      const failed = results.filter((r) => r.status === "failed").length;
      const skipped = results.length - sent - failed;
      app.notify(
        `notify test: ${sent} sent${failed ? ` · ${failed} failed` : ""}${skipped ? ` · ${skipped} skipped` : ""}${failed ? " (log view: L)" : ""}`,
      );
      for (const r of results)
        app.logEvent(
          "notify",
          `${oneLine(r.kind)} ${oneLine(r.id)} — ${r.status}${r.detail ? ` · ${oneLine(r.detail).slice(0, 60)}` : ""}${r.ms != null ? ` · ${r.ms}ms` : ""}`,
        );
    } catch (e) {
      app.notify(`notify test: ${(e as Error).message.slice(0, 80)}`, true);
    }
  };
  app.overlay(
    new ActionPicker(
      "Notify sinks (testing only — CRUD lives in the web FE)",
      sinks.map((s) => ({
        value: s.id,
        // kind is device-authored and sits in a LABEL (never LF-normalized
        // by pi-tui — r12 review m1) — oneLine here, not just the description.
        label: `${s.enabled ? "●" : "○"} ${oneLine(String(s.kind))}${s.label ? ` ${oneLine(s.label)}` : ""}`,
        description: `${oneLine(s.url)}${s.lastStatus ? ` · last ${oneLine(String(s.lastStatus))}` : ""}${s.lastError ? ` · ${oneLine(s.lastError).slice(0, 40)}` : ""}${s.silencedUntil && s.silencedUntil > Date.now() ? " · silenced" : ""}`,
      })),
      () => void test(),
      () => app.closeOverlay(),
      "enter/t test every enabled sink · esc close",
      { t: () => void test() },
    ),
  );
}

// ---------------------------------------------- run-13: :archive
// The SDK's archive surface (policy #3): list bundles, read a transcript,
// restore. NO delete door — the SDK exposes no endpoint, and the palette does
// not invent one (run-13 scope). fmtBytes/fmtDur come from commands.ts (their
// home since run-12); the import is function-referenced only, so the benign
// pickers↔commands cycle is safe under ESM live bindings.

/** Transcript dump caps (run-13 A2, the r9 diagnostics-caps pattern): the log
 * view is a 500-entry ring, so one :archive enter may add at most 400 lines /
 * 100 KiB, with a LEADING marker naming what was cut — never a silent crop.
 * Each surviving line is sanitizeTerminal'd HERE: logEvent writes its text
 * verbatim (no normalizer downstream), so this helper is the chokepoint. */
const TRANSCRIPT_MAX_LINES = 400;
const TRANSCRIPT_MAX_BYTES = 100 * 1024;

export function capTranscriptLines(text: string): string[] {
  const raw = String(text ?? "");
  let cut = false;
  let body = raw;
  if (Buffer.byteLength(body, "utf8") > TRANSCRIPT_MAX_BYTES) {
    // Byte-boundary cut on the UTF-8 encoding (a char-count slice could leave
    // up to 4× the budget for multibyte text); toString drops any dangling
    // multibyte fragment as U+FFFD.
    cut = true;
    body = Buffer.from(body, "utf8").subarray(0, TRANSCRIPT_MAX_BYTES).toString("utf8");
  }
  const total = raw.split("\n").length;
  const all = body.split("\n");
  const lines = all.slice(0, TRANSCRIPT_MAX_LINES);
  if (all.length > TRANSCRIPT_MAX_LINES) cut = true;
  const out = lines.map((l) => sanitizeTerminal(l));
  if (cut) {
    // The count names the lines the operator will not see (a byte cut can hide
    // more than the count shows — it is a lower bound, still honest).
    const dropped = Math.max(1, total - lines.length);
    out.unshift(`... truncated (${dropped} line${dropped === 1 ? "" : "s"})`);
  }
  return out;
}

/** /archive (run-13 A2): archived sessions, newest first. Every device-
 * authored field goes through oneLine INCLUDING the label path — pi-tui
 * LF-normalizes descriptions only, so label strings must be collapsed at
 * compose time (the r12 m1 lesson, pinned by test). Enter keeps the list up
 * (reading is read-only, the pickNotify pattern) and dumps the markdown
 * transcript into the log view through the caps above; r restores behind the
 * same y/n gate /reset uses, then the list refetches without the row. */
export async function pickArchived(app: App) {
  let list: ArchivedView[];
  try {
    list = (await app.client.archived()).sessions;
  } catch (e) {
    return app.notify(`archive: ${(e as Error).message.slice(0, 80)}`, true);
  }
  if (!list.length) return app.notify("no archived sessions on this device");
  // archivedAt is relay-borne — coerce (a string/garbage field must not break
  // the sort, R19 discipline) and sort newest-first.
  const sessions = [...list].sort((a, b) => (Number(b.archivedAt) || 0) - (Number(a.archivedAt) || 0));
  const items: SelectItem[] = sessions.map((s) => ({
    // value is never rendered (filter matches label+description only) — keep
    // the RAW id so transcript/restore hit the device's true session.
    value: String(s.sessionId ?? ""),
    label: `${s.hasManifest === true ? "◈" : "◇"} ${oneLine(String(s.name ?? ""))}`,
    description: `${oneLine(String(s.cwd ?? ""))} · ${oneLine(String(Number(s.turns) || 0))} turns · ${fmtBytes(Number(s.bytes) || 0)} · archived ${fmtDur(Math.max(0, (Date.now() - (Number(s.archivedAt) || 0)) / 1000))} ago`,
  }));
  const showTranscript = async (item: SelectItem) => {
    const s = sessions.find((x) => x.sessionId === item.value);
    const label = oneLine(String(s?.name ?? item.value));
    try {
      const view = await app.client.archivedTranscript(item.value, "markdown");
      const raw = String(view.text ?? "");
      if (!raw.trim()) return app.notify(`transcript: ${label} is empty`);
      const lines = capTranscriptLines(raw);
      // Raw markdown is fine — the TUI does not render md, it prints lines.
      for (const line of lines) app.logEvent("arch", line);
      app.notify(`${label} — transcript, ${lines.length} line${lines.length === 1 ? "" : "s"} (log view: L)`);
    } catch (e) {
      app.notify(`transcript: ${(e as Error).message.slice(0, 80)}`, true);
    }
  };
  const restore = async (item: SelectItem) => {
    const s = sessions.find((x) => x.sessionId === item.value);
    const label = oneLine(String(s?.name ?? item.value));
    // The same y/n gate /reset and /schedules d ask (R4 finding 4): a
    // state-changing door confirms; esc or anything not starting with y keeps
    // the bundle archived.
    const ok = await app.prompt(`Restore ${label}? y/n`, "");
    if (ok === undefined || !ok.trim().toLowerCase().startsWith("y"))
      return app.flash("restore cancelled"), undefined;
    app.closeOverlay();
    await app.run(async () => {
      const restored = await app.client.restoreArchived(item.value);
      const name = oneLine(String((restored as { name?: string })?.name ?? label));
      // The app's session list refetches on its next view entry — no hook
      // needed; the toast points the operator at g.
      app.notify(`restored ${name} — press g to open it`);
      app.logEvent("arch", `restored ${name}`);
    });
    // The row is gone on the device — refetch instead of showing a stale list
    // (the pickSchedules d pattern).
    void pickArchived(app);
  };
  app.overlay(
    new ActionPicker(
      `Archived on ${oneLine(app.device.id)}`,
      items,
      (item) => void showTranscript(item),
      () => app.closeOverlay(),
      "enter transcript · r restore · esc close",
      { r: restore },
      "◈ manifest · ◇ bundle only",
    ),
  );
}
