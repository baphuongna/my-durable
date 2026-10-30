/**
 * Bounded, single-attempt salvage of an unreadable session database (R7).
 *
 * R5 store audit finding: garbage in the SQLite header (the audit recipe wrote
 * 0x41 over bytes 32-64) hides intact data forever — the close-path WAL
 * checkpoint folds the WAL into the corrupt main file without ever fixing
 * page 1, and the only recovery was a manual header patch. The auditor proved
 * the patch on a copy: fix the first 100 header bytes, integrity_check passes,
 * every entry reads back.
 *
 * `salvageSessionDb` automates exactly that, conservatively:
 *
 *   1. COPY the db aside (`<db>.salvage`, plus its `-wal`/`-shm` sidecars when
 *      present, so an unclean shutdown's frames replay onto the copy). The
 *      original file is NEVER opened for write and never modified.
 *   2. Patch the copy's first 100 header bytes: restore the magic string, a
 *      legal page size and versions when they are garbage, zero the freelist
 *      and the auto-vacuum root page (garbage there turns ptrmap validation
 *      on), and re-seat the schema-format and text-encoding fields. Every
 *      write targets header fields sqlite validates at open; page data is
 *      untouched, so a wrong guess can only fail integrity_check, never
 *      "recover" to something wrong.
 *   3. `PRAGMA integrity_check` on the copy. Only "ok" counts.
 *   4. Promote on the caller's thread: the original is renamed aside
 *      (`<db>.corrupt-<ts>` — the house quarantine rule: it is the only copy
 *      of that data, so it is kept, never deleted) and the copy is atomically
 *      renamed into place.
 *
 * The whole attempt runs in a worker thread under a hard time ceiling
 * (`SALVAGE_CEILING_MS`): `PRAGMA integrity_check` is synchronous, so on a
 * pathological multi-gigabyte database the only honest bound is terminating
 * the worker — the device's event loop never stalls, and the open path fails
 * on schedule instead of hanging. On timeout or any failure the copy files
 * are removed and the original is left byte-identical.
 */
