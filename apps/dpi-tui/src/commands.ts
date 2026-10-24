// Slash commands. Anything that is not a known command goes to the agent as text, as in pi.
import type { SlashCommand } from "@earendil-works/pi-tui";
import { THINKING_LEVELS, type ThinkingLevel } from "../../dpi-sdk/src/api.ts";
import type { App } from "./app.ts";
import { Panel, pickAgent, pickDevice, pickModel, pickSession } from "./pickers.ts";
import { parsePairArgs, runPairing } from "./pairing.ts";
import { c } from "./theme.ts";
import { basename, dirname, isAbsolute, join } from "node:path";

export const COMMANDS: SlashCommand[] = [
  { name: "sessions", description: "switch or create a session on this device" },
  { name: "agents", description: "switch agent: roots, forks, subagents" },
  { name: "model", description: "choose this agent's model" },
  { name: "devices", description: "switch device" },
  { name: "new", description: "new agent in this session", argumentHint: "[name]" },
  { name: "fork", description: "fork at an entry (default: the last reply)", argumentHint: "[entryId] [name]" },
  {
    name: "thinking",
    description: "set the thinking level",
    argumentHint: "<level>",
    getArgumentCompletions: (prefix) =>
      THINKING_LEVELS.filter((l) => l.startsWith(prefix)).map((l) => ({ value: l, label: l })),
  },
  { name: "compact", description: "summarize older context", argumentHint: "[instructions]" },
  { name: "reset", description: "start a fresh context", argumentHint: "[handoff note]" },
  { name: "name", description: "rename this agent", argumentHint: "<name>" },
  { name: "tasks", description: "live tasks in this session" },
  { name: "pair", description: "pair THIS device with a hub", argumentHint: "<CODE|PAIR_URL> [--hub ORIGIN] [--force]" },
  {
    name: "git",
    description: "git on the session's folder: status, diff, log, pull, fetch, branch, switch, commit, worktree",
    argumentHint: "[status|diff|log|fetch|pull|branch|switch <b>|commit <msg>|worktree [new <b>|remove <path>]]",
    getArgumentCompletions: (prefix) =>
      ["status", "diff", "log", "fetch", "pull", "branch", "switch", "commit", "worktree"]
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({ value: s, label: s })),
  },
  { name: "help", description: "keys and commands" },
  { name: "quit", description: "exit (the agent keeps running)" },
];

const GIT_OPS = new Set(["diff", "log", "fetch", "pull", "branch", "switch", "commit", "worktree", "status", "wt"]);

/** /git — the device's own git, spoken through its whitelisted API. */
async function gitCommand(app: App, arg: string) {
  const cwd = app.cwd();
  if (!cwd) return app.notify("no session open — /git works on a session's folder");
  const [op = "status", ...rest] = arg.split(/\s+/).filter(Boolean);
  const a1 = rest[0] ?? "";
  try {
    if (op === "status" || op === "") {
      const s = await app.client.gitStatus(cwd);
      if (!s.repo) return app.notify(`${cwd} is not a git repository`);
      const dirty = (s.staged ?? 0) + (s.unstaged ?? 0) + (s.untracked ?? 0);
      app.notify(`⎇ ${s.branch ?? s.head} ±${dirty}${s.ahead ? ` ↑${s.ahead}` : ""}${s.behind ? ` ↓${s.behind}` : ""}`);
      app.logEvent("git", `${cwd} · ${s.branch ?? s.head}${s.upstream ? ` → ${s.upstream}` : ""} · +${s.staged ?? 0}/~${s.unstaged ?? 0}/?${s.untracked ?? 0}${s.worktreeOf ? ` · worktree of ${s.worktreeOf}` : ""}`);
      for (const w of s.worktrees ?? []) app.logEvent("git", `  ${w.path} ${w.branch ? `⎇ ${w.branch}` : w.head}`);
      return;
    }
    if (op === "worktree" || op === "wt") {
      if (a1 === "new" || a1 === "add") {
        const name = rest[1];
        if (!name) return app.notify("usage: /git worktree new <branch-name>");
        const base = await app.client.gitStatus(cwd);
        if (!base.repo) return app.notify("not a git repository");
        const target = join(dirname(base.root ?? cwd), `${basename(base.root ?? cwd)}-${name}`);
        const out = await app.client.gitOp(cwd, "worktree-add", { branch: name, target });
        app.flash(`worktree: ${out.text.split("\n")[0] ?? target}`);
        app.logEvent("git", `worktree add ${target} (${name})`);
        return;
      }
      if (a1 === "remove" || a1 === "rm") {
        const target = rest[1];
        if (!target || !isAbsolute(target)) return app.notify("usage: /git worktree remove /abs/path");
        const out = await app.client.gitOp(cwd, "worktree-remove", { target });
        app.flash(out.text);
        return;
      }
      const s = await app.client.gitStatus(cwd);
      for (const w of s.worktrees ?? []) app.logEvent("git", `${w.path} ${w.branch ? `⎇ ${w.branch}` : w.head}`);
      app.notify(`${s.worktrees?.length ?? 0} worktree${s.worktrees?.length === 1 ? "" : "s"} (log view)`);
      return;
    }
    if (!GIT_OPS.has(op)) return app.notify(`unknown git op "${op}" — status diff log fetch pull branch switch commit worktree`);
    if (op === "switch" && !a1) return app.notify("usage: /git switch <branch>");
    if (op === "commit" && !rest.length) return app.notify("usage: /git commit <message>");
    const out = await app.client.gitOp(cwd, op as never, {
      ref: op === "switch" ? a1 : undefined,
      message: op === "commit" ? rest.join(" ") : undefined,
    });
    for (const line of out.text.split("\n").slice(0, 12)) if (line.trim()) app.logEvent("git", line);
    app.notify(`${op} ✓ (log view: L)`);
  } catch (e) {
    app.notify(`git ${op}: ${(e as Error).message.slice(0, 80)}`);
  }
}

