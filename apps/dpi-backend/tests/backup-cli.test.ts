/**
 * `dpi backup` (checklist Wave 2): create/list/restore over the real fs in a
 * temp dir, with the clock pinned and the daemon probe faked — a real device
 * listening on 127.0.0.1:4780 must never make a test machine-dependent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupCli, defaultBackupCliIo, type BackupCliIo } from "../src/backup-cli.js";
import { readZipEntries } from "../src/backup.js";

/** Fixed clock: the default out name and the `.bak-<timestamp>` are deterministic modulo the timezone. */
const NOW = Date.UTC(2026, 9, 25, 3, 54, 9, 123);
const BAK_STAMP = new Date(NOW).toISOString().replace(/[:.]/g, "-");

/** A CLI io over the real fs with the clock pinned, an empty env, captured
 *  output and a daemon probe that is refused by default. */
const harness = (over: { env?: Record<string, string | undefined>; fetch?: BackupCliIo["fetch"] } = {}) => {
  const lines: string[] = [];
  const errors: string[] = [];
  const io: BackupCliIo = {
    ...defaultBackupCliIo(),
    env: over.env ?? {},
    now: () => NOW,
    fetch: over.fetch ?? (async () => { throw new Error("connect ECONNREFUSED (faked)"); }),
    print: (line) => lines.push(line),
    printErr: (line) => errors.push(line),
  };
  return { io, lines, errors };
};

