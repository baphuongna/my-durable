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
 *
 * R8 adds the streaming side: the session-export route no longer buffers a
 * whole bundle (raw texts + deflate + base64 ≈ 2-3× transcript size, the R5
 * audit's scale cliff) — `streamSessionBundle` composes the same entries from
 * the store's public APIs, deflates each one through a pipe while writing a
 * temp file, and the route pipes that file to the HTTP response before
 * unlinking it. Entries keep today's paths/payloads; the only layout
 * difference is the streaming form's data descriptor (spec bit 3) so entry
 * sizes can be written after the deflated body without buffering it.
 *
 * R11 1.1: the temp file lives BESIDE THE DATA DIR (same volume as the store,
 * DPI_EXPORT_TMPDIR overrides), not `os.tmpdir()` — a tmpfs-backed /tmp is
 * RAM, and the R5 cliff would return through the back door (or ENOSPC at
 * tmpfs size while the real disk sits empty). "Streaming lifted the RAM
 * cliff" is volume-dependent: the deflate WINDOW is always RAM-bounded, the
 * spill file is disk-bounded only where the data dir lives on real disk.
 */
import { randomUUID } from "node:crypto";
import { open, rm, stat } from "node:fs/promises";
import { tmpdir, hostname, platform } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createDeflateRaw, deflateRawSync } from "node:zlib";
import { invalid } from "./errors.js";
import { DURABLE_VERSION, type SessionRow, type Store } from "./store.js";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";

export interface ZipEntry {
  /** Forward-slash relative path inside the archive. */
  path: string;
  /** UTF-8 text payload. */
  text: string;
}

/**
 * R7 export memory guard — the LEGACY in-memory path only (`Store.exportSession`,
 * the base64 JSON surface). R8's streamed route (`streamSessionBundle`) never
 * holds the whole bundle, so its sanity ceiling is `EXPORT_TOTAL_LIMIT_BYTES`.
 * Kept for the untouched legacy callers: the same refusal style — an `invalid`
 * fault that names the size and tells the operator to compact first.
 */
export const EXPORT_RAW_LIMIT_BYTES = 32 * 1024 * 1024;

/**
 * R8 streaming sanity ceiling: total UNCOMPRESSED bytes an export may stream
 * (before deflate). Streaming lifts the R7 32 MiB in-memory cliff, but an
 * unbounded export could still fill the disk / take a device down — so an
 * absurd total (a transcript nobody has compacted in weeks) still refuses with
 * the same invalid-fault style, size named, compaction suggested.
 */
export const EXPORT_TOTAL_LIMIT_BYTES = 256 * 1024 * 1024;

/** Biggest value a classic (zip64-less) 32-bit zip field can hold. */
export const ZIP_U32_MAX = 0xffffffff;
/** Biggest file count the 16-bit EOCD field can hold. */
export const ZIP_MAX_ENTRIES = 0xffff;