const KEYS: [string, string][] = [
  ["enter", "send; steers the agent while it works"],
  ["alt+enter", "queue as a follow-up"],
  ["esc", "interrupt foreground work"],
  ["shift+tab", "cycle thinking level"],
  ["ctrl+l", "model picker"],
  ["ctrl+o", "expand tool output and thinking"],
  ["ctrl+c", "clear input, or exit when empty"],
  ["ctrl+d", "exit"],
];

/** Returns false when `text` is not a command, so the caller sends it to the agent. */
export async function runCommand(app: App, text: string): Promise<boolean> {
  const match = text.match(/^\/(\S+)\s*([\s\S]*)$/);
  const command = COMMANDS.find((c) => c.name === match?.[1]);
  if (!match || !command) return false;
  const arg = match[2].trim();
  const handle = app.handle;
  switch (command.name) {
    case "sessions":
      await pickSession(app);
      break;
    case "agents":
      pickAgent(app);
      break;
    case "model":
      await pickModel(app);
      break;
    case "devices":
      pickDevice(app);
      break;
    case "new":
      // "new agent" needs an open session; the n KEY (new session) is the other door.
      if (!app.sessionId) {
        app.notify("no session open — press n to create one");
        break;
      }
      await app.run(async () => {
        const created = await app.client.session(app.sessionId!).createAgent(arg ? { name: arg } : {});
        await app.attach(app.sessionId!, created.id);
        app.flash(`New agent ${created.name}`);
      });
      break;
    case "fork": {
      const [first, ...rest] = arg.split(/\s+/).filter(Boolean);
      const explicit = first && /^\d+$/.test(first) ? Number(first) : undefined;
      const name = (explicit === undefined ? [first, ...rest] : rest).filter(Boolean).join(" ") || undefined;
      const entryId =
        explicit ?? app.model.state.entries.filter((e) => e.kind === "pi.assistant").at(-1)?.id;
      if (entryId === undefined) return app.flash("Nothing to fork yet.", true), true;
      await app.run(async () => {
        const created = await handle!.fork({ entryId, name });
        await app.attach(app.sessionId!, created.id);
        app.flash(`Forked at #${entryId} → ${created.name}`);
      });
      break;
    }
    case "thinking": {
      if (!THINKING_LEVELS.includes(arg as ThinkingLevel))
        return app.flash(`Levels: ${THINKING_LEVELS.join(", ")}`, true), true;
      await app.run(async () => {
        await handle!.configure({ thinkingLevel: arg as ThinkingLevel });
      });
      break;
    }
    case "compact":
      await app.run(async () => {
        await handle!.compact(arg || undefined);
        app.flash("Compaction requested");
      });
      break;
    case "reset":
      await app.run(async () => {
        await handle!.reset(arg || undefined);
        app.flash("New context started; history stays stored");
      });
      break;
    case "name":
      if (!arg) return app.flash("Usage: /name <name>", true), true;
      await app.run(async () => {
        await handle!.rename(arg);
        app.flash(`Agent renamed to ${arg}`);
      });
      break;
    case "git":
      await gitCommand(app, arg);
      break;
    case "pair":
      await runPairing(app, parsePairArgs(arg));
      break;
    case "tasks":
      app.overlay(
        new Panel(() => {
          const tasks = app.session.state.tasks;
          const lines = [c.bold(c.accent(`Live tasks in ${app.sessionSummary()?.name ?? "session"}`)), ""];
          if (!tasks.length) lines.push(c.muted("No live tasks."));
          for (const t of tasks)
            lines.push(
              `${t.background ? c.secondary("◌ bg") : c.warn("● fg")} #${t.id} ${t.kind} ${c.muted(`agent #${t.conversationId} │ ${t.state.status}${t.state.phase ? `/${t.state.phase}` : ""}`)}`,
            );
          lines.push("", c.muted("esc close"));
          return lines;
        }, () => app.closeOverlay()),
      );
      break;
    case "help":
      app.overlay(
        new Panel(
          () => [
            c.bold(c.accent("dpi-tui")),
            c.muted(`${app.device.id} │ ${app.device.url}`),
            "",
            ...KEYS.map(([k, d]) => `${c.secondary(k.padEnd(11))} ${d}`),
            "",
            ...COMMANDS.map((x) => `${c.secondary(`/${x.name}`.padEnd(11))} ${x.description ?? ""}`),
            "",
            c.muted("Closing dpi-tui never stops the agent. esc to close."),
          ],
          () => app.closeOverlay(),
        ),
      );
      break;
    case "quit":
      app.exit();
      break;
  }
  return true;
}
