/**
 * `dpi gc` — retention for archived sessions (checklist Wave 2, policy gate #3).
 *
 * Deliberately dry-run by default: the *policy* (how long to keep work) is the
 * operator's call, not ours, so nothing is ever deleted without `--yes`.
 * Mirrors piggery's `gc --closed-before DURATION [--dry-run]`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { gcApply, gcPlan, humanBytes, parseDuration, removedSessionIds } from "./gc.js";
import { expand, readEnvFile } from "./doctor.js";
import { lockFile, DeviceAlreadyRunningError } from "./store.js";
import { ScheduleRegistry } from "./schedules.js";
import { GraphRegistry } from "./graphs.js";

export interface GcArgs {
  argv: readonly string[];
}

export interface GcIo {
  print: (line: string) => void;
  printErr: (line: string) => void;
  env: Record<string, string | undefined>;
  readFile: (path: string) => string;
  homedir: () => string;
  now: () => number;
  /** R13 P3-1: the pending-sweep marker's writer — optional so test fakes can
   *  omit it (a missing writer just means the retry hint degrades to the
   *  message, never a crash). */
  writeFile?: (path: string, data: string) => void;
  remove?: (path: string) => void;
}

export const defaultGcIo = (): GcIo => ({
  print: (line) => process.stdout.write(`${line}\n`),
  printErr: (line) => process.stderr.write(`${line}\n`),
  env: process.env as Record<string, string | undefined>,
  readFile: (path) => readFileSync(path, "utf8"),
  homedir,
  now: () => Date.now(),
});

const HELP = `dpi gc — retention for archived sessions

  dpi gc --closed-before 30d [--dry-run | --yes] [--home <dir>] [--data-dir <dir>]
  dpi gc --sweep [--home <dir>] [--data-dir <dir>]

  --closed-before D   age cutoff: 90m, 12h, 30d, 2w
  --dry-run           show what would be deleted (the default)
  --yes               actually delete it
  --sweep             retry a pending dangling-ref sweep (after a delete whose
                      sweep failed — deletes nothing by itself)
  --home <dir>        device home (default: $DPI_HOME, else ~/.dpi)
  --data-dir <dir>    device data dir (default: <home>/backend)

Nothing is deleted without --yes: the retention policy is the operator's call.`;

/** Device data dir, resolved the same way the daemon does (`config.ts`). */
export function resolveDataDir(argv: readonly string[], io: GcIo): string {
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const envFile = io.env.DPI_ENV_FILE;
  let fileEnv: Record<string, string> = {};
  if (envFile) {
    // R6 cli finding 2: a missing/unreadable env file used to escape as a raw
    // ENOENT/EACCES stack from deep inside resolution — say it in one line.
    try {
      fileEnv = readEnvFile(io.readFile(envFile));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      const why =
        code === "ENOENT"
          ? "the file does not exist"
          : code === "EACCES"
            ? "the file is not readable"
            : e instanceof Error
              ? e.message
              : String(e);
      throw new Error(`cannot read DPI_ENV_FILE '${envFile}' — ${why}`);
    }
  }
  const value = (key: string) =>
    io.env[key] ?? (typeof fileEnv[key] === "string" ? fileEnv[key] : undefined);
  const dataDirArg = flag("--data-dir") ?? value("DPI_DATA_DIR");
  if (dataDirArg) return expand(dataDirArg, io.homedir());
  const home = flag("--home") ?? value("DPI_HOME") ?? join(io.homedir(), ".dpi");
  return join(expand(home, io.homedir()), "backend");
}

