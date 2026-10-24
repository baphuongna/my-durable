// Git state, shared and LAZY: one entry per device+folder, fetched only when
// something actually looks at it, kept across tab switches, never re-fetched
// while fresh. In-flight calls are shared so chip + panel + re-entry of either
// cost ONE device round-trip.
import { reactive } from "vue";
import type { GitStatus } from "@sdk/client";
import { deviceClient } from "./hub";

export interface GitEntry {
  at: number; // last settled fetch (0 = never)
  status: GitStatus | null;
  error: string;
  loading: boolean; // first fetch, nothing to show yet
  refreshing: boolean; // refetch with data on screen
}

const entries = new Map<string, GitEntry>();
const inflight = new Map<string, Promise<void>>();

/** Fill MANY folders in one round-trip (session lists want branch-per-cwd).
 *  Decorative by design: a failed batch stays silent — the Git tab is where
 *  errors belong. */
export async function ensureGitBatch(deviceId: string, paths: string[]) {
  const stale = paths.filter((p) => !fresh(gitEntry(deviceId, p), staleMsForBatch));
  if (!stale.length) return;
  try {
    const map = await deviceClient(deviceId).gitStatusBatch(stale, { timeoutMs: 60_000 });
    for (const [p, s] of Object.entries(map)) {
      const e = gitEntry(deviceId, p);
      e.status = s;
      e.at = Date.now();
      e.error = "";
    }
  } catch {
    /* decorative: never surface batch failures */
  }
}
const staleMsForBatch = 60_000;

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