const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MiB`;

/**
 * The zip64-less refusal reason for a would-be archive, or undefined when every
 * quantity still fits the classic format's fields. All four are checked because
 * the classic zip caps EACH of them: per-entry sizes, total archive size (the
 * local-header offset field), and the 16-bit entry count.
 */
export function zip64Problem(parts: {
  raw?: number;
  compressed?: number;
  archive?: number;
  entries?: number;
}): string | undefined {
  if ((parts.raw ?? 0) > ZIP_U32_MAX)
    return `an entry is ${mb(parts.raw ?? 0)} uncompressed, over the 4 GiB zip limit`;
  if ((parts.compressed ?? 0) > ZIP_U32_MAX)
    return `an entry is ${mb(parts.compressed ?? 0)} deflated, over the 4 GiB zip limit`;
  if ((parts.archive ?? 0) > ZIP_U32_MAX)
    return `the archive is ${mb(parts.archive ?? 0)}, over the 4 GiB zip limit`;
  if ((parts.entries ?? 0) > ZIP_MAX_ENTRIES)
    return `the archive holds ${(parts.entries ?? 0).toLocaleString()} files, over the ${ZIP_MAX_ENTRIES} zip limit`;
  return undefined;
}

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

/** Incremental CRC-32 (IEEE) fed chunk by chunk — the streaming writer's checksum. */
export class Crc32 {
  #crc = 0xffffffff;

  update(chunk: Uint8Array): this {
    let crc = this.#crc;
    for (let i = 0; i < chunk.length; i += 1) crc = CRC_TABLE[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8);
    this.#crc = crc;
    return this;
  }

  /** The finalized checksum, exactly what the one-shot `crc32` returns. */
  get(): number {
    return (this.#crc ^ 0xffffffff) >>> 0;
  }
}

export function crc32(data: Uint8Array): number {
  const crc = new Crc32();
  crc.update(data);
  return crc.get();
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

// ------------------------------------------------------------ R8 streamed export

/** Deflate + CRC move in slices, not per byte; 256 KiB keeps syscall count sane. */
const CHUNK_BYTES = 1 << 18;
/** Spec bit 3: sizes/crc follow the deflated body in a data descriptor. */
const FLAG_DESCRIPTOR = 0x0008;
/** Data descriptor records MAY carry the local-header signature; readers that
 *  scan forward prefer it, and python's zipfile writes it the same way. */
const DATA_DESCRIPTOR_SIG = 0x08074b50;

/**
 * A temp file (never a hardcoded path — Windows-safe), written 0600 like
 * every other transcript-bearing file on the device. R11 1.1: the SPILL
 * volume is the data dir (real disk, same filesystem the store already
 * writes), `DPI_EXPORT_TMPDIR` overrides, `os.tmpdir()` is the last resort —
 * tmpfs-backed /tmp is RAM and would silently reintroduce the R5 cliff.
 */
const tempZipPath = (baseDir: string) => join(baseDir, `.dpi-export-${process.pid}-${randomUUID()}.zip`);

/** Where the export spill file goes: explicit operator override → the store's
 *  own data dir (R11 1.1) → the OS temp dir. Dot-prefixed so a casual `ls`
 * of the data dir does not read as a session artifact. */
export function exportTempDir(dataDir: string): string {
  // R12 P3-12 (known coupling): the spill shares the data volume with the
  // registries — a 12-256 MB export on a nearly-full disk can push registry
  // writes into ENOSPC (schedules degrade gracefully: R11 2.2 skips runs and
  // reports once) until the export finishes and unlinks. Self-healing by
  // design; noted here so nobody "fixes" it back to tmpfs.
  return process.env.DPI_EXPORT_TMPDIR || dataDir || tmpdir();
}

/**
 * The streaming half of the zip writer. Entries are deflated through a pipe and
 * written to disk as the deflate stream emits, so RAM holds one entry at a time
 * instead of the whole archive. Classic-layout difference: because sizes are
 * only known after an entry's body has streamed, local headers carry spec bit 3
 * (data descriptor) and the real sizes/crc land in the descriptor + central
 * directory — the form python's `zipfile`, Java's `ZipOutputStream` and every
 * mainstream reader accepts. Central-directory and EOCD records are identical
 * to the one-shot writer's.
 */
class ZipStreamWriter {
  readonly path: string;
  /** Total UNCOMPRESSED bytes committed so far — the ceiling's running total. */
  rawTotal = 0;
  bytes = 0;
  private handle: Awaited<ReturnType<typeof open>>;
  private stamp: { time: number; date: number };
  private offset = 0;
  count = 0;
  private central: Buffer[] = [];
  private centralBytes = 0;

  private constructor(path: string, handle: Awaited<ReturnType<typeof open>>) {
    this.path = path;
    this.handle = handle;
    this.stamp = dosStamp(new Date());
  }

  /** Create the temp file exclusively, so two exports never share one archive. */
  static async create(baseDir: string): Promise<ZipStreamWriter> {
    const path = tempZipPath(baseDir);
    const handle = await open(path, "wx", 0o600);
    return new ZipStreamWriter(path, handle);
  }

  async add(entry: ZipEntry, ceilingBytes: number): Promise<void> {
    const name = Buffer.from(entry.path.replace(/^\/+/, ""), "utf8");
    if (!name.length) throw invalid("zip entry name is empty");
    if (name.length > 0xffff) throw invalid(`zip entry name is over the 64 KiB zip limit: ${entry.path.slice(0, 100)}`);
    const raw = Buffer.from(entry.text, "utf8");
    // The ceiling is checked as raw bytes accumulate, BEFORE this entry's copy
    // is even built for deflate — a refusal never pays for the oversized entry.
    this.rawTotal += raw.length;
    if (this.rawTotal > ceilingBytes)
      throw invalid(
        `Export refused: transcripts are ${mb(this.rawTotal)} of text, over the ${mb(ceilingBytes)} streaming ceiling. ` +
          `Compact the session first, then export again`,
      );
    const zip64 = zip64Problem({ raw: raw.length, archive: this.offset + this.centralBytes + 22 });
    if (zip64) throw invalid(`Export refused: ${zip64}`);
    if (this.count >= ZIP_MAX_ENTRIES) throw invalid(`Export refused: ${zip64Problem({ entries: this.count + 1 })}`);

    // Deflate through a pipe: the compressed bytes hit the disk as they emit,
    // with backpressure, instead of accumulating one body-sized Buffer.
    const crc = new Crc32();
    let compressed = 0;
    // Descriptor form: the local header goes down FIRST with placeholder sizes
    // (spec bit 3), the deflated body streams after it, and the real crc/sizes
    // land in the trailing data descriptor + central directory.
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAG_UTF8 | FLAG_DESCRIPTOR, 6);
    local.writeUInt16LE(8, 8); // method 8: deflate (the streamed path always deflates)
    local.writeUInt16LE(this.stamp.time, 10);
    local.writeUInt16LE(this.stamp.date, 12);
    local.writeUInt32LE(0, 14); // crc: in the descriptor below
    local.writeUInt32LE(0, 18); // compressed: in the descriptor below
    local.writeUInt32LE(0, 22); // uncompressed: in the descriptor below
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    await this.handle.write(local);
    await this.handle.write(name);
    // The body streams through deflate in chunks: pipeline wires source →
    // deflate with proper error forwarding/backpressure, the final async sink
    // writes each emitted chunk straight to the temp file.
    await pipeline(
      Readable.from(ZipStreamWriter.slices(raw, crc)),
      createDeflateRaw(),
      async (chunks: AsyncIterable<Buffer>) => {
        for await (const chunk of chunks) {
          compressed += chunk.length;
          await this.handle.write(chunk);
        }
      },
    );
    if (zip64Problem({ compressed })) throw invalid(`Export refused: ${zip64Problem({ compressed })}`);

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(DATA_DESCRIPTOR_SIG, 0);
    descriptor.writeUInt32LE(crc.get(), 4);
    descriptor.writeUInt32LE(compressed, 8);
    descriptor.writeUInt32LE(raw.length, 12);
    await this.handle.write(descriptor);

    // Central directory carries the real sizes/crc like the one-shot writer's.
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(VERSION, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(FLAG_UTF8 | FLAG_DESCRIPTOR, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(this.stamp.time, 12);
    central.writeUInt16LE(this.stamp.date, 14);
    central.writeUInt32LE(crc.get(), 16);
    central.writeUInt32LE(compressed, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0o644 << 16, 38); // external attrs: rw-r--r--
    central.writeUInt32LE(this.offset, 42);
    this.central.push(central, name);
    this.centralBytes += central.length + name.length;

    this.offset += local.length + name.length + compressed + descriptor.length;
    this.count += 1;
    this.bytes = this.offset + this.centralBytes + 22;
    if (zip64Problem({ archive: this.bytes })) throw invalid(`Export refused: ${zip64Problem({ archive: this.bytes })}`);
  }

  /** Central directory + EOCD; the handle closes and the archive is complete. */
  async finish(): Promise<number> {
    const centralBuf = Buffer.concat(this.central);
    const total = this.offset + centralBuf.length + 22;
    if (zip64Problem({ archive: total, entries: this.count }))
      throw invalid(`Export refused: ${zip64Problem({ archive: total, entries: this.count })}`);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4); // this disk
    eocd.writeUInt16LE(0, 6); // disk with central directory
    eocd.writeUInt16LE(this.count, 8);
    eocd.writeUInt16LE(this.count, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(this.offset, 16);
    eocd.writeUInt16LE(0, 20); // comment length
    await this.handle.write(centralBuf);
    await this.handle.write(eocd);
    await this.handle.close();
    this.handle = undefined as unknown as Awaited<ReturnType<typeof open>>;
    return total;
  }

  /** Close (if still open) and unlink — every failure path leaves no temp file. */
  async dispose(): Promise<void> {
    if (this.handle) {
      try {
        await this.handle.close();
      } catch {
        /* already closed */
      }
      this.handle = undefined as unknown as Awaited<ReturnType<typeof open>>;
    }
    await rm(this.path, { force: true });
  }

  /** Yield the buffer in CHUNK_BYTES slices, checksumming each before it flows. */
  private static async *slices(raw: Buffer, crc: Crc32): AsyncGenerator<Buffer> {
    for (let at = 0; at < raw.length; at += CHUNK_BYTES) {
      const chunk = raw.subarray(at, Math.min(at + CHUNK_BYTES, raw.length));
      crc.update(chunk);
      yield chunk;
    }
  }
}

/**
 * A session bundle streamed to a temp file: same entries as the legacy
 * `Store.exportSession`, minus the whole-archive-in-RAM step. The caller pipes
 * `path` to its sink and then MUST call `cleanup()` — every refusal/failure
 * cleans up by itself, only a completed archive is handed over.
 */
export interface StreamedBundle {
  /** Absolute temp-file path; read it, pipe it, then `cleanup()`. */
  path: string;
  /** `${slugName(name|id)}.bundle.zip` — the download name, unchanged from R7. */
  filename: string;
  mime: string;
  /** Zip byte length (the temp file's size) — the Content-Length for the route. */
  bytes: number;
  entries: number;
  /** Unlink the temp file. Safe to call once; the route calls it in `finally`. */
  cleanup: () => Promise<void>;
}

export async function streamSessionBundle(
  store: Store,
  row: SessionRow,
  opts: { ceilingBytes?: number } = {},
): Promise<StreamedBundle> {
  const ceilingBytes = opts.ceilingBytes ?? EXPORT_TOTAL_LIMIT_BYTES;
  // R11 1.2: refuse MONSTROUS sessions BEFORE the first stringify. The store db
  // holds every entry the bundle re-serializes, so a db over the ceiling can
  // only refuse later — after a ~2-4× transient (entries clone + pretty JSON)
  // that OOMs instead of answering. A cheap stat converts heap death into the
  // polite, remedy-naming refusal. (A db under the ceiling can still overflow
  // mid-write — json+md ≈ 2× content — and the streaming `add()` guard catches
  // that gracefully, as it always has.)
  const dbBytes = await stat(row.dbPath).then(
    (s) => s.size,
    () => 0,
  );
  if (dbBytes > ceilingBytes) {
    throw invalid(
      `Export refused: this session's store is ${mb(dbBytes)} of data, over the ${mb(ceilingBytes)} export ceiling. ` +
        `Compact the session first (archive old agents), or export it directly from the device`,
    );
  }
  const tempDir = exportTempDir(store.options.dataDir);
  let writer: ZipStreamWriter;
  try {
    writer = await ZipStreamWriter.create(tempDir);
  } catch (e) {
    // R11 1.4: disk-full surfaces as a typed invalid fault naming the remedy
    // (which volume, which knob), not a raw ENOSPC string on a 500.
    if ((e as NodeJS.ErrnoException).code === "ENOSPC") {
      throw invalid(
        `disk full while creating the export temp file under ${tempDir} — free space on that volume ` +
          `(or point DPI_EXPORT_TMPDIR at one with room) and retry`,
      );
    }
    throw e;
  }
  try {
    for await (const entry of sessionBundleEntries(store, row)) await writer.add(entry, ceilingBytes);
    const bytes = await writer.finish();
    return {
      path: writer.path,
      filename: `${slugName(row.name || row.id)}.bundle.zip`,
      mime: "application/zip",
      bytes,
      entries: writer.count,
      cleanup: () => writer.dispose(),
    };
  } catch (cause) {
    await writer.dispose();
    if ((cause as NodeJS.ErrnoException).code === "ENOSPC") {
      // R11 1.4: mid-write disk-full gets the same typed refusal as create-time.
      throw invalid(
        `disk full while writing the export under ${tempDir} — free space on that volume ` +
          `(or point DPI_EXPORT_TMPDIR at one with room) and retry`,
      );
    }
    throw cause;
  }
}

