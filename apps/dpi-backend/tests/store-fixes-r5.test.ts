// R5 store-lane fixes, each driven against the real Store + HTTP stack:
//   1 (HIGH) a transient storage failure (a held sqlite lock) must fail ONE request with a
//            retryable, bounded fault — and the next request after release must succeed
//            WITHOUT a device restart (the old code soft-bricked the session for the
//            process lifetime).
//   2        create() and rename() share the whole name rule, control characters included.
//   3        a corrupt catalog.sqlite quarantines + re-seeds from sessions/ instead of
//            crash-looping every boot.
//   4        the catalog carries a schema version: old shapes migrate (ALTER ladder),
//            future versions refuse cleanly, inserts are named-column (never positional).
//   5        raw sqlite errors map to bounded typed faults; internals never reach clients.
//   6        `dpi gc --closed-before 12h` (the CLI's advertised units) plans instead of
//            throwing a raw stack.
//   7        a second device start exits cleanly ("already running (pid N)") with no crash
//            report, instead of an uncaught exception.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { createServer } from "node:http";
import { Store } from "../src/store.js";
import { bearerAuth } from "../src/auth.js";
import { ApiFault, errorMiddleware, isStorageBusy, isUnreadableStorage } from "../src/errors.js";
import { v1 } from "../src/routes.js";
import { gcPlan, parseDuration } from "../src/gc.js";
import { gcCli, type GcIo } from "../src/gc-cli.js";
import { bootServer, faux, freePort, newToken, tempStore, until } from "./helpers.js";

const DAY = 86_400_000;

// -------------------------------------------------------------- in-process HTTP rig

async function inProcessBackend(name = "r5-store-box") {
  const t = await tempStore();
  const token = newToken();
  const store = await Store.open({
    dataDir: join(t.root, "data"),
    startDirs: [t.work],
    name,
    provider: "faux",
  });
  const app = express();
  app.disable("x-powered-by");
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.use("/v1", bearerAuth(token), express.json({ limit: "256kb" }), v1(store));
  app.use((_req, res) => res.status(404).json({ error: { code: "not_found", message: "Route not found" } }));
  app.use(errorMiddleware);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await store.close().catch(() => {});
    await t.cleanup();
  };
  return { t, store, base, api, close };
}

function callErrorMiddleware(err: unknown) {
  let status = 0;
  let body: { error?: { code?: string; message?: string } } | undefined;
  const res = {
    headersSent: false,
    status(s: number) {
      status = s;
      return this;
    },
    json(b: unknown) {
      body = b as typeof body;
      return this;
    },
    end() {},
  } as never;
  errorMiddleware(err, { method: "POST", path: "/v1/x" } as never, res, (() => {}) as never);
  return { status, body };
}

// -------------------------------------------------------------- finding 5: bounded sqlite faults

test("sqlite errors map to bounded typed faults; internals never reach the client", () => {
  const busy = Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
  assert.ok(isStorageBusy(busy));
  let mapped = callErrorMiddleware(busy);
  assert.equal(mapped.status, 503);
  assert.equal(mapped.body?.error?.code, "unavailable");
  assert.doesNotMatch(String(mapped.body?.error?.message), /database is locked|SQLITE/i, "raw sqlite text is stripped");

  const schema = Object.assign(new Error("no such column: provider"), { code: "ERR_SQLITE_ERROR", errcode: 1 });
  mapped = callErrorMiddleware(schema);
  assert.equal(mapped.status, 503);
  assert.equal(mapped.body?.error?.code, "unavailable");
  assert.doesNotMatch(String(mapped.body?.error?.message), /no such column|provider/i);

  const corrupt = Object.assign(new Error("file is not a database"), { code: "ERR_SQLITE_ERROR", errcode: 26 });
  assert.ok(isUnreadableStorage(corrupt));
  const foreign = Object.assign(new Error("unsupported file format"), { code: "ERR_SQLITE_ERROR", errcode: 1 });
  assert.ok(isUnreadableStorage(foreign), "the corrupt-header shape (bytes 32-64 garbage) is recognized");
  mapped = callErrorMiddleware(foreign);
  assert.equal(mapped.status, 503);
  assert.doesNotMatch(String(mapped.body?.error?.message), /unsupported file format/i);

  // Non-sqlite errors keep their existing mapping: a plain throw is still a 500 internal.
  const plain = callErrorMiddleware(new Error("boom"));
  assert.equal(plain.status, 500);
  assert.equal(plain.body?.error?.code, "internal");
  assert.equal(plain.body?.error?.message, "boom");
});

// -------------------------------------------------------------- finding 2: one name rule for create AND rename

