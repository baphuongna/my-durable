/**
 * GA-14 — a directory that holds secrets must be private to this account. `mkdir -m` only applies
 * to directories it creates, so a restored/copied/pre-existing 0777 directory used to stay open
 * (any local account could replace the 0600 files inside it by unlinking them).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NetworkRegistry } from "../src/node/registry.js";
import { migrateRegistryFile } from "../src/node/registry-migration.js";
import { ensurePrivateDir } from "../src/node/private-dir.js";

const mode = (p: string) => statSync(p).mode & 0o777;
const uid = process.getuid?.();
/** A directory some other account owns (root's /tmp). Unusable when the suite itself runs as root. */
const FOREIGN = "/tmp";
const foreignAvailable = uid !== undefined && uid !== 0 && statSync(FOREIGN).uid !== uid;

function scratch(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dpi-ga14-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("GA-14: opening the registry tightens a pre-existing open directory to 0700", () => {
  const s = scratch();
  try {
    const home = join(s.dir, "home");
    mkdirSync(home, { mode: 0o777 });
    chmodSync(home, 0o777);
    assert.equal(mode(home), 0o777, "premise: the directory starts world-writable");

    const registry = new NetworkRegistry(join(home, "network.sqlite"));
    try {
      assert.equal(mode(home), 0o700);
      assert.equal(mode(join(home, "network.sqlite")), 0o600);
    } finally {
      registry.close();
    }
  } finally {
    s.done();
  }
});

test("GA-14: ensurePrivateDir creates missing directories 0700 and leaves a private one alone", () => {
  const s = scratch();
  try {
    const deep = join(s.dir, "a", "b", "c");
    assert.equal(ensurePrivateDir(deep), "created");
    for (const d of [join(s.dir, "a"), join(s.dir, "a", "b"), deep]) assert.equal(mode(d), 0o700, d);
    assert.equal(ensurePrivateDir(deep), "private");
    assert.equal(mode(deep), 0o700);
  } finally {
    s.done();
  }
});

test("GA-14: any group/other bit tightens to exactly 0700; with them already gone the owner's bits survive verbatim", () => {
  const s = scratch();
  try {
    // Tighten always lands on exactly 0700 — it is a chmod, not a mask, so an input
    // that is missing owner bits (0o640) gains owner-execute on the way to 0700.
    for (const loose of [0o750, 0o705, 0o770, 0o755, 0o777, 0o701, 0o710, 0o640]) {
      const d = join(s.dir, `m${loose.toString(8)}`);
      mkdirSync(d);
      chmodSync(d, loose);
      assert.equal(ensurePrivateDir(d), "tightened", loose.toString(8));
      assert.equal(mode(d), 0o700, loose.toString(8));
    }
    // Group/other already clean ⇒ "private" with NO chmod: 0o600/0o500 stay exactly
    // as they were. The guarantee is "usable only by this account", not rwx for it.
    for (const already of [0o600, 0o500]) {
      const d = join(s.dir, `m${already.toString(8)}`);
      mkdirSync(d);
      chmodSync(d, already);
      assert.equal(ensurePrivateDir(d), "private", already.toString(8));
      assert.equal(mode(d), already, `${already.toString(8)}: the owner's bits are not forced to 7`);
    }
  } finally {
    s.done();
  }
});

test("GA-14: a path that is not a directory is refused", () => {
  const s = scratch();
  try {
    const file = join(s.dir, "file");
    writeFileSync(file, "x");
    assert.throws(() => ensurePrivateDir(file), /not a directory/);
  } finally {
    s.done();
  }
});

test("GA-14: a symlink to one's own directory is followed and the target is tightened", () => {
  const s = scratch();
  try {
    const target = join(s.dir, "target");
    mkdirSync(target);
    chmodSync(target, 0o755);
    const link = join(s.dir, "link");
    symlinkSync(target, link);
    assert.equal(ensurePrivateDir(link), "tightened");
    assert.equal(mode(target), 0o700);
  } finally {
    s.done();
  }
});

test("GA-14: a directory owned by another account is refused and left untouched", (t) => {
  // A silent skip would look like a pass; announce exactly why the scenario cannot run here.
  if (!foreignAvailable) {
    t.skip(
      uid === 0
        ? "running as root — ownership refusal not observable (root owns /tmp itself)"
        : `no directory owned by another account is available (uid=${uid}, /tmp is not foreign)`,
    );
    return;
  }
  const before = mode(FOREIGN);
  assert.throws(() => ensurePrivateDir(FOREIGN), /owned by uid \d+, not by this account/);
  assert.equal(mode(FOREIGN), before, "refusal must not chmod it");
  const s = scratch();
  try {
    const link = join(s.dir, "link");
    symlinkSync(FOREIGN, link);
    assert.throws(() => ensurePrivateDir(link), /owned by uid/, "a symlink does not launder ownership");
    assert.throws(() => new NetworkRegistry(join(FOREIGN, `dpi-ga14-${process.pid}.sqlite`)), /owned by uid/);
    assert.throws(() => migrateRegistryFile(join(FOREIGN, `dpi-ga14-${process.pid}.sqlite`)), /owned by uid/);
  } finally {
    s.done();
  }
});

test("GA-14: the migration path tightens the directory too (cold start via migrateRegistryFile)", () => {
  const s = scratch();
  try {
    const home = join(s.dir, "home");
    mkdirSync(home);
    chmodSync(home, 0o775);
    migrateRegistryFile(join(home, "network.sqlite"));
    assert.equal(mode(home), 0o700);
  } finally {
    s.done();
  }
});
