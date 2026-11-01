/**
 * run-11 h2-3 (backup re-probe + create/restore gate): r9's pre-probe guards
 * only the START of createBackup — a daemon that boots DURING the file walk
 * (which takes minutes on a real home) still gets a torn archive, because the
 * read/zip/write phases then run against live sqlite handles. Fix (a): after
 * the walk and BEFORE the first entry byte is read, re-probe healthz with the
 * same deviceIsRunning — any answer aborts on the same `device_running`
 * BackupError surface with nothing written. Fix (b): a module-level promise
 * gate serializes create+restore per process, so a restore's renameAside can
 * never swallow files a half-finished create is still reading (and vice
 * versa). Fixed clock + faked probe io, backup.test.ts style.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackupError, createBackup, defaultBackupIo, readZipEntries, restoreBackup, type BackupIo } from "../src/backup.js";
import { delay } from "./helpers.js";

/** Fixed clock, like backup-healthz-r9 — deterministic stamps, no wall time. */
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0, 0);
const HEALTHZ = "http://127.0.0.1:4780/healthz"; // a string only — the io below owns every probe

const io = (over: Partial<BackupIo> = {}): BackupIo => ({ ...defaultBackupIo(), now: () => NOW, ...over });

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/** A minimal fake device home, backup-healthz-r9 style: one registry, one binary store file. */
async function fakeHome(root: string): Promise<string> {
  const home = join(root, "home");
  await mkdir(join(home, "backend"), { recursive: true });
  await writeFile(join(home, "projects.json"), '{"version":1,"projects":[]}\n');
  await writeFile(join(home, "backend", "catalog.sqlite"), Buffer.from([0, 1, 254, 255]));
  return home;
}

test("h2-3 (a): createBackup re-probes after the walk — a daemon that came online aborts with nothing written", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-bk-reprobe-"));
  try {
    const home = await fakeHome(root);
    const out = join(root, "nested", "b.zip"); // parent dirs would only exist if the write phase ran
    let probes = 0;
    const cameOnline = io({
      fetch: async () => {
        probes += 1;
        // probe 1 (pre-walk, r9 behavior): the daemon is down — proceed.
        if (probes === 1) throw new Error("connect ECONNREFUSED 127.0.0.1:4780");
        // probe 2 (post-walk, run-11): the daemon answered mid-backup — abort.
        return { ok: true, status: 200 };
      },
    });
    await assert.rejects(
      () => createBackup(cameOnline, { home, out, healthzUrl: HEALTHZ }),
      (error: unknown) =>
        error instanceof BackupError &&
        error.code === "device_running" &&
        /came online during the backup/.test(error.message) &&
        /dpi device stop/.test(error.message),
    );
    assert.equal(probes, 2, "exactly the pre-probe and the post-walk re-probe ran");
    assert.equal(await exists(out), false, "no zip was written");
    assert.equal(await exists(join(root, "nested")), false, "not even the parent dir was created");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("h2-3 (a): a daemon that stays down through BOTH probes still gets its backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-bk-reprobe2-"));
  try {
    const home = await fakeHome(root);
    const out = join(root, "b.zip");
    let probes = 0;
    const stayedDown = io({
      fetch: async () => {
        probes += 1;
        throw new Error("connect ECONNREFUSED 127.0.0.1:4780");
      },
    });
    const result = await createBackup(stayedDown, { home, out, healthzUrl: HEALTHZ });
    assert.equal(result.files, 2, "the backup ran to completion");
    assert.equal(probes, 2, "the second probe happened — and a refused connection is not an abort");
    const names = readZipEntries(await readFile(out)).map((e) => e.name);
    assert.deepEqual(names, ["manifest.json", "backend/catalog.sqlite", "projects.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("h2-3 (a): no healthzUrl → still zero probes (the re-probe rides the existing opt-in)", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-bk-reprobe3-"));
  try {
    const home = await fakeHome(root);
    let probes = 0;
    const untouched = io({
      fetch: async () => {
        probes += 1;
        throw new Error("must not be probed");
      },
    });
    const result = await createBackup(untouched, { home, out: join(root, "b.zip") });
    assert.equal(result.files, 2);
    assert.equal(probes, 0, "neither probe fired without a healthzUrl");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("h2-3 (b): the create/restore gate serializes concurrent operations (no interleaved fs phases)", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-bk-mutex-"));
  try {
    // A clean seed archive first (the gate is released after every op).
    const home1 = await fakeHome(root);
    const zip = join(root, "b.zip");
    await createBackup(io(), { home: home1, out: zip });

    // A second home to back up concurrently with a restore of the first.
    const home2 = join(root, "home2");
    await mkdir(join(home2, "backend"), { recursive: true });
    await writeFile(join(home2, "notes.txt"), "second home");
    await writeFile(join(home2, "backend", "catalog.sqlite"), Buffer.from([9, 9, 9, 9]));

    // Slow, tagged io: every call logs its owner and takes a few ms. Without
    // the gate the two ops' fs phases interleave (that is the race being
    // serialized); with it, one op's calls form one contiguous block.
    const events: string[] = [];
    const tagged = (tag: string): BackupIo => {
      const base = io();
      const slow = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
        await delay(2 + Math.floor(Math.random() * 4));
        events.push(tag);
        return fn(...args);
      };
      return {
        readFile: slow(base.readFile),
        writeFile: slow(base.writeFile),
        rename: slow(base.rename),
        mkdir: slow(base.mkdir),
        stat: slow(base.stat),
        readdir: slow(base.readdir),
        chmod: slow(base.chmod),
        exists: slow(base.exists),
        now: base.now,
      };
    };

    const [created, restored] = await Promise.all([
      createBackup(tagged("create"), { home: home2, out: join(root, "b2.zip") }),
      restoreBackup(tagged("restore"), { zipPath: zip, home: join(root, "restored") }),
    ]);
    assert.equal(created.files, 2, "the concurrent create succeeded");
    assert.equal(restored.restored, 2, "the concurrent restore succeeded");

    // No interleaving: whichever op won the gate ran ALL its io calls before
    // the other's FIRST one.
    const firstCreate = events.indexOf("create");
    const lastCreate = events.lastIndexOf("create");
    const firstRestore = events.indexOf("restore");
    const lastRestore = events.lastIndexOf("restore");
    assert.ok(firstCreate !== -1 && firstRestore !== -1, "both ops ran io");
    assert.ok(
      lastCreate < firstRestore || lastRestore < firstCreate,
      `create and restore interleaved their fs phases: ${events.join(",")}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