test("create rejects control characters (the rule rename already enforced)", async () => {
  const t = await tempStore();
  const store = await Store.open({ dataDir: join(t.root, "data"), startDirs: [t.work], name: "r5", provider: "faux" });
  try {
    await assert.rejects(() => store.create({ name: "a\u0007b", cwd: t.work, model: faux }), /control characters/);
    // Edge whitespace normalizes away before the rule runs (trim-then-validate,
    // the same contract rename has held since R4): "\nlead" stores as "lead".
    const trimmed = await store.create({ name: "\nlead", cwd: t.work, model: faux });
    assert.equal(trimmed.name, "lead", "edge control characters are trimmed, not stored");
    await assert.rejects(() => store.create({ name: "search", cwd: t.work, model: faux }), /reserved/);
    await assert.rejects(
      () => store.create({ name: `${"x".repeat(81)}`, cwd: t.work, model: faux }),
      /the limit is/,
    );
    // rename keeps rejecting too — the rule is shared, not duplicated.
    // (rename is synchronous — assert.throws, not assert.rejects.)
    const good = await store.create({ name: "ok-name", cwd: t.work, model: faux });
    assert.throws(() => store.rename(store.resolveSession("ok-name"), "bad\u0017name"), /control characters/);
    assert.equal(store.resolveSession(good.id).name, "ok-name");
  } finally {
    await store.close();
    await t.cleanup();
  }
});

// -------------------------------------------------------------- finding 1: the availability brick

test("a held sqlite lock fails requests with a bounded retryable fault, then the session recovers without a restart", async () => {
  const { t, store, api, close } = await inProcessBackend("r5-brick-box");
  try {
    const created = (await (await api("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ name: "brick", cwd: t.work, model: faux }),
    })).json()) as { id: string; dbPath: string };
    const row = store.resolveSession("brick");

    // External holder: another connection takes BEGIN EXCLUSIVE on the session db
    // (pi-durable's 5 s busy timeout makes each locked attempt take ~5 s).
    const holder = new DatabaseSync(row.dbPath);
    holder.exec("BEGIN EXCLUSIVE");

    // 1. The in-flight POST fails, but with the BOUNDED retryable shape — never raw sqlite text.
    const failing = await api("/v1/sessions/brick/agents/1/messages", {
      method: "POST",
      body: JSON.stringify({ content: "hi", requestId: "r5-brick-1" }),
    });
    assert.ok(failing.status >= 400 && failing.status < 600, `retryable status, got ${failing.status}`);
    const failBody = (await failing.json()) as { error: { code: string; message: string } };
    assert.equal(failBody.error.code, "unavailable");
    assert.doesNotMatch(failBody.error.message, /database is locked|SQLITE/i, "no raw sqlite text");

    // 2. pi-durable closed the session; wait for the recorded failure.
    await until(() => store.errors.get(row.id) !== undefined);

    // 3. THE acceptance: release the lock, send again — success WITHOUT a device restart.
    holder.exec("ROLLBACK");
    holder.close();
    const recovered = await api("/v1/sessions/brick/agents/1/messages", {
      method: "POST",
      body: JSON.stringify({ content: "back", requestId: "r5-brick-2", waitMs: 20_000 }),
    });
    assert.ok(recovered.ok, `the next message succeeds after release (got ${recovered.status})`);
    const done = (await recovered.json()) as { status: string };
    assert.equal(done.status, "done", "the faux model answers after the reopen");
    assert.equal(store.errors.get(row.id), undefined, "the recorded failure cleared on reopen");

    // The device itself never went down.
    assert.equal((await api("/v1/sessions")).status, 200);
  } finally {
    await close();
  }
});

test("a locked-out retry answers the storage-busy fault while the lock is still held", async () => {
  const t = await tempStore();
  const store = await Store.open({ dataDir: join(t.root, "data"), startDirs: [t.work], name: "r5-busy", provider: "faux" });
  let holder: DatabaseSync | undefined;
  try {
    await store.create({ name: "busy", cwd: t.work, model: faux });
    const session = store.resolveSession("busy");
    holder = new DatabaseSync(session.dbPath);
    holder.exec("BEGIN EXCLUSIVE");
    try {
      await store.send((await store.resolveAgent("busy", "main")).c, { content: "hi", requestId: "busy-1" });
      assert.fail("the first send should fail while the lock is held");
    } catch (e) {
      assert.ok(/database is locked/i.test(String((e as Error).message)), "the raw busy error surfaces to the store");
    }
    await until(() => store.errors.get(session.id) !== undefined);
    // The reopen attempt still hits the lock: it must fail as the bounded busy fault, not the raw error.
    await assert.rejects(
      () => store.resolveAgent("busy", "main"),
      (e: unknown) =>
        e instanceof ApiFault && e.code === "unavailable" && !/database is locked/i.test(e.message),
    );
  } finally {
    try {
      holder?.exec("ROLLBACK");
      holder?.close();
    } catch {}
    await store.close();
    await t.cleanup();
  }
});

