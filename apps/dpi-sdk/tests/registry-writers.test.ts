/**
 * D-1 writer ownership (spec 08 §D-1, 07 §7.1). The v0→v1 migration holds the
 * registry's only pre-upgrade history, so it must have the file to itself:
 * every hub, TUI or net script that opens network.sqlite holds a connection,
 * and the migration has to prove none is left rather than assume it.
 *
 * "Old-code writers" below are plain node:sqlite processes (the v0 shape of
 * those programs), so each scenario is real cross-process lock contention.
 *
 * Harness self-checks (never set in CI): DPI_TEST_WEDGE_WRITER=1 / DPI_TEST_WEDGE_RACER=1
 * suppress the child's "ready" line so the rig's bounded waits can be proven to
 * SIGKILL a never-ready child instead of hanging the runner until the test timeout:
 *   DPI_TEST_WEDGE_WRITER=1 tsx --test tests/registry-writers.test.ts  → fails at the 10 s bound
 *   DPI_TEST_WEDGE_RACER=1  tsx --test --test-name-pattern=racing tests/registry-writers.test.ts → fails at the 15 s bound
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { copyFile, rm } from "node:fs/promises";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { migrateRegistryFile } from "../src/node/registry-migration.js";
import { makeClosedV0, tempDir } from "./fixtures/registry-v0.js";

const WRITER_SCRIPT = `
const { DatabaseSync } = require("node:sqlite");
const [path, mode] = process.argv.slice(1);
const db = new DatabaseSync(path);
db.exec("PRAGMA busy_timeout=3000;");
const insert = (id) => db.prepare(
  "INSERT INTO devices(id,name,kind,url,source,position,created_at,updated_at) VALUES(?,?,'url','http://10.0.0.7:7900','ui',0,1,1)"
).run(id, id);
if (mode === "idle") db.prepare("SELECT count(*) FROM devices").get();
if (mode === "txn") { db.exec("BEGIN IMMEDIATE"); insert("dev-live"); }
if (mode === "wal") { db.exec("PRAGMA wal_autocheckpoint=0"); insert("dev-wal-1"); insert("dev-wal-2"); }
if (process.env.DPI_TEST_WEDGE_WRITER !== "1") process.stdout.write("ready\\n");
let buffered = "";
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  const lines = buffered.split("\\n");
  buffered = lines.pop();
  for (const line of lines) {
    if (line === "commit") { db.exec("COMMIT"); process.stdout.write("committed\\n"); }
    if (line === "exit") { db.close(); process.exit(0); }
  }
});
`;

type WriterMode = "idle" | "txn" | "wal";

/** Rejects with `onTimeout()`'s message after `ms` without ever leaving the underlying promise un-settled. */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(onTimeout())), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

class Writer {
  private out = "";
  private watchers: (() => void)[] = [];
  readonly exited: Promise<void>;

  private constructor(private readonly child: ChildProcessByStdio<Writable, Readable, null>) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.out += chunk;
      for (const watcher of this.watchers) watcher();
    });
    this.exited = new Promise((resolve) => child.once("exit", () => resolve()));
  }

  static async start(path: string, mode: WriterMode) {
    const child = spawn(process.execPath, ["--no-warnings", "-e", WRITER_SCRIPT, path, mode], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const writer = new Writer(child);
    try {
      await writer.line("ready");
    } catch (err) {
      // A child that never says ready must not outlive the wait that gave up on it.
      await writer.kill();
      throw err;
    }
    return writer;
  }

  line(text: string) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`writer never printed ${text}; got ${JSON.stringify(this.out)}`)), 10_000);
      const check = () => {
        if (!this.out.split("\n").includes(text)) return;
        clearTimeout(timer);
        resolve();
      };
      this.watchers.push(check);
      check();
    });
  }

  send(command: string) {
    this.child.stdin.write(`${command}\n`);
  }

  async stop() {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.send("exit");
      const graceful = await withTimeout(this.exited, 5_000, () => "did not exit on request within 5s").then(
        () => true,
        () => false,
      );
      if (!graceful) await this.kill(); // a wedged child must not hang the runner until the test timeout
    } else {
      await this.exited;
    }
  }

  async kill() {
    this.child.kill("SIGKILL");
    await this.exited;
  }
}

