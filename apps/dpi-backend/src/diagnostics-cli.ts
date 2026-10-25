/**
 * `dpi diagnostics` — the redacted diagnostic bundle CLI (checklist Wave 3).
 *
 * Mirrors `backup-cli.ts`: the CLI io extends the module's `DiagnosticsIo`
 * with print/printErr (env and homedir already live on the module io), so one
 * object is faked in tests. Exit codes: 0 bundle written (failed sections
 * included — the bundle still built), 1 the bundle could not be written,
 * 2 usage error; nothing is ever thrown out of `diagnosticsCli`. `argv` is
 * what follows the `diagnostics` word.
 */
import { basename, dirname, join, resolve } from "node:path";
import { collectDiagnostics, defaultDiagnosticsIo, DEVICE_LOG_LINES, type DiagnosticsIo } from "./diagnostics.js";
import { expand, readEnvFile } from "./doctor.js";
import { humanBytes } from "./gc.js";

export interface DiagnosticsCliArgs {
  argv: readonly string[];
}

/** The CLI adds output to the module's io — one object, so a test fakes exactly what it needs. */
export interface DiagnosticsCliIo extends DiagnosticsIo {
  print: (line: string) => void;
  printErr: (line: string) => void;
}

export const defaultDiagnosticsCliIo = (): DiagnosticsCliIo => ({
  ...defaultDiagnosticsIo(),
  print: (line) => process.stdout.write(`${line}\n`),
  printErr: (line) => process.stderr.write(`${line}\n`),
});

const HELP = `dpi diagnostics — redacted diagnostic bundle (checklist Wave 3)

  dpi diagnostics [--out FILE] [--home DIR]

  Collects everything an operator would paste into a bug report, with secrets
  stripped, into one 0600 zip: manifest, the doctor checks, device/vitals/env,
  session summaries (no transcripts), the project/schedule/notify registries,
  and the last ${DEVICE_LOG_LINES} lines of device.log.

  --home DIR   device home (default: $DPI_HOME, else ~/.dpi)
  --out FILE   where the bundle lands (default: <home>-diagnostics/dpi-diagnostics-<YYYYMMDD-HHMMSS>.zip,
               a sibling of home, so a bundle never sits inside what it reads)

Every value is redacted before it enters the zip (dpi_ tokens, Bearer headers,
sk-/pk-/rk- keys, any 32+ char token-shaped run). A section that cannot be
collected is recorded as {"error": ...} and the bundle still builds — a broken
device is exactly when diagnostics matter most.

Exit codes: 0 bundle written, 1 the bundle could not be written, 2 usage error.`;

const flagValue = (argv: readonly string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
};

/** env wins over the env file, like doctor.ts's `deviceEndpoint`. */
async function envValues(io: DiagnosticsCliIo): Promise<(key: string) => string | undefined> {
  const envFile = io.env.DPI_ENV_FILE;
  let fileEnv: Record<string, string> = {};
  if (envFile) {
    try {
      fileEnv = readEnvFile(await io.readFile(resolve(expand(envFile, io.homedir()))));
    } catch {
      /* unreadable env file: fall back to process env, like doctor.ts */
    }
  }
  return (key) => io.env[key] ?? (typeof fileEnv[key] === "string" ? fileEnv[key] : undefined);
}

/** `--home` wins, then $DPI_HOME (env file included), then ~/.dpi — the gc-cli rule. */
async function resolveHome(argv: readonly string[], io: DiagnosticsCliIo): Promise<string> {
  const value = await envValues(io);
  const home = flagValue(argv, "--home") ?? value("DPI_HOME") ?? join(io.homedir(), ".dpi");
  return resolve(expand(home, io.homedir()));
}

/** A sibling of home: a bundle must never sit inside the directory it reads. */
export const defaultDiagnosticsDir = (home: string): string => join(dirname(home), `${basename(home)}-diagnostics`);

/** `YYYYMMDD-HHMMSS` in local time — the name a human matches against \`ls\`. */
const stamp = (now: number): string => {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export async function diagnosticsCli(args: DiagnosticsCliArgs, io: DiagnosticsCliIo = defaultDiagnosticsCliIo()): Promise<number> {
  try {
    return await run(args, io);
  } catch (error) {
    // The CLI contract is an exit code, never a stack trace (gcCli's rule).
    io.printErr(`dpi diagnostics: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function run(args: DiagnosticsCliArgs, io: DiagnosticsCliIo): Promise<number> {
  const argv = args.argv;
  if (argv.includes("--help") || argv.includes("-h")) {
    io.print(HELP);
    return 0;
  }
  const allowed = new Set(["--home", "--out"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--home" || arg === "--out") {
      i += 1; // its value, if any
      continue;
    }
    if (arg.startsWith("-")) {
      io.printErr(`dpi diagnostics: unknown flag '${arg}'\n\n${HELP}`);
      return 2;
    }
    io.printErr(`dpi diagnostics: unexpected argument '${arg}' (no positional arguments)\n\n${HELP}`);
    return 2;
  }

  const home = await resolveHome(argv, io);
  const outArg = flagValue(argv, "--out");
  const out = outArg
    ? resolve(expand(outArg, io.homedir()))
    : join(defaultDiagnosticsDir(home), `dpi-diagnostics-${stamp(io.now())}.zip`);

  const result = await collectDiagnostics(io, { home, out });
  for (const section of result.sections) {
    if (section.ok) io.print(`ok ${section.name} ${humanBytes(section.bytes)}`);
    else io.print(`failed ${section.name}: ${section.error}`);
  }
  const failed = result.sections.filter((s) => !s.ok).length;
  io.print(result.path);
  io.print(`diagnostic bundle: ${result.sections.length} section(s), ${humanBytes(result.bytes)} total${failed ? `, ${failed} failed` : ""}`);
  return 0;
}
