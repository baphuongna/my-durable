// Branch-per-session in the tree: watches the network feed and batch-fetches
// git status for every ONLINE device's distinct session folders — at most one
// call per device per minute (the shared store dedupes everything else).
import { watch } from "vue";
import { network } from "./store";
import { ensureGitBatch, gitEntry } from "./git-store";

const lastBatch = new Map<string, number>();

/** Install once from App setup (client only). */
export function watchSessionGit() {
  watch(
    () => network.devices.value.map((d) => `${d.id}:${d.status}:${d.tree?.sessions.length ?? 0}:${d.tree?.sessions.map((s) => s.cwd).join("|")}`).join(";"),
    () => {
      for (const d of network.devices.value) {
        if (d.status !== "online" || !d.tree?.sessions.length) continue;
        const now = Date.now();
        if (now - (lastBatch.get(d.id) ?? 0) < 60_000) continue;
        lastBatch.set(d.id, now);
        void ensureGitBatch(d.id, d.tree.sessions.map((s) => s.cwd));
      }
    },
    { immediate: true },
  );
}

/** ⎇ branch for a session row, when we already know it (never triggers I/O). */
export const branchOf = (deviceId: string, cwd: string) => gitEntry(deviceId, cwd).status?.branch;
