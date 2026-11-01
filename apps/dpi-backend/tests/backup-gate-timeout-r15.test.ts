/**
 * Run-15 (u2-2, backend hunter): withBackupGate races each CALLER against
 * BACKUP_GATE_TIMEOUT_MS. A hung op (an io.readFile that never settles)
 * used to leave every later create/restore promise pending forever with
 * nothing to surface. The fix rejects the CALLER with
 * BackupError("gate_timeout") while the gate stays chained on the raw op —
 * the hung op is NOT aborted; the next caller keeps FIFO-ing behind it,
 * each with its own deadline. The deadline itself is injectable via
 * setBackupGateTimeoutForTests (git.ts's setGitClockForTests pattern),
 * because a fake io cannot fast-forward a real timer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUP_GATE_TIMEOUT_MS,
  BackupError,
  createBackup,
  defaultBackupIo,
  setBackupGateTimeoutForTests,
  type BackupIo,
} from "../src/backup.js";

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0, 0);

const settle = () => new Promise<void>((r) => setImmediate(r));

test("u2-2: a hung op holding the gate fails the next caller fast with gate_timeout; the op itself is not aborted", async () => {
  const root = await mkdtemp(join(tmpdir(), "dpi-r15-gate-"));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "device.log"), "one entry\n");

  // io.readFile parks forever until the test releases it — a hung fs read
  // mid zip-build is exactly the shape the finding describes.
  let releaseRead: (() => void) | undefined;
  const hungIo: BackupIo = {
    ...defaultBackupIo(),
    now: () => NOW,
    readFile: () =>
      new Promise((resolve) => {
        releaseRead = () => resolve(new Uint8Array([0x41]));
      }),
  };

  let firstSettled: "pending" | "ok" | "error" = "pending";
  const first = createBackup(hungIo, { home, out: join(root, "out", "first.zip") }).then(
    (r) => ((firstSettled = "ok"), r),
    (e) => ((firstSettled = "error"), e),
  );
  await settle();
  await settle();
  assert.equal(firstSettled, "pending", "the first op walked and is parked inside the gate on io.readFile");

  try {
    // Arm the short deadline only NOW: the first caller's race was armed
    // with the production 10-minute default when it entered, so it stays
    // pending — the second caller (queued FIFO behind the hung op) hits 25ms.
    setBackupGateTimeoutForTests(25);
    await assert.rejects(
      createBackup({ ...defaultBackupIo(), now: () => NOW }, { home, out: join(root, "out", "second.zip") }),
      (err: unknown) => {
        assert.ok(err instanceof BackupError, "gate_timeout is a BackupError");
        assert.equal((err as BackupError).code, "gate_timeout");
        assert.match((err as BackupError).message, /still busy/);
        return true;
      },
    );
    await settle();
    assert.equal(firstSettled, "pending", "the timeout rejected only the CALLER — the hung op still owns the gate");

    // Release the hung read: the first op settles on its own (nothing was
    // aborted mid-flight), and the gate lets the next caller through.
    releaseRead?.();
    const firstResult = await first;
    assert.equal(firstSettled, "ok", "the first op completed once its io answered");
    assert.equal(firstResult.files, 1, "its archive holds the one walked file");

    const third = await createBackup({ ...defaultBackupIo(), now: () => NOW }, {
      home,
      out: join(root, "out", "third.zip"),
    });
    assert.equal(third.files, 1, "the gate is healthy again after the hung op settled");
  } finally {
    setBackupGateTimeoutForTests(); // restore the 10-minute production deadline
    releaseRead?.(); // leak-proof: never leave the hung op owning the gate
    await first.catch(() => {}); // swallow the tail of a possibly-failed run
    await rm(root, { recursive: true, force: true });
  }
});

test("u2-2: the production deadline is 10 minutes", () => {
  assert.equal(BACKUP_GATE_TIMEOUT_MS, 10 * 60 * 1000, "a hung gate surfaces after 10 minutes, never hangs forever");
});