const ids = (db: DatabaseSync) =>
  (db.prepare("SELECT id FROM devices ORDER BY id").all() as { id: string }[]).map((r) => r.id);

function readState(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      version: (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      columns: (db.prepare("PRAGMA table_info(devices)").all() as unknown[]).length,
      ids: ids(db),
      v1Tables: (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('hub_meta','pairings','devices_v1_new')").all() as unknown[]).length,
    };
  } finally {
    db.close();
  }
}

test("D-1: a writer with an open transaction makes the migration abort — v0 untouched, no backup, retry after it stops keeps its rows", { timeout: 30_000 }, async () => {
  const dir = await tempDir();
  const path = join(dir, "network.sqlite");
  makeClosedV0(path, [{ id: "dev-a" }]);
  const writer = await Writer.start(path, "txn");
  try {
    const started = Date.now();
    assert.throws(() => migrateRegistryFile(path, { busyTimeoutMs: 150 }), /stop all registry writers/);
    assert.ok(Date.now() - started < 2_500, "abort is bounded by the busy timeout, not a hang");
    assert.deepEqual(readState(path), { version: 0, columns: 15, ids: ["dev-a"], v1Tables: 0 });
    assert.equal(existsSync(`${path}.pre-v1.bak`), false, "no backup from an aborted attempt");

    // The refused migration must not have hurt the writer.
    writer.send("commit");
    await writer.line("committed");
  } finally {
    await writer.stop();
  }

  try {
    const result = migrateRegistryFile(path);
    assert.equal(result.action, "migrated");
    const bak = new DatabaseSync(result.backupPath!, { readOnly: true });
    assert.deepEqual(ids(bak), ["dev-a", "dev-live"]);
    bak.close();
    assert.deepEqual(readState(path).ids, ["dev-a", "dev-live"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("D-1: a writer that merely holds the registry open (idle, no transaction) also blocks the migration", { timeout: 30_000 }, async () => {
  const dir = await tempDir();
  const path = join(dir, "network.sqlite");
  makeClosedV0(path, [{ id: "dev-a" }]);
  const writer = await Writer.start(path, "idle");
  try {
    // A TRUNCATE checkpoint succeeds against an idle connection, so it proves nothing about writers.
    assert.throws(() => migrateRegistryFile(path, { busyTimeoutMs: 150 }), /stop all registry writers/);
    assert.deepEqual(readState(path), { version: 0, columns: 15, ids: ["dev-a"], v1Tables: 0 });
    assert.equal(existsSync(`${path}.pre-v1.bak`), false);
  } finally {
    await writer.stop();
  }
  try {
    assert.equal(migrateRegistryFile(path).action, "migrated");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("D-1: rows committed by a writer that was killed live only in the WAL — a main-file copy loses them, the migration backup keeps them", { timeout: 30_000 }, async () => {
  const dir = await tempDir();
  const path = join(dir, "network.sqlite");
  makeClosedV0(path, [{ id: "dev-a" }]);
  const writer = await Writer.start(path, "wal");
  await writer.kill(); // no clean close, so nothing folds the WAL into the main file
  try {
    assert.ok(statSync(`${path}-wal`).size > 0, "premise: committed frames are still in the WAL");
    const naivePath = join(dir, "naive.sqlite");
    await copyFile(path, naivePath);
    const naive = new DatabaseSync(naivePath, { readOnly: true });
    assert.deepEqual(ids(naive), ["dev-a"], "a main-file copy misses the WAL rows (the documented failure mode)");
    naive.close();

    const result = migrateRegistryFile(path);
    assert.equal(result.action, "migrated");
    const bak = new DatabaseSync(result.backupPath!, { readOnly: true });
    assert.deepEqual(ids(bak), ["dev-a", "dev-wal-1", "dev-wal-2"]);
    assert.equal((bak.prepare("PRAGMA table_info(devices)").all() as unknown[]).length, 15, "backup opens as v0");
    assert.equal((bak.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
    bak.close();
    assert.equal(statSync(result.backupPath!).mode & 0o777, 0o600);
    assert.deepEqual(readState(path).ids, ["dev-a", "dev-wal-1", "dev-wal-2"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("D-1: a WAL left beside the backup by an earlier attempt is not replayed, and the stale sidecars are removed from disk", { timeout: 30_000 }, async () => {
  const dir = await tempDir();
  try {
    // A real WAL with valid frames, from a different database of the same shape.
    const other = join(dir, "other.sqlite");
    makeClosedV0(other, [{ id: "dev-a" }]);
    const stranger = await Writer.start(other, "wal");
    await stranger.kill();
    assert.ok(statSync(`${other}-wal`).size > 0);

    const path = join(dir, "network.sqlite");
    makeClosedV0(path, [{ id: "dev-a" }]);
    await copyFile(`${other}-wal`, `${path}.pre-v1.bak-wal`);
    writeFileSync(`${path}.pre-v1.bak-shm`, "stale");
    assert.ok(existsSync(`${path}.pre-v1.bak-wal`), "premise: a stale -wal sits beside the future backup");
    assert.ok(existsSync(`${path}.pre-v1.bak-shm`), "premise: a stale -shm sits beside the future backup");

    const result = migrateRegistryFile(path);
    assert.equal(result.action, "migrated");
    const bak = new DatabaseSync(result.backupPath!, { readOnly: true });
    assert.deepEqual(ids(bak), ["dev-a"], "the backup is this database, not the stranger's frames");
    bak.close();
    // The outcome above cannot see the cleanup: SQLite itself discards a foreign WAL
    // (salt mismatch) beside the freshly truncated backup, so rows alone would stay
    // correct even if the sidecars were never deleted. Pin the cleanup by filesystem
    // state instead. The migration removes exactly the backup's own sidecars — not
    // the registry's -wal/-shm, which belong to the migrated database's connection.
    assert.equal(existsSync(`${result.backupPath!}-wal`), false, "the stale -wal beside the backup is removed");
    assert.equal(existsSync(`${result.backupPath!}-shm`), false, "the stale -shm beside the backup is removed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- processes that start together --------------------------------------------------
// Each racer is a new-code process (hub, TUI, net script) that calls
// migrateRegistryFile on boot. They leave a shared gate within about a millisecond.

const MIGRATION_MODULE = fileURLToPath(new URL("../src/node/registry-migration.ts", import.meta.url));
const SDK_DIR = fileURLToPath(new URL("..", import.meta.url));

const RACER_SCRIPT = `
const [modulePath, path, timeoutArg] = process.argv.slice(1);
const { migrateRegistryFile } = await import(modulePath);
if (process.env.DPI_TEST_WEDGE_RACER !== "1") process.stdout.write("ready\\n");
const gate = Number(await new Promise((resolve) => process.stdin.once("data", (d) => resolve(String(d).trim()))));
while (Date.now() < gate - 5) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
while (Date.now() < gate) { /* spin to the gate */ }
try {
  const opts = timeoutArg ? { busyTimeoutMs: Number(timeoutArg) } : undefined;
  process.stdout.write(JSON.stringify({ action: migrateRegistryFile(path, opts).action }) + "\\n");
} catch (e) {
  process.stdout.write(JSON.stringify({ error: String(e && e.message || e) }) + "\\n");
}
`;

type RaceResult = { action?: string; error?: string };

const RACER_READY_TIMEOUT_MS = 15_000; // tsx boots in well under a second warm; this is the wedge bound
const RACER_DONE_TIMEOUT_MS = 45_000; // must fire before the test's 60 s timeout so the rig, not the runner, kills a wedged racer

async function race(path: string, racers: number, opts: { busyTimeoutMs?: number } = {}): Promise<RaceResult[]> {
  const procs: {
    child: ChildProcessByStdio<Writable, Readable, null>;
    out: string;
    ready: Promise<void>;
    done: Promise<RaceResult>;
  }[] = [];
  // A wedged racer must not outlive the wait that gave up on it: every failure path
  // below SIGKILLs the whole cohort instead of hanging until the test timeout.
  const killAll = () => {
    for (const p of procs) if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill("SIGKILL");
  };
  for (let i = 0; i < racers; i++) {
    const child = spawn(
      process.execPath,
      [
        "--import", "tsx", "--no-warnings", "--input-type=module", "-e", RACER_SCRIPT,
        MIGRATION_MODULE, path,
        ...(opts.busyTimeoutMs !== undefined ? [String(opts.busyTimeoutMs)] : []),
      ],
      { cwd: SDK_DIR, stdio: ["pipe", "pipe", "inherit"] },
    );
    const p: (typeof procs)[number] = { child, out: "", ready: Promise.resolve(), done: Promise.resolve({}) };
    procs.push(p);
    child.stdout.setEncoding("utf8");
    const waiters: (() => void)[] = [];
    child.stdout.on("data", (chunk: string) => {
      p.out += chunk;
      for (const wake of waiters) wake();
    });
    const waitFor = (predicate: () => boolean) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (predicate()) resolve();
        };
        waiters.push(check);
        check();
      });
    p.ready = (async () => {
      try {
        await withTimeout(waitFor(() => p.out.includes("ready\n")), RACER_READY_TIMEOUT_MS, () => `never printed ready within ${RACER_READY_TIMEOUT_MS}ms; output: ${JSON.stringify(p.out)}`);
      } catch (err) {
        killAll();
        throw new Error(`racer ${i} ${err instanceof Error ? err.message : String(err)} (cohort SIGKILLed)`);
      }
    })();
    p.done = new Promise<RaceResult>((resolve) =>
      child.once("exit", (code) => {
        const last = p.out.trim().split("\n").pop() ?? "";
        try {
          resolve(JSON.parse(last) as RaceResult);
        } catch {
          resolve({ error: `racer exited ${code} without a result: ${JSON.stringify(p.out)}` });
        }
      }),
    );
  }
  await Promise.all(procs.map((p) => p.ready));
  const gate = Date.now() + 250;
  for (const p of procs) p.child.stdin.end(`${gate}\n`); // EOF lets each racer exit once it has reported
  return Promise.all(
    procs.map((p, i) =>
      withTimeout(p.done, RACER_DONE_TIMEOUT_MS, () => {
        killAll();
        return `racer ${i} did not report within ${RACER_DONE_TIMEOUT_MS}ms; output: ${JSON.stringify(p.out)} (cohort SIGKILLed)`;
      }),
    ),
  );
}

const tally = (results: RaceResult[]) => {
  const out: Record<string, number> = {};
  for (const r of results) out[r.action ?? `error: ${r.error}`] = (out[r.action ?? `error: ${r.error}`] ?? 0) + 1;
  return out;
};

test("D-1: starters racing on a v0 registry — exactly one migrates, the rest see v1, nobody fails or loses rows", { timeout: 60_000 }, async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "network.sqlite");
    makeClosedV0(path, [{ id: "dev-a" }, { id: "dev-b", position: 1 }]);
    const results = await race(path, 4);
    assert.deepEqual(tally(results), { migrated: 1, noop: 3 });
    const state = readState(path);
    assert.equal(state.version, 1);
    assert.deepEqual(state.ids, ["dev-a", "dev-b"]);
    const db = new DatabaseSync(path, { readOnly: true });
    assert.equal((db.prepare("SELECT count(*) AS n FROM hub_meta WHERE key='hub_id'").get() as { n: number }).n, 1);
    assert.equal((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
    db.close();
    const bak = new DatabaseSync(`${path}.pre-v1.bak`, { readOnly: true });
    assert.deepEqual(ids(bak), ["dev-a", "dev-b"]);
    bak.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("D-1: starters racing on a missing registry — exactly one creates it, the rest see v1", { timeout: 60_000 }, async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "network.sqlite");
    const results = await race(path, 4);
    assert.deepEqual(tally(results), { fresh: 1, noop: 3 });
    assert.equal(readState(path).version, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("D-1: starters racing against a holder that outlives the busy timeout — every racer gets the documented refusal, every time", { timeout: 60_000 }, async () => {
  const dir = await tempDir();
  const path = join(dir, "network.sqlite");
  makeClosedV0(path, [{ id: "dev-a" }]);
  // Positive control for the probabilistic races above: this variant cannot pass by
  // luck. The holder keeps an open connection past every racer's busy timeout, so
  // each racer MUST report the refusal (or something is broken in the retry path).
  const holder = await Writer.start(path, "idle");
  try {
    for (let round = 0; round < 2; round++) {
      const results = await race(path, 4, { busyTimeoutMs: 400 });
      assert.equal(results.length, 4, `round ${round}`);
      for (const r of results) {
        assert.match(
          r.error ?? "",
          /another process still has the registry open — stop all registry writers/,
          `round ${round}: expected the documented refusal, got ${JSON.stringify(r)}`,
        );
      }
    }
    assert.equal(readState(path).version, 0, "the refused racers changed nothing");
    assert.equal(existsSync(`${path}.pre-v1.bak`), false, "no backup from a refused attempt");
  } finally {
    await holder.stop();
  }
  // And the documented retry outcome: once the holder is gone, the same starters converge.
  assert.deepEqual(tally(await race(path, 4)), { migrated: 1, noop: 3 });
  await rm(dir, { recursive: true, force: true });
});

// ---- a migrator killed mid-way ----------------------------------------------------
// SIGKILL gives no chance to roll back or close: the file must come out either as
// the intact v0 or as a complete v1, and the next start must finish the job.

const KILL_SCRIPT = `
import { writeSync } from "node:fs";
const [modulePath, path, target] = process.argv.slice(1);
const { migrateRegistryFile } = await import(modulePath);
try {
  migrateRegistryFile(path, {
    onPhase: (phase) => {
      writeSync(1, "phase:" + phase + "\\n");
      if (phase === target) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
    },
  });
  writeSync(1, "finished\\n");
} catch (e) {
  writeSync(1, "error:" + (e && e.message || e) + "\\n");
}
`;

async function killAt(path: string, phase: string) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--no-warnings", "--input-type=module", "-e", KILL_SCRIPT, MIGRATION_MODULE, path, phase],
    { cwd: SDK_DIR, stdio: ["ignore", "pipe", "inherit"] },
  );
  let out = "";
  child.stdout.setEncoding("utf8");
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const reached = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`never reached ${phase}; got ${JSON.stringify(out)}`)), 20_000);
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      if (out.split("\n").includes(`phase:${phase}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  try {
    await reached;
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
}

test("D-3: a migrator killed at any phase leaves the intact v0 or a complete v1, and the next start finishes", { timeout: 120_000 }, async () => {
  const dir = await tempDir();
  try {
    for (const phase of ["preflight", "after-backup", "mid-transaction", "before-user-version"]) {
      const path = join(dir, `${phase}.sqlite`);
      makeClosedV0(path, [{ id: "dev-a" }, { id: "dev-b", position: 1 }]);
      await killAt(path, phase);
      assert.deepEqual(readState(path), { version: 0, columns: 15, ids: ["dev-a", "dev-b"], v1Tables: 0 }, `${phase}: v0 intact`);
      const result = migrateRegistryFile(path);
      assert.equal(result.action, "migrated", `${phase}: next start migrates`);
      assert.deepEqual(readState(path).ids, ["dev-a", "dev-b"], `${phase}: rows kept`);
      const bak = new DatabaseSync(result.backupPath!, { readOnly: true });
      assert.deepEqual(ids(bak), ["dev-a", "dev-b"], `${phase}: backup is whole`);
      bak.close();
    }

    const committed = join(dir, "after-commit.sqlite");
    makeClosedV0(committed, [{ id: "dev-a" }, { id: "dev-b", position: 1 }]);
    await killAt(committed, "after-commit");
    const state = readState(committed);
    assert.equal(state.version, 1, "after-commit: the transaction was durable");
    assert.deepEqual(state.ids, ["dev-a", "dev-b"]);
    assert.equal(migrateRegistryFile(committed).action, "noop");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