/**
 * The bundle composition, entry by entry, mirroring `Store.exportSession`'s
 * layout exactly (manifest.json, session.json, per-agent transcript/config,
 * README when the session's store is closed). It pulls only public store APIs
 * and yields one entry at a time so the writer never holds more than the
 * current transcript in memory. The three mirrors below (`NOT_OPENED_README`,
 * `slugName`, the manifest shape) are byte-for-byte copies of store.ts's
 * module-private originals — keep them in sync if export's layout ever moves.
 */
const NOT_OPENED_README = [
  "This bundle was exported while the session's store was closed.",
  "",
  "It contains manifest.json and session.json only. Start the device and re-export",
  "from the running session to include per-agent transcripts and configs.",
  "",
].join("\n");

/** "My session #1" → "my-session-1" for the download name (mirrors store.ts). */
function slugName(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .toLowerCase();
  return slug || "session";
}

async function* sessionBundleEntries(store: Store, row: SessionRow): AsyncGenerator<ZipEntry> {
  const opened = store.opened.get(row.id);
  const agents = opened ? await store.agents(row) : [];
  const manifest = {
    format: "dpi-session-bundle",
    version: 1,
    exportedAt: new Date().toISOString(),
    device: {
      uid: store.uid,
      name: store.name,
      hostname: hostname(),
      platform: `${platform()} node ${process.version}`,
      durableVersion: DURABLE_VERSION,
    },
    session: { id: row.id, name: row.name, cwd: row.cwd, model: row.model, createdAt: row.createdAt },
    agents: agents.map((a) => ({ id: a.id, name: a.name, kind: a.kind })),
  };
  yield { path: "manifest.json", text: `${JSON.stringify(manifest, null, 2)}\n` };
  yield { path: "session.json", text: `${JSON.stringify(store.sessionSummaryBase(row), null, 2)}\n` };
  for (const agent of agents) {
    const c = opened ? await opened.harness.conversation(agent.id as ConversationId, ctx) : undefined;
    if (!c) continue;
    const dir = `agents/${agent.id}`;
    yield {
      path: `${dir}/transcript.json`,
      text: `${JSON.stringify(await store.transcript(c, "json"), null, 2)}\n`,
    };
    const md = await store.transcript(c, "markdown");
    if (typeof md.text === "string") yield { path: `${dir}/transcript.md`, text: md.text };
    yield {
      path: `${dir}/config.json`,
      text: `${JSON.stringify((await store.agentDetail(row, c)).config, null, 2)}\n`,
    };
  }
  if (!agents.length) yield { path: "README.txt", text: NOT_OPENED_README };
}
