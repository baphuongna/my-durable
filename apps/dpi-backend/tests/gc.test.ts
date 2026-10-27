/**
 * Retention / GC (checklist Wave 2, policy gate #3): the module can only plan
 * and apply what it is told — there are no defaults and no timer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gcApply, gcPlan, humanBytes, parseArchivedName, parseDuration } from "../src/gc.js";
import { gcCli, type GcIo } from "../src/gc-cli.js";

const DAY = 86_400_000;

/** A fake device archive: three archived sessions, one alien directory, one stray file. */
async function archive() {
  const root = await mkdtemp(join(tmpdir(), "dpi-gc-"));
  const dir = join(root, "archive");
  await mkdir(dir, { recursive: true });
  const now = Date.now();
  const make = async (id: string, ageDays: number, bytes: number) => {
    const target = join(dir, `${id}-${now - ageDays * DAY}`);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "agent.sqlite"), "x".repeat(bytes));
  };
  await make("aaaa1111-0000-0000-0000-000000000000", 40, 100);
  await make("bbbb2222-0000-0000-0000-000000000000", 10, 200);
  await make("cccc3333-0000-0000-0000-000000000000", 1, 300);
  await mkdir(join(dir, "not-a-session"), { recursive: true });
  await writeFile(join(dir, "stray.txt"), "x");
  return { root, dir, now };
}

test("parseArchivedName only accepts <sessionId>-<closedAtMs>", () => {
  assert.equal(
    parseArchivedName("abc-1790000000000"),
    undefined,
    "non-uuid names are not bundles — GC never deletes what the browser cannot list (R8 3.1)",
  );
  assert.equal(parseArchivedName("not-a-session"), undefined);
  assert.equal(parseArchivedName("abc-1"), undefined, "a short number is not a timestamp");
  assert.equal(parseArchivedName("abc-1790000000000.zip"), undefined);
});

test("gcPlan names exactly what a cutoff selects, and never touches the disk", async () => {
  const a = await archive();
  try {
    const plan = await gcPlan(a.dir, { closedBeforeDays: 30, now: a.now });
    assert.equal(plan.total.count, 3);
    assert.equal(plan.total.bytes, 600);
    assert.deepEqual(plan.candidates.map((c) => c.sessionId.slice(0, 4)), ["aaaa"]);
    assert.equal(plan.candidates[0].ageDays, 40);
    assert.equal(plan.candidateBytes, 100);
    assert.deepEqual(plan.skipped, [{ name: "not-a-session", reason: "not an archived-session directory" }]);
    // Nothing was deleted by planning.
    assert.equal((await readdir(a.dir)).length, 5);

    const none = await gcPlan(a.dir, { closedBeforeDays: 365, now: a.now });
    assert.deepEqual(none.candidates, []);
    await assert.rejects(() => gcPlan(a.dir, { closedBeforeDays: 0 }), /positive/);
    // Sub-day cutoffs work (R5 finding 6): the CLI's advertised 12h/90m arrive as fractional days.
    const halfDay = await gcPlan(a.dir, { closedBeforeDays: 0.5, now: a.now });
    assert.deepEqual(halfDay.candidates.map((c) => c.sessionId.slice(0, 4)), ["cccc", "bbbb", "aaaa"]);
    const quarterDay = await gcPlan(a.dir, { closedBeforeDays: parseDuration("90m"), now: a.now });
    assert.equal(quarterDay.candidates.length, 3);
  } finally {
    await rm(a.root, { recursive: true, force: true });
  }
});

test("gcApply deletes only the plan's candidates, including nested files", async () => {
  const a = await archive();
  try {
    const { removed, bytes } = await gcApply(a.dir, { closedBeforeDays: 30, now: a.now });
    assert.equal(removed.length, 1);
    assert.equal(bytes, 100);
    const left = await readdir(a.dir);
    assert.equal(left.length, 4);
    assert.ok(!left.some((n) => n.startsWith("aaaa")), "the old session is gone");
    assert.ok(left.includes("not-a-session"), "an alien directory is never deleted");
    assert.ok(left.includes("stray.txt"));
  } finally {
    await rm(a.root, { recursive: true, force: true });
  }
});

test("parseDuration reads what a human types", () => {
  assert.equal(parseDuration("30d"), 30);
  assert.equal(parseDuration("2w"), 14);
  assert.equal(parseDuration("12h"), 0.5);
  assert.equal(parseDuration("90m"), 0.0625);
  assert.throws(() => parseDuration("30"), /duration/i);
  assert.throws(() => parseDuration("0d"), /positive/i);
  assert.equal(humanBytes(1536), "1.5 KiB");
});

test("the CLI is dry-run by default and needs --yes to delete", async () => {
  const a = await archive();
  const lines: string[] = [];
  const io: GcIo = {
    print: (l) => lines.push(l),
    printErr: (l) => lines.push(`ERR ${l}`),
    env: { DPI_HOME: a.root },
    readFile: () => "",
    homedir: () => a.root,
    now: () => a.now,
  };
  try {
    assert.equal(await gcCli({ argv: ["--closed-before", "30d", "--data-dir", a.root] }, io), 0);
    assert.match(lines.join("\n"), /would delete 1 session/);
    assert.match(lines.join("\n"), /re-run with --yes/);
    assert.equal((await readdir(a.dir)).length, 5, "dry-run deleted nothing");

    lines.length = 0;
    assert.equal(await gcCli({ argv: ["--closed-before", "30d", "--yes", "--data-dir", a.root] }, io), 0);
    assert.match(lines.join("\n"), /deleted 1 archived session/);
    assert.equal((await readdir(a.dir)).length, 4);

    lines.length = 0;
    assert.equal(await gcCli({ argv: [] }, io), 2, "no cutoff is a usage error");
    assert.match(lines.join("\n"), /--closed-before DURATION is required/);
    lines.length = 0;
    assert.equal(await gcCli({ argv: ["--closed-before", "30d", "--bogus"] }, io), 2);
    assert.match(lines.join("\n"), /unknown flag/);
  } finally {
    await rm(a.root, { recursive: true, force: true });
  }
});
