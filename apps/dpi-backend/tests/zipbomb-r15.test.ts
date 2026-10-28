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
function zipOne(name: string, data: Buffer, method: 0 | 8, declareUncompressed: number): Buffer {
  const comp = method === 8 ? deflateRawSync(data) : data;
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0x2821, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(declareUncompressed, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(declareUncompressed, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(30 + name.length, 42);
  const body = Buffer.concat([local, Buffer.from(name, "utf8"), comp]);
  const off = body.length;
  const centralFull = Buffer.concat([central, Buffer.from(name, "utf8")]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralFull.length, 12);
  eocd.writeUInt32LE(0, 16);
  return Buffer.concat([body, centralFull, eocd]).subarray(0, off) !== null
    ? Buffer.concat([body, centralFull.subarray(0, centralFull.length), eocd, Buffer.alloc(0)])
    : Buffer.alloc(0);
}

// Fix the writer: local header offset in central dir must point at the LOCAL header (0).
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
void zipOne;

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
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
