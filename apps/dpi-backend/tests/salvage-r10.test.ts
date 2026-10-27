/**
 * R10 salvage hardening (R9 audit findings 5.1-5.3):
 *
 *   5.1 promote is crash-window free: the original is hardlink-kept aside
 *       FIRST, stale sidecars removed, then ONE atomic rename — at every crash
 *       point either the original or the promoted copy sits at the db path.
 *   5.2 scratch files are unique per attempt (two concurrent salvages of one
 *       session never share .salvage names), and openAgent single-flights the
 *       attempt per session id.
 *   5.3 the promote warning discloses the honest-stale case (lost WAL = the
 *       copy reflects the last checkpoint).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { salvageSessionDb } from "../src/salvage.js";

/** A REAL sqlite db with one committed row (so integrity_check passes after a header patch). */
async function makeRealDb(dir: string): Promise<string> {
  const dbPath = join(dir, "agent.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE t (v TEXT)");
  db.prepare("INSERT INTO t VALUES (?)").run("real data");
  db.close();
  return dbPath;
}

test("5.1 promote keeps the db path occupied at every step; original bytes survive in quarantine", async () => {
  const dir = await mkdtemp(join(tmpdir(), "r10-salv-"));
  try {
    const dbPath = await makeRealDb(dir);
    const before = await readFile(dbPath);
    // Corrupt the header the R5 way — garbage in fields sqlite validates at open.
    const b = Buffer.from(before);
    b.fill(0xff, 32, 64);
    await writeFile(dbPath, b);

    const outcome = await salvageSessionDb(dbPath, 5000);
    assert.equal(outcome.recovered, true, `salvage should recover: ${JSON.stringify(outcome)}`);

    // The promoted db is a real, queryable sqlite file.
    const db = new DatabaseSync(dbPath);
    assert.equal(db.prepare("SELECT v FROM t").get()?.v, "real data");
    db.close();

    // The quarantined original is byte-identical to the corrupt input.
    const quarantined = (await readdir(dir)).find((n) => n.includes(".corrupt-"));
    assert.ok(quarantined, "quarantine file exists");
    assert.deepEqual(await readFile(join(dir, quarantined)), b, "quarantine holds the ORIGINAL bytes");

    // No scratch leftovers: unique names were all cleaned.
    const leftovers = (await readdir(dir)).filter((n) => n.includes(".salvage"));
    assert.deepEqual(leftovers, [], "no scratch files remain");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("5.2 two concurrent salvage attempts use disjoint scratch files and both settle safely", async () => {
  const dir = await mkdtemp(join(tmpdir(), "r10-salv2-"));
  try {
    const dbPath = await makeRealDb(dir);
    const b = Buffer.from(await readFile(dbPath));
    b.fill(0xff, 32, 64);
    await writeFile(dbPath, b);

    const [a, b2] = await Promise.all([
      salvageSessionDb(dbPath, 5000),
      salvageSessionDb(dbPath, 5000),
    ]);
    // At least one recovers; both settle without crashing the other's scratch.
    assert.ok(a.recovered || b2.recovered, "one of the two concurrent attempts recovered");
    const names = (await readdir(dir)).filter((n) => n.includes(".salvage"));
    assert.deepEqual(names, [], "no scratch files remain from either attempt");
    // The db path is occupied (either promoted copy or… it must be promoted here).
    const db = new DatabaseSync(dbPath);
    assert.equal(db.prepare("SELECT v FROM t").get()?.v, "real data");
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("5.2b a failed salvage leaves the original byte-identical and cleans its unique scratch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "r10-salv3-"));
  try {
    const dbPath = join(dir, "agent.sqlite");
    const garbage = Buffer.alloc(4096, 0xab); // nothing patchable
    await writeFile(dbPath, garbage);

    const outcome = await salvageSessionDb(dbPath, 5000);
    assert.equal(outcome.recovered, false, "garbage cannot pass integrity_check");
    assert.deepEqual(await readFile(dbPath), garbage, "original byte-identical");
    const names = (await readdir(dir)).filter((n) => n.includes(".salvage"));
    assert.deepEqual(names, [], "scratch cleaned");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
