/**
 * Retention / auto-GC for archived sessions — checklist Wave 2, policy gate #3.
 *
 * The policy decision (what the defaults should be) is the leader's, so this
 * module ships **no defaults and no timer**: it only answers "what would be
 * deleted" (`gcPlan`) and deletes exactly that, when someone asks for it
 * explicitly. `--dry-run` is the default at the CLI, following piggery's
 * `gc --closed-before DURATION [--dry-run]` shape.
 *
 * An archived session directory is `<archiveDir>/<sessionId>-<closedAtMs>`, so
 * age and size are readable without opening any database.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export interface ArchivedEntry {
  /** Directory name inside archive/. */
  name: string;
  path: string;
  /** Session id parsed out of the directory name (the archived session's own id). */
  sessionId: string;
  /** When the session was archived (from the directory name, ms). */
  closedAt: number;
  bytes: number;
}

export interface GcCandidate extends ArchivedEntry {
  /** Whole days since it was archived, as a human reasons about it. */
  ageDays: number;
}

export interface GcPlan {
  /** Everything in archive/. */
  total: { count: number; bytes: number };
  /** What a `closedBeforeDays` cutoff selects. */
  candidates: GcCandidate[];
  candidateBytes: number;
  /** Directories we could not read (kept, never deleted). */
  skipped: { name: string; reason: string }[];
}

async function dirBytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await dirBytes(child);
    else total += await stat(child).then((s) => s.size, () => 0);
  }
  return total;
}

/** Parse `<sessionId>-<closedAtMs>`; anything else is reported as skipped, never guessed at. */
export function parseArchivedName(name: string): { sessionId: string; closedAt: number } | undefined {
  const match = /^(.+)-(\d{10,})$/u.exec(name);
  if (!match) return undefined;
  const closedAt = Number(match[2]);
  if (!Number.isFinite(closedAt) || closedAt <= 0) return undefined;
  return { sessionId: match[1], closedAt };
}

export async function archivedEntries(archiveDir: string): Promise<{ entries: ArchivedEntry[]; skipped: GcPlan["skipped"] }> {
  const entries: ArchivedEntry[] = [];
  const skipped: GcPlan["skipped"] = [];
  for (const entry of await readdir(archiveDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const parsed = parseArchivedName(entry.name);
    if (!parsed) {
      skipped.push({ name: entry.name, reason: "not an archived-session directory" });
      continue;
    }
    const path = join(archiveDir, entry.name);
    entries.push({ name: entry.name, path, ...parsed, bytes: await dirBytes(path) });
  }
  return { entries: entries.sort((a, b) => b.closedAt - a.closedAt), skipped };
}

/** What a retention policy would delete. Pure read: nothing is touched. */
export async function gcPlan(archiveDir: string, options: { closedBeforeDays: number; now?: number }): Promise<GcPlan> {
  const now = options.now ?? Date.now();
  const days = options.closedBeforeDays;
  if (!Number.isFinite(days) || days < 1) throw new Error(`closedBeforeDays must be at least 1, got ${String(days)}`);
  const { entries, skipped } = await archivedEntries(archiveDir);
  const cutoff = now - days * 86_400_000;
  const candidates = entries
    .filter((entry) => entry.closedAt <= cutoff)
    .map((entry) => ({ ...entry, ageDays: Math.floor((now - entry.closedAt) / 86_400_000) }));
  return {
    total: { count: entries.length, bytes: entries.reduce((n, e) => n + e.bytes, 0) },
    candidates,
    candidateBytes: candidates.reduce((n, e) => n + e.bytes, 0),
    skipped,
  };
}

/**
 * Delete exactly the candidates the plan named — re-planned at delete time so a
 * session archived between the preview and the delete is never removed by a
 * stale list. Returns what was actually removed.
 */
export async function gcApply(
  archiveDir: string,
  options: { closedBeforeDays: number; now?: number },
): Promise<{ removed: GcCandidate[]; bytes: number }> {
  const plan = await gcPlan(archiveDir, options);
  const removed: GcCandidate[] = [];
  for (const candidate of plan.candidates) {
    try {
      await rm(candidate.path, { recursive: true, force: true });
      removed.push(candidate);
    } catch {
      // A directory that cannot be removed stays in the archive; the next run
      // reports it again rather than pretending it is gone.
    }
  }
  return { removed, bytes: removed.reduce((n, e) => n + e.bytes, 0) };
}

/**
 * "30d", "12h", "90m", "2w" → days (fractional). Days is the unit the plan
 * reasons in, so hours/weeks are converted here rather than refused.
 */
export function parseDuration(input: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([smhdw])$/iu.exec(String(input ?? "").trim());
  if (!match) throw new Error(`expected a duration like 30d, 12h or 2w — got ${JSON.stringify(input)}`);
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const days = unit === "s" ? value / 86_400 : unit === "m" ? value / 1440 : unit === "h" ? value / 24 : unit === "w" ? value * 7 : value;
  if (!(days > 0)) throw new Error(`duration must be positive — got ${JSON.stringify(input)}`);
  return days;
}

export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
