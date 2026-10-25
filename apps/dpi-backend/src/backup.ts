/**
 * Device-side backup/restore of the device home — "Backup/restore of session
 * data" (SHOULD), Wave 2 of docs/host-project-checklist.md.
 *
 * Modelled on orca's `rolling-file-backup.ts` (a copy ahead of every risky
 * change) and piggery's CLI ops discipline (every destructive op asks once):
 *
 *   - `createBackup` writes exactly one new file and deletes nothing;
 *   - `restoreBackup` deletes nothing either — an existing home is renamed to
 *     `<home>.bak-<timestamp>` and kept, so the one rollback a restore has is
 *     also the only copy it needs;
 *   - restore refuses to run while the device daemon answers on its port: a
 *     copy taken under a live sqlite handle is not a backup, it is a lie.
 *
 * The zip is built in memory, so the walk is capped (256 MiB by default,
 * `maxBytes`). The writer here emits the same three records as `zip.ts` (local
 * header / central directory / EOCD) but takes bytes, not text — a device home
 * holds `backend/catalog.sqlite`, and `zip.ts`'s `ZipEntry.text` would
 * re-encode it as UTF-8. `crc32` is imported from `zip.ts` so the checksum can
 * never drift between the two writers. `readZipEntries` reads those archives
 * back (methods 0 and 8 only) and refuses anything it does not recognise: this
 * reader exists for OUR backups, not for arbitrary archives.
 *
 * Every fs/clock/network access goes through `BackupIo` (the `gc.ts` /
 * `doctor.ts` pattern), so tests pin the clock and fake the daemon probe
 * instead of trusting a port to happen to be closed. Symlinks are followed by
 * `stat` (a symlinked sessions dir is still the device's data); a walk deeper
 * than 64 levels is refused rather than looped through; empty directories are
 * not preserved (the zip stores files only).
 */
