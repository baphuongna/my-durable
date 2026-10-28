/**
 * R13 P3-1 — the gc retry contract:
 *
 *   delete-ok / sweep-fail writes a pending-sweep marker (ids kept for retry)
 *   and exits 1; a later `dpi gc --yes` (or standalone `dpi gc --sweep`) merges
 *   the marker, sweeps, clears it and exits 0. Before this, the printed
 *   "re-run later" advice was a dead end: a re-run with nothing to delete
 *   never swept again, so refs stayed dangling forever while cron read success.
 *
 * Level: unit-ish — gcCli against a temp data dir with real registries, a
 * stubbed device fetch (404 = version skew) and a stubbed io for files.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gcCli, type GcIo } from "../src/gc-cli.js";

const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** The io the CLI gets: stdout/stderr captured, REAL fs (the marker and
 *  registries live in a temp data dir), env with a device token, and a fetch
 *  that answers 404 (version skew), 200 (healthy daemon) or fails (offline). */
function makeIo(fetchStatus: number | "unreachable") {
  const lines: string[] = [];
  const errs: string[] = [];
  const realFetch = globalThis.fetch;
  if (fetchStatus !== "unreachable") {
    globalThis.fetch = (async () =>
      ({
        ok: fetchStatus >= 200 && fetchStatus < 300,
        status: fetchStatus,
        json: async () => ({ schedules: 1, graphRuns: 0 }),
      }) as unknown as Response) as typeof fetch;
  } else {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
  }
  const io: GcIo = {
    print: (l) => lines.push(l),
    printErr: (l) => errs.push(l),
    env: { DPI_PORT: "4780", DPI_TOKEN: "tok" },
    readFile: (p) => readFileSync(p, "utf8"),
    homedir: () => tmpdir(),
    now: () => Date.now(),
    writeFile: (p, data) => void writeFileSync(p, data),
    remove: (p) => void rmSync(p, { force: true }),
  };
  return { io, lines, errs, restore: () => void (globalThis.fetch = realFetch) };
}

/** A data dir with one 40d-old archive bundle + one dangling schedule ref. */
async function fixture(): Promise<{ dataDir: string; archiveDir: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), "r13-gc-"));
  const archiveDir = join(dataDir, "archive");
  await mkdir(join(archiveDir, `${SID}-${Date.now() - 40 * 86_400_000}`), { recursive: true });
  await writeFile(
    join(dataDir, "schedules.json"),
    JSON.stringify({
      version: 1,
      schedules: [
        {
          id: "sch_1",
          name: "sweep",
          cwd: "/tmp/x",
          model: { provider: "faux", modelId: "echo" },
          prompt: "p",
          everyMinutes: 5,
          lastSessionId: SID,
        },
      ],
    }),
  );
  await writeFile(join(dataDir, "graphs.json"), JSON.stringify({ version: 1, graphs: [], runs: [] }));
  return { dataDir, archiveDir };
}

test("delete-ok/sweep-fail exits 1 and KEEPS the ids for retry (the marker)", async () => {
  const { dataDir, archiveDir } = await fixture();
  const rig = makeIo(404); // version-skewed daemon answers 404 to the sweep route
  try {
    const code = await gcCli({ argv: ["--closed-before", "30d", "--yes", "--data-dir", dataDir] }, rig.io);
    assert.equal(code, 1, "a failed sweep after a real delete is NOT success");
    const marker = join(dataDir, "gc-pending-sweep.json");
    assert.ok(await stat(marker).then(() => true, () => false), "the marker file exists");
    assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")).ids, [SID], "the removed id is kept for retry");
    assert.match(rig.errs.join("\n"), /dpi gc --sweep/, "the remedy names the standalone retry");
    assert.match(rig.errs.join("\n"), /predates the sweep route/, "the 404 names version skew");

    // A later run with NOTHING to delete (the bundle is already gone) still
    // merges the marker and retries — the R13 fix for the dead-end retry.
    rig.restore();
    const healthy = makeIo(200); // the daemon answers the sweep now
    const code2 = await gcCli({ argv: ["--closed-before", "30d", "--yes", "--data-dir", dataDir] }, healthy.io);
    assert.equal(code2, 0, "the merged sweep succeeds");
    assert.match(healthy.lines.join("\n"), /included 1 pending ref id/, "the retry is reported");
    assert.ok(
      await stat(join(dataDir, "gc-pending-sweep.json")).then(() => false, () => true),
      "the marker is cleared after success",
    );
    healthy.restore();
  } finally {
    rig.restore();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("dpi gc --sweep: standalone retry; nothing pending is a clean no-op", async () => {
  const { dataDir } = await fixture();
  const rig = makeIo("unreachable"); // offline: registries are lock-swept for real
  try {
    const none = makeIo("unreachable");
    const code0 = await gcCli({ argv: ["--sweep", "--data-dir", dataDir] }, none.io);
    assert.equal(code0, 0, "nothing pending: clean no-op");
    assert.match(none.lines.join("\n"), /no pending ref sweep/);
    none.restore();

    // Seed a marker; the device is unreachable, so the offline lock path sweeps
    // the REAL registries (no daemon race) and clears the marker.
    writeFileSync(join(dataDir, "gc-pending-sweep.json"), JSON.stringify({ ids: [SID] }));
    const code = await gcCli({ argv: ["--sweep", "--data-dir", dataDir] }, rig.io);
    assert.equal(code, 0, "the standalone retry succeeds offline");
    assert.match(rig.lines.join("\n"), /swept 1 pending ref id/);
    const after = JSON.parse(readFileSync(join(dataDir, "schedules.json"), "utf8"));
    assert.equal(after.schedules[0].lastSessionId, undefined, "the dangling ref is gone");
    assert.ok(
      await stat(join(dataDir, "gc-pending-sweep.json")).then(() => false, () => true),
      "marker cleared",
    );
  } finally {
    rig.restore();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("dry-run reports pending sweep ids", async () => {
  const { dataDir } = await fixture();
  writeFileSync(join(dataDir, "gc-pending-sweep.json"), JSON.stringify({ ids: [SID] }));
  const rig = makeIo("unreachable");
  try {
    const code = await gcCli({ argv: ["--closed-before", "30d", "--data-dir", dataDir] }, rig.io);
    assert.equal(code, 0);
    assert.match(rig.lines.join("\n"), /1 pending ref id\(s\).*--yes \(or --sweep\)/);
  } finally {
    rig.restore();
    await rm(dataDir, { recursive: true, force: true });
  }
});
