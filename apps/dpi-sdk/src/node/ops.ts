// Process helpers for the network ops CLI: local commands, remote shell scripts over ssh
// (scripts and secrets travel on stdin, never argv), rsync and the exe.dev control plane.
import { spawn } from "node:child_process";
import type { NetDevice } from "./config.js";

/** run-8 U9: every device-facing step gets a deadline by default, so a hung or
 *  hostile host cannot block the operator's CLI indefinitely. */
const DEFAULT_TIMEOUT_MS = 60_000;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  stdin?: string;
  timeoutMs?: number;
  /** run-8 U9: cap on captured stdout/stderr per stream (default 1 MiB). */
  maxBytes?: number;
  /** Stream output to this process's stdout/stderr while capturing it. */
  echo?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  allowFail?: boolean;
}

export function run(cmd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    // run-8 U9: a hostile/hung device controls every byte on these pipes and
    // run() accumulated them without limit, so `net status`/`up` could OOM or
    // hang forever (facts/register/logs passed no timeout at all).
    const cap = options.maxBytes ?? 1024 * 1024;
    let truncatedStdout = false;
    let truncatedStderr = false;
    const take = (current: string, chunk: Buffer, mark: (v: boolean) => void): string => {
      if (current.length >= cap) {
        mark(true);
        return current;
      }
      return current + chunk.toString().slice(0, cap - current.length);
    };
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 2000).unref?.();
          stderr = take(stderr, Buffer.from(`\n[timeout after ${timeoutMs}ms]`), (v) => (truncatedStderr = v));
        }, timeoutMs)
      : undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = take(stdout, chunk, (v) => (truncatedStdout = v));
      if (options.echo) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = take(stderr, chunk, (v) => (truncatedStderr = v));
      if (options.echo) process.stderr.write(chunk);
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      // cold-3 L10: a silent cut is indistinguishable from a complete log.
      const marker = `\n[truncated at ${cap} bytes]`;
      const result = {
        code: code ?? 1,
        stdout: truncatedStdout ? stdout + marker : stdout,
        stderr: truncatedStderr ? stderr + marker : stderr,
      };
      if (result.code !== 0 && !options.allowFail)
        reject(Object.assign(Error(`${cmd} ${args.slice(0, 3).join(" ")} … failed (exit ${result.code}): ${stderr.trim().slice(-800)}`), { result }));
      else resolve(result);
    });
    child.stdin.end(options.stdin ?? "");
  });
}

export const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=15"];

// --------------------------------------------- run-9 u9 (unit E): ssh argv guards
// OpenSSH joins the words after the destination into ONE remote command string
// the remote shell re-parses; rsync word-splits its -e value and embeds
// host:path in a remote command that shell re-parses too; an option-shaped
// word (leading dash) in destination position is parsed as an ssh OPTION.
// config.ts gates the yaml scalars at parse time — these are the sink-side
// twins for every dynamic word that reaches an ssh/rsync argv, so sources
// that never flow through config (share port numbers, set-public/rm values,
// clamped integers) cannot smuggle options, detach words or re-parse shell.