import { chmod, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { dirname, join, relative, resolve, sep } from "node:path";
import { crc32 } from "./zip.js";
import { humanBytes } from "./gc.js";
import { PACKAGE_VERSION } from "./store.js";

export type BackupErrorCode = "invalid" | "device_running" | "not_found";

/** Typed failure, same shape as `ProjectRegistryError`: a CLI picks its exit code from `code`, not from message matching. */
export class BackupError extends Error {
  readonly code: BackupErrorCode;

  constructor(code: BackupErrorCode, message: string) {
    super(message);
    this.name = "BackupError";
    this.code = code;
  }
}

const invalid = (message: string) => new BackupError("invalid", message);
const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The in-memory zip build is capped so `createBackup` cannot balloon the device's RAM. */
export const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
/** `ensurePrivateDir` (dpi-sdk) is synchronous and not injectable; the io carries the same 0700/0600 rule instead. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
/** A deeper tree is a symlink loop, not a device home. */
const MAX_WALK_DEPTH = 64;

export interface BackupStat {
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
  mode: number;
  mtimeMs: number;
}

export interface BackupIo {
  readFile(path: string): Promise<Uint8Array>;
  /** `mode` applies when the file is created; an explicit `chmod` follows, like projects.ts's persist. */
  writeFile(path: string, data: Uint8Array, mode?: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Recursive; `mode` (0700 by default) applies to the directories it creates. */
  mkdir(path: string, mode?: number): Promise<void>;
  stat(path: string): Promise<BackupStat>;
  /** Names only — `stat` decides what each one is (withFileTypes is not injectable-friendly). */
  readdir(path: string): Promise<string[]>;
  chmod(path: string, mode: number): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Daemon probe for restore. A fetch that THROWS is a refused connection, i.e. "not running". */
  fetch?(url: string, init?: { signal?: AbortSignal }): Promise<{ ok: boolean; status: number }>;
  now(): number;
}

export const defaultBackupIo = (): BackupIo => ({
  readFile: (path) => readFile(path),
  writeFile: (path, data, mode) => writeFile(path, data, { mode }),
  rename: (from, to) => rename(from, to),
  // fs/promises mkdir(recursive) resolves with the first created path — dropped, the io promises void.
  mkdir: async (path, mode) => {
    await mkdir(path, { recursive: true, mode: mode ?? DIR_MODE });
  },
  stat: (path) => stat(path),
  readdir: (path) => readdir(path),
  chmod: (path, mode) => chmod(path, mode),
  exists: async (path) => {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  },
  fetch: async (url, init) => {
    const res = await fetch(url, init as RequestInit | undefined);
    return { ok: res.ok, status: res.status };
  },
  now: () => Date.now(),
});

// ---------------------------------------------------------------- create

/** Entry 0 of every backup zip: what was backed up, by which build. */
export interface BackupManifest {
  createdAt: string;
  packageVersion: string;
  deviceName?: string;
  files: number;
  bytes: number;
}

export interface CreateBackupOptions {
  home: string;
  out: string;
  deviceName?: string;
  /** Total-bytes guard for the in-memory zip build. Defaults to `MAX_BACKUP_BYTES` (256 MiB). */
  maxBytes?: number;
}

export interface CreateBackupResult {
  path: string;
  files: number;
  bytes: number;
}

interface WalkedFile {
  /** Path relative to home, posix separators — the zip entry name. */
  rel: string;
  abs: string;
  size: number;
}

/**
 * Collect every regular file under `home`, sorted for a deterministic zip:
 * registries, backend/catalog.sqlite, sessions, logs — everything. Skipped:
 * `.lock` files (live handles, not data), non-regular entries (sockets, FIFOs,
 * devices), any `node_modules` segment, and the output file itself (a backup
 * must never swallow a previous backup of itself).
 */
async function walkHome(io: BackupIo, home: string, out: string, maxBytes: number): Promise<WalkedFile[]> {
  const outAbs = resolve(out);
  const files: WalkedFile[] = [];
  let bytes = 0;
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH) throw invalid(`${dir} nests deeper than ${MAX_WALK_DEPTH} levels — refusing to walk it`);
    for (const name of (await io.readdir(dir)).sort()) {
      if (name === "node_modules") continue;
      const abs = join(dir, name);
      let entry: BackupStat;
      try {
        entry = await io.stat(abs);
      } catch {
        continue; // broken symlink / vanished entry: not backup-able, not fatal
      }
      if (entry.isDirectory()) {
        await visit(abs, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue; // sockets, FIFOs, devices
      if (name.endsWith(".lock")) continue;
      if (resolve(abs) === outAbs) continue;
      bytes += entry.size;
      if (bytes > maxBytes) {
        throw invalid(
          `${home} is ${bytes} bytes (${humanBytes(bytes)}) after ${files.length + 1} file(s); ` +
            `the in-memory zip build is capped at ${maxBytes} bytes (${humanBytes(maxBytes)})`,
        );
      }
      files.push({ rel: relative(home, abs).split(sep).join("/"), abs, size: entry.size });
    }
  };
  await visit(home, 0);
  return files;
}

/**
 * Zip the whole device home into `opts.out` (0600, parent dirs 0700) and touch
 * nothing else. The timestamped default name is the CLI's decision, not this
 * module's.
 */
export async function createBackup(io: BackupIo, opts: CreateBackupOptions): Promise<CreateBackupResult> {
  const home = resolve(opts.home);
  const out = resolve(opts.out);
  let homeStat: BackupStat;
  try {
    homeStat = await io.stat(home);
  } catch (error) {
    throw new BackupError("not_found", `home directory not found: ${home} (${describeError(error)})`);
  }
  if (!homeStat.isDirectory()) throw invalid(`home is not a directory: ${home}`);

  const files = await walkHome(io, home, out, opts.maxBytes ?? MAX_BACKUP_BYTES);
  const bytes = files.reduce((n, f) => n + f.size, 0);
  const manifest: BackupManifest = {
    createdAt: new Date(io.now()).toISOString(),
    packageVersion: PACKAGE_VERSION,
    files: files.length,
    bytes,
  };
  if (opts.deviceName) manifest.deviceName = opts.deviceName;

  // Entry 0 is the manifest, so restore can always recognise it by position —
  // and a home file that happens to be called manifest.json still round-trips.
  const entries: Array<{ name: string; data: Uint8Array }> = [
    { name: "manifest.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8") },
  ];
  for (const file of files) entries.push({ name: file.rel, data: await io.readFile(file.abs) });

  const zip = zipBytes(entries, new Date(io.now()));
  await io.mkdir(dirname(out), DIR_MODE);
  await io.writeFile(out, zip, FILE_MODE);
  await io.chmod(out, FILE_MODE);
  return { path: out, files: files.length, bytes };
}

// ---------------------------------------------------------------- zip build
// The records are the ones zip.ts writes; only the payload differs (bytes, not
// UTF-8 text). Keep the two byte layouts in sync if zip.ts ever changes.

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** Bit 11: file names are UTF-8. */
const FLAG_UTF8 = 0x0800;
const VERSION = 20;

/** MS-DOS time/date: 2-second resolution, 1980 epoch (zip.ts's rule, verbatim). */
function dosStamp(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Deflate when it helps, store when it does not — the same choice zip.ts makes. */
function zipBytes(entries: readonly { name: string; data: Uint8Array }[], at: Date): Buffer {
  const stamp = dosStamp(at);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength);
    const deflated = deflateRawSync(raw);
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(VERSION, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(FILE_MODE << 16, 38); // external attrs: rw-------
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...locals, centralBuf, eocd]);
}

