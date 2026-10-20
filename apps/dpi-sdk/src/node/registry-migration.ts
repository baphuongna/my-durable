/**
 * network.sqlite schema v0 → v1 migration and maintenance (spec 07 §5/§7.2).
 *
 * Contract (all enforced here):
 * - Writers must be stopped: a TRUNCATE checkpoint must succeed, otherwise abort.
 * - Cold backup: checkpoint → close → copy (0600) → verify the copy opens and
 *   passes integrity_check. Never hot-copy the main DB, never delete WAL/SHM.
 * - One transaction rebuilds devices (15 legacy columns + transport='lan'),
 *   creates UID index, hub_meta, pairings, tunnel_credentials, tunnel_state,
 *   events + triggers; user_version=1 set INSIDE the transaction.
 * - Any injected failure rolls back to an intact v0 database.
 * - Rerun on valid v1 is a no-op; unknown/higher/partial-corrupt schema aborts
 *   (no CREATE IF NOT EXISTS masking).
 * - This module never touches agent.sqlite / catalog / app-state (different domain).
 */
import { DatabaseSync } from "node:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

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

export type MigrationFailPoint =
  | "preflight"
  | "after-backup"
  | "mid-transaction"
  | "before-user-version"
  | "after-commit";

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

/**
 * Bring the registry file at `path` to schema v1. Owns its connections so it
 * can do the cold-backup dance (checkpoint → close → copy → verify → reopen).
 * Throws on any failure; caller (hub/TUI boot) must not start on throw.
 */
export function migrateRegistryFile(
  path: string,
  opts: { failAt?: MigrationFailPoint; backup?: boolean } = {},
): RegistryMigrationResult {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fresh = !existsSync(path);
  let db = new DatabaseSync(path);
  if (fresh) chmodSync(path, 0o600);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;");

  try {
    const knownTables = ["devices", "ui_state"].filter((t) => tableExists(db, t));
    const otherTables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]
    ).map((r) => r.name);

    // ---- fresh database: create v1 directly
    if (otherTables.length === 0) {
      db.exec(DEVICES_V1_DDL.replace("{name}", "devices") + ";" + V1_SCHEMA_SQL);
      const hubId = randomUUID();
      db.prepare("INSERT INTO hub_meta(key,value) VALUES('hub_id',?)").run(hubId);
      db.exec(`PRAGMA user_version=${REGISTRY_SCHEMA_VERSION};`);
      return { action: "fresh", version: REGISTRY_SCHEMA_VERSION, hubId };
    }
    void knownTables;

    const version = userVersion(db);
    if (version === REGISTRY_SCHEMA_VERSION) {
      validateV1(db);
      return { action: "noop", version };
    }
    if (version > REGISTRY_SCHEMA_VERSION) {
      throw new MigrationError(`database schema v${version} is newer than supported v${REGISTRY_SCHEMA_VERSION}`);
    }
    if (version !== 0) throw new MigrationError(`unknown schema version ${version}`);

    // ---- v0 preflight: exact column set, canonical ids/uids, no duplicates
    const cols = columns(db, "devices");
    const expected = [...V0_COLUMNS];
    if (cols.length !== expected.length || expected.some((c, i) => cols[i] !== c)) {
      throw new MigrationError(`unknown v0 schema: devices columns ${JSON.stringify(cols)}`);
    }
    if (!tableExists(db, "ui_state")) throw new MigrationError("unknown v0 schema: missing ui_state");
    const v0Rows = db.prepare("SELECT id, url, device_uid FROM devices").all() as {
      id: string; url: string | null; device_uid: string | null;
    }[];
    const seenUid = new Set<string>();
    for (const row of v0Rows) {
      if (!DEVICE_ID_PATTERN.test(row.id)) throw new MigrationError(`non-canonical device id ${JSON.stringify(row.id)} — resolve manually (no trim)`);
      if (row.url === null || row.url.trim() === "") throw new MigrationError(`device ${row.id} has empty/NULL url — resolve manually`);
      if (row.device_uid !== null) {
        if (!UUID_CANONICAL.test(row.device_uid)) throw new MigrationError(`non-canonical device_uid on ${row.id}: ${JSON.stringify(row.device_uid)} — resolve manually (no trim)`);
        if (seenUid.has(row.device_uid)) throw new MigrationError(`duplicate device_uid ${row.device_uid} — operator must resolve before migration`);
        seenUid.add(row.device_uid);
      }
    }
    if (opts.failAt === "preflight") throw new MigrationError("injected: preflight");

    // ---- WAL-safe cold backup (writers must be stopped)
    const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
    if (checkpoint.busy !== 0) throw new MigrationError("WAL checkpoint busy — stop all registry writers (hub/TUI/net) before migrating");
    const preCount = (db.prepare("SELECT count(*) AS n FROM devices").get() as { n: number }).n;
    db.close();

    const backupPath = `${path}.pre-v1.bak`;
    if (opts.backup !== false) {
      copyFileSync(path, backupPath);
      chmodSync(backupPath, 0o600);
      const walSidecar = `${path}-wal`;
      if (existsSync(walSidecar)) copyFileSync(walSidecar, `${backupPath}-wal`);
      // Verify the backup: opens, integrity ok, v0-readable with the WAL data folded in.
      const bak = new DatabaseSync(backupPath, { readOnly: true });
      try {
        if (integrity(bak) !== "ok") throw new MigrationError("backup integrity_check failed");
        const bakCount = (bak.prepare("SELECT count(*) AS n FROM devices").get() as { n: number }).n;
        if (bakCount !== preCount) throw new MigrationError(`backup row count ${bakCount} != ${preCount} (WAL not folded?)`);
        const bakCols = columns(bak, "devices");
        if (bakCols.length !== 15) throw new MigrationError("backup is not readable as v0");
      } finally {
        bak.close();
      }
    }
    if (opts.failAt === "after-backup") throw new MigrationError("injected: after-backup");

    // ---- one-transaction migration
    db = new DatabaseSync(path);
    db.exec("PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;");
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
      if (opts.failAt === "mid-transaction") throw new MigrationError("injected: mid-transaction");
      db.exec("DROP TABLE devices; ALTER TABLE devices_v1_new RENAME TO devices;");
      db.exec(V1_SCHEMA_SQL);
      const hubId = randomUUID();
      db.prepare("INSERT INTO hub_meta(key,value) VALUES('hub_id',?)").run(hubId);
      if (opts.failAt === "before-user-version") throw new MigrationError("injected: before-user-version");
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
    if (opts.failAt === "after-commit") throw new MigrationError("injected: after-commit");
    return { action: "migrated", version: REGISTRY_SCHEMA_VERSION, backupPath, hubId: (db.prepare("SELECT value FROM hub_meta WHERE key='hub_id'").get() as { value: string }).value };
  } finally {
    try {
      db.close();
    } catch {
      /* closed already */
    }
  }
}
