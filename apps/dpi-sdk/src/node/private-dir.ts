/**
 * Directories that hold secrets (registry database, device keypair, pairing file, backend env).
 *
 * `mkdir` applies its mode only to directories it creates. One that already exists — restored from
 * a backup, copied with the wrong umask, made by hand — keeps whatever mode it had, and anyone who
 * can write to it can unlink the 0600 files inside and put their own in their place. So the
 * directory itself is checked every time, not just created.
 */
import { chmodSync, mkdirSync, statSync } from "node:fs";

export type PrivateDirOutcome = "created" | "private" | "tightened";

/**
 * Make `dir` usable only by this account: create it (and missing parents) 0700, or take group/other
 * access away from an existing one. Throws when the directory belongs to another account (their
 * access cannot be removed by us and must not be trusted) or when the mode cannot be enforced.
 * A symlink is followed; the target is what gets judged.
 */
export function ensurePrivateDir(dir: string): PrivateDirOutcome {
  const existing = statOrUndefined(dir);
  if (existing && !existing.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (!existing) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // POSIX owner/mode bits do not exist on Windows; ACLs are the platform's job there.
  if (process.platform === "win32") return existing ? "private" : "created";

  const uid = process.getuid?.();
  const st = statSync(dir);
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(`${dir} is owned by uid ${st.uid}, not by this account (uid ${uid}); it cannot be made private. Choose another location or chown it.`);
  }
  if ((st.mode & 0o077) === 0) return existing ? "private" : "created";

  chmodSync(dir, 0o700);
  const after = statSync(dir).mode & 0o777;
  if ((after & 0o077) !== 0) {
    throw new Error(`${dir} is mode ${after.toString(8)} and chmod 700 did not take effect; refusing to keep secrets there`);
  }
  return existing ? "tightened" : "created";
}

function statOrUndefined(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