// ----------------------------------------------------------------- zip read

export interface ZipArchiveEntry {
  name: string;
  data: Uint8Array;
}

/** A name our own writer could have produced: relative, posix, no `..`, no NUL, no backslash. */
function validateEntryName(name: string): void {
  if (!name) throw invalid("zip entry has an empty name");
  if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name)) {
    throw invalid(`zip entry name is absolute: ${name}`);
  }
  if (name.includes("\\") || name.includes("\0")) {
    throw invalid(`zip entry name is not a posix path: ${JSON.stringify(name)}`);
  }
  for (const segment of name.split("/")) {
    if (segment === "..") throw invalid(`zip entry name escapes the archive: ${name}`);
  }
}

/**
 * Read back a zip this module (or `zip.ts`) wrote: EOCD → central directory →
 * local headers, methods 0 and 8 only, sizes and crc32 verified. This is not a
 * general-purpose unzip: anything unexpected is a `BackupError("invalid")`
 * rather than a best-effort guess.
 */
export function readZipEntries(data: Uint8Array): ZipArchiveEntry[] {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const bad = (why: string): BackupError => invalid(`not a readable backup zip: ${why}`);

  // The EOCD sits in the last 22 bytes plus (at most) a 64 KiB comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad("no end-of-central-directory record");

  const count = buf.readUInt16LE(eocd + 8);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  if (centralOffset + centralSize !== eocd) {
    throw bad(`central directory (offset ${centralOffset}, size ${centralSize}) does not end at the EOCD (${eocd})`);
  }

  const entries: ZipArchiveEntry[] = [];
  let p = centralOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > eocd) throw bad(`central directory entry ${i} overruns the archive`);
    if (buf.readUInt32LE(p) !== CENTRAL_SIG) throw bad(`central directory entry ${i} is corrupt`);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLength + extraLength + commentLength > eocd) {
      throw bad(`central directory entry ${i} overruns the archive`);
    }
    const name = buf.toString("utf8", p + 46, p + 46 + nameLength);
    validateEntryName(name);

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw bad(`local header for ${name} is corrupt`);
    }
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    if (start + compressedSize > buf.length) throw bad(`data for ${name} overruns the archive`);

    let out: Buffer;
    if (method === 0) out = buf.subarray(start, start + compressedSize);
    else if (method === 8) {
      try {
        out = inflateRawSync(buf.subarray(start, start + compressedSize));
      } catch (error) {
        throw bad(`cannot inflate ${name} (${describeError(error)})`);
      }
    } else throw bad(`unsupported compression method ${method} for ${name}`);

    if (out.length !== uncompressedSize) {
      throw bad(`${name} decompressed to ${out.length} bytes, expected ${uncompressedSize}`);
    }
    if (crc32(out) !== crc) throw bad(`checksum mismatch for ${name}`);

    entries.push({ name, data: out });
    p += 46 + nameLength + extraLength + commentLength;
  }
  if (p - centralOffset !== centralSize) throw bad("central directory size does not match its entries");
  return entries;
}

