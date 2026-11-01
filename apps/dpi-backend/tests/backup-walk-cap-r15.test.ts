/**
 * Run-15 (u2-3, backend hunter): walkHome refuses to enumerate past
 * MAX_WALK_ENTRIES (200_000) — a runaway home (a symlink explosion, a
 * pathological sessions tree) used to grind through unbounded stat calls
 * before any byte cap could fire. BackupError("too_many_entries") with a
 * clear message; depth and byte caps unchanged. Pure fake io: no real fs —
 * the fake readdir fabricates more entries than the cap.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  BackupError,
  MAX_WALK_ENTRIES,
  createBackup,
  defaultBackupIo,
  type BackupIo,
  type BackupStat,
} from "../src/backup.js";

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0, 0);

const fileStat = (): BackupStat => ({ isFile: () => true, isDirectory: () => false, size: 0, mode: 0o600, mtimeMs: 0 });
const dirStat = (): BackupStat => ({ isFile: () => false, isDirectory: () => true, size: 0, mode: 0o600, mtimeMs: 0 });

test("u2-3: a home enumerating past MAX_WALK_ENTRIES refuses with too_many_entries, not an unbounded grind", async () => {
  const home = "/fake/runaway-home";
  const io: BackupIo = {
    ...defaultBackupIo(),
    now: () => NOW,
    stat: async (path) => (path === home ? dirStat() : fileStat()),
    // One flat directory with one entry PAST the cap — the walk must throw
    // at the (cap+1)-th name, before that entry is ever stat'd.
    readdir: async () => Array.from({ length: MAX_WALK_ENTRIES + 1 }, (_, i) => `entry-${i}`),
  };
  await assert.rejects(
    createBackup(io, { home, out: "/fake/out/backup.zip" }),
    (err: unknown) => {
      assert.ok(err instanceof BackupError, "the walk cap is a BackupError");
      assert.equal((err as BackupError).code, "too_many_entries");
      assert.match((err as BackupError).message, /200000 entries/, "the message names the cap");
      assert.match((err as BackupError).message, /runaway/, "the message says what it suspects");
      return true;
    },
  );
});

/** Note (run-15 u2-3): an exactly-at-cap boundary test is not reachable
 *  through createBackup — the zip format's EOCD entry count is a u16, so a
 *  200_000-file archive fails in zipBytes (RangeError) before the boundary
 *  could ever matter. The walk cap is pinned by the over-cap refusal above. */
