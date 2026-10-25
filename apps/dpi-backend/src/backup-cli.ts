/**
 * `dpi backup` — device-home backup/restore, "Backup/restore of session data"
 * (SHOULD) in Wave 2 of docs/host-project-checklist.md.
 *
 * Piggery's rule, borrowed from `dpi gc`: a destructive op asks once. `restore`
 * prints the plan (file count, target home, where the old home goes) and exits
 * 0 without touching anything unless `--yes` is passed — and it refuses to run
 * at all, plan included, while the device daemon answers on its port (the same
 * DPI_HOST/DPI_PORT rule `dpi doctor` uses; healthz needs no auth).
 *
 * The CLI io extends the module's `BackupIo` with print/printErr/env/homedir,
 * so one object is faked in tests. Exit codes: 0 ok, 1 backup error, 2 usage
 * error; nothing is ever thrown out of `backupCli`. `argv` is what follows the
 * `backup` word (`backupCli({ argv: ["create", "--home", dir] })`).
 */
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  createBackup,
  defaultBackupIo,
  deviceIsRunning,
  listBackups,
  readBackupEntries,
  restoreBackup,
  type BackupIo,
} from "./backup.js";
import { expand, readEnvFile } from "./doctor.js";
import { humanBytes } from "./gc.js";

export interface BackupCliArgs {
  argv: readonly string[];
}

/** The CLI adds output, env and home to the module's io — one object, so a test fakes exactly what it needs. */
export interface BackupCliIo extends BackupIo {
  print: (line: string) => void;
  printErr: (line: string) => void;
  env: Record<string, string | undefined>;
  homedir: () => string;
}

export const defaultBackupCliIo = (): BackupCliIo => ({
  ...defaultBackupIo(),
  print: (line) => process.stdout.write(`${line}\n`),
  printErr: (line) => process.stderr.write(`${line}\n`),
  env: process.env as Record<string, string | undefined>,
  homedir,
});

const HELP = `dpi backup — device home backup/restore (checklist Wave 2)

  dpi backup create [--out FILE] [--home DIR]
  dpi backup list [--home DIR] [--dir DIR]
  dpi backup restore FILE [--home DIR] [--yes]

  create    zip the whole device home (registries, backend/catalog.sqlite,
            sessions, logs) into one 0600 file; nothing is deleted and nothing
            leaves the machine
  list      the backups in the default dir (or --dir DIR), newest first
  restore   unpack a backup into the home dir; the current home is renamed to
            <home>.bak-<timestamp>, never deleted

  --home DIR   device home (default: $DPI_HOME, else ~/.dpi)
  --out FILE   where create writes (default: <home>-backups/dpi-backup-<YYYYMMDD-HHMMSS>.zip,
               a sibling of home, so a backup never sits inside what it backs up)
  --dir DIR    where list looks (default: the create dir for that home)
  --yes        actually restore — without it, restore only prints the plan

Restore refuses to run while the device daemon answers on its port (DPI_HOST /
DPI_PORT, default 127.0.0.1:4780) — stop it first with \`dpi device stop\`.
Exit codes: 0 ok, 1 backup error, 2 usage error.`;

const flagValue = (argv: readonly string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
};

/** env wins over the env file, like doctor.ts's `deviceEndpoint`. */
async function envValues(io: BackupCliIo): Promise<(key: string) => string | undefined> {
  const envFile = io.env.DPI_ENV_FILE;
  let fileEnv: Record<string, string> = {};
  if (envFile) {
    try {
      fileEnv = readEnvFile(Buffer.from(await io.readFile(resolve(expand(envFile, io.homedir())))).toString("utf8"));
    } catch {
      /* unreadable env file: fall back to process env, like doctor.ts */
    }
  }
  return (key) => io.env[key] ?? (typeof fileEnv[key] === "string" ? fileEnv[key] : undefined);
}

/** `--home` wins, then $DPI_HOME (env file included), then ~/.dpi — the gc-cli rule. */
async function resolveHome(argv: readonly string[], io: BackupCliIo): Promise<string> {
  const value = await envValues(io);
  const home = flagValue(argv, "--home") ?? value("DPI_HOME") ?? join(io.homedir(), ".dpi");
  return resolve(expand(home, io.homedir()));
}

/** The daemon's healthz, built the way doctor.ts builds its endpoint (0.0.0.0 probed over loopback). */
async function healthzUrl(io: BackupCliIo): Promise<string> {
  const value = await envValues(io);
  const host = value("DPI_HOST") || "127.0.0.1";
  const probeHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const port = Number(value("DPI_PORT") || "4780");
  return `http://${probeHost}:${Number.isInteger(port) && port > 0 ? port : 4780}/healthz`;
}

