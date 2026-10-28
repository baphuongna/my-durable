// Transcript items (from the SDK, same as the web client) → pi-tui components, cached by item id.
// Only items whose content changed are rebuilt; the live assistant reuses its Markdown blocks.
import {
  Container,
  Markdown,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import type { ToolCallView, TranscriptItem } from "../../dpi-sdk/src/transcript.ts";
import { c, markdownTheme } from "./theme.ts";
import { sanitizeTerminal } from "./sanitize.ts";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Advanced by the app while a tool runs; running tool rows read it at render time. */
export const spinner = { frame: 0 };
const TAIL = 6;

/** One styled line, cut to the width. A STYLED primitive (R14 cold review):
 * inputs are usually pre-styled with the theme's own SGR, so this class must
 * NOT strip escapes — callers sanitize the untrusted PAYLOAD before styling
 * (same data-boundary rule as views.ts). */
export class Line implements Component {
  constructor(public text: string) {}
  render(width: number) {
    return [truncateToWidth(this.text, width)];
  }
  invalidate() {}
}

/** Wrapped text with a first-line prefix and a hanging indent. */
class Wrapped implements Component {
  constructor(
    private text: string,
    private prefix: string,
    private style: (s: string) => string,
    private indent = "  ",
  ) {
    this.text = sanitizeTerminal(text);
  }
  render(width: number) {
    const inner = Math.max(1, width - 2);
    const lines = this.text.split("\n").flatMap((l) => (l ? wrapTextWithAnsi(l, inner) : [""]));
    return lines.map((l, i) => truncateToWidth((i ? this.indent : this.prefix) + this.style(l), width));
  }
  invalidate() {}
}

function argsPreview(call: ToolCallView) {
  const args = call.args as Record<string, unknown> | undefined;
  if (args && typeof args === "object") {
    for (const key of ["command", "path", "file_path", "pattern", "task", "query"])
      if (typeof args[key] === "string") return (args[key] as string).replace(/\s+/g, " ");
  }
  const json = JSON.stringify(call.args ?? {});
  return json === "{}" ? "" : json;
}

export class ToolRow implements Component {
  constructor(
    private call: ToolCallView,
    private expand: boolean,
  ) {}
  render(width: number) {
    const s = this.call.status;
    const icon =
      s === "running" ? c.warn(SPIN[spinner.frame % SPIN.length]) : s === "done" ? c.ok("✓") : s === "error" ? c.err("✗") : c.muted("○");
    const head = truncateToWidth(
      `${icon} ${c.bold(sanitizeTerminal(this.call.name))} ${c.muted(sanitizeTerminal(argsPreview(this.call)))}`,
      width,
    );
    const body = sanitizeTerminal(this.call.result ?? this.call.output ?? "").replace(/\s+$/, "");
    if (!body) return [head];
    const all = body.split("\n");
    const shown = this.expand ? all : all.slice(-TAIL);
    const gutter = c.muted("  │ ");
    const lines = this.expand
      ? shown.flatMap((l) => (l ? wrapTextWithAnsi(l, Math.max(1, width - 4)) : [""]))
      : shown;
    const out = [head, ...lines.map((l) => truncateToWidth(gutter + (s === "error" ? c.err(l) : l), width))];
    if (all.length > shown.length)
      out.splice(1, 0, truncateToWidth(c.muted(`  │ … ${all.length - shown.length} earlier lines (ctrl+o)`), width));
    return out;
  }
  invalidate() {}
}

class Stack implements Component {
  constructor(public parts: Component[] = []) {}
  render(width: number) {
    return this.parts.flatMap((p) => p.render(width));
  }
  invalidate() {
    for (const p of this.parts) p.invalidate();
  }
}

/** Assistant message: Markdown text blocks (reused across deltas), thinking, tool rows, errors. */
class AssistantView extends Stack {
  private markdown = new Map<number, Markdown>();
  update(item: Extract<TranscriptItem, { kind: "assistant" }>, expand: boolean) {
    const parts: Component[] = [new Line("")];
    item.blocks.forEach((block, i) => {
      if (block.type === "text") {
        const safe = sanitizeTerminal(block.text);
        let md = this.markdown.get(i);
        if (!md) {
          md = new Markdown(safe, 0, 0, markdownTheme);
          this.markdown.set(i, md);
        } else md.setText(safe);
        parts.push(md);
      } else if (block.type === "thinking") {
        parts.push(
          expand
            ? new Wrapped(block.text, c.muted("∴ "), (s) => c.italic(c.muted(s)))
            : new Line(c.italic(c.muted(`∴ ${sanitizeTerminal(block.text).replace(/\s+/g, " ")}`))),
        );
      } else parts.push(new ToolRow(block.call, expand));
    });
    if (item.streaming && !item.blocks.length) parts.push(new Line(c.muted("…")));
    if (item.error) parts.push(new Line(c.err(`! ${sanitizeTerminal(item.error)}`)));
    this.parts = parts;
  }
}

export function itemComponent(item: TranscriptItem, expand: boolean): Component {
  switch (item.kind) {
    case "user":
      return new Stack([new Line(""), new Wrapped(item.text, c.user("› "), c.user)]);
    case "assistant": {
      const view = new AssistantView();
      view.update(item, expand);
      return view;
    }
    case "tool-result":
      return new ToolRow(
        { callId: String(item.id), name: item.name, args: undefined, status: item.isError ? "error" : "done", result: item.text },
        expand,
      );
    case "tool":
      return new ToolRow(item.call, expand);
    default:
      return new Line(c.muted(`── ${sanitizeTerminal(item.text)} `));
  }
}

export class TranscriptView extends Container {
  private cache = new Map<string, { sig: string; component: Component }>();
  expand = false;

  update(items: readonly TranscriptItem[]) {
    const next = new Map<string, { sig: string; component: Component }>();
    this.clear();
    for (const item of items) {
      const key = `${item.kind}:${item.id}`;
      const sig = `${this.expand}|${JSON.stringify(item)}`;
      let entry = this.cache.get(key);
      if (!entry || entry.sig !== sig) {
        if (entry && item.kind === "assistant" && entry.component instanceof AssistantView)
          entry.component.update(item, this.expand);
        else entry = { sig, component: itemComponent(item, this.expand) };
        entry.sig = sig;
      }
      next.set(key, entry);
      this.addChild(entry.component);
    }
    this.cache = next;
  }

  reset() {
    this.cache.clear();
    this.clear();
  }
}