// -------------------------------------------------------------- finding 3: corrupt catalog quarantines + re-seeds

test("a corrupt catalog boots fresh, quarantines the file, and re-seeds session rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-r5-corrupt-"));
  const home = root;
  const work = join(home, "work");
  const token = newToken();
  try {
    await mkdir(work, { recursive: true });
    const server1 = await bootServer({ home, startDirs: work, token, name: "r5-corrupt" });
    const created = (await (
      await fetch(`${server1.base}/v1/sessions`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "keeper", cwd: work, model: faux }),
      })
    ).json()) as { id: string };
    await server1.stop();

    // Garbage into header bytes 32-64 (the audit's recipe) breaks the catalog for good.
    const catalogPath = join(home, "backend", "catalog.sqlite");
    const buf = readFileSync(catalogPath);
    for (let i = 32; i < 64; i++) buf[i] = 0x41;
    await writeFile(catalogPath, buf);

    // The device BOOTS (no crash loop), quarantines the corrupt file, re-seeds rows.
    const server2 = await bootServer({ home, startDirs: work, token, name: "r5-corrupt" });
    try {
      const health = await fetch(`${server2.base}/healthz`);
      assert.ok(health.ok, "device boots with a fresh catalog");
      const list = (await (
        await fetch(`${server2.base}/v1/sessions`, { headers: { authorization: `Bearer ${token}` } })
      ).json()) as { id: string; name: string; dbPath: string }[];
      assert.ok(list.length >= 1, "the session list is non-empty after re-seed");
      const keeper = list.find((s) => s.id === created.id);
      assert.ok(keeper, "the keeper session row was re-seeded from sessions/");
      assert.match(keeper.name, /^Recovered session/, "re-seeded rows carry the placeholder name");
      assert.equal(keeper.dbPath, join(home, "backend", "sessions", created.id, "agent.sqlite"));
      const entries = await readdir(join(home, "backend"));
      assert.ok(
        entries.some((n) => n.startsWith("catalog.sqlite.corrupt-")),
        "the corrupt catalog was quarantined, not deleted",
      );
    } finally {
      await server2.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------- finding 4: catalog schema migration

test("an old-shape catalog (no provider column) migrates on boot and create works", async () => {
  const t = await tempStore();
  const first = await Store.open({ dataDir: join(t.root, "data"), startDirs: [t.work], name: "r5", provider: "faux" });
  const keeper = await first.create({ name: "legacy", cwd: t.work, model: faux });
  await first.close();

  // Rewind the catalog to the pre-R5 shape: drop provider, remove the version stamp.
  const catalogPath = join(t.root, "data", "catalog.sqlite");
  const rewind = new DatabaseSync(catalogPath);
  const columnsBefore = (rewind.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(columnsBefore.includes("provider"));
  rewind.exec("ALTER TABLE sessions DROP COLUMN provider");
  rewind.prepare("DELETE FROM meta WHERE key='catalog_schema_version'").run();
  rewind.close();

  const reopened = await Store.open({ dataDir: join(t.root, "data"), startDirs: [t.work], name: "r5", provider: "faux" });
  try {
    const row = reopened.list().find((r) => r.id === keeper.id);
    assert.ok(row, "the legacy row survives the migration");
    // The ladder's ALTER carries DEFAULT '' — and Store.open's eager boot pass
    // corrects provider from the session's own committed storage before list()
    // ever runs (stronger than the lazy backfill this test first described).
    assert.equal(row.provider, "faux", "provider is corrected from session storage on the reopened boot");
    const created = await reopened.create({ name: "post-migration", cwd: t.work, model: faux });
    assert.ok(created.id, "create works after the migration (used to 500 positionally)");
  } finally {
    await reopened.close();
    await t.cleanup();
  }
});

test("a newer-shape catalog (extra column) accepts named-column inserts", async () => {
  const t = await tempStore();
  const first = await Store.open({ dataDir: join(t.root, "data"), startDirs: [t.work], name: "r5", provider: "faux" });
  await first.close();
  const catalogPath = join(t.root, "data", "catalog.sqlite");
  const ahead = new DatabaseSync(catalogPath);
  ahead.exec("ALTER TABLE sessions ADD COLUMN future_flag INTEGER NOT NULL DEFAULT 0");
  ahead.close();

  const reopened = await Store.open({ dataDir: join(t.root, "data"), startDirs: [t.work], name: "r5", provider: "faux" });
  try {
    const created = await reopened.create({ name: "extra-column", cwd: t.work, model: faux });
    assert.ok(created.id, "create works on a catalog with an extra column (positional inserts used to 500)");
  } finally {
    await reopened.close();
    await t.cleanup();
  }
});

test("a future catalog schema version refuses cleanly", async () => {
  const t = await tempStore();
  const first = await Store.open({ dataDir: join(t.root, "data"), startDirs: [t.work], name: "r5", provider: "faux" });
  await first.close();
  const catalogPath = join(t.root, "data", "catalog.sqlite");
  const ahead = new DatabaseSync(catalogPath);
  ahead.prepare("UPDATE meta SET value='99' WHERE key='catalog_schema_version'").run();
  ahead.close();
  await assert.rejects(
    () => Store.open({ dataDir: join(t.root, "data"), startDirs: [t.work], name: "r5", provider: "faux" }),
    /newer than supported version/,
    "mirror pi-durable's migrations refusal: bounded message, no silent attempt",
  );
  await t.cleanup();
});

// -------------------------------------------------------------- finding 6: gc accepts the advertised units

test("gc plans a sub-day cutoff (12h / 90m) and the CLI reports errors instead of stack traces", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-r5-gc-"));
  try {
    const now = Date.now();
    const dataDir = join(root, "backend");
    const archiveDir = join(dataDir, "archive");
    await mkdir(join(archiveDir, `aaaa1111-0000-0000-0000-000000000000-${now - 40 * DAY}`), { recursive: true });
    await writeFile(join(archiveDir, `aaaa1111-0000-0000-0000-000000000000-${now - 40 * DAY}`, "agent.sqlite"), "x");

    // Sub-day cutoffs are legal (the CLI help advertises 90m/12h).
    const plan = await gcPlan(archiveDir, { closedBeforeDays: parseDuration("12h"), now });
    assert.equal(plan.candidates.length, 1);

    // The CLI plans with 12h and exits 0.
    const out: string[] = [];
    const errs: string[] = [];
    const io: GcIo = {
      print: (l) => out.push(l),
      printErr: (l) => errs.push(l),
      env: {},
      readFile: () => "",
      homedir: () => root,
      now: () => now,
    };
    const code = await gcCli({ argv: ["--closed-before", "12h", "--dry-run", "--data-dir", dataDir] }, io);
    assert.equal(code, 0);
    assert.ok(out.some((l) => l.startsWith("archive ")), `plan output, got ${JSON.stringify(out)}`);
    assert.ok(out.some((l) => /would delete 1/.test(l)));

    // A genuinely bad cutoff gets the pretty path, not a raw stack.
    const bad = await gcCli({ argv: ["--closed-before", "0d", "--dry-run", "--data-dir", dataDir] }, io);
    assert.equal(bad, 2);
    assert.ok(errs.some((l) => /dpi gc: /.test(l)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------- finding 7: double start exits cleanly

test("a second device start prints 'already running (pid N)' and exits 0 without a crash report", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-r5-double-"));
  const home = root;
  const work = join(home, "work");
  const token = newToken();
  try {
    await mkdir(work, { recursive: true });
    const first = await bootServer({ home, startDirs: work, token, name: "r5-double" });
    try {
      const port = await freePort();
      const env = {
        ...process.env,
        DPI_HOME: home,
        DPI_ENV_FILE: resolve(home, "none.env"),
        DPI_TOKEN: token,
        DPI_PROVIDER: "faux",
        DPI_START_DIRS: work,
        DPI_DEVICE_NAME: "r5-double",
      };
      const second = spawn(
        process.execPath,
        ["--import", "tsx", resolve(import.meta.dirname, "../src/main.ts"), "--port", String(port), "--host", "127.0.0.1"],
        { env, stdio: ["ignore", "pipe", "pipe"], cwd: resolve(import.meta.dirname, "..") },
      );
      let secondOut = "";
      second.stdout?.on("data", (x) => (secondOut += x));
      second.stderr?.on("data", (x) => (secondOut += x));
      const [exitCode, signal] = await once(second, "exit");
      assert.equal(signal, null);
      assert.equal(exitCode, 0, `the second start exits 0 (a no-op), got ${exitCode}`);
      assert.match(secondOut, /already running \(pid \d+\)/, "the operator hears why, with the owning pid");
      const crashes = await readdir(join(home, "backend", "crashes")).catch(() => [] as string[]);
      assert.deepEqual(crashes, [], "no crash report: a double start is not a crash");
      // The first device is still healthy.
      assert.ok((await fetch(`${first.base}/healthz`)).ok, "the owning device keeps serving");
    } finally {
      await first.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
