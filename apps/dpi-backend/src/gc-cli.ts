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
import { gcApply, gcPlan, humanBytes, parseDuration } from "./gc.js";
import { expand, readEnvFile } from "./doctor.js";

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

  --closed-before D   age cutoff: 90m, 12h, 30d, 2w
  --dry-run           show what would be deleted (the default)
  --yes               actually delete it
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
  const fileEnv = envFile ? readEnvFile(io.readFile(envFile)) : {};
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
  const known = new Set(["--closed-before", "--dry-run", "--yes", "--home", "--data-dir"]);
  for (const arg of argv) {
    if (arg.startsWith("-") && !known.has(arg)) {
      io.printErr(`dpi gc: unknown flag '${arg}'\n\n${HELP}`);
      return 2;
    }
  }
  const at = argv.indexOf("--closed-before");
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
  const archiveDir = join(resolveDataDir(argv, io), "archive");
  const options = { closedBeforeDays: days, now: io.now() };

  if (!apply) {
    const plan = await gcPlan(archiveDir, options);
    io.print(`archive ${archiveDir}`);
    io.print(`keep last ${days}d — ${plan.total.count} archived session(s), ${humanBytes(plan.total.bytes)}`);
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
    return 0;
  }

  const { removed, bytes } = await gcApply(archiveDir, options);
  io.print(`deleted ${removed.length} archived session(s), ${humanBytes(bytes)} freed.`);
  return 0;
}