import { Worker } from "node:worker_threads";
import { existsSync, linkSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";

/** The open path must never hang on salvage: everything above this ceiling is abandoned. */
export const SALVAGE_CEILING_MS = 5_000;

/** What happened to ONE salvage attempt. Bounded and secret-free — it reaches operator surfaces. */
export interface SalvageOutcome {
  /** Always true when salvageSessionDb returned: the attempt was made. */
  attempted: boolean;
  /** The patched copy passed integrity_check and was promoted into place. */
  recovered: boolean;
  /** Why the salvage did not recover, when it did not. */
  reason?: string;
  /** Where the original (still corrupt) file was kept when promotion happened. */
  keptAs?: string;
}

/**
 * The copy/patch/integrity_check work, as plain CommonJS so it can run in a
 * `new Worker(src, { eval: true })` thread. No imports of project code: the
 * worker is self-contained and terminable at any instruction.
 */
const WORKER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
const { copyFileSync, existsSync, lstatSync, readSync, openSync, closeSync, rmSync, writeSync } = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const main = workerData.dbPath;
const copy = workerData.copyPath; // R10 5.2: unique per attempt — two workers never share scratch files
const fail = (reason) => parentPort.postMessage({ ok: false, reason: String(reason).slice(0, 80) });
/** run-8 U7: the copy source must be a REGULAR file of bounded size. Nothing
 *  validated it (archived.ts lstats the same name for reads), so a planted
 *  symlink to /dev/zero, a FIFO or a huge file turned this into an unbounded
 *  synchronous copy — and the 5s ceiling only settles the parent promise, it
 *  cannot recall a thread blocked in a native fs call. */
const MAX_DB_BYTES = 256 * 1024 * 1024;
function assertRegular(path, label) {
  let st;
  try {
    st = lstatSync(path, { throwIfNoEntry: false });
  } catch {
    return "unreadable";
  }
  if (!st) return "missing";
  if (!st.isFile()) return label + " is not a regular file";
  if (st.size > MAX_DB_BYTES) return label + " is too large to salvage";
  return null;
}
function run() {
try {
  // 1. Copy main + sidecars aside. The original is only ever read.
  const bad = assertRegular(main, "database");
  if (bad) return fail(bad);
  for (const suffix of ["-wal", "-shm"]) {
    if (!existsSync(main + suffix)) continue;
    const sideBad = assertRegular(main + suffix, "database" + suffix);
    if (sideBad && sideBad !== "missing") return fail(sideBad);
  }
  rmSync(copy, { force: true });
  copyFileSync(main, copy);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(main + suffix)) copyFileSync(main + suffix, copy + suffix);
    else rmSync(copy + suffix, { force: true });
  }
  // 2. Patch the copy's header: only fields sqlite validates at open (see module doc).
  // run-8 U7: patch the first 100 header bytes positionally — reading and
  // rewriting the WHOLE database cost ~2x its size in RSS for a 100-byte fix.
  const HEADER_BYTES = 100;
  const fd = openSync(copy, "r+");
  let b;
  try {
    b = Buffer.alloc(HEADER_BYTES);
    const n = readSync(fd, b, 0, HEADER_BYTES, 0);
    if (n < HEADER_BYTES) return fail("truncated database header");
  } finally {
    closeSync(fd);
  }
  const MAGIC = "SQLite format 3\\0";
  if (b.slice(0, 16).toString("latin1") !== MAGIC) b.write(MAGIC, 0, 16, "latin1");
  const pageSize = b.readUInt16BE(16);
  const legalPageSize = pageSize === 1 || (pageSize >= 512 && pageSize <= 32768 && (pageSize & (pageSize - 1)) === 0);
  if (!legalPageSize) b.writeUInt16BE(4096, 16); // sqlite's default; a wrong guess fails integrity, never lies
  if (b[18] !== 1 && b[18] !== 2) b[18] = 2; // write version: WAL (pi-durable's journal mode)
  if (b[19] !== 1 && b[19] !== 2) b[19] = 2; // read version
  if (b[20] > 32) b[20] = 0; // reserved bytes per page: node:sqlite uses 0
  b.writeUInt32BE(0, 32); // first freelist trunk page (garbage here = freelist corruption)
  b.writeUInt32BE(0, 36); // freelist page count
  const schemaFormat = b.readUInt32BE(44);
  if (!(schemaFormat >= 1 && schemaFormat <= 4)) b.writeUInt32BE(4, 44); // "unsupported file format" otherwise
  b.writeUInt32BE(0, 52); // largest root b-tree page: nonzero garbage turns ptrmap validation on
  const encoding = b.readUInt32BE(56);
  if (!(encoding >= 1 && encoding <= 3)) b.writeUInt32BE(1, 56); // UTF-8
  const wfd = openSync(copy, "r+");
  try {
    writeSync(wfd, b, 0, b.length, 0);
  } finally {
    closeSync(wfd);
  }
  // 3. Integrity is the ONLY gate for promotion.
  let db;
  try {
    db = new DatabaseSync(copy); // read-write: a copied -wal may need recovery replay
    const rows = db.prepare("PRAGMA integrity_check").all();
    const ok = rows.length === 1 && rows[0].integrity_check === "ok";
    if (!ok) {
      db.close();
      db = undefined;
      parentPort.postMessage({ ok: false, reason: "integrity check failed" });
      return;
    }
    // Fold any replayed WAL into the copy so the promoted file is self-contained
    // (the same checkpoint pi-durable's own close runs).
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    db = undefined;
    parentPort.postMessage({ ok: true });
  } finally {
    try { db && db.close(); } catch (e) {}
  }
} catch (error) {
  fail((error && error.message) || error);
}
}
run();
`;

const rmCopyFiles = (copyPath: string) => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(copyPath + suffix, { force: true });
};

/** R10 5.2: a scratch name unique per attempt, so a second salvage on the same
 *  session (two routes opening one corrupt db concurrently) can never eat the
 *  first attempt's in-flight copy — the audit's strand-the-db scenario. */
const scratchPath = (dbPath: string): string =>
  `${dbPath}.salvage-${process.pid.toString(36)}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

