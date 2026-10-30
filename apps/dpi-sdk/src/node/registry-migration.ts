/**
 * network.sqlite schema v0 → v1 migration and maintenance (spec 07 §5/§7.2).
 *
 * Contract (all enforced here):
 * - Writers must be stopped: a v0 file is migrated only while this process
 *   holds the file's EXCLUSIVE lock, which exists only when no other connection
 *   (hub, TUI, net script; idle or not) has it open. Otherwise abort.
 * - Backup under that lock: VACUUM INTO a 0600 file (a consistent snapshot that
 *   includes the WAL, never a raw copy of the main file) → fsync → verify the
 *   copy opens as v0 with every row and passes integrity_check. One file.
 * - One transaction rebuilds devices (15 legacy columns + transport='lan'),
 *   creates UID index, hub_meta, pairings, tunnel_credentials, tunnel_state,
 *   events + triggers; user_version=1 set INSIDE the transaction.
 * - Any injected failure rolls back to an intact v0 database.
 * - Rerun on valid v1 is a no-op; unknown/higher/partial-corrupt schema aborts
 *   (no CREATE IF NOT EXISTS masking).
 * - This module never touches agent.sqlite / catalog / app-state (different domain).
 */
import { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, existsSync, fstatSync, fsyncSync, openSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { ensurePrivateDir } from "./private-dir.js";
import { normalizeUrl, validateToken } from "./registry.js";

export const REGISTRY_SCHEMA_VERSION = 1;
const UUID_CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DEVICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The 15 legacy v0 columns, in order. */
const V0_COLUMNS = [
  "id", "name", "kind", "url", "token", "source", "position", "device_uid",
  "last_status", "last_error", "last_seen_at", "last_info_json", "last_tree_json",
  "created_at", "updated_at",
] as const;

const V1_TABLES = [
  "devices", "ui_state", "hub_meta", "pairings", "tunnel_credentials",
  "tunnel_state", "events",
] as const;

/** v1 DDL for everything except `devices` (identical for fresh + migration). */
const V1_SCHEMA_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS devices_uid_unique ON devices(device_uid)
  WHERE device_uid IS NOT NULL;
CREATE TABLE IF NOT EXISTS ui_state(
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS hub_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pairings(
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE RESTRICT,
  pairing_epoch TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('paired','revoked')),
  credential_generation INTEGER NOT NULL CHECK(credential_generation >= 1),
  rotation_id TEXT,
  rotation_target_credential_id TEXT,
  rotation_started_at INTEGER,
  rotation_requested_at INTEGER,
  paired_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK((rotation_id IS NULL AND rotation_target_credential_id IS NULL
          AND rotation_started_at IS NULL) OR
        (rotation_id IS NOT NULL AND rotation_target_credential_id IS NOT NULL
          AND rotation_started_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS tunnel_credentials(
  credential_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  pairing_epoch TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 1),
  token_hash TEXT NOT NULL UNIQUE
    CHECK(length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK(status IN ('current','previous','retired','revoked')),
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  retired_at INTEGER,
  revoked_at INTEGER,
  UNIQUE(device_id, pairing_epoch, generation),
  CHECK((status='revoked') = (revoked_at IS NOT NULL)),
  CHECK(status<>'retired' OR retired_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS credentials_one_current ON tunnel_credentials(device_id)
  WHERE status='current';
CREATE UNIQUE INDEX IF NOT EXISTS credentials_one_previous ON tunnel_credentials(device_id)
  WHERE status='previous';
CREATE TRIGGER IF NOT EXISTS credentials_no_delete BEFORE DELETE ON tunnel_credentials
BEGIN SELECT RAISE(ABORT, 'credential history is retained'); END;
CREATE TRIGGER IF NOT EXISTS credentials_no_revive
BEFORE UPDATE OF status, token_hash, device_id, pairing_epoch ON tunnel_credentials
WHEN OLD.status='revoked' AND
  (NEW.status<>'revoked' OR NEW.token_hash<>OLD.token_hash OR
   NEW.device_id<>OLD.device_id OR NEW.pairing_epoch<>OLD.pairing_epoch)
BEGIN SELECT RAISE(ABORT, 'revoked credential is immutable'); END;
CREATE TABLE IF NOT EXISTS tunnel_state(
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE RESTRICT,
  connection_id TEXT NOT NULL,
  connected_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  reader_count INTEGER NOT NULL CHECK(reader_count BETWEEN 0 AND 128)
);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  request_id TEXT,
  connection_id TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('ok','denied')),
  detail_json TEXT NOT NULL DEFAULT '{}'
    CHECK(json_valid(detail_json) AND length(CAST(detail_json AS BLOB)) <= 4096)
);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
`;

const DEVICES_V1_DDL = `
CREATE TABLE {name}(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('local','ssh','exe-dev','url')),
  url TEXT,
  token TEXT,
  source TEXT NOT NULL DEFAULT 'ui' CHECK(source IN ('config','ui')),
  position INTEGER NOT NULL DEFAULT 0,
  device_uid TEXT,
  last_status TEXT NOT NULL DEFAULT 'checking',
  last_error TEXT,
  last_seen_at INTEGER,
  last_info_json TEXT,
  last_tree_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  transport TEXT NOT NULL DEFAULT 'lan' CHECK(transport IN ('lan','tunnel')),
  CHECK((transport='lan' AND url IS NOT NULL) OR
        (transport='tunnel' AND url IS NULL AND token IS NULL))
)`;

/**
 * Objects the v1 schema owns, derived FROM the v1 DDL itself (no second hand-maintained
 * copy to drift), minus the two tables v0 already had. A v0 file that already contains
 * one of these is not a v0 file: it is half-migrated or hand-edited, and migrating it
 * with the IF-NOT-EXISTS DDL would silently carry the stray object into the new v1.
 */
const V1_ONLY_OBJECTS: readonly string[] = (() => {
  const names = new Set<string>();
  const ddl = `${DEVICES_V1_DDL.replace("{name}", "devices")};${V1_SCHEMA_SQL}`;
  for (const m of ddl.matchAll(/\bCREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER)\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    names.add(m[1]);
  }
  names.delete("devices"); // v0 and v1 both have it
  names.delete("ui_state"); // v0 and v1 both have it
  return [...names].sort();
})();

/** Column names of `table` from its CREATE TABLE statement in `ddl` (table-constraint rows skipped). */
function ddlColumns(ddl: string, table: string): readonly string[] {
  const m = ddl.match(new RegExp(`\\bCREATE TABLE (?:IF NOT EXISTS )?${table}\\s*\\(([^;]*)\\)`, "i"));
  if (!m) throw new Error(`cannot derive columns of ${table} from DDL`);
  const cols: string[] = [];
  let seg = "";
  let depth = 0;
  for (const ch of m[1]) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      cols.push(seg.trim().split(/\s+/)[0]);
      seg = "";
      continue;
    }
    seg += ch;
  }
  cols.push(seg.trim().split(/\s+/)[0]);
  return cols.filter(
    (c) => c && !/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)$/i.test(c),
  );
}

/**
 * The exact column set each v0 table must have (order included), derived from the DDL
 * constants above — devices from V0_COLUMNS, ui_state from the v1 DDL, whose ui_state is
 * identical to v0's (the only other table v0 had). No second hand-maintained copy to drift.
 */
const V0_TABLE_COLUMNS: readonly (readonly [string, readonly string[]])[] = [
  ["devices", V0_COLUMNS],
  ["ui_state", ddlColumns(V1_SCHEMA_SQL, "ui_state")],
];

export type MigrationFailPoint =
  | "preflight"
  | "after-backup"
  | "mid-transaction"
  | "before-user-version"
  | "after-commit";

export interface MigrationOptions {
  /** Test seam: throw `injected: <point>` when that phase is reached. */
  failAt?: MigrationFailPoint;
  /** Test seam: called as each phase is reached (crash drills block here and get killed). */
  onPhase?: (point: MigrationFailPoint) => void;
  /** `false` skips the cold backup (tests only). */
  backup?: boolean;
  /** How long to wait for other connections before giving up. Default 3000. */
  busyTimeoutMs?: number;
}

export interface RegistryMigrationResult {
  action: "fresh" | "migrated" | "noop";
  version: number;
  backupPath?: string;
  hubId?: string;
}

class MigrationError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(`registry migration: ${message}`);
  }
}

const DEFAULT_BUSY_TIMEOUT_MS = 3000;

function reached(opts: MigrationOptions, point: MigrationFailPoint): void {
  opts.onPhase?.(point);
  if (opts.failAt === point) throw new MigrationError(`injected: ${point}`);
}
const WRITERS_STILL_RUNNING =
  "another process still has the registry open — stop all registry writers (hub, TUI, net scripts) and retry";

const tableExists = (db: DatabaseSync, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

const userVersion = (db: DatabaseSync) =>
  (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

const integrity = (db: DatabaseSync) =>
  (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);
}

function validateV1(db: DatabaseSync): void {
  for (const table of V1_TABLES) {
    if (!tableExists(db, table)) throw new MigrationError(`partial schema: missing table ${table}`);
  }
  const cols = columns(db, "devices");
  if (cols.length !== 16 || !cols.includes("transport")) {
    throw new MigrationError("partial schema: devices is not v1 (16 columns incl. transport)");
  }
  for (const trigger of ["credentials_no_delete", "credentials_no_revive", "events_no_update", "events_no_delete"]) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger))
      throw new MigrationError(`partial schema: missing trigger ${trigger}`);
  }
  if (integrity(db) !== "ok") throw new MigrationError("integrity_check failed on v1 database");
}

const userTables = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(
    (r) => r.name,
  );

/**
 * Creates v1 directly in one transaction, so a crash or a starter arriving at
 * the same moment never sees a half-built schema. Returns undefined when
 * another starter built it first.
 */
function createFresh(db: DatabaseSync): RegistryMigrationResult | undefined {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (userTables(db).length > 0) {
      db.exec("ROLLBACK");
      return undefined;
    }
    db.exec(DEVICES_V1_DDL.replace("{name}", "devices") + ";" + V1_SCHEMA_SQL);
    const hubId = randomUUID();
    db.prepare("INSERT INTO hub_meta(key,value) VALUES('hub_id',?)").run(hubId);
    db.exec(`PRAGMA user_version=${REGISTRY_SCHEMA_VERSION};`);
    db.exec("COMMIT");
    return { action: "fresh", version: REGISTRY_SCHEMA_VERSION, hubId };
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* nothing was open */
    }
    throw e;
  }
}

/** Only v0 migrates; a v1 file is validated, anything else is refused. */
function assertMigratable(version: number): void {
  if (version > REGISTRY_SCHEMA_VERSION) {
    throw new MigrationError(`database schema v${version} is newer than supported v${REGISTRY_SCHEMA_VERSION}`);
  }
  if (version !== 0) throw new MigrationError(`unknown schema version ${version}`);
}

const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const isBusy = (e: unknown) => {
  const code = ((e as { errcode?: number }).errcode ?? 0) & 0xff;
  return code === 5 || code === 6; // SQLITE_BUSY / SQLITE_LOCKED
};

/**
 * Opens `path` and runs `ready` on it, closing and retrying with jitter while
 * another process holds a lock. SQLite's own busy handler does not cover
 * everything: the first switch of a new file to WAL fails at once, and a
 * connection in EXCLUSIVE mode keeps its shared lock while it waits to upgrade,
 * so two starters waiting that way would hold each other out until both timed out.
 */
function openWhenFree(path: string, busyTimeoutMs: number, ready: (db: DatabaseSync) => void): DatabaseSync {
  const deadline = Date.now() + busyTimeoutMs;
  for (;;) {
    const db = new DatabaseSync(path);
    try {
      ready(db);
      return db;
    } catch (e) {
      db.close();
      if (!isBusy(e) || Date.now() >= deadline) throw e;
      sleepMs(5 + Math.random() * 20);
    }
  }
}

/**
 * Opens `path` as its only connection, or throws. In WAL mode every open
 * connection, idle ones included, keeps a shared lock on the main file, so an
 * EXCLUSIVE lock exists only while no hub, TUI or net script has the registry
 * open. A TRUNCATE checkpoint cannot show that: it succeeds against idle
 * connections.
 */
function openExclusive(path: string, busyTimeoutMs: number): DatabaseSync {
  try {
    return openWhenFree(path, busyTimeoutMs, (db) => {
      db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA foreign_keys=ON;");
      db.prepare("SELECT count(*) FROM sqlite_master").get(); // the first read takes the lock
    });
  } catch (e) {
    if (isBusy(e)) throw new MigrationError(WRITERS_STILL_RUNNING, e);
    throw e;
  }
}

/** v0 preflight: no stray v1 objects, exact column set per v0 table, canonical ids/uids, no duplicates. */
function preflightV0(db: DatabaseSync): void {
  // First: anything the v1 schema owns means this is not a v0 file at all. Refused before
  // the backup is written and before any write touches the registry (the caller's
  // `reached(opts, "preflight")` hook still fires only after preflightV0 returns).
  const stray = db
    .prepare(
      `SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name IN (${V1_ONLY_OBJECTS.map(() => "?").join(",")}) ORDER BY name`,
    )
    .all(...V1_ONLY_OBJECTS) as { type: string; name: string }[];
  if (stray.length > 0)
    throw new MigrationError(
      `v0 database already contains v1-only object(s): ${stray.map((s) => `${s.type} ${s.name}`).join(", ")}`,
    );
  if (!tableExists(db, "ui_state")) throw new MigrationError("unknown v0 schema: missing ui_state");
  // Exact column set for every v0 table: extra (or missing/renamed) columns mean a
  // hand-edited file or an unknown v0.x — refused like everything else here, never
  // silently migrated or dropped.
  for (const [table, expected] of V0_TABLE_COLUMNS) {
    const cols = columns(db, table);
    if (cols.length !== expected.length || expected.some((c, i) => cols[i] !== c)) {
      const unknown = cols.filter((c) => !expected.includes(c));
      throw new MigrationError(
        `unknown v0 schema: table ${table} columns ${JSON.stringify(cols)}` +
          (unknown.length > 0 ? ` — unknown column(s) ${unknown.join(", ")}` : ""),
      );
    }
  }
  // run-8 U9: the v0 rows predate the writer-side caps and normalisation, and
  // the copy below is verbatim — a pre-run-7 registry could carry a hostile
  // 16MiB last_tree_json (parsed by EVERY NetworkRegistry.list() forever) or a
  // token with CRLF (breaking every client construction). Enforce the same
  // per-field policy at the migration seam: cap the JSON blobs and NULL out a
  // url/token that the live writers would have refused.
  const rows = db.prepare(
    "SELECT id, url, device_uid, token, last_info_json, last_tree_json FROM devices",
  ).all() as {
    id: string; url: string | null; device_uid: string | null;
    token: string | null; last_info_json: string | null; last_tree_json: string | null;
  }[];
  const INFO_CAP = 64 * 1024;
  const TREE_CAP = 288 * 1024;
  const normalize = db.prepare(
    "UPDATE devices SET url=?, token=?, last_info_json=?, last_tree_json=? WHERE id=?",
  );
  const seenUid = new Set<string>();
  for (const row of rows) {
    if (!DEVICE_ID_PATTERN.test(row.id)) throw new MigrationError(`non-canonical device id ${JSON.stringify(row.id)} — resolve manually (no trim)`);
    if (row.url === null || row.url.trim() === "") throw new MigrationError(`device ${row.id} has empty/NULL url — resolve manually`);
    if (row.device_uid !== null) {
      if (!UUID_CANONICAL.test(row.device_uid)) throw new MigrationError(`non-canonical device_uid on ${row.id}: ${JSON.stringify(row.device_uid)} — resolve manually (no trim)`);
      if (seenUid.has(row.device_uid)) throw new MigrationError(`duplicate device_uid ${row.device_uid} — operator must resolve before migration`);
      seenUid.add(row.device_uid);
    }
    let url: string = row.url;
    try {
      url = normalizeUrl(row.url);
    } catch {
      // The live writer would have refused this url; carrying it over would put
      // an arbitrary scheme in every consumer. Fail closed (url is NOT NULL).
      throw new MigrationError(`device ${row.id} has a url the live writer refuses — resolve manually`);
    }
    let token: string | null = row.token;
    if (token !== null) {
      try {
        validateToken(token);
      } catch {
        token = null;
      }
    }
    const capJson = (text: string | null, cap: number): string | null =>
      text !== null && text.length > cap ? null : text;
    const info = capJson(row.last_info_json, INFO_CAP);
    const tree = capJson(row.last_tree_json, TREE_CAP);
    if (url !== row.url || token !== row.token || info !== row.last_info_json || tree !== row.last_tree_json)
      normalize.run(url, token, info, tree, row.id);
  }
}

/**
 * Windows cannot fsync read-only or directory handles (FlushFileBuffers needs a write
 * handle; directory handles cannot be flushed at all — EPERM, errno -4048). POSIX-only
 * durability steps are skipped there: NTFS journaling plus the atomic rename carry it.
 */
export const fsyncReadOnlySupported = process.platform !== "win32";

function syncFile(file: string): void {
  if (!fsyncReadOnlySupported) return;
  const fd = openSync(file, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * fsyncs a DIRECTORY (POSIX: a read-only fd on a directory can be fsynced), so the
 * directory entry of a file that was just created and fsynced survives power loss.
 * Syncing only the file is not enough: the file's data can be durable while the
 * link that names it is not, and the file then simply does not exist after a crash.
 * Exported for a focused unit test — the fsync itself is not observable from JS.
 */
export function syncDirectory(dir: string): void {
  if (!fsyncReadOnlySupported) return; // Windows: directory fds cannot be fsynced (EPERM)
  const fd = openSync(dir, "r");
  try {
    if (!fstatSync(fd).isDirectory()) throw new Error(`not a directory: ${dir}`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Snapshots the registry with SQLite itself (VACUUM INTO), so the copy includes
 * everything committed to the WAL and is taken without a second handle on the
 * file: on POSIX, closing any descriptor of a file drops every lock the process
 * holds on it, which would silently end the exclusive lock the caller relies on.
 * Then proves the copy opens as v0 with every row. The copy is one file.
 */
function writeBackup(db: DatabaseSync, backupPath: string, expectedRows: number): void {
  const sidecars = [`${backupPath}-wal`, `${backupPath}-shm`];
  // Leftovers of an aborted earlier attempt must not be replayed onto the new copy.
  // SQLite itself drops a WAL found beside a zero-page file, so removing the sidecars
  // is belt and braces: the outcome (not this call) is what the stale-WAL test pins.
  for (const stale of [backupPath, ...sidecars]) rmSync(stale, { force: true });
  writeFileSync(backupPath, "", { mode: 0o600, flag: "wx" }); // VACUUM INTO fills an empty file; 0600 from the start
  db.prepare("VACUUM INTO ?").run(backupPath);
  syncFile(backupPath); // the only way back: durable before the registry is touched
  syncDirectory(dirname(backupPath)); // and its directory entry too: a durable file no one can name is no backup
  const bak = new DatabaseSync(backupPath, { readOnly: true });
  try {
    if (integrity(bak) !== "ok") throw new MigrationError("backup integrity_check failed");
    const rows = (bak.prepare("SELECT count(*) AS n FROM devices").get() as { n: number }).n;
    if (rows !== expectedRows) throw new MigrationError(`backup row count ${rows} != ${expectedRows}`);
    if (columns(bak, "devices").length !== 15) throw new MigrationError("backup is not readable as v0");
  } finally {
    bak.close();
  }
}

/** Runs with the file's exclusive lock held; `db` is the only connection to it. */
function migrateV0(db: DatabaseSync, path: string, opts: MigrationOptions): RegistryMigrationResult {
  // What was read before the lock was taken may be stale: a peer that started
  // at the same moment can have migrated while this process waited for it.
  const version = userVersion(db);
  if (version === REGISTRY_SCHEMA_VERSION) {
    validateV1(db);
    return { action: "noop", version };
  }
  assertMigratable(version);

  preflightV0(db);
  reached(opts, "preflight");

  const preCount = (db.prepare("SELECT count(*) AS n FROM devices").get() as { n: number }).n;

  const backupPath = `${path}.pre-v1.bak`;
  if (opts.backup !== false) writeBackup(db, backupPath, preCount);
  reached(opts, "after-backup");

  // ---- one-transaction migration
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(DEVICES_V1_DDL.replace("{name}", "devices_v1_new"));
    db.exec(
      `INSERT INTO devices_v1_new(id,name,kind,url,token,source,position,device_uid,
         last_status,last_error,last_seen_at,last_info_json,last_tree_json,
         created_at,updated_at,transport)
       SELECT id,name,kind,url,token,source,position,device_uid,
         last_status,last_error,last_seen_at,last_info_json,last_tree_json,
         created_at,updated_at,'lan'
       FROM devices`,
    );
    reached(opts, "mid-transaction");
    db.exec("DROP TABLE devices; ALTER TABLE devices_v1_new RENAME TO devices;");
    db.exec(V1_SCHEMA_SQL);
    const hubId = randomUUID();
    db.prepare("INSERT INTO hub_meta(key,value) VALUES('hub_id',?)").run(hubId);
    reached(opts, "before-user-version");
    db.exec(`PRAGMA user_version=${REGISTRY_SCHEMA_VERSION};`);
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back by close */
    }
    throw e;
  }
  if (integrity(db) !== "ok") throw new MigrationError("integrity_check failed after migration");
  const fk = db.prepare("PRAGMA foreign_key_check").all();
  if (fk.length > 0) throw new MigrationError(`foreign_key_check failed: ${JSON.stringify(fk)}`);
  // Re-validate the v1 invariants on the thing just produced — never hand back an
  // action:"migrated" for a schema this module itself would refuse on a rerun.
  validateV1(db);
  reached(opts, "after-commit");
  return {
    action: "migrated",
    version: REGISTRY_SCHEMA_VERSION,
    backupPath,
    hubId: (db.prepare("SELECT value FROM hub_meta WHERE key='hub_id'").get() as { value: string }).value,
  };
}

/**
 * Bring the registry file at `path` to schema v1. Owns its connections: a
 * v0 file is migrated while holding the only connection to it (snapshot backup,
 * then one transaction). Throws on any failure; the caller (hub/TUI boot)
 * must not start on throw.
 */
export function migrateRegistryFile(path: string, opts: MigrationOptions = {}): RegistryMigrationResult {
  const busyTimeoutMs = opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  ensurePrivateDir(dirname(path));
  const fresh = !existsSync(path);
  let db = openWhenFree(path, busyTimeoutMs, (c) => {
    if (fresh) chmodSync(path, 0o600);
    c.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`);
  });

  try {
    if (userTables(db).length === 0) {
      const created = createFresh(db);
      if (created) return created;
    }

    const version = userVersion(db);
    if (version === REGISTRY_SCHEMA_VERSION) {
      validateV1(db);
      return { action: "noop", version };
    }
    assertMigratable(version);

    // v0: migrating needs the file to itself. Release this connection first so
    // two processes starting together cannot each hold the other out.
    db.close();
    db = openExclusive(path, busyTimeoutMs);
    return migrateV0(db, path, opts);
  } finally {
    try {
      db.close();
    } catch {
      /* closed already */
    }
  }
}
