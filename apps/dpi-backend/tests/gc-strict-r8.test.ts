/**
 * Audit 3.1 (R8): gc must parse archive bundles with the SAME strict pattern
 * the archive browser/restore use (`archived.ts` BUNDLE_DIR_PATTERN) and must
 * NEVER delete a directory the browser cannot list. The old loose
 * `<name>-<10+ digits>` form parsed operator directories like
 * `nas-backup-2025010112` as closed bundles (10 digits → a bogus closedAt) and
 * `dpi gc --closed-before 30d --yes` rm -rf'd data the UI never showed.
 *
 * Contract under test:
 *  - non-matching dirs (operator names, epoch-seconds, junk, wrong-length ids,
 *    uppercase) → skipped + reported, never deleted;
 *  - strict `<36 hex/dash uuid>-<13-digit ms>` bundles still parse and delete
 *    per retention;
 *  - shape-matching but out-of-range closedAt (13 zeros → 0, absurd future) →
 *    skipped, never deleted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archivedEntries, gcApply, gcPlan, parseArchivedName } from "../src/gc.js";
import { gcCli, type GcIo } from "../src/gc-cli.js";

const DAY = 86_400_000;
/** 36 chars, lowercase hex + dashes — exactly what the browser accepts. */
const UUID_A = "11111111-2222-4333-8444-555555555555";
const UUID_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const UUID_C = "12345678-90ab-4cde-8f01-23456789abcd";

/** Directories the browser cannot list — gc must report every one and keep it. */
const JUNK_DIRS = [
  "nas-backup-2025010112", // operator/backup-tool name with a 10-digit tail
  "dump-1735689600", // epoch SECONDS
  "random-junk", // no digits at all
  "AAAABBBB-0000-0000-0000-000000000000-1735689600000", // uppercase → not [0-9a-f]
  "short-1735689600000", // sessionId part is not 36 chars
];

/** The archive fixture: three strict bundles (40d/10d/1d old) + junk + pathological closedAt. */
async function archive() {
  const root = await mkdtemp(join(tmpdir(), "dpi-gc-strict-r8-"));
  const dir = join(root, "archive");
  await mkdir(dir, { recursive: true });
  const now = Date.now();
  const make = async (name: string, bytes: number) => {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, "agent.sqlite"), "x".repeat(bytes));
  };
  await make(`${UUID_A}-${now - 40 * DAY}`, 100); // strict, old → deletable
  await make(`${UUID_B}-${now - 10 * DAY}`, 200); // strict, recent → kept
  await make(`${UUID_C}-${now - 1 * DAY}`, 300); // strict, newest → kept
  for (const name of JUNK_DIRS) await make(name, 10);
  await make(`${UUID_A}-0000000000000`, 10); // matches \d{13} but closedAt = 0
  await make(`${UUID_B}-9999999999999`, 10); // absurd future (year 2286)
  await writeFile(join(dir, "stray.txt"), "x"); // files are invisible to gc
  return { root, dir, now };
}

const everyName = (names: readonly string[]) => {
  const wanted = [...names, "stray.txt"];
  return {
    allPresent: async (dir: string) => {
      const left = await readdir(dir);
      for (const name of wanted) assert.ok(left.includes(name), `expected ${name} to survive (saw ${JSON.stringify(left)})`);
      return left;
    },
  };
};

test("parseArchivedName is as strict as the archive browser's bundle pattern", () => {
  assert.deepEqual(parseArchivedName(`${UUID_A}-1735689600000`), { sessionId: UUID_A, closedAt: 1735689600000 });
  for (const name of JUNK_DIRS) assert.equal(parseArchivedName(name), undefined, `${name} must not parse`);
  assert.equal(parseArchivedName(`${UUID_A}-173568960000`), undefined, "12 digits is not a 13-digit ms timestamp");
  assert.equal(parseArchivedName(`${UUID_A}-17356896000000`), undefined, "14 digits is not a 13-digit ms timestamp");
  assert.equal(parseArchivedName(`${UUID_A}-0000000000000`), undefined, "closedAt 0 is out of range: skip, don't delete");
});

