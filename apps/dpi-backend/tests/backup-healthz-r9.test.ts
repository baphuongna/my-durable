/**
 * Run-9 unit H (run-8 u7): `createBackup` never probed healthz while restore
 * did — a backup taken while the device daemon answers captures
 * catalog.sqlite + agent.sqlite (+ -wal/-shm) at different instants, i.e. a
 * live "backup" is torn. Parity fix: create probes exactly like restore (same
 * `deviceIsRunning` call, healthz needs no auth, `device_running` refusal when
 * ANY answer arrives, proceed when the connection is refused or no URL is
 * given), and the CLI surfaces the probe for `dpi backup create`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackupError, createBackup, defaultBackupIo, readZipEntries, type BackupIo } from "../src/backup.js";
import { backupCli, defaultBackupCliIo, type BackupCliIo } from "../src/backup-cli.js";

/** Fixed clock, like backup.test.ts — deterministic stamps, no wall time. */
const NOW = Date.UTC(2026, 9, 25, 3, 54, 9, 123);

const io = (over: Partial<BackupIo> = {}): BackupIo => ({ ...defaultBackupIo(), now: () => NOW, ...over });

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/** A minimal fake device home, backup.test.ts style: one registry, one binary store file. */
async function fakeHome(root: string): Promise<string> {
  const home = join(root, "home");
  await mkdir(join(home, "backend"), { recursive: true });
  await writeFile(join(home, "projects.json"), '{"version":1,"projects":[]}\n');
  await writeFile(join(home, "backend", "catalog.sqlite"), Buffer.from([0, 1, 254, 255]));
  return home;
}

const HEALTHZ = "http://127.0.0.1:4780/healthz";
const deviceRunning = (error: unknown): boolean =>
  error instanceof BackupError && error.code === "device_running" && /dpi device stop/.test(error.message);

test("createBackup refuses while the daemon answers (any status) and writes nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-backup-hz-"));
  try {
    const home = await fakeHome(root);
    const out = join(root, "nested", "b.zip"); // parent dirs would be created on write

    const running = io({ fetch: async () => ({ ok: true, status: 200 }) });
    await assert.rejects(() => createBackup(running, { home, out, healthzUrl: HEALTHZ }), deviceRunning);
    assert.equal(await exists(out), false, "no zip was written");
    assert.equal(await exists(join(root, "nested")), false, "not even the parent dir was created");

    // any answer counts, not just ok ones — same rule as restore
    const erroring = io({ fetch: async () => ({ ok: false, status: 500 }) });
    await assert.rejects(() => createBackup(erroring, { home, out, healthzUrl: HEALTHZ }), deviceRunning);
    assert.equal(await exists(join(root, "nested")), false, "still nothing on disk");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createBackup proceeds on a refused connection and writes a real zip", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-backup-hz-"));
  try {
    const home = await fakeHome(root);
    const out = join(root, "b.zip");
    const refused = io({ fetch: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:4780"); } });
    const result = await createBackup(refused, { home, out, healthzUrl: HEALTHZ });
    assert.equal(result.files, 2);
    assert.equal(await exists(out), true);
    const names = readZipEntries(await readFile(out)).map((e) => e.name);
    assert.deepEqual(names, ["manifest.json", "backend/catalog.sqlite", "projects.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("no healthzUrl → no probe at all, like restore", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-backup-hz-"));
  try {
    const home = await fakeHome(root);
    const out = join(root, "b.zip");
    const untouched = io({ fetch: async () => { throw new Error("must not be probed"); } });
    const result = await createBackup(untouched, { home, out });
    assert.equal(result.files, 2, "the backup ran without probing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the probe is first: a running daemon wins even over a missing home", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-backup-hz-"));
  try {
    const running = io({ fetch: async () => ({ ok: true, status: 200 }) });
    // restore probes before reading the zip; create must probe before the walk —
    // fail fast, do not start fs work against a device that is live.
    await assert.rejects(
      () => createBackup(running, { home: join(root, "ghost"), out: join(root, "b.zip"), healthzUrl: HEALTHZ }),
      (error: unknown) => error instanceof BackupError && error.code === "device_running",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an io without fetch cannot probe: create trusts the caller's 'not running'", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-backup-hz-"));
  try {
    const home = await fakeHome(root);
    const noFetch: BackupIo = { ...defaultBackupIo(), now: () => NOW };
    delete noFetch.fetch; // deviceIsRunning: no fetch → cannot probe → not running
    const result = await createBackup(noFetch, { home, out: join(root, "b.zip"), healthzUrl: HEALTHZ });
    assert.equal(result.files, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** The CLI harness of backup-cli.test.ts: real fs, pinned clock, refused probe by default. */
const cliHarness = (over: { fetch?: BackupCliIo["fetch"] } = {}) => {
  const lines: string[] = [];
  const errors: string[] = [];
  const io: BackupCliIo = {
    ...defaultBackupCliIo(),
    env: {},
    now: () => NOW,
    fetch: over.fetch ?? (async () => { throw new Error("connect ECONNREFUSED (faked)"); }),
    print: (line) => lines.push(line),
    printErr: (line) => errors.push(line),
  };
  return { io, lines, errors };
};

test("dpi backup create refuses while the daemon answers — the probe surfaces in the CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-backup-hz-"));
  try {
    const home = await fakeHome(root);

    const answered = cliHarness({ fetch: async () => ({ ok: true, status: 200 }) });
    assert.equal(await backupCli({ argv: ["create", "--home", home] }, answered.io), 1);
    assert.match(answered.errors.join("\n"), /device is running/);
    assert.match(answered.errors.join("\n"), /dpi device stop/);
    assert.equal(await exists(join(root, "home-backups")), false, "no backup dir was created");

    // refused connection (the default fake) → create proceeds, same as restore
    const refused = cliHarness();
    assert.equal(await backupCli({ argv: ["create", "--home", home] }, refused.io), 0);
    assert.match(refused.lines.join("\n"), /backed up 2 file\(s\)/);
    assert.ok(await exists(join(root, "home-backups")), "the backup landed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
