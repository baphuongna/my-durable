/**
 * R15 (run-2 h8): a hostile "backup" zip used to inflate method-8 entries with
 * no output bound (~1000x amplification observed) and checked sizes only after
 * the full allocation — plan mode equally affected. Now the inflate itself is
 * capped per entry AND the archive's declared total may not exceed
 * MAX_BACKUP_BYTES (256 MiB), matching the write side.
 * Level: unit, scratch files only (hermetic — no daemon, no network).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_BACKUP_BYTES, readZipEntries } from "../src/backup.ts";
import { crc32 } from "../src/zip.ts";

/** Minimal zip writer for exactly one stored-or-deflated entry. */
function zipOneFixed(name: string, data: Buffer, method: 0 | 8, declareUncompressed: number): Buffer {
  const comp = method === 8 ? deflateRawSync(data) : data;
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(declareUncompressed, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(declareUncompressed, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42); // local header offset = 0
  const body = Buffer.concat([local, Buffer.from(name, "utf8"), comp]);
  const centralFull = Buffer.concat([central, Buffer.from(name, "utf8")]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralFull.length, 12);
  eocd.writeUInt32LE(body.length, 16); // central directory starts after the body
  return Buffer.concat([body, centralFull, eocd]);
}

test("R15 h8: zip-bomb entries are refused by the inflate cap, not after allocation", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dpi-zipbomb-"));
  try {
    // 10 MB of zeros deflates tiny; declared uncompressed size lies (small),
    // so the old code allocated the FULL 10 MB before any check.
    const bomb = Buffer.alloc(10 * 1024 * 1024);
    const zipped = zipOneFixed("state.sqlite", bomb, 8, bomb.length);
    // Sanity: the honest archive still restores.
    const ok = readZipEntries(zipped);
    assert.equal(ok.length, 1);
    assert.equal(ok[0].data.length, bomb.length);

    // Same stream, declared size 1024 bytes: the inflate must stop at the cap.
    const lie = zipOneFixed("state.sqlite", bomb, 8, 1024);
    assert.throws(() => readZipEntries(lie), /cannot inflate|decompressed/);

    // Declared-total guard: one 256 MiB+1 declared entry (never inflated).
    const huge = zipOneFixed("big.bin", Buffer.alloc(0), 0, MAX_BACKUP_BYTES + 1);
    assert.throws(() => readZipEntries(huge), /declares more than/);

    // Boundary control (R15 cold review P2-1/P3-3): an entry declaring EXACTLY
    // the ceiling must pass the TOTAL guard (it then fails the honest size
    // check with empty data — proof the refusal comes from the size check,
    // not the total). MAX+1 fails the total guard itself.
    const single = zipOneFixed("f.bin", Buffer.alloc(0), 0, MAX_BACKUP_BYTES);
    assert.throws(() => readZipEntries(single), /decompressed to 0 bytes/, "exactly-MAX passes the total guard");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// R18 (run-4 h2): pin the manifest-allowance boundary exactly — the allowance
// is 64 KiB, subtracted from entry-0's declared size, and only entry-0 named
// exactly "manifest.json" gets it.
function zipTwoFixed(
  name0: string, declare0: number, name1: string, declare1: number,
  honest0 = 0, // entry-0's real byte count (declared-only by default)
): Buffer {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, declared, real] of [
    [name0, declare0, honest0],
    [name1, declare1, 0],
  ] as [string, number, number][]) {
    const data = Buffer.alloc(real); // by default declared-only: the honest-size check ends the run
    const comp = data; // method 0
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    const body = Buffer.concat([local, Buffer.from(name, "utf8"), comp]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(body);
    centrals.push(Buffer.concat([central, Buffer.from(name, "utf8")]));
    offset += body.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(2, 8);
  eocd.writeUInt16LE(2, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralDir, eocd]);
}

const ALLOWANCE = 64 * 1024;
test("R18 h2: the entry-0 manifest allowance is exactly 64 KiB, once", () => {
  // (a) 65536 rides fully free: 0 + MAX == MAX, the TOTAL guard passes and the
  // run dies later at the honest-size check — proving the allowance applied.
  assert.throws(
    () => readZipEntries(zipTwoFixed("manifest.json", ALLOWANCE, "home.bin", MAX_BACKUP_BYTES)),
    /decompressed to 0 bytes/,
  );
  // (b) 65537 (honestly present!) + MAX: one byte over the allowance trips
  // the TOTAL guard — the entry-0 bytes are real so its own checks pass.
  assert.throws(
    () =>
      readZipEntries(
        zipTwoFixed("manifest.json", ALLOWANCE + 1, "home.bin", MAX_BACKUP_BYTES, ALLOWANCE + 1),
      ),
    /declares more than/,
  );
  // (c) no second allowance: "manifest.json" at position 1 counts fully.
  assert.throws(
    () => readZipEntries(zipTwoFixed("seed.txt", 0, "manifest.json", MAX_BACKUP_BYTES + 1)),
    /declares more than/,
  );
});
