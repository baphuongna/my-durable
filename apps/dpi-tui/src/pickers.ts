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
import { agentTree, type TreeNode } from "../../dpi-sdk/src/models.ts";
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

/** A titled SelectList; typing filters it. */
export class Picker extends Box {
  readonly list: SelectList;
  private filter = "";
  private title: Title;
  constructor(
    private label: string,
    items: SelectItem[],
    onPick: (item: SelectItem) => void,
    onCancel: () => void,
    hint = "↑↓ move │ enter select │ type to filter │ esc close",
    subtitle?: string,
  ) {
    super(1, 0, panelBg);
    this.title = new Title(c.bold(c.accent(label)));
    this.list = new SelectList(items, Math.max(1, Math.min(14, items.length)), selectTheme);
    this.list.onSelect = onPick;
    this.list.onCancel = onCancel;
    this.addChild(this.title);
    if (subtitle) this.addChild(new Title(subtitle));
    this.addChild(this.list);
    this.addChild(new Title(c.muted(hint)));
  }
  handleInput(data: string) {
    if (matchesKey(data, "backspace")) this.filter = this.filter.slice(0, -1);
    else if (data.length === 1 && data >= " " && data !== "\x7f") this.filter += data;
    else return this.list.handleInput(data);
    this.list.setFilter(this.filter);
    this.title.text = c.bold(c.accent(this.label)) + (this.filter ? c.muted(`  /${this.filter}`) : "");
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

export async function pickSession(app: App) {
  const tree = await app.client.tree();
  const items: SelectItem[] = [
    { value: "+new", label: "＋ New session", description: `choose a directory on ${app.device.id}` },
    ...tree.sessions.map((s) => ({
      value: s.id,
      label: s.name,
      description: `${s.cwd.split("/").slice(-2).join("/")} │ ${s.agents.length} agent${s.agents.length === 1 ? "" : "s"}${s.busy ? " │ working" : ""}`,
    })),
  ];
  app.overlay(
    new Picker(`Sessions on ${app.device.id}`, items, (item) => {
      app.closeOverlay();
      if (item.value === "+new") return void newSession(app);
      const s = tree.sessions.find((x) => x.id === item.value)!;
      const root = s.agents.find((a) => a.kind === "root") ?? s.agents[0];
      void app.attach(s.id, root?.id ?? 1);
    }, () => app.closeOverlay(!app.sessionId)),
  );
}

export async function newSession(app: App) {
  const name = await app.prompt("Session name", "");
  if (name === undefined) return app.sessionId ? undefined : pickSession(app);
  const cwd = await walkDirs(app, "");
  if (!cwd) return app.sessionId ? undefined : pickSession(app);
  const model = await chooseModel(app, app.info.defaultModel);
  if (!model) return;
  await app.run(async () => {
    const s = await app.client.createSession({ name: name || "New session", cwd, model: { provider: model.provider, modelId: model.id } });
    await app.attach(s.id, s.agents.find((a) => a.kind === "root")?.id ?? 1);
    app.flash(`Session created in ${cwd}`);
  });
}

function walkDirs(app: App, path: string): Promise<string | undefined> {
  return new Promise((done) => {
    const step = async (at: string) => {
      const listing = await app.client.dirs(at).catch((e: Error) => (app.flash(e.message, true), undefined));
      if (!listing) return done(undefined);
      const items: SelectItem[] = [
        ...(listing.path ? [{ value: `use:${listing.path}`, label: `✓ Use ${listing.path}` }] : []),
        ...(listing.path ? [{ value: listing.parent ?? "", label: listing.parent ? ".." : "⌂ start dirs" }] : []),
        ...listing.dirs.map((d) => ({ value: d.path, label: `${d.name}/` })),
      ];
      app.overlay(
        new Picker(`Working directory on ${app.device.id}`, items, (item) => {
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
      `Model (${app.device.id})`,
      models.map((m) => ({ value: `${m.provider}/${m.id}`, label: m.name, description: `${m.tier} │ ${m.provider}` })),
      (item) => {
        app.closeOverlay();
        done(models.find((m) => `${m.provider}/${m.id}` === item.value));
      },
      () => {
        app.closeOverlay();
        done(undefined);
      },
    );
    const index = models.findIndex((m) => m.id === current);
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
        label: `${"  ".repeat(depth)}${icon} ${a.name}${a.busy ? " ●" : ""}`,
        description: [a.kind === "fork" ? `fork @ #${a.forkedAt}` : a.kind, a.background ? `${a.background} bg` : ""]
          .filter(Boolean)
          .join(" │ "),
      });
      walk(node.children, depth + 1);
    }
  };
  walk(agentTree(app.device.id, summary, false), 0);
  const picker = new Picker(`Agents in ${summary.name}`, rows, (item) => {
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
