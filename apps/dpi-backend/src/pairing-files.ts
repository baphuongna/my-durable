/**
 * Atomic secret-file primitives for the device pairing state (spec 03 §7).
 *
 * Order is normative: temp file 0600 in the SAME directory → write + fsync →
 * rename → fsync the directory. A file is only reported as persisted after
 * every step. Callers must never ACK or use a credential before writeAtomic
 * resolves, and async latecomers must re-check the active operation before
 * committing (see pairing.ts).
 */
import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { ensurePrivateDir } from "../../dpi-sdk/src/node/private-dir.js";

export { ensurePrivateDir };

/** Write `contents` to `path` atomically (temp → fsync → rename → dir fsync). */
export function writeAtomic(path: string, contents: string): void {
  ensurePrivateDir(dirname(path));
  replaceFileAtomic(path, contents);
}

/** The write itself, for callers that have already judged the directory (and must not have it chmod'ed). */
export function replaceFileAtomic(path: string, contents: string): void {
  const dir = dirname(path);
  const temp = join(dir, `.${basename(path)}.tmp-${randomBytes(6).toString("hex")}`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "w", 0o600);
    writeSync(fd, Buffer.from(contents, "utf8"));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    // fsync the directory so the rename itself is durable.
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (e) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
    try {
      unlinkSync(temp); // cleanup ONLY the temp this function created
    } catch {}
    throw e;
  }
}

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Exactly the names `replaceFileAtomic` gives its temp files for the two state files in the home directory. */
const STATE_TEMP = /^\.(?:pairing|device-keypair)\.json\.tmp-[0-9a-f]{12}$/;

/**
 * A writer killed between creating its temp file and renaming it leaves that file behind, holding a credential.
 * Run before anything in this process writes: it must not race a live writer.
 */
export function removeStaleTemps(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (!STATE_TEMP.test(name)) continue;
    const path = join(dir, name);
    try {
      unlinkSync(path); // never follows a symlink; refuses a directory
    } catch {
      /* raced away or not removable: the next start retries */
    }
  }
}

/** Tolerant JSON load for state files: malformed → undefined (caller decides). */
export function loadJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * The device key, or undefined when there is none yet. Anything else that keeps it from being read (permissions,
 * I/O error, truncated or damaged contents) throws: the caller must not answer that by minting a new identity
 * over the old file.
 */
export function readKeypairFile(path: string): DeviceKeypair | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw keypairUnusable(path, (e as Error).message);
  }
  let parsed: Partial<DeviceKeypair> | null;
  try {
    parsed = JSON.parse(raw) as Partial<DeviceKeypair> | null;
  } catch {
    throw keypairUnusable(path, "not valid JSON");
  }
  if (!parsed?.privateKeyPem || !parsed.publicKeyPem || !parsed.fingerprint) throw keypairUnusable(path, "key fields are missing");
  return parsed as DeviceKeypair;
}

const keypairUnusable = (path: string, why: string) =>
  new Error(`device keypair ${path} is unusable (${why}); refusing to replace it. Restore it from a backup, or move it away to enroll this device again.`);

/** Tighten a file that must hold secrets if a copy/restore loosened it. */
export function ensureFileMode0600(path: string): void {
  try {
    if ((statSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600);
  } catch {
    /* file may not exist yet */
  }
}

export interface DeviceKeypair {
  fingerprint: string; // sha256:<64hex> of the DER SPKI
  publicKeyPem: string;
  privateKeyPem: string;
}

export interface PairingFile {
  version: 1;
  deviceUid: string;
  deviceId: string;
  pairingEpoch: string;
  credentialId: string;
  generation: number;
  hubOrigin: string;
  hubUrl: string;
  hubId: string;
  tunnelToken: string;
  updatedAt: number;
  operationId: string;
}

export const keypairPath = (home: string) => join(home, "device-keypair.json");
export const pairingPath = (home: string) => join(home, "pairing.json");
