/**
 * Atomic secret-file primitives for the device pairing state (spec 03 §7).
 *
 * Order is normative: temp file 0600 in the SAME directory → write + fsync →
 * rename → fsync the directory. A file is only reported as persisted after
 * every step. Callers must never ACK or use a credential before writeAtomic
 * resolves, and async latecomers must re-check the active operation before
 * committing (see pairing.ts).
 */
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Write `contents` to `path` atomically (temp → fsync → rename → dir fsync). */
export function writeAtomic(path: string, contents: string): void {
  const dir = dirname(path);
  ensurePrivateDir(dir);
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

/** Tolerant JSON load for state files: malformed → undefined (caller decides). */
export function loadJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

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
