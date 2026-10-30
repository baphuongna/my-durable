// R18 (run-4 h1): restore is a session-placement writer — it must enforce the
// same start-dir choke point as create. The leader probe confirmed a planted
// archive manifest (same-user writable, reachable by any session agent with
// bash) restored a session rooted OUTSIDE the start dirs, re-anchoring its
// tool environment (and giving read-only sessions out-of-sandbox reads).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store.js";
import { faux, tempStore } from "./helpers.js";

test("restore refuses a manifest cwd outside the start dirs (create-parity choke point)", async () => {
  const root = mkdtempSync(join(tmpdir(), "dpi-restore-r18-"));
  try {
    const work = join(root, "work");
    const outside = join(root, "outside-vault");
    mkdirSync(work, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const dataDir = join(root, "data");

    const plant = (cwd: string): string => {
      const sessionId = randomUUID();
      const dir = join(dataDir, "archive", `${sessionId}-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "session.json"),
        JSON.stringify({
          sessionId,
          name: "planted",
          cwd,
          model: "m",
          provider: "faux",
          createdAt: Date.now(),
          archivedAt: Date.now(),
          packageVersion: "0",
        }),
      );
      return sessionId;
    };

    const store = await Store.open({ dataDir, startDirs: [work], name: "restore-box", provider: "faux" } as never);
    const outsideId = plant(outside);

    // The choke point: a planted outside cwd is refused, and the refusal
    // happens BEFORE the bundle moves (the archive stays restorable).
    await assert.rejects(
      () => (store as unknown as { restoreArchivedSession(id: string): Promise<unknown> }).restoreArchivedSession(outsideId),
      (e: { code?: string }) => e.code === "invalid",
    );

    // Control: a bundle whose cwd IS a start-dir folder restores fine.
    const insideId = plant(join(work, "project"));
    mkdirSync(join(work, "project"), { recursive: true });
    const restored = (await (store as unknown as { restoreArchivedSession(id: string): Promise<{ cwd: string }> })
      .restoreArchivedSession(insideId)) as { cwd: string };
    assert.ok(restored.cwd.startsWith(work), `restored cwd must live under the start dir: ${restored.cwd}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R20 h6: an oversized planted archive manifest is refused without reading it", async () => {
  const { bootServer, newToken, tempStore } = await import("./helpers.js");
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token, name: "r20m" });
  try {
    // Plant a >1 MiB valid-shape manifest with an in-model cwd: pre-fix the
    // restore READ + PARSED the whole file before the cwd refusal (leader
    // probe: 150 MB plant = ~770 ms and ~600 MB RSS per request, repeatable,
    // and the archive LISTING paid the same per bundle).
    const sid = "deadbeef-0000-4000-8000-000000000001";
    const bundle = join(t.root, "home", "backend", "archive", `${sid}-1700000000000`);
    mkdirSync(bundle, { recursive: true });
    const manifest = {
      sessionId: sid, name: "Plant", cwd: t.work, model: "m", provider: "p",
      createdAt: 1700000000000, archivedAt: 1700000000000, pad: "x".repeat(2 * 1024 * 1024),
    };
    writeFileSync(join(bundle, "session.json"), JSON.stringify(manifest));
    for (let i = 1; i <= 2; i++) {
      const t0 = performance.now();
      const resp = await fetch(`${server.base}/v1/archive/${sid}/restore`, {
        method: "POST", headers: { authorization: `Bearer ${token}` },
      });
      const ms = performance.now() - t0;
      assert.ok(resp.status === 400 || resp.status === 404, `refused without reading (${resp.status} — absent manifest degrades to the empty-cwd refusal)`);
      assert.ok(ms < 500, `oversized manifest must not be read, took ${Math.round(ms)}ms`);
    }
    const t1 = performance.now();
    const list = await (await fetch(`${server.base}/v1/archive`, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.ok(performance.now() - t1 < 500, "listing must skip the oversized manifest too");
    assert.ok(list.sessions.length >= 1, "the bundle still lists (degraded row)");
  } finally {
    await server.stop();
    await t.cleanup();
  }
});

test("run-7 D6: FIFO and /dev/zero manifest plants return undefined without blocking", async () => {
  const { execFileSync } = await import("node:child_process");
  const { readArchiveManifest } = await import("../src/archived.js");
  const root = mkdtempSync(join(tmpdir(), "dpi-d6-reg-"));
  const fifoBundle = join(root, "archive", `${randomUUID()}-1`);
  mkdirSync(fifoBundle, { recursive: true });
  execFileSync("mkfifo", [join(fifoBundle, "session.json")]);
  const zeroBundle = join(root, "archive", `${randomUUID()}-2`);
  mkdirSync(zeroBundle, { recursive: true });
  symlinkSync("/dev/zero", join(zeroBundle, "session.json"));
  // A block here would hang the whole suite: the descriptor-pinned read
  // (O_NONBLOCK | O_NOFOLLOW + fstat isFile) must return undefined instantly.
  const t0 = Date.now();
  assert.equal(readArchiveManifest(fifoBundle), undefined, "FIFO plant degrades, never blocks");
  assert.equal(readArchiveManifest(zeroBundle), undefined, "endless-device symlink degrades, never grows");
  assert.ok(Date.now() - t0 < 1000, `both plants settled fast (${Date.now() - t0}ms)`);
  rmSync(root, { recursive: true, force: true });
});

test("run-7 B1-A: a reopen racing archive() must not re-arm over the moved bundle", async () => {
  const t = await tempStore();
  const store = await Store.open({ ...t.options, name: "b1-race-box" });
  try {
    let reArmed = 0;
    let refused = 0;
    for (let i = 0; i < 5; i++) {
      const row = await store.create({ name: "race-" + i, cwd: "project", model: faux } as never);
      await store.archive(store.row(row.id) as never); // make the row un-opened
      const restored = await store.restoreArchivedSession(row.id);
      // the race: openAgent in flight while archive completes mid-open
      const opening = (store as unknown as { openAgent: (r: never) => Promise<unknown> }).openAgent(store.row(restored.id) as never);
      opening.catch(() => {}); // the rejection may land before the await below
      await store.archive(store.row(restored.id) as never);
      try {
        await opening;
        if ((store as unknown as { opened: Map<string, unknown> }).opened.has(restored.id)) reArmed++;
      } catch {
        refused++; // any refusal (epoch guard or the archived-away storage) is the safe outcome
      }
    }
    assert.equal(reArmed, 0, "no live harness may sit over an archived bundle");
    assert.ok(refused >= 1, "the racing reopen is refused with the archiving reason");
  } finally {
    await store.close().catch(() => {});
    await t.cleanup();
  }
});

test("run-7 B1-B: planted manifest names degrade through the restore choke point", async () => {
  const t = await tempStore();
  const store = await Store.open({ ...t.options, name: "b1-name-box" });
  try {
    const row = await store.create({ name: "plantme", cwd: "project", model: faux } as never);
    await store.archive(store.row(row.id));
    // plant hostile names into the archived bundle's manifest, one at a time
    const bundleRoot = (store as unknown as { archiveDir: string }).archiveDir;
    const { readdirSync } = await import("node:fs");
    const bundleName = readdirSync(bundleRoot).find((n) => n.startsWith(row.id));
    assert.ok(bundleName, "bundle exists");
    const { readArchiveManifest, writeArchiveManifest } = await import("../src/archived.js");
    for (const bad of ["search", "a\nb", "x".repeat(500_000)]) {
      // re-find the bundle EVERY round: the restore below moves it away and
      // the re-archive mints a fresh <id>-<ts> name
      const current = readdirSync(bundleRoot).find((n) => n.startsWith(row.id))!;
      const m = readArchiveManifest(join(bundleRoot, current))!;
      writeArchiveManifest(join(bundleRoot, current), { ...m, name: bad });
      const restored = await store.restoreArchivedSession(row.id);
      const listed = store.list().find((s) => s.id === restored.id)!;
      assert.ok(typeof listed.name === "string" && listed.name.length <= 80, "name is bounded");
      assert.notEqual(listed.name.toLowerCase(), "search", "reserved name never lands");
      assert.ok(!/[\u0000-\u001f\u007f]/.test(listed.name), "control characters never land");
      await store.archive(store.row(restored.id) as never); // re-archive for the next plant
    }
  } finally {
    await store.close().catch(() => {});
    await t.cleanup();
  }
});

test("run-8 U1: a crash between the archive rename and the catalog DELETE is repaired at boot (zombie row, manifest-less bundle, orphan dir)", async () => {
  const { mkdir, rename } = await import("node:fs/promises");
  const { join } = await import("node:path");

  // A: row live, dir already moved AND manifest written (crash before DELETE)
  const t = await tempStore();
  try {
    const s1 = await t.open();
    const row = await s1.create({ name: "zombie", cwd: join(t.work, "project"), model: faux });
    await s1.close();
    const archiveDir = join(t.options.dataDir, "archive");
    await mkdir(archiveDir, { recursive: true });
    await rename(join(t.options.dataDir, "sessions", row.id), join(archiveDir, `${row.id}-${Date.now()}`));

    const s2 = await t.open(); // boots -> reconcile completes the archive
    assert.equal(s2.list().some((r) => r.id === row.id), false, "the zombie row must be completed, not immortal");
    assert.ok(s2.archivedList().some((a) => a.sessionId === row.id), "the bundle stays browsable");
    const restored = await s2.restoreArchivedSession(row.id); // was: 'a live session with this id already exists'
    assert.equal(restored.name, "zombie", "the recovered manifest carries the row identity");
    await s2.close();
  } finally {
    await t.cleanup();
  }

  // B: an orphan sessions/<uuid> dir with no catalog row is re-added
  const t2 = await tempStore();
  try {
    const s1 = await t2.open();
    const row = await s1.create({ name: "orphan", cwd: join(t2.work, "project"), model: faux });
    await s1.close();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(t2.options.dataDir, "catalog.sqlite"));
    db.exec(`DELETE FROM sessions WHERE id = '${row.id}'`);
    db.close();

    const s2 = await t2.open();
    assert.ok(s2.list().some((r) => r.id === row.id), "the orphan dir must be visible again (was: 404 forever)");
    await s2.close();
  } finally {
    await t2.cleanup();
  }
});
