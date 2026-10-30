/**
 * D-2/D-3: registry v0→v1 migration — 15 legacy fields preserved,
 * injected-failure rollback, canonical/duplicate identity aborts,
 * idempotent rerun, partial-schema detection, FK/constraint enforcement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NetworkRegistry } from "../src/node/registry.js";
import { migrateRegistryFile, syncDirectory } from "../src/node/registry-migration.js";
import { makeClosedV0, makeV0, tempDir } from "./fixtures/registry-v0.js";
// D-1 (WAL-safe backup, writer ownership) lives in registry-writers.test.ts: it needs real second processes.

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
    makeClosedV0(path, rows, [["ui.openPanel", '{"tab":"tasks"}']]);
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

test("D-3: injected failures roll back to intact v0 (except after-commit)", async () => {
  const dir = await tempDir();
  try {
    for (const failAt of ["preflight", "after-backup", "mid-transaction", "before-user-version"] as const) {
      const path = join(dir, `${failAt}.sqlite`);
      makeClosedV0(path, [{ id: "dev-a", token: "t".repeat(40) }]);
      // Exact message: an abort for any other reason (a lock, a stale handle) must not pass as the injected one.
      assert.throws(() => migrateRegistryFile(path, { failAt }), new RegExp(`injected: ${failAt}$`));
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
    makeClosedV0(path, [{ id: "dev-a" }]);
    assert.throws(() => migrateRegistryFile(path, { failAt: "after-commit" }), /injected: after-commit$/);
    assert.equal(migrateRegistryFile(path).action, "noop");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("D-3: duplicate UID / non-canonical UID / bad id / empty url abort before mutation", async () => {
  const dir = await tempDir();
  try {
    const uid = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
    const cases: { name: string; rows: Record<string, unknown>[]; reason: RegExp }[] = [
      { name: "duplicate-uid", rows: [{ id: "a", device_uid: uid }, { id: "b", device_uid: uid }], reason: /duplicate device_uid/ },
      { name: "uid-trailing-space", rows: [{ id: "a", device_uid: `${uid} ` }], reason: /non-canonical device_uid/ },
      { name: "uid-uppercase", rows: [{ id: "a", device_uid: uid.toUpperCase() }], reason: /non-canonical device_uid/ },
      { name: "id-trailing-space", rows: [{ id: "a " }], reason: /non-canonical device id/ },
      { name: "empty-url", rows: [{ id: "a", url: "" }], reason: /empty\/NULL url/ },
    ];
    for (const c of cases) {
      const path = join(dir, `${c.name}.sqlite`);
      makeClosedV0(path, c.rows);
      assert.throws(() => migrateRegistryFile(path), c.reason, c.name);
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

test("a v0 file that already carries v1-only objects is refused BEFORE the backup, naming the object", async () => {
  const dir = await tempDir();
  try {
    const cases: { name: string; ddl: string; offender: RegExp }[] = [
      { name: "stray-pairings-table", ddl: "CREATE TABLE pairings(x)", offender: /table pairings/ },
      { name: "stray-hub-meta-table", ddl: "CREATE TABLE hub_meta(key TEXT, value TEXT)", offender: /table hub_meta/ },
      { name: "stray-trigger", ddl: "CREATE TRIGGER events_no_update BEFORE UPDATE ON ui_state BEGIN SELECT RAISE(ABORT,'x'); END", offender: /trigger events_no_update/ },
      { name: "stray-index", ddl: "CREATE INDEX devices_uid_unique ON devices(id)", offender: /index devices_uid_unique/ },
      { name: "stray-view-named-like-v1-object", ddl: "CREATE VIEW tunnel_state AS SELECT 1 AS x", offender: /view tunnel_state/ },
    ];
    for (const c of cases) {
      const path = join(dir, `${c.name}.sqlite`);
      const db = makeV0(path, [{ id: "dev-a" }]);
      db.exec(c.ddl);
      db.close();
      assert.throws(
        () => migrateRegistryFile(path),
        (e: unknown) => /v1-only/.test(String(e)) && c.offender.test(String(e)),
        `${c.name}: refusal must be a MigrationError naming the object`,
      );
      const after = new DatabaseSync(path);
      assert.equal((after.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 0, `${c.name}: registry untouched`);
      after.close();
      assert.equal(existsSync(`${path}.pre-v1.bak`), false, `${c.name}: no backup was written`);
    }
    // The refusal happens inside preflightV0, BEFORE the "preflight" phase hook: a stray object
    // must win over an injected failAt at the same point, so the ordering of the check is pinned.
    const stray = join(dir, "hook-order.sqlite");
    const hookDb = makeV0(stray, [{ id: "dev-a" }]);
    hookDb.exec("CREATE TABLE pairings(x)");
    hookDb.close();
    assert.throws(() => migrateRegistryFile(stray, { failAt: "preflight" }), /table pairings/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a v0 file with unknown extra columns in devices or ui_state is refused BEFORE the backup, naming table and column", async () => {
  const dir = await tempDir();
  try {
    // Drift: one extra column per v0 table, each holding a value nobody intended
    // to carry (or drop) into v1. Same fail-closed rule as stray v1-only objects.
    const cases: { name: string; table: string; column: string; alter: string }[] = [
      { name: "devices-stray-column", table: "devices", column: "stray", alter: "ALTER TABLE devices ADD COLUMN stray TEXT" },
      { name: "ui-state-stray-column", table: "ui_state", column: "note", alter: "ALTER TABLE ui_state ADD COLUMN note TEXT" },
    ];
    for (const c of cases) {
      const path = join(dir, `${c.name}.sqlite`);
      const db = makeV0(path, [{ id: "dev-a" }], [["ui.panel", '"tasks"']]);
      db.exec(c.alter);
      db.prepare(`UPDATE ${c.table} SET ${c.column}='unintended'`).run();
      db.close();
      assert.throws(
        () => migrateRegistryFile(path),
        (e: unknown) => {
          const msg = String(e);
          return (
            msg.includes("registry migration: unknown v0 schema") &&
            msg.includes(c.table) &&
            msg.includes(`unknown column(s) ${c.column}`)
          );
        },
        `${c.name}: refusal must name the table and the offending column`,
      );
      const after = new DatabaseSync(path);
      assert.equal((after.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 0, `${c.name}: still v0`);
      after.close();
      assert.equal(existsSync(`${path}.pre-v1.bak`), false, `${c.name}: no backup was written`);
    }
    // Ordering, mirroring the stray-v1-object pin: the drift refusal happens inside
    // preflightV0, BEFORE the "preflight" phase hook, so it wins over an injected failAt.
    const drift = join(dir, "hook-order.sqlite");
    const hookDb = makeV0(drift, [{ id: "dev-a" }]);
    hookDb.exec("ALTER TABLE ui_state ADD COLUMN note TEXT");
    hookDb.close();
    assert.throws(() => migrateRegistryFile(drift, { failAt: "preflight" }), /unknown column/);
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
    makeClosedV0(path, [{ id: "dev-old", token: "k".repeat(44) }], [["k1", '"v1"']]);
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

test("D-1: the backup is one self-contained file — no -wal/-shm left beside it", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "network.sqlite");
    makeClosedV0(path, [{ id: "dev-a" }]);
    const result = migrateRegistryFile(path);
    assert.equal(result.action, "migrated");
    const beside = readdirSync(dir).filter((name) => name.startsWith("network.sqlite.pre-v1.bak"));
    assert.deepEqual(beside, ["network.sqlite.pre-v1.bak"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("D-1: the backup's DIRECTORY is fsynced too — syncDirectory opens a dir fd read-only, fsyncs it, and refuses a non-directory", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "network.sqlite");
    makeClosedV0(path, [{ id: "dev-a" }]);
    const result = migrateRegistryFile(path);
    assert.equal(result.action, "migrated");
    assert.ok(result.backupPath);
    // A real directory: open+fsync+close succeeds on POSIX (an fsync that fails would throw).
    assert.doesNotThrow(() => syncDirectory(dir));
    // A regular file is refused — the durability call must not silently fsync the wrong object class.
    assert.throws(() => syncDirectory(result.backupPath!), /not a directory/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("windows durability: syncDirectory and syncFile never throw EPERM on any platform (regression: dir fd fsync crashed dpi device on win32)", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "dpi-fsync-"));
  const file = join(dir, "probe");
  writeFileSync(file, "x");
  // On POSIX these genuinely fsync; on win32 the guard skips them (EPERM otherwise).
  assert.doesNotThrow(() => syncDirectory(dir), "syncDirectory must not throw on win32");
  const { fsyncReadOnlySupported } = await import("../src/node/registry-migration.js");
  if (fsyncReadOnlySupported) {
    // The read-only-file fsync is exercised through the same guard on win32.
    assert.equal(process.platform !== "win32", true, "guard is POSIX here");
  }
});

test("run-8 U9: the v0->v1 copy enforces the live writers' per-field policy (caps, normalizeUrl, validateToken)", async () => {
  const { NetworkRegistry } = await import("../src/node/registry.js");
  const dir = await tempDir();
  const path = join(dir, "network.sqlite");
  const bigTree = JSON.stringify({ blob: "y".repeat(400 * 1024) }); // > 288KiB cap
  makeClosedV0(path, [
    {
      id: "dev-big",
      url: "http://10.0.0.6:7900",
      token: "a".repeat(40),
      last_tree_json: bigTree,
      last_info_json: JSON.stringify({ ok: true }),
    },
    {
      id: "dev-badtoken",
      url: "http://10.0.0.7:7900",
      token: "abc\r\nX-Injected: 1",
    },
  ]);
  migrateRegistryFile(path);
  const reg = new NetworkRegistry(path);
  const big = reg.get("dev-big")!;
  assert.ok(big.lastTree == null, "an oversized legacy tree blob must be dropped, not re-parsed forever");
  assert.ok(big.lastInfo, "a within-cap blob survives");
  assert.ok(reg.get("dev-badtoken")!.token == null, "a token the writer would refuse must not migrate");
  reg.close();

  // A url the live writer refuses fails the migration CLOSED (url is NOT NULL,
  // and carrying an arbitrary scheme over would reach every consumer).
  const dir2 = await tempDir();
  const path2 = join(dir2, "network.sqlite");
  makeClosedV0(path2, [{ id: "dev-badurl", url: "javascript:alert(1)", token: "b".repeat(40) }]);
  assert.throws(() => migrateRegistryFile(path2), /url the live writer refuses|cannot be normalised|not an http/i);
});

test("run-8 U9: an aborted migration leaves the v0 file untouched (sanitising never happens in the read-only preflight)", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = await tempDir();
  const path = join(dir, "network.sqlite");
  // row A needs sanitising (oversized tree), row B makes the migration abort.
  makeClosedV0(path, [
    { id: "dev-a", url: "http://10.0.0.9:7900", token: "c".repeat(40), last_tree_json: JSON.stringify({ b: "z".repeat(300 * 1024) }) },
    { id: "dev-b", url: "javascript:alert(1)", token: "d".repeat(40) },
  ]);
  assert.throws(() => migrateRegistryFile(path), /url the live writer refuses/);
  const db = new DatabaseSync(path);
  const row = db.prepare("SELECT last_tree_json FROM devices WHERE id='dev-a'").get() as { last_tree_json: string };
  db.close();
  assert.equal(row.last_tree_json.length, JSON.stringify({ b: "z".repeat(300 * 1024) }).length, "the v0 row must not be rewritten by an aborted migration");
});