export async function gcCli(args: GcArgs, io: GcIo = defaultGcIo()): Promise<number> {
  const argv = args.argv;
  if (argv.includes("--help") || argv.includes("-h")) {
    io.print(HELP);
    return 0;
  }
  const known = new Set(["--closed-before", "--dry-run", "--yes", "--sweep", "--home", "--data-dir"]);
  for (const arg of argv) {
    if (arg.startsWith("-") && !known.has(arg)) {
      io.printErr(`dpi gc: unknown flag '${arg}'\n\n${HELP}`);
      return 2;
    }
  }
  const at = argv.indexOf("--closed-before");
  // R13 P3-1: `--sweep` is a standalone retry of a pending ref sweep — it
  // needs no cutoff (it deletes nothing; it only clears refs left behind by
  // an earlier delete-ok/sweep-fail pass).
  if (argv.includes("--sweep")) {
    let dataDir0: string;
    try {
      dataDir0 = resolveDataDir(argv, io);
    } catch (e) {
      io.printErr(`dpi gc: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    const pending0 = readPendingIds(io, pendingSweepPath(dataDir0));
    if (!pending0.length) {
      io.print("no pending ref sweep.");
      return 0;
    }
    try {
      await sweepRefs(dataDir0, pending0, io, deviceToken(io));
      io.remove?.(pendingSweepPath(dataDir0));
      io.print(`swept ${pending0.length} pending ref id(s); marker cleared.`);
      return 0;
    } catch (e) {
      io.printErr(
        `dpi gc: pending sweep failed: ${e instanceof Error ? e.message : String(e)} (marker kept — retry with --sweep)`,
      );
      return 1;
    }
  }
  if (at < 0 || !argv[at + 1]) {
    io.printErr(`dpi gc: --closed-before DURATION is required (e.g. 30d)\n\n${HELP}`);
    return 2;
  }
  let days: number;
  try {
    days = parseDuration(argv[at + 1]);
  } catch (e) {
    io.printErr(`dpi gc: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const apply = argv.includes("--yes");
  // R6 cli finding 2: resolveDataDir touches the env file — keep its failures
  // in the one-line pretty-error regime (exit 1), like the plan/apply calls.
  let archiveDir: string;
  try {
    archiveDir = join(resolveDataDir(argv, io), "archive");
  } catch (e) {
    io.printErr(`dpi gc: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const options = { closedBeforeDays: days, now: io.now() };
  const dataDir = dataDirOf(archiveDir);
  const pendingFile = pendingSweepPath(dataDir);
  const pending = readPendingIds(io, pendingFile);

  // The plan/apply calls live inside the pretty-error path (R5 finding 6): a bad
  // cutoff or unreadable archive used to escape as a raw stack trace.
  try {
    if (!apply) {
      const plan = await gcPlan(archiveDir, options);
      io.print(`archive ${archiveDir}`);
      io.print(`keep last ${argv[at + 1]} — ${plan.total.count} archived session(s), ${humanBytes(plan.total.bytes)}`);
      if (!plan.candidates.length) {
        io.print("nothing to delete.");
      } else {
        io.print(`would delete ${plan.candidates.length} session(s), ${humanBytes(plan.candidateBytes)}:`);
        for (const candidate of plan.candidates.slice(0, 20))
          io.print(`  ${candidate.sessionId.slice(0, 8)}  ${candidate.ageDays}d old  ${humanBytes(candidate.bytes)}`);
        if (plan.candidates.length > 20) io.print(`  … and ${plan.candidates.length - 20} more`);
        io.print("re-run with --yes to delete.");
      }
      for (const skip of plan.skipped) io.printErr(`skipped ${skip.name}: ${skip.reason}`);
      if (plan.danglingRefs.schedules > 0 || plan.danglingRefs.graphRuns > 0) {
        io.print(
          `sweep would clear ${plan.danglingRefs.schedules} schedule ref(s) and ${plan.danglingRefs.graphRuns} graph-run ref(s) pointing at the deletions.`,
        );
      }
      if (pending.length > 0)
        io.print(
          `${pending.length} pending ref id(s) from an earlier failed sweep — re-run with --yes (or --sweep) to retry.`,
        );
      return 0;
    }

    const { removed, bytes } = await gcApply(archiveDir, options);
    io.print(`deleted ${removed.length} archived session(s), ${humanBytes(bytes)} freed.`);

    // R10 Design B: sweep refs pointing at what we just removed — MERGED with
    // any ids a previous failed sweep left behind (R13 P3-1: the retry used to
    // be a dead end — a re-run with nothing to delete never swept again, so
    // refs stayed dangling forever while the operator read success).
    // Daemon-first (registry mutations happen in-process, no file race);
    // offline falls back to the same advisory lock Store.open takes.
    const ids = [...new Set([...pending, ...removedSessionIds(removed)])];
    if (ids.length > 0) {
      try {
        await sweepRefs(dataDir, ids, io, deviceToken(io));
        if (pending.length > 0) {
          io.remove?.(pendingFile);
          io.print(`(included ${pending.length} pending ref id(s) from an earlier failed sweep — marker cleared.)`);
        }
      } catch (e) {
        writePendingIds(io, pendingFile, ids);
        io.printErr(
          `dpi gc: deleted ${ids.length} session(s) but the ref sweep failed: ${
            e instanceof Error ? e.message : String(e)
          } (ids kept for retry: dpi gc --sweep — the sweep is idempotent)`,
        );
        // R12 P2-3: cron/scripts gate on the exit code — a failed sweep after
        // a real delete must not read as success.
        return 1;
      }
    }
    return 0;
  } catch (e) {
    io.printErr(`dpi gc: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

const dataDirOf = (archiveDir: string) => archiveDir.slice(0, archiveDir.length - "/archive".length);

/** R13 P3-1: the pending-sweep marker — ids a delete-ok/sweep-fail pass left
 *  behind. Session UUIDs only (not secret); written best-effort, read
 *  tolerantly, cleared on the first successful sweep. */
const pendingSweepPath = (dataDir: string) => join(dataDir, "gc-pending-sweep.json");

const readPendingIds = (io: GcIo, path: string): string[] => {
  try {
    const doc = JSON.parse(io.readFile(path)) as { ids?: unknown };
    return Array.isArray(doc.ids)
      ? [...new Set(doc.ids.filter((id): id is string => typeof id === "string" && id.length > 0))]
      : [];
  } catch {
    return []; // absent/corrupt — nothing pending
  }
};

const writePendingIds = (io: GcIo, path: string, ids: string[]): void => {
  try {
    io.writeFile?.(path, `${JSON.stringify({ ids }, null, 2)}\n`);
  } catch {
    /* best-effort — the printed remedy still names --sweep */
  }
};

/** The device token, from the process env or the env file (DPI_ENV_FILE) —
 *  only needed for the daemon-first sweep route. */
function deviceToken(io: GcIo): string | undefined {
  if (io.env.DPI_TOKEN) return io.env.DPI_TOKEN;
  const envFile = io.env.DPI_ENV_FILE;
  if (!envFile) return undefined;
  try {
    return readEnvFile(io.readFile(envFile)).DPI_TOKEN;
  } catch {
    return undefined; // unreadable env file already failed loudly in resolveDataDir
  }
}

/** Daemon-first dangling-ref sweep: POST /v1/gc/sweep-refs when the device
 *  answers locally, else the offline lock-guarded registry sweep. Reports what
 *  was cleared either way. Throws on failure (the caller prints and exits
 *  non-zero — the DELETE already happened; the sweep is idempotent, retryable). */
async function sweepRefs(dataDir: string, ids: string[], io: GcIo, token?: string): Promise<void> {
  const port = Number(io.env.DPI_PORT ?? "4780");
  if (token && Number.isInteger(port)) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/gc/sweep-refs`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-dpi-token": token },
        body: JSON.stringify({ sessionIds: ids }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const cleared = (await res.json()) as { schedules: number; graphRuns: number };
        if (cleared.schedules || cleared.graphRuns)
          io.print(`swept ${cleared.schedules} schedule ref(s), ${cleared.graphRuns} graph-run ref(s).`);
        return;
      }
      // R12 P3-6: name the two skew shapes an operator can actually hit —
      // anything else is a real fault; falling through to the offline path
      // would race the daemon, so surface it instead.
      if (res.status === 404)
        throw new Error(
          "device predates the sweep route — upgrade it (npm i -g my-durable) and re-run dpi gc " +
            "(or DPI_PORT points at another local service — check it)",
        );
      if (res.status === 401)
        throw new Error("device refused the sweep token — stale DPI_TOKEN in the env file; refresh it and re-run dpi gc");
      throw new Error(`device answered ${res.status} to the sweep route`);
    } catch (e) {
      if (e instanceof TypeError || (e instanceof Error && /fetch|network|ECONN/i.test(e.message))) {
        /* device not reachable locally — offline path below */
      } else throw e;
    }
  }
  // Offline: the same advisory lock Store.open takes, so a live (but
  // unreachable) daemon refuses instead of racing us on the registry files.
  const unlock = lockFile(join(dataDir, "app-state.sqlite.lock"));
  try {
    const schedules = await ScheduleRegistry.open(join(dataDir, "schedules.json"));
    const graphs = await GraphRegistry.open(join(dataDir, "graphs.json"));
    const s = await schedules.clearSessionRefs(new Set(ids));
    const g = await graphs.clearSessionRefs(new Set(ids));
    if (s || g) io.print(`swept ${s} schedule ref(s), ${g} graph-run ref(s).`);
  } catch (e) {
    if (e instanceof DeviceAlreadyRunningError)
      throw new Error("device is running — retry via the API route (dpi gc after the device answers, or restart it)");
    throw e;
  } finally {
    unlock();
  }
}
