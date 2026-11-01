/**
 * Private-file hygiene shared by every app (device backend, hub, sdk registry):
 * atomic writes for credentials and owner-only access on every platform.
 *
 * POSIX gets file modes (0600/0700). Windows ignores them, so the same calls
 * install the hardened DACL Orca uses (`windows-secure-dacl.ts`): protected
 * from inheritance, full control for SYSTEM, Administrators and the user —
 * nobody else. `icacls` ships with every Windows box, so no native addon is
 * needed. Like Orca (and paseo's applyPrivateMode) a restriction failure never
 * crashes the caller: it reports and returns false so the boot can continue and
 * a later pass can retry.
 */
import { chmodSync, closeSync, fsyncSync, openSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { execFile } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { ensurePrivateDir } from "./private-dir.js";

export interface RestrictDeps {
  platform?: NodeJS.Platform;
  /** Injectable for tests: run a command, resolve stdout or reject. */
  execFile?: (cmd: string, args: string[]) => Promise<string>;
  /** Injectable for tests: the temp-sibling name used for the atomic write. */
  tempName?: (path: string) => string;
}

/** icacls (like most argv parsers) reads a leading '-'/'/' word as a switch, not a filename. */
const optionShaped = (p: string) => p === "" || /^[-\/]/.test(p);

/** orca's SIDs: SYSTEM and local Administrators can take ownership anyway. */
const LOCAL_SYSTEM_SID = "S-1-5-18";
const BUILTIN_ADMINISTRATORS_SID = "S-1-5-32-544";

const execDefault = (cmd: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile(cmd, args, { timeout: 15_000, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout ?? ""));
    });
  });

/** The current user's SID via `whoami` (locale-proof: extract the S-1-5-* token). */
async function userSid(deps: RestrictDeps): Promise<string> {
  const out = await deps.execFile!("whoami", ["/user", "/fo", "csv", "/nh"]);
  const m = out.match(/S-1-5-[0-9-]+/);
  if (!m) throw Error(`whoami returned no SID: ${out.trim()}`);
  return m[0];
}

/**
 * Restrict one FILE to its owner. POSIX: chmod 0600 (idempotent). Windows:
 * strip inheritance, grant SYSTEM + Administrators + the user. Never throws.
 */
export async function restrictToOwner(path: string, deps: RestrictDeps = {}): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  const exec = deps.execFile ?? execDefault;
  if (platform === "win32") {
    if (optionShaped(path)) {
      console.error(`private-file: refusing icacls on option-shaped path ${JSON.stringify(path)}`);
      return false;
    }
    try {
      const sid = await userSid({ execFile: exec });
      const grants = [LOCAL_SYSTEM_SID, BUILTIN_ADMINISTRATORS_SID, sid].map(
        (s) => `*${s}:F`,
      );
      await exec("icacls", [path, "/inheritance:r", "/grant:r", ...grants]);
      return true;
    } catch (e) {
      console.error(`private-file: could not restrict ${path} (${(e as Error).message})`);
      return false;
    }
  }
  try {
    chmodSync(path, 0o600);
    return true;
  } catch (e) {
    console.error(`private-file: could not restrict ${path} (${(e as Error).message})`);
    return false;
  }
}

/** Restrict a DIRECTORY (children inherit on Windows via (OI)(CI)). Never throws. */
export async function restrictDirToOwner(path: string, deps: RestrictDeps = {}): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  const exec = deps.execFile ?? execDefault;
  if (platform === "win32") {
    if (optionShaped(path)) {
      console.error(`private-file: refusing icacls on option-shaped path ${JSON.stringify(path)}`);
      return false;
    }
    try {
      const sid = await userSid({ execFile: exec });
      const grants = [LOCAL_SYSTEM_SID, BUILTIN_ADMINISTRATORS_SID, sid].map(
        (s) => `*${s}:(OI)(CI)F`,
      );
      await exec("icacls", [path, "/inheritance:r", "/grant:r", ...grants]);
      return true;
    } catch (e) {
      console.error(`private-file: could not restrict ${path} (${(e as Error).message})`);
      return false;
    }
  }
  try {
    chmodSync(path, 0o700);
    return true;
  } catch (e) {
    console.error(`private-file: could not restrict ${path} (${(e as Error).message})`);
    return false;
  }
}

/** The unpublished sibling a write goes into first: `.<name>.<12 hex>.tmp` beside it. */
const tempSiblingName = (path: string) =>
  join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);

/** r10 h3-2: a SIGKILL between writeSync and renameSync strands a
 * secret-bearing temp sibling that nothing ever cleaned — random names never
 * collide, so one stale copy of EVERY rotated-away credential could
 * accumulate. Prune the target's stale temps (grace window keeps a concurrent
 * writer's live temp safe) at the top of every atomic write. */
const TEMP_GRACE_MS = 60 * 60 * 1000;
function pruneStaleTemps(path: string, deps: RestrictDeps = {}): void {
  if ((deps.platform ?? process.platform) === "win32") {
    // win32 rename-refusal races make pruning riskier than the residue; the
    // 0700 dir already bounds exposure there.
    return;
  }
  const dir = dirname(path);
  const prefix = `.${basename(path)}.`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
    try {
      const full = join(dir, name);
      if (now - statSync(full).mtimeMs > TEMP_GRACE_MS) rmSync(full, { force: true });
    } catch {
      /* someone else's temp racing us — leave it */
  }
  }
}

/**
 * Atomic write for credential files (orca STA-3941 / paseo writePrivateFileAtomicSync):
 * temp file 0600 + fsync + rename, so readers only ever see the old bytes or the
 * complete new ones — a crash mid-write can never truncate a token. The temp
 * file is created EXCLUSIVE ("wx"), so a planted symlink at the predictable
 * `.name.*.tmp` shape cannot be truncated through, and the parent directory goes
 * through ensurePrivateDir (an existing too-loose directory is tightened — or
 * refused — instead of silently reused). Resolves with the owner-restriction
 * outcome so callers can surface a failed pass instead of re-running it by
 * hand. Throws only if the disk write itself fails.
 */
export async function writePrivateFileAtomic(
  path: string,
  contents: string,
  deps: RestrictDeps = {},
): Promise<boolean> {
  ensurePrivateDir(dirname(path));
  pruneStaleTemps(path, deps);
  const temp = (deps.tempName ?? tempSiblingName)(path);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeSync(fd, Buffer.from(contents, "utf8"));
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } catch (e) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
    throw e;
  }
  // POSIX: fsync the directory so the rename itself is durable (Windows dir
  // fds cannot be fsynced — EPERM; NTFS journaling carries it there).
  if ((deps.platform ?? process.platform) !== "win32") {
    try {
      const dirFd = openSync(dirname(path), "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      /* best effort, like pairing-files' fsyncReadOnlySupported probe */
    }
  }
  return await restrictToOwner(path, deps);
}