/** Read + parse a backup file; restore and the CLI's plan share the `not_found` mapping. */
export async function readBackupEntries(io: BackupIo, zipPath: string): Promise<ZipArchiveEntry[]> {
  let data: Uint8Array;
  try {
    data = await io.readFile(resolve(zipPath));
  } catch (error) {
    throw new BackupError("not_found", `cannot read backup ${zipPath}: ${describeError(error)}`);
  }
  return readZipEntries(data);
}

// ---------------------------------------------------------------- restore

export interface RestoreBackupOptions {
  zipPath: string;
  home: string;
  /** When set, restore first refuses if the daemon answers here (healthz needs no auth). */
  healthzUrl?: string;
}

export interface RestoreBackupResult {
  restored: number;
  /** Where the previous home went; absent when there was nothing to move. */
  backupOfOldHome?: string;
}

/**
 * Is the device daemon answering? Any HTTP answer (even 404/500) means yes; a
 * fetch that throws is a refused connection, i.e. no. A missing `io.fetch`
 * cannot probe and reports "not running" — the caller decides whether to trust
 * that.
 */
export async function deviceIsRunning(io: BackupIo, healthzUrl: string): Promise<boolean> {
  if (!io.fetch) return false;
  try {
    await io.fetch(healthzUrl, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Unpack a backup into `home`. Nothing is deleted: an existing home is renamed
 * to `<home>.bak-<timestamp>` first (colons and dots flattened to dashes — a
 * Windows filename cannot hold them), then `-2`, `-3`, … if that name is taken.
 * The manifest is the backup's own metadata, so entry 0 named manifest.json is
 * not extracted — a home file of the same name still round-trips, because the
 * manifest always comes first.
 */
export async function restoreBackup(io: BackupIo, opts: RestoreBackupOptions): Promise<RestoreBackupResult> {
  const home = resolve(opts.home);
  if (opts.healthzUrl && (await deviceIsRunning(io, opts.healthzUrl))) {
    throw new BackupError("device_running", "the device is running — stop it first (`dpi device stop`)");
  }
  const entries = await readBackupEntries(io, opts.zipPath);

  let backupOfOldHome: string | undefined;
  if (await io.exists(home)) backupOfOldHome = await renameAside(io, home);

  await io.mkdir(home, DIR_MODE);
  let restored = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (i === 0 && entry.name === "manifest.json") continue;
    if (entry.name.endsWith("/")) {
      await io.mkdir(join(home, entry.name), DIR_MODE); // a directory entry from a foreign zip
      continue;
    }
    const target = join(home, entry.name);
    await io.mkdir(dirname(target), DIR_MODE);
    await io.writeFile(target, entry.data, FILE_MODE);
    await io.chmod(target, FILE_MODE);
    restored += 1;
  }
  return { restored, backupOfOldHome };
}

/** `<home>.bak-<ISO-ish stamp>`, `-2`/`-3` when taken. Never deletes the old home. */
async function renameAside(io: BackupIo, home: string): Promise<string> {
  const stamp = new Date(io.now()).toISOString().replace(/[:.]/g, "-");
  const base = `${home}.bak-${stamp}`;
  let target = base;
  for (let n = 2; await io.exists(target); n += 1) target = `${base}-${n}`;
  await io.rename(home, target);
  return target;
}

// ------------------------------------------------------------------ list

export interface BackupListing {
  name: string;
  bytes: number;
  mtimeMs: number;
}

/** The `dpi-backup-*.zip` files in `dir`, newest first. A missing dir is an empty list, not an error. */
export async function listBackups(io: BackupIo, dir: string): Promise<BackupListing[]> {
  if (!(await io.exists(dir))) return [];
  const listings: BackupListing[] = [];
  for (const name of await io.readdir(dir)) {
    if (!/^dpi-backup-.*\.zip$/.test(name)) continue;
    try {
      const entry = await io.stat(join(dir, name));
      if (!entry.isFile()) continue;
      listings.push({ name, bytes: entry.size, mtimeMs: entry.mtimeMs });
    } catch {
      /* vanished between readdir and stat: not a backup we can vouch for */
    }
  }
  return listings.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
