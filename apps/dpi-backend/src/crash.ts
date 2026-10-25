/**
 * Local-only crash reports for the device daemon — Gate #1 of the crash
 * policy. The daemon runs detached, so when it dies on an uncaught exception
 * journald holds nothing useful and the operator is left guessing. This module
 * writes one short markdown file per crash into the device home
 * (`<home>/backend/crashes/`): fixed headings, one fact per line, readable by
 * both a human and an independent agent, ~25 lines.
 *
 * NOTHING is ever uploaded anywhere. There is no telemetry and no opt-in or
 * opt-out question to answer — we cannot leak what we never send. What the
 * file deliberately does NOT contain is written down in the report itself
 * ("## not included"): no environment values, tokens, credentials, file
 * contents, or transcripts. Every line still passes `redactLine` before it
 * reaches disk, so a secret embedded in an error message is masked even
 * though it was never supposed to be there.
 *
 * The writer is synchronous on purpose: `uncaughtException` fires when the
 * process is already dying, and an async write may never flush — a crash
 * report that races the exit is not a crash report. The write is still atomic
 * (tmp file + rename, the backup.ts discipline); a `.bak` makes no sense here
 * because every crash creates its own NEW file and rotation deletes the
 * oldest silently, keeping the newest 10. Dirs are 0700, files 0600.
 *
 * `installCrashHandlers` registers the two process-level hooks.
 * uncaughtException writes the report, notes the path on stderr (the one line
 * journald keeps), and exits 1 on `setImmediate` so pending IO can flush.
 * unhandledRejection writes the report but does NOT exit — Node's default is
 * to keep running, and that default is preserved. Both handlers are wrapped
 * so the handler itself can never throw: a crashing crash handler would only
 * lose the report.
 */
import { chmodSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The 0700/0600 rule every private file in the device home follows (backup.ts / diagnostics.ts). */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
/** Rotation: the newest reports kept on disk; older ones are deleted silently. */
export const MAX_CRASH_REPORTS = 10;
/** Longest the one-line error message may be after redaction — a crash report is short by design. */
const MESSAGE_MAX = 600;
/** Stack frames kept — enough to see where, not enough to pad the file. */
const STACK_FRAMES = 5;
/** `crash-20261025-074812-010.md` — UTC so the name sorts and round-trips through `listCrashReports`. */
const CRASH_NAME_RE = /^crash-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})\.md$/;

/** Live counts the leader wires in later; every field optional because a broken device still gets a report. */
export interface CrashStateSnapshot {
  openSessions?: number;
  totalSessions?: number;
  schedules?: number;
  graphs?: number;
  runsInFlight?: string[];
  notifySinks?: number;
}

export interface CrashHandlerDeps {
  /** Device home dir; reports land in `<home>/backend/crashes/`. */
  home: string;
  /** packageVersion, e.g. "0.0.46". */
  version: string;
  /** Leader wires the real counts in later; wrapped in try so it can never take the report down. */
  state?: () => CrashStateSnapshot;
  /** Injectable clock — tests pin it instead of sleeping. */
  now?: () => Date;
  /** `Date.now()` of daemon start; present → the uptime line, absent → no line at all. */
  startedAt?: number;
}

/** One report as `listCrashReports` hands it to a caller. */
export interface CrashReportEntry {
  file: string;
  whenMs: number;
  ageLabel: string;
}

// ----------------------------------------------------------------- redaction

/**
 * Mask secret-shaped values in one line, mirroring the hub audit's
 * `scrubSecrets` (a different package — the shapes are mirrored, not shared):
 * prefixed tokens keep their prefix, `name=value` keeps the name, a PEM block
 * collapses to a single marker. NEVER the words themselves, only the values.
 */
