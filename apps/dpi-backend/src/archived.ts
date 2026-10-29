/**
 * Read-only browsing and one-way restore of `<dataDir>/archive/` — the first
 * slice of "old sessions as feature surface": sessions are never auto-deleted
 * (user-decided policy #3 rationale), so the archive becomes worth browsing.
 *
 * `store.archive()` moves `<dataDir>/sessions/<uuid>/` to
 * `<dataDir>/archive/<uuid>-<archivedAtMs>/` and deletes the catalog row —
 * which until now made every bundle anonymous: the session's name/cwd/model
 * lived only in the deleted row. This module adds a `session.json` manifest
 * inside each bundle (`writeArchiveManifest`, for the store to call going
 * forward) and reads BOTH worlds: for old bundles the dirname is the ONLY
 * source of truth (uuid + archivedAt ms), and everything else degrades —
 * `archived <first 8 of id>` name, empty cwd/model — instead of hiding rows.
 *
 * A bundle's `agent.sqlite` is a foreign database: opened with `{ readOnly: true }`
 * and closed on every path (the gc/doctor rule for handles we do not own).
 * `listArchived` never throws — an unreadable sqlite degrades to
 * `turns: -1` / `lastMessageAt: null`, an unreadable dir to `bytes: 0` — while
 * `archivedTranscript` reuses the SDK's `toTranscript`/`toMarkdown` so an
 * archived session renders exactly like a live one, and throws the one
 * "archive bundle unreadable" the route maps to 404. `restoreArchive` is the
 * single mutation: one rename back under `sessions/<id>` (refused while a live
 * session with that id exists), synthesize-and-write a manifest for old bundles.
 *
 * No express, no Store import: the leader wires routes and store calls.
 */
import { chmodSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { toMarkdown, toTranscript, type TranscriptItem } from "../../dpi-sdk/src/transcript.js";
import type { WireEntry } from "../../dpi-sdk/src/api.js";

/** Written into every bundle by `writeArchiveManifest`; the manifest of record once it exists. */
const MANIFEST_NAME = "session.json";
/** The one file every archived session dir carries (`store.archive()` moved it verbatim). */
const DB_NAME = "agent.sqlite";
/** Manifests and restored dirs keep the house rule: 0600 files, 0700 dirs. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** `<uuid>-<archivedAtMs>`: the only identity an old bundle has. R11 4.1:
 *  CANONICAL uuid shape (8-4-4-4-12 lowercase hex) — the old `[0-9a-f-]{36}`
 *  character class also matched 36 dashes, hex-without-dashes and other
 *  lookalikes an operator might drop in archive/ from another tool; those are
 *  now skipped+reported by BOTH gc and the browser (this ONE pattern is the
 *  shared source — real bundles are canonical-uuid session ids by
 *  construction, so nothing legitimate is lost). */
export const BUNDLE_DIR_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(\d{13})$/;
/** Full lowercase uuid, 8-4-4-4-12: a PREFIX of another uuid must never match a bundle. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The identity a catalog row used to hold — written into the bundle so archiving stops being lossy. */
export interface ArchiveManifest {
  sessionId: string;
  name: string;
  cwd: string;
  model: string;
  provider: string;
  createdAt: number;
  archivedAt: number;
  packageVersion: string;
}

/** One row of the archive listing: manifest data where it exists, dirname + degradation where it does not. */
export interface ArchivedView {
  sessionId: string;
  archivedAt: number;
  /** Manifest name, or `archived <first 8 of id>` for old bundles. */
  name: string;
  /** Manifest cwd, or "" when unknown. */
  cwd: string;
  /** Manifest model, or "" when unknown. */
  model: string;
  /** Count of pi.user + pi.assistant entries; -1 when the sqlite is unreadable. */
  turns: number;
  /** Max `model[].timestamp` across entries; null when unreadable (or no messages). */
  lastMessageAt: number | null;
  /** Recursive dir size; 0 when unreadable. */
  bytes: number;
  hasManifest: boolean;
}

/** The same shape `store.transcript()` returns, so archived sessions render like live ones. */
export type ArchivedTranscript =
  | { format: "markdown"; text: string }
  | { format: "json"; items: TranscriptItem[] };

/**
 * Write `session.json` (2-space JSON + trailing newline, 0600) into `bundleDir`.
 * Overwrites silently: a re-archive of the same bundle updates its identity.
 */
export function writeArchiveManifest(bundleDir: string, m: ArchiveManifest): void {
  const path = join(bundleDir, MANIFEST_NAME);
  writeFileSync(path, `${JSON.stringify(m, null, 2)}\n`, { mode: FILE_MODE });
  chmodSync(path, FILE_MODE); // mode only applies on create; keep 0600 across overwrites
}

/**
 * Read a bundle's manifest. Absent or corrupt (bad JSON, wrong shape) →
 * undefined — an old bundle is normal, not an error. Never throws.
 */
export function readArchiveManifest(bundleDir: string): ArchiveManifest | undefined {
  try {
    const manifestPath = join(bundleDir, MANIFEST_NAME);
    // R20 (run-6 h6): a manifest written by store.archive() is a few hundred
    // bytes; a planted one had NO ceiling — restore and the archive LISTING
    // read the whole file into RAM per cheap request (leader probe: a 150 MB
    // plant cost ~770 ms and ~600 MB RSS per refused restore, repeatable).
    // Refuse oversized manifests without reading them.
    if (statSync(manifestPath).size > 1024 * 1024) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const m = parsed as Record<string, unknown>;
    if (
      typeof m.sessionId !== "string" ||
      typeof m.name !== "string" ||
      typeof m.cwd !== "string" ||
      typeof m.model !== "string" ||
      typeof m.provider !== "string" ||
      typeof m.createdAt !== "number" ||
      typeof m.archivedAt !== "number" ||
      typeof m.packageVersion !== "string"
    ) {
      return undefined;
    }
    return {
      sessionId: m.sessionId,
      name: m.name,
      cwd: m.cwd,
      model: m.model,
      provider: m.provider,
      createdAt: m.createdAt,
      archivedAt: m.archivedAt,
      packageVersion: m.packageVersion,
    };
  } catch {
    return undefined;
  }
}

/** Parse one `entries.record` / tolerate one bad row: corrupt records are skipped, never fatal. */
function parseRecord(record: unknown): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = typeof record === "string" ? JSON.parse(record) : record;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * turns/lastMessageAt from the bundle's sqlite, degraded on any error: a
 * foreign handle we close on every path — listing must never throw for a
 * bundle that is merely unreadable.
 */
function bundleStats(bundleDir: string): { turns: number; lastMessageAt: number | null } {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(join(bundleDir, DB_NAME), { readOnly: true });
    const rows = db.prepare("SELECT record FROM entries").all() as unknown[];
    let turns = 0;
    let lastMessageAt: number | null = null;
    for (const row of rows) {
      const entry = parseRecord((row as { record?: unknown }).record);
      if (!entry) continue;
      if (entry.kind === "pi.user" || entry.kind === "pi.assistant") turns += 1;
      if (!Array.isArray(entry.model)) continue;
      for (const message of entry.model) {
        const timestamp = (message as { timestamp?: unknown } | null)?.timestamp;
        if (typeof timestamp === "number" && (lastMessageAt === null || timestamp > lastMessageAt)) {
          lastMessageAt = timestamp;
        }
      }
    }
    return { turns, lastMessageAt };
  } catch {
    return { turns: -1, lastMessageAt: null };
  } finally {
    try {
      db?.close();
    } catch {
      // never-opened or already closed: nothing to release
    }
  }
}

/** Recursive size of a bundle dir; 0 when unreadable. Symlinks are not followed (lstat-free stat on entries we can read). */
function dirBytes(dir: string, depth = 0): number {
  // R16 (run-2 h8): listArchived must never throw — statSync FOLLOWS symlinks,
  // so a planted symlink loop (a->b, b->a) blew the stack. Lstat never
  // follows; the depth cap bounds hostile deep trees. Symlinked entries are
  // skipped (not sizeable), matching gc.ts.
  let total = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  if (depth >= 64) return total;
  for (const e of entries) {
    try {
      if (e.isDirectory()) total += dirBytes(join(dir, e.name), depth + 1);
      else if (e.isFile()) total += lstatSync(join(dir, e.name)).size;
    } catch {
      // broken symlink / vanished entry: not sizeable, not fatal
    }
  }
  return total;
}

/**
 * Every bundle in `archiveDir`, newest archivedAt first. Manifest fields where
 * present, dirname-derived fallbacks where not; unreadable pieces degrade
 * rather than hide. Missing archiveDir → []. Never throws.
 */
