/**
 * Retention / auto-GC for archived sessions — checklist Wave 2, policy gate #3.
 *
 * The policy decision (what the defaults should be) is the leader's, so this
 * module ships **no defaults and no timer**: it only answers "what would be
 * deleted" (`gcPlan`) and deletes exactly that, when someone asks for it
 * explicitly. `--dry-run` is the default at the CLI, following piggery's
 * `gc --closed-before DURATION [--dry-run]` shape.
 *
 * An archived session directory is `<archiveDir>/<uuid>-<closedAtMs>` — parsed
 * with the SAME strict `BUNDLE_DIR_PATTERN` the archive browser and restore use
 * (audit 3.1: the old loose `<name>-<10+ digits>` form let gc delete operator
 * directories like `nas-backup-2025010112` that the UI never listed). Any
 * directory in archive/ that does not parse strictly — or whose closedAt is out
 * of range — is reported as skipped and never deleted, so age and size remain
 * readable without opening any database.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BUNDLE_DIR_PATTERN } from "./archived.js";

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
  /** R10 Design B: refs that WOULD dangle if the candidates were deleted —
   *  schedule `lastSessionId`s and graph `TaskRunState.sessionId`s pointing at
   *  candidate session ids. The operator sees the referential cost of --yes. */
  danglingRefs: { schedules: number; graphRuns: number };
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

/**
 * Parse `<uuid>-<closedAtMs>` with the exact strict pattern the archive browser
 * and restore use (`archived.ts` BUNDLE_DIR_PATTERN); anything else is reported
 * as skipped, never guessed at. A shape-match with an out-of-range value (13
 * zeros → closedAt 0) is refused too: skip, don't delete.
 */
export function parseArchivedName(name: string): { sessionId: string; closedAt: number } | undefined {
  const match = BUNDLE_DIR_PATTERN.exec(name);
  if (!match) return undefined;
  const closedAt = Number(match[2]);
  if (!Number.isFinite(closedAt) || closedAt <= 0) return undefined;
  return { sessionId: match[1], closedAt };
}

export async function archivedEntries(
  archiveDir: string,
  /** Clock for the future-closedAt guard; defaults to wall time. */
  now: number = Date.now(),
): Promise<{ entries: ArchivedEntry[]; skipped: GcPlan["skipped"] }> {
  const entries: ArchivedEntry[] = [];
  const skipped: GcPlan["skipped"] = [];
  for (const entry of await readdir(archiveDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const parsed = parseArchivedName(entry.name);
    if (!parsed) {
      skipped.push({ name: entry.name, reason: "not an archived-session directory" });
      continue;
    }
    if (parsed.closedAt > now) {
      // A bundle stamped in the future (bad clock, corrupted name) is reported
      // and never considered for deletion.
      skipped.push({ name: entry.name, reason: "closedAt is in the future — never auto-deleted" });
      continue;
    }
    const path = join(archiveDir, entry.name);
    entries.push({ name: entry.name, path, ...parsed, bytes: await dirBytes(path) });
  }
  return { entries: entries.sort((a, b) => b.closedAt - a.closedAt), skipped };
}

/** R10 Design B: count refs that would dangle if `ids` were removed. Tolerant
 *  raw reads — the registries may not exist yet, and a corrupt file must never
 *  stop a gc plan (the sweep itself runs through the registries' own safe
 *  commit paths). */
export function danglingRefCounts(
  dataDir: string,
  ids: ReadonlySet<string>,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): { schedules: number; graphRuns: number } {
  if (ids.size === 0) return { schedules: 0, graphRuns: 0 };
  let schedules = 0;
  let graphRuns = 0;
  try {
    const doc = JSON.parse(readFile(join(dataDir, "schedules.json"))) as {
      schedules?: Array<{ lastSessionId?: string }>;
    };
    for (const s of doc.schedules ?? []) if (s.lastSessionId && ids.has(s.lastSessionId)) schedules += 1;
  } catch {
    /* absent or unreadable — nothing countable */
  }
  try {
    const doc = JSON.parse(readFile(join(dataDir, "graphs.json"))) as {
      runs?: Array<{ tasks?: Record<string, { sessionId?: string }> }>;
    };
    for (const run of doc.runs ?? [])
      for (const task of Object.values(run.tasks ?? {}))
        if (task.sessionId && ids.has(task.sessionId)) graphRuns += 1;
  } catch {
    /* absent or unreadable — nothing countable */
  }
  return { schedules, graphRuns };
}

/** What a retention policy would delete. Pure read: nothing is touched. */
export async function gcPlan(archiveDir: string, options: { closedBeforeDays: number; now?: number }): Promise<GcPlan> {
  const now = options.now ?? Date.now();
  const days = options.closedBeforeDays;
  // Sub-day cutoffs are legal (R5 finding 6): the CLI advertises 90m/12h and
  // parseDuration delivers them as fractional days. Only non-positive values refuse.
  if (!Number.isFinite(days) || days <= 0) throw new Error(`closedBeforeDays must be positive, got ${String(days)}`);
  const { entries, skipped } = await archivedEntries(archiveDir, now);
  const cutoff = now - days * 86_400_000;
  const candidates = entries
    .filter((entry) => entry.closedAt <= cutoff)
    .map((entry) => ({ ...entry, ageDays: Math.floor((now - entry.closedAt) / 86_400_000) }));
  const candidateIds = new Set(candidates.map((c) => c.sessionId));
  return {
    total: { count: entries.length, bytes: entries.reduce((n, e) => n + e.bytes, 0) },
    candidates,
    candidateBytes: candidates.reduce((n, e) => n + e.bytes, 0),
    skipped,
    danglingRefs: danglingRefCounts(dirname(archiveDir), candidateIds),
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

/** R10 Design B: the removed ids a ref-sweep should target (gcApply callers
 *  pass these on — to the daemon route when it answers, else the offline
 *  sweep). Derived from what gcApply actually removed. */
export function removedSessionIds(removed: readonly GcCandidate[]): string[] {
  return removed.map((c) => c.sessionId);
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
