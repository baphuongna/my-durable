<script setup lang="ts">
// Git chip for the session breadcrumb: branch + dirty at a glance, click for
// the real panel — status, worktrees, fetch/pull/log/commit, new worktree.
// Everything goes through the device's whitelisted /v1/git API.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ChevronDown, GitBranch, RefreshCw } from "lucide-vue-next";
import { deviceId, sessionSummary, notify } from "../client/store";
import { deviceClient } from "../client/hub";
import type { GitStatus } from "@sdk/client";

const props = defineProps<{ deviceId?: string; cwd?: string }>();
const status = ref<GitStatus | null>(null);
const open = ref(false);
const busy = ref("");
const logText = ref("");
const commitMsg = ref("");
const wtName = ref("");

const cwd = computed(() => props.cwd ?? sessionSummary.value?.cwd ?? "");
const devId = computed(() => props.deviceId ?? devId.value);
const dirty = computed(() => (status.value?.staged ?? 0) + (status.value?.unstaged ?? 0) + (status.value?.untracked ?? 0));

let timer: ReturnType<typeof setInterval> | undefined;
async function refresh() {
  if (!cwd.value || !devId.value) return;
  try {
    status.value = await deviceClient(devId.value).gitStatus(cwd.value);
  } catch (e) {
    status.value = null;
  }
}
// First fetch inside setup: SSR (and the first paint) wait for it, so the chip
// never flashes empty; later refreshes ride the interval + cwd changes.
await refresh();
watch(cwd, () => void refresh());
onMounted(() => {
  timer = setInterval(refresh, 15000);
});
onBeforeUnmount(() => timer && clearInterval(timer));

async function op(name: "fetch" | "pull" | "log" | "branch", keepOpen = true) {
  if (!devId.value || !cwd.value) return;
  busy.value = name;
  logText.value = "";
  try {
    const out = await deviceClient(devId.value).gitOp(cwd.value, name);
    if (name === "log" || name === "branch") logText.value = out.text;
    else notify(`git ${name}: ${out.text.split("\n")[0] ?? "ok"}`);
    await refresh();
  } catch (e) {
    notify(`git ${name} failed: ${(e as Error).message.slice(0, 120)}`);
  } finally {
    busy.value = "";
    void keepOpen;
  }
}

async function commit() {
  if (!devId.value || !cwd.value || !commitMsg.value.trim()) return;
  busy.value = "commit";
  try {
    const out = await deviceClient(devId.value).gitOp(cwd.value, "commit", { message: commitMsg.value.trim() });
    notify(out.text);
    commitMsg.value = "";
    await refresh();
  } catch (e) {
    notify(`commit failed: ${(e as Error).message.slice(0, 120)}`);
  } finally {
    busy.value = "";
  }
}

async function addWorktree() {
  if (!devId.value || !cwd.value || !wtName.value.trim() || !status.value?.root) return;
  busy.value = "wt";
  const root = status.value.root;
  const parent = root.slice(0, root.lastIndexOf("/"));
  const base = root.slice(root.lastIndexOf("/") + 1);
  const target = `${parent}/${base}-${wtName.value.trim()}`;
  try {
    const out = await deviceClient(devId.value).gitOp(cwd.value, "worktree-add", {
      branch: wtName.value.trim(),
      target,
    });
    notify(`worktree: ${out.text.split("\n")[0] ?? target}`);
    wtName.value = "";
    await refresh();
  } catch (e) {
    notify(`worktree failed: ${(e as Error).message.slice(0, 120)}`);
  } finally {
    busy.value = "";
  }
}

async function removeWorktree(path: string) {
  if (!devId.value || !cwd.value) return;
  if (!confirm(`Remove worktree ${path}?`)) return;
  busy.value = "wt";
  try {
    await deviceClient(devId.value).gitOp(cwd.value, "worktree-remove", { target: path });
    await refresh();
  } catch (e) {
    notify(`remove failed: ${(e as Error).message.slice(0, 120)}`);
  } finally {
    busy.value = "";
  }
}
</script>

<template>
  <span v-if="status?.repo" class="git-chip-wrap">
    <button class="crumb git-chip" :title="`${status.root} · ${status.head ?? ''} ${status.subject ?? ''}`" @click="open = !open">
      <GitBranch :size="16" aria-hidden="true" />
      <span class="branch">{{ status.branch ?? status.head }}</span>
      <span v-if="dirty" class="dirty">±{{ dirty }}</span>
      <span v-if="status.ahead" class="ahead">↑{{ status.ahead }}</span>
      <span v-if="status.behind" class="behind">↓{{ status.behind }}</span>
      <ChevronDown :size="14" aria-hidden="true" />
    </button>
    <div v-if="open" class="git-panel" @click.stop>
      <header>
        <strong>git · {{ status.root }}</strong>
        <button :disabled="!!busy" title="refresh" @click="refresh()"><RefreshCw :size="14" /></button>
      </header>
      <p class="line">
        {{ status.branch ?? "detached" }}<template v-if="status.upstream"> → {{ status.upstream }}</template>
        · <span title="staged/unstaged/untracked">+{{ status.staged ?? 0 }} ~{{ status.unstaged ?? 0 }} ?{{ status.untracked ?? 0 }}</span>
      </p>
      <p class="line muted">{{ status.head }} {{ status.subject }}</p>
      <p v-if="status.worktreeOf" class="line wt-of">worktree of {{ status.worktreeOf }}</p>

      <div class="row">
        <button :disabled="!!busy" @click="op('fetch')">fetch</button>
        <button :disabled="!!busy" @click="op('pull')">pull</button>
        <button :disabled="!!busy" @click="op('log')">log</button>
        <button :disabled="!!busy" @click="op('branch')">branches</button>
      </div>

      <div class="row commit">
        <input v-model="commitMsg" placeholder="commit message…" @keyup.enter="commit" />
        <button :disabled="!!busy || !commitMsg.trim()" @click="commit">commit -am</button>
      </div>

      <div class="row wt">
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

      <pre v-if="logText" class="log">{{ logText.slice(0, 4000) }}</pre>
    </div>
  </span>
</template>

<style scoped>
.git-chip-wrap { position: relative; display: inline-flex; align-items: center; }
.git-chip { gap: 4px; }
.git-chip .branch { max-width: 14ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dirty { color: var(--warn, #e5a50a); }
.ahead { color: var(--ok, #2ea043); }
.behind { color: var(--info, #58a6ff); }
.git-panel {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 40; min-width: 320px; max-width: min(560px, 90vw);
  background: var(--bg-2, #1c1c22); border: 1px solid var(--border, #333); border-radius: 8px; padding: 10px 12px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 40%); font-size: 12px;
}
.git-panel header { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.git-panel .line { margin: 4px 0; }
.git-panel .muted, .muted { opacity: 0.7; }
.git-panel .wt-of { color: var(--info, #58a6ff); }
.git-panel .row { display: flex; gap: 6px; margin: 8px 0; flex-wrap: wrap; }
.git-panel .row.commit, .git-panel .row.wt { flex-wrap: nowrap; }
.git-panel input { flex: 1; min-width: 0; }
.git-panel .wts { list-style: none; padding: 0; margin: 4px 0; display: grid; gap: 2px; }
.git-panel .wts li { display: flex; gap: 8px; align-items: center; }
.git-panel .wts code { font-size: 11px; }
.git-panel .log { max-height: 220px; overflow: auto; background: rgb(0 0 0 / 25%); padding: 8px; border-radius: 6px; }
</style>