export function redactLine(line: string): string {
  return (
    line
      // Bearer headers first: the token after them is 8+ chars of credential.
      .replace(/(bearer\s+)([A-Za-z0-9._-]{8,})/gi, "$1<redacted>")
      // Prefixed tokens (OpenAI sk-, dpt_/dpi_/adm_ device tokens, GitHub, Slack) — word-bounded so
      // "risk-management" is a word, not a secret.
      .replace(/\b(sk-|dpt_|dpi_|adm_|ghp_|gho_|xox)[A-Za-z0-9_-]{8,}/g, "$1<redacted>")
      // A value LABELLED a credential is a credential: keep the name, drop the value. No \b — it
      // would fail after the "_" in DPI_TOKEN (a word char), exactly the shape real env leaks take.
      .replace(
        /(token|secret|password|passwd|api[_-]?key)(\s*[:=]\s*)\S+/gi,
        "$1$2<redacted>",
      )
      // PEM blocks: BEGIN to END, or to the end of the line when the block is truncated.
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "<private-key-redacted>")
  );
}

// ------------------------------------------------------------------ helpers

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

/** `crash-<YYYYMMDD-HHMMSS-mmm>.md`, UTC — fixed-width so lexicographic order is time order. */
export function crashFileName(now: Date): string {
  return `crash-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(
    now.getUTCHours(),
  )}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}-${pad(now.getUTCMilliseconds(), 3)}.md`;
}

/** The timestamp encoded in a report filename, or null when the name is not ours. */
function crashWhenMs(name: string): number | null {
  const match = CRASH_NAME_RE.exec(name);
  if (!match) return null;
  const whenMs = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number(match[7]),
  );
  return Number.isFinite(whenMs) ? whenMs : null;
}

