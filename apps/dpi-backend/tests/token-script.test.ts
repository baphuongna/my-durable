/**
 * `npm run token`: the env file ends 0600 and is replaced atomically, and the script never loosens or tightens a
 * directory that is not the device's own state directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const mode = (p: string) => statSync(p).mode & 0o777;
const SCRIPT = resolve(import.meta.dirname, "../scripts/token.ts");
const BACKEND = resolve(import.meta.dirname, "..");
const TSX = join(BACKEND, "node_modules/.bin/tsx");
const OLD = `dpi_${"o".repeat(43)}`;

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "dpi-token-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(env: Record<string, string>, args: string[] = [], cwd = BACKEND) {
  const clean = { ...process.env };
  delete clean.DPI_HOME;
  delete clean.DPI_ENV_FILE;
  return spawnSync(TSX, [SCRIPT, ...args], { env: { ...clean, ...env }, encoding: "utf8", cwd });
}

const privateHome = (root: string) => {
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  return home;
};

test("B5: an existing token file with loose permissions ends 0600 and its token is kept", () => {
  const s = scratch();
  try {
    const home = privateHome(s.dir);
    const file = join(home, "backend.env");
    writeFileSync(file, `DPI_TOKEN=${OLD}\nOTHER=1\n`, { mode: 0o644 });
    chmodSync(file, 0o644);
    const r = run({ DPI_HOME: home, DPI_ENV_FILE: file });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), OLD);
    assert.equal(mode(file), 0o600);
    assert.equal(readFileSync(file, "utf8"), `DPI_TOKEN=${OLD}\nOTHER=1\n`);
  } finally {
    s.done();
  }
});

test("B5: --rotate replaces the file by renaming a private temp file, keeps the other lines, leaves 0600 and no temp", () => {
  const s = scratch();
  try {
    const home = privateHome(s.dir);
    const file = join(home, "backend.env");
    writeFileSync(file, `OTHER=1\nDPI_TOKEN=${OLD}\n`, { mode: 0o666 });
    chmodSync(file, 0o666);
    const before = statSync(file).ino;
    const r = run({ DPI_HOME: home, DPI_ENV_FILE: file }, ["--rotate"]);
    assert.equal(r.status, 0, r.stderr);
    const token = r.stdout.trim();
    assert.match(token, /^dpi_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(token, OLD);
    assert.equal(readFileSync(file, "utf8"), `DPI_TOKEN=${token}\nOTHER=1\n`);
    assert.equal(mode(file), 0o600);
    assert.notEqual(statSync(file).ino, before, "a new file took the old one's place");
    assert.deepEqual(readdirSync(home), ["backend.env"]);
  } finally {
    s.done();
  }
});

test("B5: a first run creates the missing directories 0700 and the file 0600 without touching the existing parent", () => {
  const s = scratch();
  try {
    chmodSync(s.dir, 0o755);
    const file = join(s.dir, "new", "deeper", "backend.env");
    const r = run({ DPI_ENV_FILE: file, DPI_HOME: join(s.dir, "elsewhere") });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout.trim(), /^dpi_/);
    assert.equal(mode(file), 0o600);
    assert.equal(mode(join(s.dir, "new", "deeper")), 0o700);
    assert.equal(mode(join(s.dir, "new")), 0o700);
    assert.equal(mode(s.dir), 0o755, "the parent that already existed is left alone");
  } finally {
    s.done();
  }
});

test("B5: an existing loose directory that is not the device home is refused, not chmod'ed", () => {
  const s = scratch();
  try {
    const loose = join(s.dir, "shared");
    mkdirSync(loose);
    chmodSync(loose, 0o755);
    const file = join(loose, "backend.env");
    const r = run({ DPI_HOME: join(s.dir, "home"), DPI_ENV_FILE: file }, ["--rotate"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /shared/);
    assert.match(r.stderr, /chmod 700|private directory/);
    assert.equal(r.stdout.trim(), "", "no token is printed when nothing was saved");
    assert.equal(mode(loose), 0o755);
    assert.equal(existsSync(file), false);
  } finally {
    s.done();
  }
});

test("B5: a bare file name in a loose working directory never chmods the working directory", () => {
  const s = scratch();
  try {
    chmodSync(s.dir, 0o755);
    const r = run({ DPI_HOME: join(s.dir, "home"), DPI_ENV_FILE: "backend.env" }, [], s.dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /chmod 700|private directory/);
    assert.equal(mode(s.dir), 0o755);
    assert.equal(existsSync(join(s.dir, "backend.env")), false);
  } finally {
    s.done();
  }
});

test("B5: the device home itself is still tightened (it is the script's own state directory)", () => {
  const s = scratch();
  try {
    const home = join(s.dir, "home");
    mkdirSync(home);
    chmodSync(home, 0o755);
    const r = run({ DPI_HOME: home });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(mode(home), 0o700);
    assert.equal(mode(join(home, "backend.env")), 0o600);
  } finally {
    s.done();
  }
});

test("B5: a symlinked token file is refused rather than replaced or followed", () => {
  const s = scratch();
  try {
    const home = privateHome(s.dir);
    const target = join(s.dir, "target.env");
    writeFileSync(target, `DPI_TOKEN=${OLD}\n`, { mode: 0o600 });
    const file = join(home, "backend.env");
    symlinkSync(target, file);
    const r = run({ DPI_HOME: home, DPI_ENV_FILE: file }, ["--rotate"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /symlink/);
    assert.equal(readFileSync(target, "utf8"), `DPI_TOKEN=${OLD}\n`);
  } finally {
    s.done();
  }
});

test("B5: a DPI_HOME that is the working directory (or another shared place) is refused, not tightened", () => {
  const s = scratch();
  try {
    chmodSync(s.dir, 0o755);
    const r = run({ DPI_HOME: s.dir }, [], s.dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /chmod 700|private directory/);
    assert.equal(mode(s.dir), 0o755);
    assert.equal(existsSync(join(s.dir, "backend.env")), false);
  } finally {
    s.done();
  }
});
