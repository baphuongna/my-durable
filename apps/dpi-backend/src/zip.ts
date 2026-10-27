/**
 * A minimal ZIP writer: no dependencies, no shelling out to `zip`.
 *
 * Export bundles need to be one downloadable file, and the device has no
 * archive library. The format only needs the three records a reader actually
 * walks — local header, central directory, end-of-central-directory — so it is
 * cheaper to write them here than to add a dependency for one button.
 *
 * Entries are deflated (`zlib.deflateRawSync`, method 8) or stored (method 0)
 * when deflating makes them bigger (already-compressed or tiny payloads).
 */
import { deflateRawSync } from "node:zlib";

export interface ZipEntry {
  /** Forward-slash relative path inside the archive. */
  path: string;
  /** UTF-8 text payload. */
  text: string;
}

/**
 * R7 export memory guard. A bundle is built entirely in RAM — raw entry texts,
 * then deflate, then base64 — which the R5 audit measured at ≈2-3× the transcript
 * size held at once (a 13 MB probe already pushed RSS to ~150 MB). Until export
 * streams (R8+), refuse above this ceiling instead of hitting the scale cliff:
 * 32 MiB of raw serialized entries is a transcript nobody has compacted, and the
 * refusal names the size and tells the operator to compact first.
 */
export const EXPORT_RAW_LIMIT_BYTES = 32 * 1024 * 1024;

/** Total UTF-8 bytes an archive would hold — the "raw" side of the guard (pre-deflate). */
export function zipRawBytes(entries: readonly ZipEntry[]): number {
  let bytes = 0;
  for (const entry of entries) bytes += Buffer.byteLength(entry.text, "utf8");
  return bytes;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** Bit 11: file names are UTF-8 (we write non-ASCII session names). */
const FLAG_UTF8 = 0x0800;
const VERSION = 20;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS time/date: 2-second resolution, 1980 epoch. */
function dosStamp(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Build one ZIP archive from text entries. Deterministic apart from the timestamps. */
export function zipSync(entries: readonly ZipEntry[], at: Date = new Date()): Buffer {
  const stamp = dosStamp(at);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path.replace(/^\/+/, ""), "utf8");
    const raw = Buffer.from(entry.text, "utf8");
    const deflated = deflateRawSync(raw);
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(VERSION, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0o644 << 16, 38); // external attrs: rw-r--r--
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralBuf, eocd]);
}