/** A sibling of home: a backup must never sit inside the directory it backs up. */
export const defaultBackupDir = (home: string): string => join(dirname(home), `${basename(home)}-backups`);

/** `YYYYMMDD-HHMMSS` in local time — the name a human matches against `ls`. */
const stamp = (now: number): string => {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export async function backupCli(args: BackupCliArgs, io: BackupCliIo = defaultBackupCliIo()): Promise<number> {
  try {
    return await run(args, io);
  } catch (error) {
    // The CLI contract is an exit code, never a stack trace (gcCli's rule).
    io.printErr(`dpi backup: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function run(args: BackupCliArgs, io: BackupCliIo): Promise<number> {
  const argv = args.argv;
  if (argv.includes("--help") || argv.includes("-h")) {
    io.print(HELP);
    return 0;
  }
  const [sub = "", ...rest] = argv;
  const flags: Record<string, Set<string>> = {
    create: new Set(["--home", "--out"]),
    list: new Set(["--home", "--dir"]),
    restore: new Set(["--home", "--yes"]),
  };
  if (!flags[sub]) {
    io.printErr(`dpi backup: unknown subcommand '${sub || "(none)"}' — expected create, list or restore\n\n${HELP}`);
    return 2;
  }
  for (const arg of rest) {
    if (arg.startsWith("-") && !flags[sub].has(arg)) {
      io.printErr(`dpi backup ${sub}: unknown flag '${arg}'\n\n${HELP}`);
      return 2;
    }
  }
  if (sub === "create") return await createCmd(rest, io);
  if (sub === "list") return await listCmd(rest, io);
  return await restoreCmd(rest, io);
}

async function createCmd(rest: readonly string[], io: BackupCliIo): Promise<number> {
  const home = await resolveHome(rest, io);
  const outArg = flagValue(rest, "--out");
  const out = outArg
    ? resolve(expand(outArg, io.homedir()))
    : join(defaultBackupDir(home), `dpi-backup-${stamp(io.now())}.zip`);
  const result = await createBackup(io, { home, out });
  io.print(result.path);
  io.print(`backed up ${result.files} file(s), ${humanBytes(result.bytes)} from ${home}`);
  return 0;
}

async function listCmd(rest: readonly string[], io: BackupCliIo): Promise<number> {
  const home = await resolveHome(rest, io);
  const dirArg = flagValue(rest, "--dir");
  const dir = dirArg ? resolve(expand(dirArg, io.homedir())) : defaultBackupDir(home);
  const backups = await listBackups(io, dir);
  if (!backups.length) {
    io.print(`no backups yet in ${dir}`);
    return 0;
  }
  io.print(`${backups.length} backup(s) in ${dir}, newest first:`);
  for (const b of backups) {
    io.print(`  ${new Date(b.mtimeMs).toISOString()}  ${humanBytes(b.bytes).padStart(9)}  ${b.name}`);
  }
  return 0;
}

async function restoreCmd(rest: readonly string[], io: BackupCliIo): Promise<number> {
  // The positional FILE, skipping flags and the value --home consumes.
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--home") i += 1;
    else if (!rest[i].startsWith("-")) positional.push(rest[i]);
  }
  if (positional.length !== 1) {
    io.printErr(`dpi backup restore: expected exactly one FILE (a dpi-backup-*.zip)\n\n${HELP}`);
    return 2;
  }
  const zipPath = resolve(expand(positional[0], io.homedir()));
  const home = await resolveHome(rest, io);
  const url = await healthzUrl(io);

  if (!rest.includes("--yes")) {
    if (await deviceIsRunning(io, url)) {
      io.printErr("dpi backup restore: the device is running — stop it first (`dpi device stop`)");
      return 1;
    }
    // Read-only: the plan describes the backup, it does not touch the home.
    const entries = await readBackupEntries(io, zipPath);
    const files = entries.filter((e, i) => !(i === 0 && e.name === "manifest.json") && !e.name.endsWith("/")).length;
    io.print(`would restore ${files} file(s) from ${zipPath} into ${home}`);
    io.print(
      (await io.exists(home))
        ? `the current home would be renamed to ${home}.bak-<timestamp> (never deleted)`
        : `${home} does not exist yet — it would be created`,
    );
    io.print("re-run with --yes to restore.");
    return 0;
  }

  const result = await restoreBackup(io, { zipPath, home, healthzUrl: url });
  io.print(`restored ${result.restored} file(s) from ${zipPath} into ${home}`);
  if (result.backupOfOldHome) io.print(`previous home kept as ${result.backupOfOldHome}`);
  return 0;
}
