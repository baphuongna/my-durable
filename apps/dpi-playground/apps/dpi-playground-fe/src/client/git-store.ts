// Git state, shared and LAZY: one entry per device+folder, fetched only when
// something actually looks at it, kept across tab switches, never re-fetched
// while fresh. In-flight calls are shared so chip + panel + re-entry of either
// cost ONE device round-trip.
import { reactive, watch } from "vue";
import type { GitStatus } from "@sdk/client";
import { deviceClient } from "./hub";
import { network } from "./store";

export interface GitEntry {
  at: number; // last settled fetch (0 = never)
  status: GitStatus | null;
  error: string;
  loading: boolean; // first fetch, nothing to show yet
  refreshing: boolean; // refetch with data on screen
}

const entries = new Map<string, GitEntry>();
const inflight = new Map<string, Promise<void>>();
/** run-7 D2: the module-global entry map had NO ceiling — a hostile device's
 *  status-batch response (or a hostile tree's cwds) grew it forever until the
 *  tab OOMs. Same discipline as the SDK caps: bounded slots, oldest evicted. */
const MAX_GIT_ENTRIES = 2000;
function capEntries() {
  while (entries.size > MAX_GIT_ENTRIES) {
    const oldest = entries.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/** A device's git surface is bounded by its start dirs (R21, index 400s): a
 *  project left over from OTHER start dirs answers 400 on the device, and
 *  asking anyway just spams the console with network errors every stale
 *  window. The network frame carries each device's startDirs + platform —
 *  pre-check client-side (the device stays the enforcer) and settle such
 *  paths locally. Unknown device facts → allow: the device decides. */
function gitPathAllowed(deviceId: string, path: string): boolean {
  const dev = network.devices.value.find((d) => d.id === deviceId) as
    | { info?: { startDirs?: unknown; platform?: unknown } }
    | undefined;
  const dirs = dev?.info?.startDirs;
  if (!Array.isArray(dirs) || dirs.length === 0) return true;
  const win = String(dev?.info?.platform ?? "").startsWith("win32");
  const norm = (p: string) =>
    win ? p.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase() : p.trim().replace(/\/+$/, "");
  const a = norm(path);
  return dirs.some((raw) => {
    const b = norm(String(raw));
    return !!b && (a === b || a.startsWith(win ? b + "\\" : b + "/"));
  });
}

/**
 * run-8 (live console report): panels that call gitOp DIRECTLY (the commit
 * log, PR list, turn list) skipped the pre-check above, so a project left over
 * from other start dirs — or a plain non-repo project — produced a 400 storm
 * on every mount and every network frame. Exported so every git caller asks
 * the same question. `reason` is the operator-facing sentence.
 */
export function gitAllowedFor(
  deviceId: string,
  path: string,
): { ok: true } | { ok: false; reason: string } {
  if (!gitPathAllowed(deviceId, path)) return { ok: false, reason: "outside the device's start dirs" };
  const entry = gitEntry(deviceId, path);
  if (entry.status && entry.status.repo === false) return { ok: false, reason: "not a git repository" };
  return { ok: true };
}

/** Settle an entry from either a real status or the batch's `{error}` shape. */
function settleEntry(e: GitEntry, s: GitStatus | { error: string } | undefined) {
  if (s && typeof (s as { error?: unknown }).error === "string") {
    e.status = null;
    e.error = (s as { error: string }).error;
  } else {
    e.status = (s as GitStatus) ?? null;
    e.error = "";
  }
  e.at = Date.now();
}

/** Fill MANY folders in one round-trip (session lists want branch-per-cwd).
 *  Decorative by design: a failed batch stays silent — the Git tab is where
 *  errors belong. */
export async function ensureGitBatch(deviceId: string, paths: string[]) {
  const stale = paths.filter((p) => !fresh(gitEntry(deviceId, p), staleMsForBatch) && gitPathAllowed(deviceId, p));
  if (!stale.length) return;
  // run-7 D2: (a) the device truncates at 50 paths — chunk so every stale
  // path actually settles (beyond-50 paths used to ride every batch forever);
  // (b) 10 chunks max per pass keeps a hostile tree from fanning requests.
  for (let i = 0; i < stale.length && i < 500; i += 50) {
    const chunk = stale.slice(i, i + 50);
    try {
      const map = (await deviceClient(deviceId).gitStatusBatch(chunk, { timeoutMs: 60_000 })) as Record<
        string,
        GitStatus | { error: string }
      >;
      // run-7 D2: settle ONLY the keys WE sent — the response map is hostile-
      // device-controlled and used to be iterated wholesale, letting a device
      // grow this tab's retained state with keys the FE never asked for.
      for (const p of chunk) {
        const s = map[p];
        if (s !== undefined) settleEntry(gitEntry(deviceId, p), s);
      }
    } catch {
      /* decorative: never surface batch failures */
    }
  }
  capEntries();
}
const staleMsForBatch = 60_000;

/** fs-auto-refresh, FE side: the device's tree carries dirty marks for repos
 *  its watcher saw change — refresh exactly those entries, still lazy (never
 *  an interval), throttled per entry. */
let wired = false;
export function wireGitAutoRefresh() {
  if (wired || import.meta.env.SSR) return;
  wired = true;
  watch(() => network.devices.value, (devices) => {
    const now = Date.now();
    for (const d of devices) {
      const marks = ((d as { tree?: { git?: { root: string; at: number }[] } }).tree?.git ?? []).filter(
        (m) => now - m.at < 60_000,
      );
      if (!marks.length) continue;
      for (const key of [...entries.keys()]) {
        // run-8 U4: decode at the FIRST '::' — a cwd containing '::' (legal
        // POSIX bytes, device-controlled per R23) truncated the split() form at
        // its own first '::', never refreshing the real entry and force-
        // refreshing a phantom prefix entry on a matching prefix mark.
        const sep = key.indexOf("::");
        const devId = key.slice(0, sep);
        const cwd = key.slice(sep + 2);
        if (sep < 0 || !devId || devId !== d.id || !cwd) continue;
        const e = entries.get(key)!;
        if (!marks.some((m) => cwd === m.root || cwd.startsWith(m.root + "/") || cwd.startsWith(m.root + "\\"))) continue;
        if (e.loading || now - e.at < 4000) continue; // throttle: bursts coalesce
        void ensureGit(devId, cwd, { force: true });
      }
    }
  });
}

/** Test hook: the store is module-global on purpose (tab switches must not
 *  refetch) — tests reset it so entries never leak between cases. */
export function clearGitCache() {
  entries.clear();
  inflight.clear();
}

const key = (deviceId: string, cwd: string) => `${deviceId}::${cwd}`;

export function gitEntry(deviceId: string, cwd: string): GitEntry {
  const k = key(deviceId, cwd);
  let e = entries.get(k);
  if (!e) {
    e = reactive({ at: 0, status: null, error: "", loading: false, refreshing: false });
    entries.set(k, e);
  }
  return e;
}

/** True when the entry is fresh enough to show without touching the device. */
const fresh = (e: GitEntry, staleMs: number) => e.at > 0 && Date.now() - e.at < staleMs && (e.status !== null || e.error);

/**
 * Fetch only when nothing usable is cached. `force` bypasses the TTL (the
 * retry/refresh buttons and post-op refreshes use it).
 */
export async function ensureGit(
  deviceId: string,
  cwd: string,
  opts: { staleMs?: number; force?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  const { staleMs = 60_000, force = false, timeoutMs = 60_000 } = opts;
  if (!deviceId || !cwd) return;
  const k = key(deviceId, cwd);
  const e = gitEntry(deviceId, cwd);
  if (!force && fresh(e, staleMs)) return;
  // Outside the device's sandbox: settle locally, never send the doomed 400.
  if (!gitPathAllowed(deviceId, cwd)) {
    settleEntry(e, { error: "outside the device's start dirs" });
    return;
  }  capEntries();
  const running = inflight.get(k);
  if (running) return running;
  const first = e.status === null && !e.error;
  if (first) e.loading = true;
  else e.refreshing = true;
  e.error = ""; // a new attempt must not stack on the old verdict
  const p = (async () => {
    try {
      // Big checkouts honestly take 20s+ — wait for the truth.
      e.status = await deviceClient(deviceId).gitStatus(cwd, { timeoutMs });
      e.at = Date.now();
    } catch (err) {
      const raw = (err as Error).message ?? "";
      e.error = /fetch failed|Cannot reach|Failed to fetch|NetworkError|abort/i.test(raw)
        ? `device unreachable — check that it is online, then retry (${raw.slice(0, 80)})`
        : raw.slice(0, 160);
      e.at = Date.now(); // a failed attempt is still an attempt: no hammering
    } finally {
      e.loading = false;
      e.refreshing = false;
      inflight.delete(k);
    }
  })();
  inflight.set(k, p);
  return p;
}
