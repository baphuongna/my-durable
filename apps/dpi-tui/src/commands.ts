// Slash commands. Anything that is not a known command goes to the agent as text, as in pi.
import type { SlashCommand } from "@earendil-works/pi-tui";
import { THINKING_LEVELS, type ThinkingLevel } from "../../dpi-sdk/src/api.ts";
import type { App } from "./app.ts";
import { sanitizeTerminal, oneLine } from "./sanitize.ts";
export { oneLine };
import { Panel, pickAgent, pickArchived, pickDevice, pickEnv, pickGraphs, pickModel, pickNotify, pickSession, pickSchedules, pickThinking } from "./pickers.ts";
import { parsePairArgs, runPairing } from "./pairing.ts";
import { gitStateSuffix } from "./views.ts";
import { c } from "./theme.ts";
import { basename, dirname, isAbsolute, join } from "node:path";
import { access, writeFile } from "node:fs/promises";

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
  { name: "find", description: "search every session's transcript on this device", argumentHint: "<text>" },
  // run-13 wave 2 — session take-out. :export writes the device's zip bundle
  // to a local path; :archive walks the archived sessions (transcript /
  // restore). No delete door: the SDK exposes no endpoint for it.
  { name: "export", description: "save a session bundle (zip) to a local path", argumentHint: "[sessionId]" },
  { name: "archive", description: "archived sessions: read a transcript, restore" },
  { name: "pair", description: "pair THIS device with a hub", argumentHint: "<CODE|PAIR_URL> [--hub ORIGIN] [--force]" },
  {
    name: "git",
    description: "git on the session's folder: status, diff, log, pull, fetch, branch, switch, commit, worktree, merge-abort",
    argumentHint: "[status|diff|log|fetch|pull|branch|switch <b>|commit <msg>|worktree [new <b>|remove <path>]|merge-abort]",
    getArgumentCompletions: (prefix) =>
      ["status", "diff", "log", "fetch", "pull", "branch", "switch", "commit", "worktree", "merge-abort"]
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({ value: s, label: s })),
  },
  // run-12 device-ops doors. None takes an argument — each opens a picker
  // (or, for :usage/:vitals, dumps straight to the toast + log view), so there
  // are no subcommands to complete; the row hotkeys live in the pickers.
  { name: "schedules", description: "scheduled sessions: run now, toggle, delete, create" },
  { name: "env", description: "the device's env file: view, edit, set, remove" },
  { name: "notify", description: "notify sinks: list them and fire a test event" },
  { name: "usage", description: "token/cost rollup — toast + log view" },
  { name: "vitals", description: "device health: uptime, memory, disk, lag, git spawns" },
  // run-14: the last uncovered SDK surface — task-graphs. Read/run/remove
  // only; DAG authoring is the web FE's job, so there is no create door and
  // no argument to complete (the row hotkeys live in pickGraphs).
  { name: "graphs", description: "task-graphs: detail, run, remove (DAG editing lives in the web FE)" },
  { name: "help", description: "keys and commands" },
  { name: "quit", description: "exit (the agent keeps running)" },
];

const GIT_OPS = new Set(["diff", "log", "fetch", "pull", "branch", "switch", "commit", "worktree", "status", "wt", "merge-abort"]);

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
      // Merge/detached ride the toast (R5 finding 4): a mid-merge repo with
      // conflicts used to show a healthy branch line, same blind spot the
      // header chip had — the web's GitPanel has banner'd this state all along.
      app.notify(
        `⎇ ${s.branch ?? s.head} ±${dirty}${s.ahead ? ` ↑${s.ahead}` : ""}${s.behind ? ` ↓${s.behind}` : ""}${gitStateSuffix(s)}`,
      );
      app.logEvent("git", `${cwd} · ${s.branch ?? s.head}${s.merge ? " · MERGING" : s.detached ? " · detached" : ""}${s.upstream ? ` → ${s.upstream}` : ""} · +${s.staged ?? 0}/~${s.unstaged ?? 0}/?${s.untracked ?? 0}${s.worktreeOf ? ` · worktree of ${s.worktreeOf}` : ""}`);
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
    if (!GIT_OPS.has(op))
      return app.notify(`unknown git op "${op}" — status diff log fetch pull branch switch commit worktree merge-abort`);
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