test("gcPlan skips and reports every directory the browser cannot list, and touches nothing", async () => {
  const a = await archive();
  try {
    const plan = await gcPlan(a.dir, { closedBeforeDays: 30, now: a.now });
    // Only the three strict bundles count as archive content.
    assert.equal(plan.total.count, 3);
    assert.equal(plan.total.bytes, 600);
    assert.deepEqual(plan.candidates.map((c) => c.sessionId.slice(0, 8)), [UUID_A.slice(0, 8)]);
    // Every junk dir is reported, each with its reason — same channel the browser uses.
    const byName = new Map(plan.skipped.map((s) => [s.name, s.reason]));
    for (const name of JUNK_DIRS) {
      assert.equal(byName.get(name), "not an archived-session directory", `${name} must be reported as skipped`);
    }
    // Shape-matches with out-of-range closedAt: 13 zeros parses to 0 → refused
    // (reported skipped, never guessed at); the future stamp is named as such.
    assert.equal(byName.get(`${UUID_A}-0000000000000`), "not an archived-session directory");
    assert.equal(byName.get(`${UUID_B}-9999999999999`), "closedAt is in the future — never auto-deleted");
    // Planning is a pure read.
    assert.equal((await readdir(a.dir)).length, 3 + JUNK_DIRS.length + 2 + 1);
  } finally {
    await rm(a.root, { recursive: true, force: true });
  }
});

test("gcApply deletes only strict, in-range, old bundles — junk and odd stamps survive", async () => {
  const a = await archive();
  try {
    const { removed, bytes } = await gcApply(a.dir, { closedBeforeDays: 30, now: a.now });
    assert.equal(removed.length, 1);
    assert.equal(removed[0]!.sessionId, UUID_A);
    assert.equal(bytes, 100);
    const left = await everyName([...JUNK_DIRS, `${UUID_A}-0000000000000`, `${UUID_B}-9999999999999`, `${UUID_B}-${a.now - 10 * DAY}`, `${UUID_C}-${a.now - 1 * DAY}`]).allPresent(a.dir);
    assert.equal(left.length, 10, "exactly the one old strict bundle is gone");
  } finally {
    await rm(a.root, { recursive: true, force: true });
  }
});

test("even a keep-everything cutoff never selects future-stamped or zero-stamped bundles", async () => {
  const a = await archive();
  try {
    // A 1d cutoff (≤ the age of the youngest bundle) selects all three real
    // bundles. A future closedAt can never satisfy closedAt <= cutoff, and
    // closedAt 0 is refused at parse time — the guards turn both into reported
    // skips instead of silent archive contents, whatever the operator types.
    const plan = await gcPlan(a.dir, { closedBeforeDays: 1, now: a.now });
    assert.deepEqual(
      plan.candidates.map((c) => c.sessionId).sort(),
      [UUID_A, UUID_B, UUID_C].sort(),
      "only the three strict, past-stamped bundles are ever deletable",
    );
    assert.ok(plan.skipped.some((s) => s.name === `${UUID_B}-9999999999999`));
    assert.ok(plan.skipped.some((s) => s.name === `${UUID_A}-0000000000000`));
    const direct = await archivedEntries(a.dir, a.now);
    assert.ok(!direct.entries.some((e) => e.closedAt > a.now || e.closedAt <= 0), "out-of-range closedAt never becomes an entry");
    const { removed } = await gcApply(a.dir, { closedBeforeDays: 1, now: a.now });
    assert.equal(removed.length, 3);
    await everyName([...JUNK_DIRS, `${UUID_A}-0000000000000`, `${UUID_B}-9999999999999`, "stray.txt"]).allPresent(a.dir);
  } finally {
    await rm(a.root, { recursive: true, force: true });
  }
});

test("the CLI reports the skipped directories on the plan path", async () => {
  const a = await archive();
  const out: string[] = [];
  const errs: string[] = [];
  const io: GcIo = {
    print: (l) => out.push(l),
    printErr: (l) => errs.push(l),
    env: { DPI_HOME: a.root },
    readFile: () => "",
    homedir: () => a.root,
    now: () => a.now,
  };
  try {
    assert.equal(await gcCli({ argv: ["--closed-before", "30d", "--data-dir", a.root] }, io), 0);
    assert.match(out.join("\n"), /3 archived session\(s\)/);
    assert.match(out.join("\n"), /would delete 1 session\(s\)/);
    for (const name of JUNK_DIRS) assert.ok(errs.some((l) => l === `skipped ${name}: not an archived-session directory`), `stderr must report skipped ${name}, got ${JSON.stringify(errs)}`);
    assert.ok(errs.some((l) => l === `skipped ${UUID_B}-9999999999999: closedAt is in the future — never auto-deleted`));
    // And --yes still deletes exactly the one strict old bundle.
    out.length = errs.length = 0;
    assert.equal(await gcCli({ argv: ["--closed-before", "30d", "--yes", "--data-dir", a.root] }, io), 0);
    assert.match(out.join("\n"), /deleted 1 archived session/);
    await everyName([...JUNK_DIRS, `${UUID_A}-0000000000000`, `${UUID_B}-9999999999999`, "stray.txt"]).allPresent(a.dir);
  } finally {
    await rm(a.root, { recursive: true, force: true });
  }
});
