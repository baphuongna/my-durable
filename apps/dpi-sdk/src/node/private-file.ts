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
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { execFile } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export interface RestrictDeps {
  platform?: NodeJS.Platform;
  /** Injectable for tests: run a command, resolve stdout or reject. */
  execFile?: (cmd: string, args: string[]) => Promise<string>;
}

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

/**
 * Atomic write for credential files (orca STA-3941 / paseo writePrivateFileAtomicSync):
 * temp file 0600 + fsync + rename, so readers only ever see the old bytes or the
 * complete new ones — a crash mid-write can never truncate a token. Then the
 * owner restriction runs on every platform. Throws only if the disk write
 * itself fails.
 */
export async function writePrivateFileAtomic(
  path: string,
  contents: string,
  deps: RestrictDeps = {},
): Promise<void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "w", 0o600);
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
  await restrictToOwner(path, deps);
}
