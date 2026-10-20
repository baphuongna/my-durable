/**
 * D-1/D-2/D-3: registry v0→v1 migration — 15 legacy fields preserved, WAL-safe
 * backup, injected-failure rollback, canonical/duplicate identity aborts,
 * idempotent rerun, partial-schema detection, FK/constraint enforcement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NetworkRegistry } from "../src/node/registry.js";
import { migrateRegistryFile } from "../src/node/registry-migration.js";

/** Exact v0 bootstrap DDL (from registry.ts @ 37165c6) for true-v0 fixtures. */
const V0_DDL = `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
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

async function tempDir() {
  return mkdtemp(join(tmpdir(), "dpi-mig-"));
}

function makeV0(path: string, rows: Record<string, unknown>[] = [], uiState: [string, string][] = []) {
  const db = new DatabaseSync(path);
  db.exec(V0_DDL);
  const insert = db.prepare(
    `INSERT INTO devices(id,name,kind,url,token,source,position,device_uid,last_status,last_error,last_seen_at,last_info_json,last_tree_json,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const V = (v: unknown): string | number | null => (v === undefined || v === null ? null : (v as string | number));
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

test("fresh registry creates v1 directly with hub_id, FK on, rerun no-op", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "network.sqlite");
    const reg = new NetworkRegistry(path);
    const version = (reg.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    assert.equal(version, 1);
    assert.equal((reg.db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
    const hubId = (reg.db.prepare("SELECT value FROM hub_meta WHERE key='hub_id'").get() as { value: string }).value;
    assert.match(hubId, /^[0-9a-f-]{36}$/);
    for (const t of ["pairings", "tunnel_credentials", "tunnel_state", "events"])
      assert.ok(reg.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t), t);
    reg.close();
    // rerun = no-op validation
    const again = migrateRegistryFile(path);
    assert.equal(again.action, "noop");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("D-2: v0→v1 preserves all 15 fields, ui_state, order; transport='lan' makes 16 columns", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "network.sqlite");
    const rows = [
      { id: "b-dev", name: "Bravo", position: 1, token: "x".repeat(43), device_uid: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0", last_info_json: '{"model":"faux"}', last_tree_json: '{"nodes":[]}' },
      { id: "a-dev", name: "Alpha", position: 0, source: "config", last_status: "offline", last_error: "boom" },
      { id: "c-dev", name: "Charlie", position: 1, token: null },
    ];
    makeV0(path, rows, [["ui.openPanel", '{"tab":"tasks"}']]);
    const before = new DatabaseSync(path);
    const beforeRows = (before.prepare("SELECT * FROM devices ORDER BY position,id").all() as Record<string, unknown>[]);
    before.close();

    const result = migrateRegistryFile(path);
    assert.equal(result.action, "migrated");
    assert.ok(result.backupPath && existsSync(result.backupPath));

    const after = new DatabaseSync(path);
    const cols = (after.prepare("PRAGMA table_info(devices)").all() as { name: string }[]).map((c) => c.name);
    assert.equal(cols.length, 16);
    assert.ok(cols.includes("transport"));
    const afterRows = (after.prepare("SELECT * FROM devices ORDER BY position,id").all() as Record<string, unknown>[]);
    assert.equal(afterRows.length, 3);
    for (let i = 0; i < 3; i++) {
      for (const [k, v] of Object.entries(beforeRows[i])) {
        assert.deepEqual(afterRows[i][k], v, `field ${k} preserved`);
      }
      assert.equal(afterRows[i].transport, "lan");
    }
    assert.equal(afterRows[0].id, "a-dev"); // order preserved
    assert.equal(afterRows[1].id, "b-dev");
    const ui = after.prepare("SELECT value FROM ui_state WHERE key='ui.openPanel'").get() as { value: string };
    assert.equal(ui.value, '{"tab":"tasks"}');
    after.close();

    // idempotent rerun
    assert.equal(migrateRegistryFile(path).action, "noop");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("D-1: WAL counterexample — naive main-file copy misses WAL rows; migration backup contains them", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "network.sqlite");
    const db = makeV0(path, [{ id: "dev-a" }]);
    // Commit a row that stays in the WAL (no checkpoint, connection still open).
    db.exec("PRAGMA wal_autocheckpoint=0;");
    db.prepare(
      `INSERT INTO devices(id,name,kind,url,token,source,position,created_at,updated_at) VALUES('dev-wal','W','url','http://1.2.3.4:1',NULL,'ui',5,1,1)`,
    ).run();

    // Counterexample: copying only the main DB file loses dev-wal.
    const naivePath = join(dir, "naive.sqlite");
    await copyFile(path, naivePath);
    db.close();
    // The naive copy may lack even the schema (DDL itself can sit in the WAL).
    // Either way it must NOT see the WAL-committed row dev-wal.
    const naive = new DatabaseSync(naivePath, { readOnly: true });
    let naiveSeesWalRow = false;
    try {
      naiveSeesWalRow =
        (naive.prepare("SELECT count(*) AS n FROM devices WHERE id='dev-wal'").get() as { n: number }).n > 0;
    } catch {
      naiveSeesWalRow = false; // no such table — even stronger counterexample
    }
    naive.close();
    assert.equal(naiveSeesWalRow, false); // dev-wal is missing — the documented failure mode

    const result = migrateRegistryFile(path);
    const bak = new DatabaseSync(result.backupPath!, { readOnly: true });
    const bakCount = (bak.prepare("SELECT count(*) AS n FROM devices").get() as { n: number }).n;
    const bakCols = (bak.prepare("PRAGMA table_info(devices)").all() as unknown[]).length;
    bak.close();
    assert.equal(bakCount, 2); // WAL commits folded into the backup
    assert.equal(bakCols, 15); // backup opens as v0
    const mode = statSync(result.backupPath!).mode & 0o777;
    assert.equal(mode, 0o600);

    const after = new DatabaseSync(path);
    assert.equal((after.prepare("SELECT count(*) AS n FROM devices").get() as { n: number }).n, 2);
    after.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("D-3: injected failures roll back to intact v0 (except after-commit)", async () => {
  const dir = await tempDir();
  try {
    for (const failAt of ["preflight", "after-backup", "mid-transaction", "before-user-version"] as const) {
      const path = join(dir, `${failAt}.sqlite`);
      makeV0(path, [{ id: "dev-a", token: "t".repeat(40) }]);
      assert.throws(() => migrateRegistryFile(path, { failAt }), /injected|registry migration/);
      const db = new DatabaseSync(path);
      const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      const cols = (db.prepare("PRAGMA table_info(devices)").all() as unknown[]).length;
      const count = (db.prepare("SELECT count(*) AS n FROM devices").get() as { n: number }).n;
      const pairings = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pairings'").get();
      db.close();
      assert.equal(version, 0, `${failAt}: still v0`);
      assert.equal(cols, 15, `${failAt}: 15 columns intact`);
      assert.equal(count, 1, `${failAt}: data intact`);
      assert.equal(pairings, undefined, `${failAt}: no v1 tables leaked`);
    }
    // after-commit: DB is a valid v1 (the failure is post-state)
    const path = join(dir, "after-commit.sqlite");
    makeV0(path, [{ id: "dev-a" }]);
    assert.throws(() => migrateRegistryFile(path, { failAt: "after-commit" }), /injected/);
    assert.equal(migrateRegistryFile(path).action, "noop");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("D-3: duplicate UID / non-canonical UID / bad id / empty url abort before mutation", async () => {
  const dir = await tempDir();
  try {
    const uid = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
    const cases: { name: string; rows: Record<string, unknown>[] }[] = [
      { name: "duplicate-uid", rows: [{ id: "a", device_uid: uid }, { id: "b", device_uid: uid }] },
      { name: "uid-trailing-space", rows: [{ id: "a", device_uid: `${uid} ` }] },
      { name: "uid-uppercase", rows: [{ id: "a", device_uid: uid.toUpperCase() }] },
      { name: "id-trailing-space", rows: [{ id: "a " }] },
      { name: "empty-url", rows: [{ id: "a", url: "" }] },
    ];
    for (const c of cases) {
      const path = join(dir, `${c.name}.sqlite`);
      makeV0(path, c.rows);
      assert.throws(() => migrateRegistryFile(path), /registry migration/, c.name);
      const db = new DatabaseSync(path);
      assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 0, c.name);
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unknown / higher / partial schema aborts (no IF-NOT-EXISTS masking)", async () => {
  const dir = await tempDir();
  try {
    // unknown: extra column in devices
    const extra = join(dir, "extra.sqlite");
    const db1 = makeV0(extra);
    db1.exec("ALTER TABLE devices ADD COLUMN foo TEXT");
    db1.close();
    assert.throws(() => migrateRegistryFile(extra), /unknown v0 schema/);

    // higher version
    const newer = join(dir, "newer.sqlite");
    const db2 = makeV0(newer);
    db2.exec("PRAGMA user_version=7");
    db2.close();
    assert.throws(() => migrateRegistryFile(newer), /newer than supported/);

    // partial v1: version=1 but pairings dropped
    const partial = join(dir, "partial.sqlite");
    const db3 = makeV0(partial);
    db3.close();
    migrateRegistryFile(partial);
    const db4 = new DatabaseSync(partial);
    db4.exec("DROP TABLE pairings");
    db4.close();
    assert.throws(() => migrateRegistryFile(partial), /partial schema/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("v1 constraints: FK RESTRICT, tombstones, append-only audit, transport CHECK", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "network.sqlite");
    const reg = new NetworkRegistry(path);
    reg.upsert({ id: "dev-a", url: "http://10.0.0.5:7900", token: "x".repeat(40) });
    const db = reg.db;
    const t = Date.now();
    // FK: pairings must reference a real device
    assert.throws(() =>
      db.prepare("INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at) VALUES('ghost','e','pk','sha256:ab','paired',1,?, ?, ?)").run(t, t, t));
    // valid pairing + credential
    db.prepare("INSERT INTO pairings(device_id,pairing_epoch,public_key,key_fingerprint,status,credential_generation,paired_at,created_at,updated_at) VALUES('dev-a','epoch-1','pk','sha256:ab','paired',1,?,?,?)").run(t, t, t);
    db.prepare("INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at) VALUES('c1','dev-a','epoch-1',1,?, 'current',?)").run("a".repeat(64), t);
    // only one current per device
    assert.throws(() =>
      db.prepare("INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at) VALUES('c2','dev-a','epoch-1',2,?,'current',?)").run("b".repeat(64), t));
    // bad hash (non-hex / wrong length)
    assert.throws(() =>
      db.prepare("INSERT INTO tunnel_credentials(credential_id,device_id,pairing_epoch,generation,token_hash,status,created_at) VALUES('c3','dev-a','epoch-1',3,?,'retired',?)").run("z".repeat(64), t));
    // tombstone: delete forbidden; revoked immutable
    assert.throws(() => db.prepare("DELETE FROM tunnel_credentials WHERE credential_id='c1'").run());
    db.prepare("UPDATE tunnel_credentials SET status='revoked', revoked_at=? WHERE credential_id='c1'").run(t);
    assert.throws(() => db.prepare("UPDATE tunnel_credentials SET status='current' WHERE credential_id='c1'").run());
    // revoked row cannot be hard-deleted either (trigger fires on DELETE regardless)
    assert.throws(() => db.prepare("DELETE FROM tunnel_credentials WHERE credential_id='c1'").run());
    // audit append-only
    db.prepare("INSERT INTO events(ts,actor,action,outcome) VALUES(?,'admin','pair.code_created','ok')").run(t);
    assert.throws(() => db.prepare("UPDATE events SET action='x' WHERE id=1").run());
    assert.throws(() => db.prepare("DELETE FROM events WHERE id=1").run());
    // devices transport CHECK: tunnel rows must be url/token NULL; lan must have url
    assert.throws(() =>
      db.prepare("INSERT INTO devices(id,name,kind,url,token,source,position,created_at,updated_at,transport) VALUES('dev-t','T','url','http://x',NULL,'ui',0,1,1,'tunnel')").run());
    // tunnel + url NULL + token NULL is VALID; giving a tunnel row a token must fail.
    db.prepare("INSERT INTO devices(id,name,kind,url,token,source,position,created_at,updated_at,transport) VALUES('dev-t2','T','url',NULL,NULL,'ui',0,1,1,'tunnel')").run();
    assert.throws(() => db.prepare("UPDATE devices SET token='x' WHERE id='dev-t2'").run());
    assert.throws(() => db.prepare("UPDATE devices SET url='http://y' WHERE id='dev-t2'").run());
    assert.throws(() => db.prepare("UPDATE devices SET url=NULL WHERE id='dev-a'").run());
    // hard-delete a device with pairing history is RESTRICTed
    assert.throws(() => db.prepare("DELETE FROM devices WHERE id='dev-a'").run());
    reg.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("existing registry keeps working after auto-migration (upsert/list/ui)", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "network.sqlite");
    makeV0(path, [{ id: "dev-old", token: "k".repeat(44) }], [["k1", '"v1"']]);
    const reg = new NetworkRegistry(path); // constructor migrates
    const rows = reg.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "dev-old");
    assert.equal(rows[0].token, "k".repeat(44));
    assert.equal(reg.uiGet("k1"), "v1");
    reg.upsert({ id: "dev-new", url: "http://10.0.0.9:7900" });
    assert.equal(reg.list().length, 2);
    reg.uiSet("k2", { a: 1 });
    assert.deepEqual(reg.uiGet<{ a: number }>("k2"), { a: 1 });
    reg.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