/** `3h 12m`-style uptime; anything not a sane duration reads `unknown`, never NaN. */
function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms < 60_000) return "<1m";
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 24) return `${hours}h ${totalMinutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** `just now` / `5m ago` / `2h ago` / `3d ago` — the label a human reads at a glance. */
export function ageLabel(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 60_000) return "just now";
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
  return `${Math.floor(ageMs / 86_400_000)}d ago`;
}

/** A number for a fact line: finite numbers as-is, everything else `unknown` — never NaN/undefined. */
const factNumber = (value: number | undefined): string =>
  typeof value === "number" && Number.isFinite(value) ? String(value) : "unknown";

/** Run ids for the fact line: present ids comma-joined, an empty list is `none`, absent is `unknown`. */
const factRuns = (runs: string[] | undefined): string => {
  if (runs === undefined) return "unknown";
  return runs.length ? runs.join(", ") : "none";
};

/** The state snapshot, or `{}` — a state callback that throws loses its line, not the report. */
function readSnapshot(deps: CrashHandlerDeps): CrashStateSnapshot {
  try {
    return deps.state?.() ?? {};
  } catch {
    return {};
  }
}

/** The one-line error label: the error's own name for Errors, `Error:` for anything else. */
function errorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "Error";
}

/** The error message flattened to one line, redacted, then capped — cap AFTER redaction so a cut cannot split a secret back open. */
function errorLine(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\r?\n/g, " ").trim();
  return redactLine(`${errorName(error)}: ${message}`).slice(0, MESSAGE_MAX);
}

/** Top 5 `at …` frames, indented as a code block; no stack → the one line `no stack captured`. */
function stackLines(error: unknown): string[] {
  const frames =
    (error instanceof Error && typeof error.stack === "string" ? error.stack : "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("at "))
      .slice(0, STACK_FRAMES)
      .map((line) => redactLine(`    ${line}`));
  return frames.length ? frames : ["    no stack captured"];
}

/**
 * The report body — every line redacted at the end, so the fixed boilerplate
 * (which contains no secrets) and the variable facts take the same path.
 */
export function buildCrashReport(deps: CrashHandlerDeps, reason: string, error: unknown, now: Date): string {
  const snapshot = readSnapshot(deps);
  const lines: string[] = [
    "# my-durable crash report",
    "",
    `- when: ${now.toISOString()}`,
    `- version: ${deps.version} (node v${process.versions.node}, ${process.platform})`,
    `- reason: ${reason}`,
  ];
  if (deps.startedAt !== undefined) lines.push(`- uptime: ${formatUptime(now.getTime() - deps.startedAt)}`);
  lines.push(
    "",
    "## error",
    "",
    errorLine(error),
    "",
    ...stackLines(error),
    "",
    "## state at crash",
    "",
    `- sessions: ${factNumber(snapshot.openSessions)} open / ${factNumber(snapshot.totalSessions)} total`,
    `- schedules: ${factNumber(snapshot.schedules)}, graphs: ${factNumber(snapshot.graphs)}, runs in flight: ${factRuns(
      snapshot.runsInFlight,
    )}`,
    `- notify sinks: ${factNumber(snapshot.notifySinks)}`,
    "",
    "## not included",
    "",
    "No environment values, tokens, credentials, file contents, or transcripts",
    "are ever written to this file.",
    "",
    "## what to do",
    "",
    "1. Restart the device: dpi device start   (with your DPI_HOME / DPI_ENV_FILE)",
    "2. If it repeats, attach this file to an issue: https://github.com/baphuongnb/my-durable",
  );
  return `${lines.map(redactLine).join("\n")}\n`;
}

/** Delete everything but the newest `MAX_CRASH_REPORTS` reports; a prune that fails is silent. */
function pruneCrashReports(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => CRASH_NAME_RE.test(name));
  } catch {
    return;
  }
  names.sort(); // fixed-width UTC names: lexicographic order is oldest → newest
  for (const name of names.slice(0, Math.max(0, names.length - MAX_CRASH_REPORTS))) {
    try {
      unlinkSync(join(dir, name));
    } catch {
      // already gone or unremovable — rotation is best effort
    }
  }
}

/**
 * Write one crash report to `<home>/backend/crashes/` and return its path, or
 * null on any IO failure — this function never throws, because its callers
 * are crash handlers with nowhere left to throw to.
 */
export function writeCrashReport(deps: CrashHandlerDeps, reason: string, error: unknown): string | null {
  try {
    const dir = join(deps.home, "backend", "crashes");
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    const now = deps.now?.() ?? new Date();
    const path = join(dir, crashFileName(now));
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, buildCrashReport(deps, reason, error, now), { mode: FILE_MODE });
    renameSync(tmp, path);
    chmodSync(path, FILE_MODE);
    pruneCrashReports(dir);
    return path;
  } catch {
    return null;
  }
}

/**
 * The newest crash reports, newest first. The timestamp comes from the FILENAME
 * only — bodies are never parsed or read, so listing stays cheap and safe.
 * Absent dir, unreadable dir, foreign filenames: an empty list, never a throw.
 */
export function listCrashReports(home: string, limit = 5): CrashReportEntry[] {
  let names: string[];
  try {
    names = readdirSync(join(home, "backend", "crashes"));
  } catch {
    return [];
  }
  const entries: { name: string; whenMs: number }[] = [];
  for (const name of names) {
    const whenMs = crashWhenMs(name);
    if (whenMs !== null) entries.push({ name, whenMs });
  }
  entries.sort((a, b) => b.whenMs - a.whenMs);
  const nowMs = Date.now();
  const dir = join(home, "backend", "crashes");
  return entries.slice(0, limit).map((entry) => ({
    file: join(dir, entry.name),
    whenMs: entry.whenMs,
    ageLabel: ageLabel(nowMs - entry.whenMs),
  }));
}

/**
 * Register the process-level crash hooks. uncaughtException: write the report,
 * say where on stderr (the one line journald keeps for a detached daemon),
 * then exit 1 on `setImmediate` so pending IO flushes — the exit happens even
 * when the report failed, because the process is already dying. unhandledRejection:
 * write the report and keep running, exactly Node's default. Returns a dispose
 * fn that removes both listeners (tests use it; nothing else should).
 */
export function installCrashHandlers(deps: CrashHandlerDeps): () => void {
  const onUncaughtException = (error: Error): void => {
    let path: string | null = null;
    try {
      path = writeCrashReport(deps, "uncaughtException", error);
    } catch {
      // the handler itself never throws; writeCrashReport already returns null on failure
    }
    try {
      process.stderr.write(`my-durable: uncaught exception — crash report ${path ?? "FAILED to write"}; exiting (code 1)\n`);
    } catch {
      // stderr gone: nothing to say
    }
    setImmediate(() => process.exit(1));
  };
  const onUnhandledRejection = (reason: unknown): void => {
    try {
      writeCrashReport(deps, "unhandledRejection", reason);
    } catch {
      // report lost; the process keeps running by design
    }
  };
  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);
  return () => {
    process.off("uncaughtException", onUncaughtException);
    process.off("unhandledRejection", onUnhandledRejection);
  };
}
