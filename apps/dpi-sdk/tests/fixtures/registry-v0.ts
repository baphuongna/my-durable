/** True-v0 `network.sqlite` fixtures shared by the migration tests. */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Exact v0 bootstrap DDL (from registry.ts @ 37165c6). */
export const V0_DDL = `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
CREATE TABLE IF NOT EXISTS devices(
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('local','ssh','exe-dev','url')),
  url TEXT NOT NULL, token TEXT,
  source TEXT NOT NULL DEFAULT 'ui' CHECK(source IN ('config','ui')),
  position INTEGER NOT NULL DEFAULT 0, device_uid TEXT,
  last_status TEXT NOT NULL DEFAULT 'checking', last_error TEXT,
  last_seen_at INTEGER, last_info_json TEXT, last_tree_json TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ui_state(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);`;

export const tempDir = () => mkdtemp(join(tmpdir(), "dpi-mig-"));

const V = (v: unknown): string | number | null => (v === undefined || v === null ? null : (v as string | number));

/** Creates a v0 registry and returns the creating connection, still open (a live writer). */
export function makeV0(path: string, rows: Record<string, unknown>[] = [], uiState: [string, string][] = []) {
  const db = new DatabaseSync(path);
  db.exec(V0_DDL);
  const insert = db.prepare(
    `INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,last_error,last_seen_at,last_info_json,last_tree_json,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const r of rows)
    insert.run(
      (r.id ?? "dev-a") as string, (r.name ?? "A") as string, (r.kind ?? "url") as string,
      (r.url ?? "http://10.0.0.5:7900") as string, V(r.token), (r.source ?? "ui") as string,
      V(r.position) ?? 0, V(r.device_uid), (r.last_status ?? "online") as string, V(r.last_error),
      V(r.last_seen_at) ?? 1760000000000, V(r.last_info_json), V(r.last_tree_json),
      V(r.created_at) ?? 1759999999000, V(r.updated_at) ?? 1760000001000,
    );
  for (const [k, v] of uiState) db.prepare("INSERT INTO ui_state(key,value,updated_at) VALUES(?,?,1)").run(k, v);
  return db;
}

/** Same data, but every connection is closed: no writer is left behind to block a migration. */
export function makeClosedV0(path: string, rows: Record<string, unknown>[] = [], uiState: [string, string][] = []) {
  makeV0(path, rows, uiState).close();
}
