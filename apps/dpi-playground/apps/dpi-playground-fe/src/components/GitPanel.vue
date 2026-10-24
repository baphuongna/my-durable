<script setup lang="ts">
// Inspector GIT tab: everything the device knows about the session's folder.
// Always visible — "not a git repository" is a state, not a reason to hide.
import { computed, onBeforeUnmount, onMounted, onServerPrefetch, ref, watch } from "vue";
import { RefreshCw } from "lucide-vue-next";
import { deviceId, sessionSummary, notify } from "../client/store";
import { deviceClient } from "../client/hub";
import type { GitStatus } from "@sdk/client";

const props = defineProps<{ deviceId?: string; cwd?: string }>();
const status = ref<GitStatus | null>(null);
const error = ref("");
const loading = ref(false); // first fetch, nothing to show yet — SAY SO
const refreshing = ref(false); // refetch with data on screen — dim, keep, never blank
let inFlight: Promise<void> | undefined;
const busy = ref("");
const out = ref("");
const commitMsg = ref("");
const wtName = ref("");

const cwd = computed(() => props.cwd ?? sessionSummary.value?.cwd ?? "");
const devId = computed(() => props.deviceId ?? deviceId.value);
const dirty = computed(() => (status.value?.staged ?? 0) + (status.value?.unstaged ?? 0) + (status.value?.untracked ?? 0));
const client = () => (devId.value ? deviceClient(devId.value) : null);

let timer: ReturnType<typeof setInterval> | undefined;
async function refresh() {
  const c = client();
  if (!c || !cwd.value) return;
  if (inFlight) return inFlight; // interval + session-switch must not pile up
  const first = !status.value;
  if (first) loading.value = true;
  else refreshing.value = true;
  inFlight = (async () => {
    try {
      status.value = await c.gitStatus(cwd.value);
      error.value = "";
    } catch (e) {
      const raw = (e as Error).message ?? "";
      // Keep the LAST GOOD status — a dropped tunnel must not blank the tab
      // the operator is reading (reported: "treo rất lâu", "Cannot reach …").
      error.value = /fetch failed|Cannot reach|Failed to fetch|NetworkError|ERR_NAME/i.test(raw)
        ? `device unreachable — check that it is online, then retry (${raw.slice(0, 80)})`
        : raw.slice(0, 160);
    } finally {
      loading.value = false;
      refreshing.value = false;
      inFlight = undefined;
    }
  })();
  return inFlight;
}
// NO top-level await: an async setup outside <Suspense> never mounts in the
// browser ("async setup invoked without a Suspense boundary") — the tab
// rendered EMPTY (reported: "TAB git trống"). Fire now on the client;
// onServerPrefetch is what SSR actually waits for.
if (!import.meta.env.SSR) void refresh();
onServerPrefetch(() => refresh());
onMounted(() => {
  timer = setInterval(refresh, 10000);
});
onBeforeUnmount(() => timer && clearInterval(timer));
// The operator switching sessions changes cwd — refetch for the new folder.
watch(cwd, () => void refresh());

async function op(name: "fetch" | "pull" | "log" | "branch" | "diff") {
  const c = client();
  if (!c || !cwd.value) return;
  busy.value = name;
  out.value = "";
  try {
    const r = await c.gitOp(cwd.value, name);
    out.value = r.text || "(empty)";
    if (name === "fetch" || name === "pull") notify(`git ${name} ✓`);
    await refresh();
  } catch (e) {
    out.value = `${name} failed: ${(e as Error).message.slice(0, 200)}`;
  } finally {
    busy.value = "";
  }
}

async function commit() {
  const c = client();
  if (!c || !cwd.value || !commitMsg.value.trim()) return;
  busy.value = "commit";
  try {
    const r = await c.gitOp(cwd.value, "commit", { message: commitMsg.value.trim() });
    notify(r.text);
    commitMsg.value = "";
    await refresh();
  } catch (e) {
    notify(`commit failed: ${(e as Error).message.slice(0, 120)}`);
  } finally {
    busy.value = "";
  }
}

async function addWorktree() {
  const c = client();
  if (!c || !cwd.value || !wtName.value.trim() || !status.value?.root) return;
  const root = status.value.root;
  const parent = root.slice(0, root.lastIndexOf("/"));
  const base = root.slice(root.lastIndexOf("/") + 1);
  busy.value = "wt";
  try {
    const r = await c.gitOp(cwd.value, "worktree-add", { branch: wtName.value.trim(), target: `${parent}/${base}-${wtName.value.trim()}` });
    notify(r.text.split("\n")[0] ?? "worktree added");
    wtName.value = "";
    await refresh();
  } catch (e) {
    notify(`worktree failed: ${(e as Error).message.slice(0, 120)}`);
  } finally {
    busy.value = "";
  }
}