// ---------------------------------------------- run-12: :usage and :vitals

/** Bytes → "8.0G" / "512M" / "42B" — one toast/log line, not a spreadsheet. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const units = ["K", "M", "G", "T"];
  let v = n;
  let i = -1;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return i < 0 ? `${n}B` : `${v >= 100 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}

/** Seconds → "2d3h" / "5h01m" / "12m" / "45s" (run-12 vitals rows). */
export function fmtDur(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d${h}h`;
  if (h) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

/** /vitals (run-12) — the :git status shape: headline toast, full report in
 * the log view. Read-only, so there is nothing to confirm anywhere here. */
async function vitalsCommand(app: App) {
  try {
    const v = await app.client.vitals();
    // r12 review m2: a device on a pre-0.0.117 build omits eventLoop/gitSpawns
    // — degrade to 0s instead of throwing the whole command away (the ops
    // view's renderer already defends the same way).
    const lag1m = Number(v.eventLoop?.lagMsMax1m) || 0;
    const lagLast = Number(v.eventLoop?.lagMsLast) || 0;
    const samples = Number(v.eventLoop?.samples) || 0;
    const gitLive = Number(v.gitSpawns?.live) || 0;
    const gitQ = Number(v.gitSpawns?.queued) || 0;
    const gitQh = Number(v.gitSpawns?.queuedHigh) || 0;
    app.notify(
      `up ${fmtDur(v.uptime)} · mem ${fmtBytes(v.memory.usedBytes)}/${fmtBytes(v.memory.totalBytes)} · disk ${fmtBytes(v.disk.freeBytes)} free · lag ${lag1m}ms (log view: L)`,
    );
    app.logEvent("vitals", `uptime ${fmtDur(v.uptime)} · process ${fmtDur(v.processUptime)} · pid ${v.pid} · ${v.cpuCount} cpu`);
    app.logEvent("vitals", `load ${v.loadavg.join(" / ")}`);
    app.logEvent(
      "vitals",
      `mem used ${fmtBytes(v.memory.usedBytes)} · free ${fmtBytes(v.memory.freeBytes)} · rss ${fmtBytes(v.memory.processRssBytes)} · heap ${fmtBytes(v.memory.heapUsedBytes)} of ${fmtBytes(v.memory.totalBytes)}`,
    );
    app.logEvent(
      "vitals",
      `disk ${oneLine(v.disk.path)} — ${fmtBytes(v.disk.freeBytes)} free of ${fmtBytes(v.disk.totalBytes)}${v.disk.known ? "" : " (size unknown)"}`,
    );
    app.logEvent("vitals", `event-loop lag ${lagLast}ms last · ${lag1m}ms max/1m · ${samples} samples`);
    app.logEvent("vitals", `git spawns ${gitLive} live · ${gitQ} queued · ${gitQh} queued-high`);
    if (v.counts) app.logEvent("vitals", `sessions ${v.counts.sessions} live · ${v.counts.archived} archived`);
  } catch (e) {
    app.notify(`vitals: ${(e as Error).message.slice(0, 80)}`, true);
  }
}

/** /usage (run-12) — same shape: tokens/cost headline, per-model/-session/
 * -project detail in the log view. Each list is top-sliced so one command
 * cannot flood the 500-entry log ring. */
async function usageCommand(app: App) {
  try {
    const u = await app.client.deviceUsage();
    const tok = (n: number) => n.toLocaleString("en-US");
    const usd = (n: number) => `$${n.toFixed(2)}`;
    app.notify(
      `usage: ${tok(u.totals.tokens)} tokens · ${usd(u.totals.cost)} · ${u.sessions.length} session${u.sessions.length === 1 ? "" : "s"} (log view: L)`,
    );
    app.logEvent(
      "usage",
      `device rollup · ${u.sessions.length} sessions · ${u.projects.length} projects · ${u.models.length} models`,
    );
    for (const m of u.models.slice(0, 12))
      app.logEvent(
        "usage",
        `  ${oneLine(m.key)} — ${tok(m.tokens)} tok · ${usd(m.cost)} (in ${tok(m.input)} · out ${tok(m.output)} · cache ${tok(m.cacheRead)})`,
      );
    for (const s of [...u.sessions].sort((a, b) => b.tokens - a.tokens).slice(0, 8))
      app.logEvent("usage", `  ${oneLine(s.name)} — ${tok(s.tokens)} tok · ${usd(s.cost)} · ${s.agents} agent${s.agents === 1 ? "" : "s"} · ${oneLine(s.cwd)}`);
    for (const p of u.projects.slice(0, 8))
      app.logEvent("usage", `  ${oneLine(p.name)} — ${tok(p.tokens)} tok · ${usd(p.cost)} · ${p.sessions} session${p.sessions === 1 ? "" : "s"} · ${oneLine(p.rootPath)}`);
  } catch (e) {
    app.notify(`usage: ${(e as Error).message.slice(0, 80)}`, true);
  }
}

// ---------------------------------------------- run-13: :export

/** run-13 A1: the export download name is DEVICE-AUTHORED (Content-Disposition
 * — SessionExport.filename), so before it seeds the save-path prompt it gets
 * the FE r16 fold: oneLine first (it is chrome AND a path segment — CR/LF
 * must go before the charset fold), then [^A-Za-z0-9._-] → "_", capped at 80.
 * The operator's TYPED path is trusted; only the seeded default passes here. */
export function sanitizeExportName(filename: string): string {
  return oneLine(String(filename ?? ""))
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 80);
}

/** /export (run-13 A1) — pull a session's zip bundle and write it to a local
 * path. Every failure mode (device refusal, bad path, disk full) lands in one
 * error toast: the command is operator-driven (prompts between awaits), so it
 * must never throw out of runCommand. */
async function exportCommand(app: App, sessionId: string) {
  let filename = "session.bundle.zip";
  let bytes: Uint8Array = new Uint8Array();
  try {
    const ex = await app.client.exportSession(sessionId);
    filename = sanitizeExportName(ex.filename) || filename;
    bytes = ex.bytes;
  } catch (e) {
    return app.notify(`export: ${(e as Error).message.slice(0, 80)}`, true);
  }
  const typed = await app.prompt("Save export as", `./${filename}`);
  if (typed === undefined || !typed.trim()) return app.flash("export cancelled"), true;
  const target = typed.trim();
  try {
    // The overwrite gate — the same y/n /reset asks (R4 finding 4): only the
    // operator's explicit y may clobber an existing file.
    const exists = await access(target).then(
      () => true,
      () => false,
    );
    if (exists) {
      const ok = await app.prompt(`Overwrite ${target}? y/n`, "");
      if (ok === undefined || !ok.trim().toLowerCase().startsWith("y"))
        return app.flash("export cancelled — kept the existing file"), true;
    }
    await writeFile(target, bytes);
    app.notify(`saved ${target} (${fmtBytes(bytes.length)})`);
    app.logEvent("export", `saved ${oneLine(target)} · ${fmtBytes(bytes.length)} · ${oneLine(filename)}`);
  } catch (e) {
    app.notify(`export: ${(e as Error).message.slice(0, 80)}`, true);
  }
}

const KEYS: [string, string][] = [
  ["enter", "send; steers the agent while it works"],
  ["alt+enter", "queue as a follow-up"],
  ["esc", "back — it never interrupts"],
  ["i", "interrupt the running turn"],
  ["shift+tab", "cycle thinking level"],
  ["ctrl+l", "model picker"],
  ["ctrl+o", "expand tool output and thinking"],
  ["ctrl+c", "clear input, or exit when empty"],
  ["ctrl+d", "exit"],
];

/** Returns false when `text` is not a command, so the caller sends it to the agent. */
/** R19 (run-5 h2): every field of a TranscriptSearchHit is relay-borne — the
 * numeric `entry` included. The compose site used to interpolate it raw, so a
 * hostile hub/device could ride an OSC/CSI payload in a string-typed `entry`
 * straight into the terminal (pi-tui writes Panel lines verbatim). One
 * chokepoint, one test.
 */
export function findHitLine(name: string, hit: { agent: string; entry: number; text: string }): string {
  return `  ${oneLine(name)}:${oneLine(hit.agent)} #${oneLine(String(hit.entry))} — ${oneLine(hit.text.slice(0, 140))}`;
}

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
        // The device API requires a name (B6); without an argument, number the new agent.
        const name = arg || `Agent ${app.session.state.agents.length + 1}`;
        const created = await app.client.session(app.sessionId!).createAgent({ name });
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
      // A bare /thinking (the palette door) opens the same picker the
      // new-session flow uses — it used to dead-end in a "Levels: …" flash
      // (R4 finding 2). A valid argument still sets directly.
      const apply = async (level: ThinkingLevel) => {
        if (!handle) return app.flash("Pick a session first (g, then ↵).", true);
        await app.run(async () => {
          await handle!.configure({ thinkingLevel: level });
          app.flash(`thinking: ${level}`);
        });
      };
      if (!THINKING_LEVELS.includes(arg as ThinkingLevel)) {
        const picked = await pickThinking(app, String(app.model.state.agent.thinkingLevel ?? "low"));
        if (!picked) break;
        await apply(picked);
        break;
      }
      await apply(arg as ThinkingLevel);
      break;
    }
    case "compact":
      await app.run(async () => {
        await handle!.compact(arg || undefined);
        app.flash("Compaction requested");
      });
      break;
    case "reset":
      // The x key confirms y/n before reset (app.ts) — the command door must
      // not skip that gate (R4 finding 4: the palette entry used to wipe the
      // context unconditionally). A typed handoff note carries its own intent.
      if (!arg) {
        // R20 cold-1 M4: same gate text as the x-key door — oneLine, not sanitize-only.
        const ok = await app.prompt(`Reset ${oneLine(app.sessionSummary()?.name ?? "context")}? y/n`, "");
        if (ok === undefined || !ok.trim().toLowerCase().startsWith("y"))
          return app.flash("reset cancelled"), true;
      }
      await app.resetContext(arg || undefined);
      break;
    case "name": {
      // A bare /name (the palette door) opens the rename Prompt instead of the
      // dead-end usage flash (R4 finding 2).
      let value = arg;
      if (!value) {
        const current = app.sessionSummary()?.agents.find((a) => a.id === app.agentId)?.name ?? "";
        // Agent names ride the wire from device/hub (model-choosable for forks
        // and subagents) and pi-tui's Input renders its value verbatim — seed
        // it sanitized (run-4 h4).
        const typed = await app.prompt("Agent name", current && current !== "main" ? oneLine(current) : ""); // R20 cold-2 minor: Input renders verbatim — one-line it
        value = (typed ?? "").trim();
        if (!value) return app.flash("rename cancelled"), true;
      }
      if (!handle) return app.flash("Pick a session first (g, then ↵).", true), true;
      await app.run(async () => {
        await handle!.rename(value);
        app.flash(`Agent renamed to ${value}`);
      });
      break;
    }
    case "git":
      await gitCommand(app, arg);
      break;
    // run-13 wave 2: session take-out — :export writes a bundle to disk,
    // :archive opens the archived-session picker (pickers.ts owns its rows).
    case "export": {
      // No argument → the session picker (attach-on-pick is that door's
      // documented behavior), then export the picked id. Esc and ＋New resolve
      // undefined — /export stays quiet rather than flashing "cancelled" over
      // a flow that tells its own story.
      let id = arg;
      if (!id) {
        const picked = await pickSession(app);
        if (picked === undefined) break;
        id = picked;
      }
      await exportCommand(app, id);
      break;
    }
    case "archive":
      await pickArchived(app);
      break;
    // run-12: the five device-ops doors — the pickers own their row hotkeys.
    case "schedules":
      await pickSchedules(app);
      break;
    case "env":
      await pickEnv(app);
      break;
    case "notify":
      await pickNotify(app);
      break;
    case "usage":
      await usageCommand(app);
      break;
    case "vitals":
      await vitalsCommand(app);
      break;
    // run-14: the graphs door — pickers.ts owns the picker + capped detail
    // dump; runGraph is fire-and-forget, remove sits behind a y/n gate.
    case "graphs":
      await pickGraphs(app);
      break;
    case "pair":
      await runPairing(app, parsePairArgs(arg));
      break;
    case "find": {
      // R18: transcript search across every session on the device. Transcript
      // text is untrusted — every interpolation below goes through
      // sanitizeTerminal before it reaches chrome (run-3 h5 discipline).
      if (!arg) return app.flash("usage: /find <text> — searches every session's transcript", true), true;
      await app.run(async () => {
        const result = await app.client.searchSessions(arg, "all");
        const shown = result.matches.slice(0, 12);
        app.overlay(
          new Panel(() => {
            const lines = [
              c.bold(c.accent(`"${sanitizeTerminal(arg)}" — ${sanitizeTerminal(String(result.matches.length))} session${result.matches.length === 1 ? "" : "s"}`)),
              "",
            ];
            if (!result.matches.length) lines.push(c.muted("No matches (names, folders, models or transcripts)."));
            for (const m of shown) {
              lines.push(
                // R20 h5: the match header is in the SAME panel as the fixed hit
              // lines — a \n in a session name split the row above the hits.
              `${c.secondary(oneLine(m.name))} ${c.muted(oneLine(m.cwd))}${m.where.includes("transcript") ? " " + c.warn("◍ transcript") : ""}`,
              );
              for (const hit of (m.hits ?? []).slice(0, 3))
                lines.push(c.muted(findHitLine(m.name, hit)));
            }
            if (result.matches.length > shown.length) lines.push(c.muted(`… ${sanitizeTerminal(String(result.matches.length - shown.length))} more`));
            if (result.scanned?.truncated)
              lines.push(c.muted(`scan budget reached (${sanitizeTerminal(String(result.scanned.entries))} entries) — refine the query`));
            lines.push("", c.muted("esc close"));
            return lines;
          }, () => app.closeOverlay()),
        );
      });
      break;
    }
    case "tasks":
      app.overlay(
        new Panel(() => {
          const tasks = app.session.state.tasks;
          const lines = [c.bold(c.accent(`Live tasks in ${oneLine(app.sessionSummary()?.name ?? "session")}`)), ""]; // R20 cold-2 minor
          if (!tasks.length) lines.push(c.muted("No live tasks."));
          for (const t of tasks)
            lines.push(
              // R19 cold-review MAJOR 4: task ids are wire-borne too — a hostile
              // relay can type them as strings carrying escape sequences (the
              // same class as the /find `entry` finding). Every scalar goes
              // through the chokepoint.
              // sanitizeTerminal keeps \n/\t, so a one-line row also collapses
              // whitespace — a wire id must not split the row it belongs to.
              `${t?.background === true ? c.secondary("◌ bg") : c.warn("● fg")} #${oneLine(String(t?.id ?? "?"))} ${oneLine(String(t?.kind ?? "?"))} ${c.muted(`agent #${oneLine(String(t?.conversationId ?? "?"))} │ ${oneLine(String(t.state?.status ?? ""))}${t.state?.phase ? `/${oneLine(String(t.state.phase))}` : ""}`)}`,
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
            c.muted(`${oneLine(app.device.id)} │ ${oneLine(app.device.url)}`), // R20 cold-1 M4
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