/** ssh destination: only [user@]host[:port] with a real 1-65535 port. */
const SSH_TARGET_RE = /^(?:[A-Za-z0-9._%][A-Za-z0-9._%-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*(?::(\d{1,5}))?$/;

/** rsync source/dest: a local path or the remote join half — never option-
 *  shaped, never whitespace/control/shell-metacharacter bearing (the dest is
 *  re-parsed by the remote shell; a leading dash is an rsync option). */
const RSYNC_PATH_UNSAFE = /[\s"'`\\;$&|<>(){}*?!\x00-\x1f]/;

function rsyncPath(p: string, what: string): string {
  if (!p) throw Error(`rsync ${what} is empty`);
  if (p.startsWith("-")) throw Error(`rsync ${what} must not be option-shaped: ${JSON.stringify(p)}`);
  if (RSYNC_PATH_UNSAFE.test(p)) throw Error(`rsync ${what} must not contain whitespace or shell metacharacters: ${JSON.stringify(p)}`);
  return p;
}

/** exe.dev argv words: options stay caller-built constants (--name=…); the
 *  charset allowlist keeps a value from detaching into new remote words or
 *  re-parsing as shell once OpenSSH joins the argv into one command string. */
const EXE_ARG_RE = /^[A-Za-z0-9._=-]+$/;

/** run-9 u9/E: an exe.dev VM name riding `ssh exe.dev new|share port|set-public|rm`
 *  argv — mirrors config.ts's vm gate at the sink (option- and shell-shaped
 *  names rejected). */
export function exeVmArg(vm: string | undefined): string {
  if (!vm || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(vm)) throw Error(`exe.dev vm name is invalid: ${JSON.stringify(vm ?? "")}`);
  return vm;
}

/** run-9 u9/E: clamp an integer before it is interpolated into argv or a
 *  generated script — Number() alone accepts NaN/1e21/22.5. */
export function argvInt(v: unknown, min: number, max: number, what: string): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw Error(`${what} must be an integer ${min}-${max} (got ${JSON.stringify(v)})`);
  return n;
}

/** run-9 u9/E: operator input (net logs <n>) clamps instead of failing. */
export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}

/** "~/x" → "$HOME/x" for use inside double-quoted remote shell strings. */
export const shPath = (p: string) => (p === "~" ? "$HOME" : p.startsWith("~/") ? `$HOME/${p.slice(2)}` : p);
/** Single-quote a value for a POSIX shell. */
export const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

const PRELUDE = `set -e
export NVM_DIR="$HOME/.nvm"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
`;

export function sshTarget(device: NetDevice) {
  if (!device.ssh) throw Error(`${device.id} (kind ${device.kind}) has no ssh target`);
  // run-9 u9/E: the destination is a leading argv word — a leading dash is an
  // ssh OPTION (-oProxyCommand=…), anything with whitespace/quotes/$ would
  // detach into new remote words once OpenSSH joins the command. Sink-side
  // twin of config.ts's parse-time gate on the ssh scalar.
  const m = SSH_TARGET_RE.exec(device.ssh);
  if (!m || (m[1] !== undefined && !(Number(m[1]) >= 1 && Number(m[1]) <= 65535)))
    throw Error(`${device.id}: ssh target must be [user@]host[:port] with no options or metacharacters (got ${JSON.stringify(device.ssh)})`);
  return device.ssh;
}

/** Run a POSIX shell script on the device. The script (and anything embedded in it) goes over stdin. */
export function remote(device: NetDevice, script: string, options: Omit<RunOptions, "stdin"> = {}) {
  return run("ssh", [...SSH_OPTS, sshTarget(device), "sh -s"], { ...options, stdin: PRELUDE + script });
}

/** The full rsync argv, built explicitly from guarded parts (pure, testable). */
export function rsyncArgv(device: NetDevice, sources: string[], dest: string): string[] {
  // The -e value is the ONE place rsync has no argv form: it word-splits the
  // string. Every word is a constant here — assert SSH_OPTS stays single
  // words so the split can never reshape the command line remote() builds.
  if (SSH_OPTS.some((o) => /[\s"'`\\;]/.test(o))) throw Error("SSH_OPTS entries must be single words (rsync word-splits -e)");
  return [
    "-a",
    "--delete",
    "--exclude", "node_modules",
    "--exclude", ".data",
    "--exclude", ".durable-pi",
    "--exclude", "dist",
    "--exclude", "*.log",
    "--exclude", ".DS_Store",
    "-e", `ssh ${SSH_OPTS.join(" ")}`,
    ...sources.map((s) => rsyncPath(s, "source")),
    `${sshTarget(device)}:${rsyncPath(dest, "dest")}`,
  ];
}

export function rsync(device: NetDevice, sources: string[], dest: string, cwd: string) {
  return run("rsync", rsyncArgv(device, sources, dest), { cwd, timeoutMs: 600_000 });
}

/** The full exe.dev argv, built explicitly from guarded args (pure, testable). */
export function exeDevArgv(args: string[]): string[] {
  for (const a of args)
    if (!a || !EXE_ARG_RE.test(a) || /^-[^-]/.test(a) || a === "-" || a === "--")
      // r10 h3-4: ssh re-parses single-dash words as ITS options (-o, -L…) —
      // those die at the sink. Double-dash `--name=x` flags are exe.dev's own
      // grammar (call sites pass them as constants) and stay legal; the
      // charset gate already blocks everything else.
      throw Error(`exe.dev argument rejected (allowed charset [A-Za-z0-9._=-], no whitespace/metacharacters, no single-dash options): ${JSON.stringify(a)}`);
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "exe.dev", ...args, "--json"];
}

/** The exe.dev control plane (`ssh exe.dev <verb> --json`). */
export async function exeDev<T = unknown>(args: string[], timeoutMs = 60_000): Promise<T> {
  const result = await run("ssh", exeDevArgv(args), { timeoutMs });
  const text = result.stdout.trim();
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    return { raw: text } as T;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
