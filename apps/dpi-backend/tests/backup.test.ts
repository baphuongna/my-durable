/**
 * Backup/restore of the device home (checklist Wave 2, "Backup/restore of
 * session data"): create writes one file and deletes nothing, restore renames
 * the old home aside instead of deleting it, and the zip round-trips binary
 * content (backend/catalog.sqlite) byte-for-byte.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import {
  BackupError,
  createBackup,
  defaultBackupIo,
  deviceIsRunning,
  listBackups,
  readZipEntries,
  restoreBackup,
  type BackupIo,
} from "../src/backup.js";
import { crc32, zipSync } from "../src/zip.js";
import { PACKAGE_VERSION } from "../src/store.js";

/** Fixed clock: the manifest stamp and the `.bak-<timestamp>` names are deterministic. */
const NOW = Date.UTC(2026, 9, 25, 3, 54, 9, 123);
const BAK_STAMP = new Date(NOW).toISOString().replace(/[:.]/g, "-");

const io = (over: Partial<BackupIo> = {}): BackupIo => ({ ...defaultBackupIo(), now: () => NOW, ...over });

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/** A fake device home: registries, a binary backend store, a lock file, node_modules noise. */
async function fakeHome(root: string): Promise<string> {
  const home = join(root, "home");
  await mkdir(join(home, "backend", "sessions", "s1"), { recursive: true });
  await writeFile(join(home, "projects.json"), `${JSON.stringify({ version: 1, projects: [] }, null, 2)}\n`);
  await writeFile(join(home, "notify.json"), "{}\n");
  await writeFile(join(home, "schedules.json"), "{}\n");
  await writeFile(join(home, "pairing.json"), JSON.stringify({ hubOrigin: "https://hub.example" }));
  await writeFile(join(home, "device.log"), "started\narchived a session\n");
  await writeFile(join(home, "backend", "catalog.sqlite"), Buffer.from([0x00, 0x01, 0x02, 0xfd, 0xfe, 0xff]));
  await writeFile(
    join(home, "backend", "sessions", "s1", "agent.sqlite"),
    Buffer.from(Array.from({ length: 256 }, (_, i) => i)), // every byte value, once
  );
  await writeFile(join(home, "backend", "sessions", "s1", "empty"), "");
  await writeFile(join(home, "backend", "catalog.sqlite.lock"), "someone is holding the db");
  await mkdir(join(home, "node_modules", "junk"), { recursive: true });
  await writeFile(join(home, "node_modules", "junk", "x.txt"), "junk");
  return home;
}

/** The files createBackup keeps, in the order the sorted walk produces them. */
const EXPECTED = [
  "backend/catalog.sqlite",
  "backend/sessions/s1/agent.sqlite",
  "backend/sessions/s1/empty",
  "device.log",
  "notify.json",
  "pairing.json",
  "projects.json",
  "schedules.json",
];

/** A hand-built zip (stored or deflated), so tests can craft what zipSync refuses to write. */
function rawZip(entries: Array<{ name: string; data: Buffer; method?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const method = entry.method ?? 0;
    const body = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, eocd]);
}