export function listArchived(archiveDir: string): ArchivedView[] {
  let names: string[];
  try {
    names = readdirSync(archiveDir);
  } catch {
    return [];
  }
  const views: ArchivedView[] = [];
  for (const name of names) {
    const match = BUNDLE_DIR_PATTERN.exec(name);
    if (!match) continue;
    const bundleDir = join(archiveDir, name);
    try {
      if (!statSync(bundleDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const sessionId = match[1];
    const archivedAt = Number(match[2]);
    const manifest = readArchiveManifest(bundleDir);
    const { turns, lastMessageAt } = bundleStats(bundleDir);
    views.push({
      sessionId,
      archivedAt,
      name: manifest?.name ?? `archived ${sessionId.slice(0, 8)}`,
      cwd: manifest?.cwd ?? "",
      model: manifest?.model ?? "",
      turns,
      lastMessageAt,
      bytes: dirBytes(bundleDir),
      hasManifest: manifest !== undefined,
    });
  }
  views.sort((a, b) => b.archivedAt - a.archivedAt || (a.sessionId < b.sessionId ? 1 : -1));
  return views;
}

/**
 * Path of the newest bundle for `sessionId`, or null. The id must be a FULL
 * uuid (8-4-4-4-12), so a prefix of another session's uuid can never match,
 * and the dirname must match it exactly.
 */
export function findBundle(archiveDir: string, sessionId: string): string | null {
  const id = sessionId.toLowerCase();
  if (!UUID_PATTERN.test(id)) return null;
  let names: string[];
  try {
    names = readdirSync(archiveDir);
  } catch {
    return null;
  }
  let best: { name: string; archivedAt: number } | null = null;
  for (const name of names) {
    const match = BUNDLE_DIR_PATTERN.exec(name);
    if (!match || match[1] !== id) continue;
    const archivedAt = Number(match[2]);
    if (!best || archivedAt > best.archivedAt) best = { name, archivedAt };
  }
  return best ? join(archiveDir, best.name) : null;
}

/**
 * Transcript of an archived bundle, same shape as the live-session endpoint:
 * ALL entries (in `conversation_id, commit_seq` order) through the SDK's
 * `toTranscript`, then `toMarkdown` for markdown. Corrupt records are skipped;
 * an unreadable sqlite throws `Error("archive bundle unreadable")` for the
 * route to map to 404.
 */
export function archivedTranscript(bundleDir: string, format: "markdown" | "json"): ArchivedTranscript {
  let db: DatabaseSync | undefined;
  const entries: WireEntry[] = [];
  try {
    db = new DatabaseSync(join(bundleDir, DB_NAME), { readOnly: true });
    const rows = db.prepare("SELECT record FROM entries ORDER BY conversation_id, commit_seq").all() as unknown[];
    for (const row of rows) {
      const entry = parseRecord((row as { record?: unknown }).record);
      if (entry) entries.push(entry as unknown as WireEntry);
    }
  } catch {
    throw new Error("archive bundle unreadable");
  } finally {
    try {
      db?.close();
    } catch {
      // never-opened or already closed: nothing to release
    }
  }
  const items = toTranscript(entries);
  return format === "markdown" ? { format: "markdown", text: toMarkdown(items) } : { format: "json", items };
}

/**
 * Move the newest bundle for `sessionId` back under `<dataDir>/sessions/<sessionId>`
 * (one rename — nothing is copied, nothing is deleted). Refused while a live
 * session with that id exists (`a live session with this id already exists`);
 * unknown id → `no archived session <id>` for the route to map to 404. Old
 * bundles gain a synthesized manifest (dirname archivedAt as createdAt too) so
 * the restored session is no longer anonymous. Returns the bundle's manifest.
 */
export async function restoreArchive(
  archiveDir: string,
  dataDir: string,
  sessionId: string,
): Promise<ArchiveManifest | undefined> {
  const sessionsDir = join(dataDir, "sessions");
  const target = join(sessionsDir, sessionId);
  try {
    await stat(target);
    throw new Error("a live session with this id already exists");
  } catch (error) {
    if (error instanceof Error && error.message === "a live session with this id already exists") throw error;
  }
  const bundle = findBundle(archiveDir, sessionId);
  if (!bundle) throw new Error(`no archived session ${sessionId}`);
  await mkdir(sessionsDir, { recursive: true, mode: DIR_MODE });
  await rename(bundle, target);
  const existing = readArchiveManifest(target);
  if (existing) return existing;
  const archivedAt = Number(BUNDLE_DIR_PATTERN.exec(basename(bundle))?.[2] ?? 0);
  const synthesized: ArchiveManifest = {
    sessionId,
    name: `archived ${sessionId.slice(0, 8)}`,
    cwd: "",
    model: "",
    provider: "",
    createdAt: archivedAt,
    archivedAt,
    packageVersion: "",
  };
  writeArchiveManifest(target, synthesized);
  return synthesized;
}