async function removeWorktree(path: string) {
  const c = client();
  if (!c || !cwd.value) return;
  if (!confirm(`Remove worktree ${path}?`)) return;
  busy.value = "wt";
  try {
    await c.gitOp(cwd.value, "worktree-remove", { target: path });
    await refresh();
  } catch (e) {
    notify(`remove failed: ${(e as Error).message.slice(0, 120)}`);
  } finally {
    busy.value = "";
  }
}
</script>

<template>
  <div class="git-tab">
    <p v-if="!cwd" class="empty">No session selected — open a session to see its git.</p>
    <template v-else>
      <header class="git-head">
        <strong>git</strong>
        <code class="cwd" :title="cwd">{{ cwd }}</code>
        <button :disabled="!!busy" title="refresh" @click="refresh()"><RefreshCw :size="14" /></button>
      </header>

      <p v-if="loading" class="empty">loading git…</p>
      <p v-if="refreshing" class="muted note">refreshing…</p>

      <p v-if="error" class="error">
        {{ error }}
        <button :disabled="!!busy || !!loading" @click="refresh()">retry</button>
      </p>

      <div v-if="status" :class="{ stale: !!error || refreshing }">
      <p v-if="status && !status.repo" class="empty">
        Not a git repository — run <code>git init</code> (or open a session inside a repo) to see branch, status and worktrees here.
      </p>

      <template v-else-if="status">
        <dl class="facts">
          <div><dt>branch</dt><dd>{{ status.branch ?? "detached" }}</dd></div>
          <div v-if="status.upstream"><dt>upstream</dt><dd>{{ status.upstream }}</dd></div>
          <div><dt>changes</dt><dd>+{{ status.staged ?? 0 }} ~{{ status.unstaged ?? 0 }} ?{{ status.untracked ?? 0 }}</dd></div>
          <div v-if="status.ahead || status.behind"><dt>sync</dt><dd>↑{{ status.ahead ?? 0 }} ↓{{ status.behind ?? 0 }}</dd></div>
          <div><dt>head</dt><dd>{{ status.head }} {{ status.subject }}</dd></div>
          <div v-if="status.worktreeOf" class="wt-of"><dt>worktree of</dt><dd>{{ status.worktreeOf }}</dd></div>
        </dl>

        <div class="row">
          <button :disabled="!!busy" @click="op('fetch')">fetch</button>
          <button :disabled="!!busy" @click="op('pull')">pull</button>
          <button :disabled="!!busy" @click="op('log')">log</button>
          <button :disabled="!!busy" @click="op('branch')">branches</button>
          <button :disabled="!!busy" @click="op('diff')">diff</button>
        </div>

        <div class="row">
          <input v-model="commitMsg" placeholder="commit message…" @keyup.enter="commit" />
          <button :disabled="!!busy || !commitMsg.trim()" @click="commit">commit -am</button>
        </div>

        <div class="row">
          <input v-model="wtName" placeholder="branch name…" @keyup.enter="addWorktree" />
          <button :disabled="!!busy || !wtName.trim()" @click="addWorktree">+ worktree</button>
        </div>
        <ul v-if="(status.worktrees?.length ?? 0) > 1" class="wts">
          <li v-for="w in status.worktrees" :key="w.path">
            <code>{{ w.path }}</code>
            <span class="muted">{{ w.branch ?? w.head }}</span>
            <button v-if="w.path !== status.root" :disabled="!!busy" @click="removeWorktree(w.path)">remove</button>
          </li>
        </ul>

        <pre v-if="out" class="out">{{ out.slice(0, 6000) }}</pre>
      </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.git-tab { display: grid; gap: 8px; font-size: 12px; padding: 8px 4px; }
.git-head { display: flex; align-items: center; gap: 8px; }
.git-head .cwd { font-size: 11px; opacity: 0.75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.facts { display: grid; gap: 2px; margin: 0; }
.facts > div { display: flex; gap: 8px; }
.facts dt { min-width: 72px; opacity: 0.6; }
.facts dd { margin: 0; word-break: break-all; }
.row { display: flex; gap: 6px; }
.row input { flex: 1; min-width: 0; }
.wts { list-style: none; padding: 0; margin: 0; display: grid; gap: 2px; }
.wts li { display: flex; gap: 8px; align-items: center; }
.wts code { font-size: 11px; }
.muted { opacity: 0.65; }
.wt-of dd { color: var(--info, #58a6ff); }
.out { max-height: 300px; overflow: auto; background: rgb(0 0 0 / 25%); padding: 8px; border-radius: 6px; font-size: 11px; }
.empty { opacity: 0.75; }
.note { font-size: 11px; }
.stale { opacity: 0.55; transition: opacity 0.2s; }
.error { color: var(--danger, #f85149); }
</style>