test("create → readZipEntries → restore round-trips content and count", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-backup-"));
  try {
    const home = await fakeHome(root);
    const out = join(root, "dpi-backup-test.zip");
    const result = await createBackup(io(), { home, out });
    assert.equal(result.path, out);
    assert.equal(result.files, EXPECTED.length);
    const expectedBytes = await Promise.all(EXPECTED.map(async (rel) => (await stat(join(home, rel))).size)).then((sizes) =>
      sizes.reduce((a, b) => a + b, 0),
    );
    assert.equal(result.bytes, expectedBytes);

    const entries = readZipEntries(await readFile(out));
    assert.deepEqual(entries.map((e) => e.name), ["manifest.json", ...EXPECTED]);
    // binary content survives byte-for-byte: every byte value, once
    const agent = entries.find((e) => e.name === "backend/sessions/s1/agent.sqlite")!;
    assert.deepEqual(Buffer.from(agent.data), Buffer.from(Array.from({ length: 256 }, (_, i) => i)));

    const fresh = join(root, "home-restored");
    const restored = await restoreBackup(io(), { zipPath: out, home: fresh });
    assert.equal(restored.restored, EXPECTED.length);
    assert.equal(restored.backupOfOldHome, undefined);
    for (const rel of EXPECTED) {
      assert.deepEqual(await readFile(join(fresh, rel)), await readFile(join(home, rel)), rel);
    }
    if (process.platform !== "win32") {
      assert.equal((await stat(join(fresh, "backend", "catalog.sqlite"))).mode & 0o777, 0o600);
      assert.equal((await stat(join(fresh, "backend"))).mode & 0o777, 0o700);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("entry 0 is a manifest naming what was backed up", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-backup-"));
  try {
    const home = await fakeHome(root);
    const out = join(root, "b.zip");
    const result = await createBackup(io(), { home, out, deviceName: "pi-4b" });
    const manifest = JSON.parse(Buffer.from(readZipEntries(await readFile(out))[0].data).toString("utf8"));
    assert.equal(manifest.createdAt, new Date(NOW).toISOString());
    assert.equal(manifest.packageVersion, PACKAGE_VERSION);
    assert.equal(manifest.deviceName, "pi-4b");
    assert.equal(manifest.files, result.files);
    assert.equal(manifest.bytes, result.bytes);

    await createBackup(io(), { home, out: join(root, "b2.zip") });
    const bare = JSON.parse(Buffer.from(readZipEntries(await readFile(join(root, "b2.zip")))[0].data).toString("utf8"));
    assert.equal("deviceName" in bare, false, "no deviceName key when none was given");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(".lock files and node_modules are skipped, and the out file never backs itself up", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-backup-"));
  try {
    const home = await fakeHome(root);
    const out = join(home, "inside.zip"); // deliberately inside what it backs up
    const first = await createBackup(io(), { home, out });
    const second = await createBackup(io(), { home, out }); // now inside.zip exists inside home
    assert.equal(second.files, first.files, "a re-run does not swallow the previous zip");
    const names = readZipEntries(await readFile(out)).map((e) => e.name);
    assert.ok(!names.some((n) => n.endsWith(".lock")), "no .lock file in the zip");
    assert.ok(!names.some((n) => n.startsWith("node_modules/")), "no node_modules in the zip");
    assert.ok(!names.includes("inside.zip"), "the out file does not contain itself");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the size cap refuses the walk, names both numbers, and writes nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-backup-"));
  try {
    const home = join(root, "big");
    await mkdir(home);
    await writeFile(join(home, "blob.bin"), "x".repeat(2_048));
    await assert.rejects(
      () => createBackup(io(), { home, out: join(root, "b.zip"), maxBytes: 1_024 }),
      (error: unknown) =>
        error instanceof BackupError &&
        error.code === "invalid" &&
        /2048/.test(error.message) &&
        /1024/.test(error.message) &&
        /capped at/i.test(error.message),
    );
    assert.equal(await exists(join(root, "b.zip")), false, "nothing was written");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore refuses while the daemon answers, whatever its status, and proceeds when the connection is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-backup-"));
  try {
    const home = await fakeHome(root);
    const out = join(root, "b.zip");
    await createBackup(io(), { home, out });

    const running = io({ fetch: async () => ({ ok: true, status: 200 }) });
    assert.equal(await deviceIsRunning(running, "http://127.0.0.1:4780/healthz"), true);
    await assert.rejects(
      () => restoreBackup(running, { zipPath: out, home: join(root, "h1"), healthzUrl: "http://127.0.0.1:4780/healthz" }),
      (error: unknown) =>
        error instanceof BackupError && error.code === "device_running" && /dpi device stop/.test(error.message),
    );
    assert.equal(await exists(join(root, "h1")), false, "nothing was written");

    // any answer counts, not just ok ones
    const erroring = io({ fetch: async () => ({ ok: false, status: 500 }) });
    await assert.rejects(
      () => restoreBackup(erroring, { zipPath: out, home: join(root, "h1b"), healthzUrl: "http://127.0.0.1:4780/healthz" }),
      (error: unknown) => error instanceof BackupError && error.code === "device_running",
    );

    // a fetch that throws is a refused connection: not running
    const refused = io({ fetch: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:4780"); } });
    const restored = await restoreBackup(refused, {
      zipPath: out,
      home: join(root, "h2"),
      healthzUrl: "http://127.0.0.1:4780/healthz",
    });
    assert.equal(restored.restored, EXPECTED.length);

    // no healthzUrl → no probe at all
    const untouched = io({ fetch: async () => { throw new Error("must not be probed"); } });
    assert.equal((await restoreBackup(untouched, { zipPath: out, home: join(root, "h3") })).restored, EXPECTED.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore renames an existing home aside (and -2 when the name is taken) instead of deleting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-backup-"));
  try {
    const home = await fakeHome(root);
    const out = join(root, "b.zip");
    await createBackup(io(), { home, out });
    await writeFile(join(home, "added-later.txt"), "changed since the backup\n");
    const expectedBak = `${home}.bak-${BAK_STAMP}`;

    const first = await restoreBackup(io(), { zipPath: out, home });
    assert.equal(first.backupOfOldHome, expectedBak);
    assert.deepEqual(await readFile(join(expectedBak, "added-later.txt"), "utf8"), "changed since the backup\n");
    assert.equal(await exists(join(home, "added-later.txt")), false, "home now holds the backup's content");

    // the same fixed clock → the same .bak name → the next one is -2
    const second = await restoreBackup(io(), { zipPath: out, home });
    assert.equal(second.backupOfOldHome, `${expectedBak}-2`);
    assert.equal(await exists(expectedBak), true, "the first .bak is still there");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("entry names that escape the archive, and corruption, are refused loudly", async () => {
  const invalidEntry = (error: unknown): boolean => error instanceof BackupError && error.code === "invalid";
  assert.throws(() => readZipEntries(zipSync([{ path: "../evil.txt", text: "pwned" }])), invalidEntry);
  assert.throws(() => readZipEntries(zipSync([{ path: "a/../../evil", text: "pwned" }])), invalidEntry);
  assert.throws(() => readZipEntries(rawZip([{ name: "/etc/passwd", data: Buffer.from("x") }])), invalidEntry);
  assert.throws(() => readZipEntries(rawZip([{ name: "C:\\evil", data: Buffer.from("x") }])), invalidEntry);
  assert.throws(() => readZipEntries(rawZip([{ name: "a\\b", data: Buffer.from("x") }])), invalidEntry);
  assert.throws(() => readZipEntries(rawZip([{ name: "c.txt", data: Buffer.from("x"), method: 12 }])), invalidEntry);
  // not a zip at all / truncated / a flipped data byte (stored and deflated)
  assert.throws(() => readZipEntries(Buffer.from("this is not a zip")), invalidEntry);
  const good = rawZip([{ name: "a.txt", data: Buffer.from("hello") }]);
  assert.throws(() => readZipEntries(good.subarray(0, good.length - 5)), invalidEntry);
  const flipped = Buffer.from(good); // local header 30 bytes + 5-byte name → data starts at 35
  flipped[36] ^= 0xff;
  assert.throws(() => readZipEntries(flipped), invalidEntry);
  const deflated = Buffer.from(rawZip([{ name: "b.txt", data: Buffer.from("hello hello hello"), method: 8 }]));
  deflated[35] ^= 0xff; // first byte of the deflate stream
  assert.throws(() => readZipEntries(deflated), invalidEntry);
});

test("an unreadable backup is not_found, and the home is left untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-backup-"));
  try {
    const home = join(root, "home");
    await mkdir(join(home, "backend"), { recursive: true });
    await writeFile(join(home, "keep.txt"), "keep");
    await assert.rejects(
      () => restoreBackup(io(), { zipPath: join(root, "missing.zip"), home }),
      (error: unknown) => error instanceof BackupError && error.code === "not_found" && /missing\.zip/.test(error.message),
    );
    assert.deepEqual(await readFile(join(home, "keep.txt"), "utf8"), "keep", "the home was not touched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listBackups shows dpi-backup-*.zip newest first; a missing dir is just empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-backup-"));
  try {
    const dir = join(root, "backups");
    assert.deepEqual(await listBackups(io(), dir), [], "a missing dir is not an error");
    await mkdir(dir);
    assert.deepEqual(await listBackups(io(), dir), []);
    const names = ["dpi-backup-20261025-010101.zip", "dpi-backup-20261025-020202.zip", "dpi-backup-20261025-030303.zip"];
    for (const [i, name] of names.entries()) {
      await writeFile(join(dir, name), "x".repeat((i + 1) * 100));
      await utimes(join(dir, name), new Date(NOW - (3 - i) * 60_000), new Date(NOW - (3 - i) * 60_000));
    }
    await writeFile(join(dir, "not-a-backup.zip"), "x"); // wrong prefix: ignored
    const listed = await listBackups(io(), dir);
    assert.deepEqual(listed.map((b) => b.name), [names[2], names[1], names[0]]);
    assert.deepEqual(listed.map((b) => b.bytes), [300, 200, 100]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