/** A small fake device home: one registry, one log, one binary store file. */
async function fakeHome(root: string, name = "home"): Promise<string> {
  const home = join(root, name);
  await mkdir(join(home, "backend"), { recursive: true });
  await writeFile(join(home, "projects.json"), '{"version":1,"projects":[]}\n');
  await writeFile(join(home, "device.log"), "started\n");
  await writeFile(join(home, "backend", "catalog.sqlite"), Buffer.from([0, 1, 254, 255]));
  return home;
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

test("create writes the default timestamped zip and prints where it landed", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-backup-cli-"));
  try {
    const home = await fakeHome(root);
    const { io, lines } = harness();
    assert.equal(await backupCli({ argv: ["create", "--home", home] }, io), 0);
    const zip = lines[0];
    assert.ok(zip.startsWith(root), `the zip lands next to home: ${zip}`);
    assert.match(zip, /home-backups\/dpi-backup-\d{8}-\d{6}\.zip$/);
    assert.ok(await exists(zip), "the zip exists at the printed path");
    assert.match(lines.join("\n"), /backed up 3 file\(s\)/);
    assert.equal(readZipEntries(await readFile(zip)).length, 4, "manifest + 3 files");
    if (process.platform !== "win32") assert.equal((await stat(zip)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("list shows what create made, says when a dir is empty, and --dir overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-backup-cli-"));
  try {
    const home = await fakeHome(root);
    const made = harness();
    assert.equal(await backupCli({ argv: ["create", "--home", home] }, made.io), 0);
    const zip = made.lines[0];

    const listing = harness();
    assert.equal(await backupCli({ argv: ["list", "--home", home] }, listing.io), 0);
    const text = listing.lines.join("\n");
    assert.match(text, /1 backup\(s\) in .*home-backups/);
    assert.match(text, /dpi-backup-\d{8}-\d{6}\.zip/);
    assert.ok(text.includes(zip.split("/").pop()!));

    const empty = harness();
    assert.equal(await backupCli({ argv: ["list", "--home", join(root, "nope")] }, empty.io), 0);
    assert.match(empty.lines.join("\n"), /no backups yet in .*nope-backups/);

    await mkdir(join(root, "elsewhere"));
    const elsewhere = harness();
    assert.equal(await backupCli({ argv: ["list", "--dir", join(root, "elsewhere")] }, elsewhere.io), 0);
    assert.match(elsewhere.lines.join("\n"), /no backups yet in .*elsewhere/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore without --yes prints the plan and writes nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-backup-cli-"));
  try {
    const home = await fakeHome(root);
    const made = harness();
    assert.equal(await backupCli({ argv: ["create", "--home", home] }, made.io), 0);
    const zip = made.lines[0];

    const fresh = join(root, "fresh");
    const plan = harness();
    assert.equal(await backupCli({ argv: ["restore", zip, "--home", fresh] }, plan.io), 0);
    const text = plan.lines.join("\n");
    assert.match(text, /would restore 3 file\(s\)/);
    assert.ok(text.includes(fresh), "the plan names the target home");
    assert.match(text, /re-run with --yes/);
    assert.equal(await exists(fresh), false, "nothing was written");
    assert.ok(!(await readdir(root)).includes("fresh"));
    assert.equal(await exists(`${fresh}.bak-${BAK_STAMP}`), false, "no .bak either");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore with --yes unpacks the backup, and keeps the old home as .bak-<ts>", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-backup-cli-"));
  try {
    const home = await fakeHome(root);
    const made = harness();
    assert.equal(await backupCli({ argv: ["create", "--home", home] }, made.io), 0);
    const zip = made.lines[0];

    const fresh = join(root, "fresh");
    const run = harness();
    assert.equal(await backupCli({ argv: ["restore", zip, "--home", fresh, "--yes"] }, run.io), 0);
    assert.match(run.lines.join("\n"), /restored 3 file\(s\)/);
    assert.deepEqual(await readFile(join(fresh, "backend", "catalog.sqlite")), Buffer.from([0, 1, 254, 255]));

    // over the live home: renamed aside, never deleted
    const over = harness();
    assert.equal(await backupCli({ argv: ["restore", zip, "--home", home, "--yes"] }, over.io), 0);
    assert.match(over.lines.join("\n"), /previous home kept as .*\.bak-/);
    assert.ok(await exists(`${home}.bak-${BAK_STAMP}`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore refuses while the daemon answers, and the probe URL honours DPI_HOST/DPI_PORT", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-backup-cli-"));
  try {
    const home = await fakeHome(root);
    const made = harness();
    assert.equal(await backupCli({ argv: ["create", "--home", home] }, made.io), 0);
    const zip = made.lines[0];

    const answered = harness({ fetch: async () => ({ ok: true, status: 200 }) });
    assert.equal(await backupCli({ argv: ["restore", zip, "--home", join(root, "f1"), "--yes"] }, answered.io), 1);
    assert.match(answered.errors.join("\n"), /device is running/);
    assert.equal(await exists(join(root, "f1")), false);

    // plan-only mode refuses too: do not offer a plan you cannot execute
    const planned = harness({ fetch: async () => ({ ok: false, status: 503 }) });
    assert.equal(await backupCli({ argv: ["restore", zip, "--home", join(root, "f2")] }, planned.io), 1);
    assert.match(planned.errors.join("\n"), /device is running/);

    const seen: string[] = [];
    const probed = harness({
      env: { DPI_PORT: "4799", DPI_HOST: "0.0.0.0" },
      fetch: async (url) => {
        seen.push(url);
        return { ok: true, status: 200 };
      },
    });
    assert.equal(await backupCli({ argv: ["restore", zip, "--home", join(root, "f3"), "--yes"] }, probed.io), 1);
    assert.deepEqual(seen, ["http://127.0.0.1:4799/healthz"], "0.0.0.0 is probed over loopback, like doctor.ts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage errors exit 2, help exits 0, and nothing is ever thrown", async () => {
  const { io, lines, errors } = harness();
  assert.equal(await backupCli({ argv: [] }, io), 2);
  assert.match(errors.join("\n"), /unknown subcommand/);
  errors.length = 0;

  assert.equal(await backupCli({ argv: ["frobnicate"] }, io), 2);
  assert.match(errors.join("\n"), /unknown subcommand 'frobnicate'/);
  errors.length = 0;

  assert.equal(await backupCli({ argv: ["create", "--bogus"] }, io), 2);
  assert.match(errors.join("\n"), /unknown flag '--bogus'/);
  errors.length = 0;

  assert.equal(await backupCli({ argv: ["restore"] }, io), 2);
  assert.match(errors.join("\n"), /FILE/);
  errors.length = 0;

  assert.equal(await backupCli({ argv: ["restore", "a.zip", "b.zip"] }, io), 2, "one FILE, not two");
  errors.length = 0;

  assert.equal(await backupCli({ argv: ["--help"] }, io), 0);
  assert.match(lines.join("\n"), /dpi backup create/);
  assert.equal(lines.filter((l) => l.startsWith("ERR")).length, 0);
});

test("--home beats $DPI_HOME, --out lands where it is told, and a missing home is a clean exit 1", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-backup-cli-"));
  try {
    const homeA = await fakeHome(root, "a-home");
    await fakeHome(root, "b-home");

    const env = harness({ env: { DPI_HOME: join(root, "b-home") } });
    assert.equal(await backupCli({ argv: ["create", "--home", homeA] }, env.io), 0);
    assert.ok(await exists(join(root, "a-home-backups")), "the flag wins");
    assert.equal(await exists(join(root, "b-home-backups")), false);

    // without --home, $DPI_HOME is the home
    const fallback = harness({ env: { DPI_HOME: join(root, "b-home") } });
    assert.equal(await backupCli({ argv: ["create"] }, fallback.io), 0);
    assert.ok(await exists(join(root, "b-home-backups")), "$DPI_HOME is used");

    const custom = join(root, "custom", "nested", "x.zip");
    const out = harness();
    assert.equal(await backupCli({ argv: ["create", "--home", homeA, "--out", custom] }, out.io), 0);
    assert.equal(out.lines[0], custom, "the printed path is the --out path");
    assert.ok(await exists(custom), "missing parent dirs are created");

    const missing = harness();
    assert.equal(await backupCli({ argv: ["create", "--home", join(root, "ghost")] }, missing.io), 1);
    assert.match(missing.errors.join("\n"), /home directory not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