/** Promote the verified copy (R10 5.1: crash-window free). The ORIGINAL and its
 *  sidecars are hardlink-kept aside FIRST (link(2) — same bytes, no copy), the
 *  stale live sidecars are then removed, and ONE atomic rename puts the copy in
 *  place. At every crash point either the original or the promoted copy sits at
 *  the db path — never neither:
 *   - before the sidecar rm: retry sees the untouched original (+ its sidecars).
 *   - after it, before the rename: the original main is still in place (its
 *     sidecars live on via the aside links; a retry re-salvages to the last
 *     checkpoint — the honest-stale case, disclosed in the promote warning). */
const promote = (dbPath: string, copyPath: string): string => {
  const aside = `${dbPath}.corrupt-${Date.now()}`;
  linkSync(dbPath, aside);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(dbPath + suffix)) {
      linkSync(dbPath + suffix, `${aside}${suffix}`);
      rmSync(dbPath + suffix, { force: true }); // stale against the promoted main
    }
  }
  renameSync(copyPath, dbPath); // POSIX rename: atomic replace
  rmCopyFiles(copyPath); // the copy's own sidecars were checkpointed away; drop leftovers
  return aside;
};

/**
 * ONE bounded salvage attempt for the session db at `dbPath`. Resolves — never
 * rejects: a salvage that cannot run is a failed salvage, and the caller's
 * failure surface (not this module) owns what the client sees.
 */
export function salvageSessionDb(dbPath: string, ceilingMs: number = SALVAGE_CEILING_MS): Promise<SalvageOutcome> {
  return new Promise((resolve) => {
    let worker: Worker;
    const copyPath = scratchPath(dbPath); // R10 5.2: unique scratch per attempt
    try {
      worker = new Worker(WORKER_SRC, { eval: true, workerData: { dbPath, copyPath } });
    } catch {
      resolve({ attempted: false, recovered: false, reason: "salvage worker unavailable" });
      return;
    }
    let settled = false;
    const finish = (result: SalvageOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => {});
      let outcome = result;
      if (outcome.recovered) {
        try {
          outcome = { ...outcome, keptAs: promote(dbPath, copyPath) };
        } catch {
          outcome = { attempted: true, recovered: false, reason: "promotion failed" };
        }
      }
      if (!outcome.recovered) rmCopyFiles(copyPath);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      finish({ attempted: true, recovered: false, reason: `timed out after ${ceilingMs}ms` });
    }, Math.max(0, ceilingMs));
    worker.once("message", (message: { ok?: boolean; reason?: string }) => {
      if (message?.ok) finish({ attempted: true, recovered: true });
      else finish({ attempted: true, recovered: false, reason: message?.reason ?? "salvage failed" });
    });
    worker.once("error", (error: Error) => finish({ attempted: true, recovered: false, reason: error.name }));
    worker.once("exit", () => finish({ attempted: true, recovered: false, reason: "salvage worker exited" }));
  });
}

/**
 * The operator-facing note when a salvage was attempted and did not recover.
 * House pattern of `sessionFailureMessage`, extended so the session list says
 * a salvage WAS attempted (and that the original file is untouched — the one
 * fact an operator needs before reaching for a backup).
 */
export const salvageFailureNote = (outcome: SalvageOutcome): string =>
  `Session failed and is unavailable (UnreadableStorage); a salvage copy was attempted but ${
    outcome.reason ? `failed (${outcome.reason}); ` : "did not pass integrity checks; "
  }the original file is untouched`;
