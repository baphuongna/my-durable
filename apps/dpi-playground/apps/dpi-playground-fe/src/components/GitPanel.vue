<script setup lang="ts">
// Inspector GIT tab, IntelliJ-shaped:
//   • branch PICKER — the list is right there, nobody types an existing name
//   • worktrees are first-class rows: create a SESSION on one click
//   • commit: big multi-line box + changed-file checkboxes (commit chosen files)
// Lazy: rides the shared git-store (one fetch per folder while fresh), the
// refresh button and every op are the only forced refetches.
import { computed, onServerPrefetch, ref, watch } from "vue";
import { Check, ChevronDown, RefreshCw, X } from "lucide-vue-next";
import { deviceId, network, sessionSummary, notify, select } from "../client/store";
import { deviceClient } from "../client/hub";
import { ensureGit, gitEntry } from "../client/git-store";
import type { GitStatus } from "@sdk/client";

const props = defineProps<{ deviceId?: string; cwd?: string }>();

const cwd = computed(() => props.cwd ?? sessionSummary.value?.cwd ?? "");
const devId = computed(() => props.deviceId ?? deviceId.value);
const entry = computed(() => gitEntry(devId.value || "?", cwd.value || "?"));
const status = computed(() => entry.value.status);
const loading = computed(() => entry.value.loading);
const refreshing = computed(() => entry.value.refreshing);
const error = computed(() => entry.value.error);

const busy = ref("");
const out = ref("");
const commitMsg = ref("");
const checked = ref<Set<string>>(new Set());
const branchMenu = ref(false);
const wtMenu = ref(false);
const newBranch = ref("");

if (!import.meta.env.SSR) void ensureGit(devId.value || "?", cwd.value || "?");
onServerPrefetch(() => ensureGit(devId.value || "?", cwd.value || "?"));
watch([devId, cwd], () => {
  branchMenu.value = false;
  wtMenu.value = false;
  void ensureGit(devId.value || "?", cwd.value || "?");
});
const refresh = () => {
  checked.value = new Set();
  return ensureGit(devId.value || "?", cwd.value || "?", { force: true });
};

// changed files: staged+modified default-checked, untracked not — IntelliJ's
// changelist behavior.
const files = computed(() => status.value?.files ?? []);
watch(files, (list) => {
  const next = new Set<string>();
  for (const f of list) if (f.x !== "?" && f.y !== "?") next.add(f.path);
  checked.value = next;
});
const someChecked = computed(() => files.value.some((f) => checked.value.has(f.path)));
const toggle = (p: string) => {
  const next = new Set(checked.value);
  if (next.has(p)) next.delete(p);
  else next.add(p);
  checked.value = next;
};
const toggleAll = () => {
  checked.value = someChecked.value ? new Set() : new Set(files.value.map((f) => f.path));
};

async function op(name: "fetch" | "pull" | "log" | "branch" | "diff") {
  if (!devId.value || !cwd.value) return;
  busy.value = name;
  out.value = "";
  try {
    const r = await deviceClient(devId.value).gitOp(cwd.value, name);
    out.value = r.text || "(empty)";
    if (name === "fetch" || name === "pull") notify(`git ${name} ✓`);
    await refresh();
  } catch (e) {
    out.value = `${name} failed: ${(e as Error).message.slice(0, 200)}`;
  } finally {
    busy.value = "";
  }
}

async function switchBranch(name: string) {
  branchMenu.value = false;
  if (!devId.value || !cwd.value || name === status.value?.branch) return;
  busy.value = "switch";
  try {
    const r = await deviceClient(devId.value).gitOp(cwd.value, "switch", { ref: name });
    notify(r.text || `switched to ${name}`);
    await refresh();
  } catch (e) {
    notify(`switch failed: ${(e as Error).message.slice(0, 140)}`);
  } finally {
    busy.value = "";
  }
}

async function commit() {
  if (!devId.value || !cwd.value || !commitMsg.value.trim()) return;
  busy.value = "commit";
  const chosen = files.value.filter((f) => checked.value.has(f.path)).map((f) => f.path);
  try {
    const r = await deviceClient(devId.value).gitOp(cwd.value, "commit", {
      message: commitMsg.value.trim(),
      ...(chosen.length ? { files: chosen } : {}),
    });
    notify(r.text);
    commitMsg.value = "";
    await refresh();
  } catch (e) {
    notify(`commit failed: ${(e as Error).message.slice(0, 140)}`);
  } finally {
    busy.value = "";
  }
}

async function addWorktree(branch: string) {
  wtMenu.value = false;
  if (!devId.value || !cwd.value || !status.value?.root) return;
  const root = status.value.root;
  const parent = root.slice(0, root.lastIndexOf("/"));
  const base = root.slice(root.lastIndexOf("/") + 1);
  const target = `${parent}/${base}-${branch.replace(/[/\\]+/g, "-")}`;
  busy.value = "wt";
  try {
    const r = await deviceClient(devId.value).gitOp(cwd.value, "worktree-add", {
      branch: branch, // existing branch checks out; new name creates it
      target,
    });
    notify(r.text.split("\n")[0] ?? `worktree ${target}`);
    newBranch.value = "";
    await refresh();
  } catch (e) {
    notify(`worktree failed: ${(e as Error).message.slice(0, 140)}`);
  } finally {
    busy.value = "";
  }
}

/** A worktree is a working copy — one click and it is a SESSION (herd flow). */
async function sessionOn(path: string, branch: string | null) {
  if (!devId.value) return;
  busy.value = "session";
  try {
    const info = network.devices.value.find((d) => d.id === devId.value)?.info;
    const model =
      (info?.models ?? []).find((m) => m.id === info?.defaultModel) ?? (info?.models ?? [])[0];
    if (!model) return notify(`no model available on ${devId.value} — cannot create a session`);
    const s = await deviceClient(devId.value).createSession({
      name: branch ?? path.slice(path.lastIndexOf("/") + 1),
      cwd: path,
      model: { provider: model.provider, modelId: model.id },
    });
    select({ deviceId: devId.value, sessionId: s.id, agentId: 1 });
    notify(`session "${s.name}" on ${path}`);
  } catch (e) {
    notify(`session failed: ${(e as Error).message.slice(0, 160)}`);
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
    notify(`remove failed: ${(e as Error).message.slice(0, 140)}`);
  } finally {
    busy.value = "";
  }
}
const worktrees = computed(() => (status.value?.worktrees ?? []).filter((w) => w.path));
</script>

<template>
  <div class="git-tab">
    <p v-if="!cwd" class="empty">No session selected — open a session to see its git.</p>
    <template v-else>
      <header class="git-head">
        <strong>git</strong>
        <code class="cwd" :title="cwd">{{ cwd }}</code>
        <button :disabled="!!busy || loading || refreshing" title="refresh" @click="refresh()"><RefreshCw :size="14" /></button>
      </header>

      <p v-if="loading" class="empty">loading git…</p>
      <p v-else-if="refreshing" class="muted note">refreshing…</p>
      <p v-if="error" class="error">{{ error }} <button :disabled="!!busy" @click="refresh()">retry</button></p>

      <div v-if="status" :class="{ stale: !!error || !!refreshing }">
        <p v-if="!status.repo" class="empty">Not a git repository — run <code>git init</code> (or open a session inside a repo).</p>

        <template v-else>
          <!-- branch bar: PICK, never type -->
          <div class="branch-bar">
            <button class="branch-btn" :disabled="!!busy" @click="branchMenu = !branchMenu">
              <strong>{{ status.branch ?? "detached" }}</strong>
              <span v-if="status.upstream" class="muted">→ {{ status.upstream }}</span>
              <span v-if="status.ahead || status.behind" class="muted">↑{{ status.ahead ?? 0 }} ↓{{ status.behind ?? 0 }}</span>
              <ChevronDown :size="14" />
            </button>
            <span class="muted">+{{ status.staged ?? 0 }} ~{{ status.unstaged ?? 0 }} ?{{ status.untracked ?? 0 }} · {{ status.head }}</span>
            <div v-if="branchMenu" class="menu">
              <button v-for="b in status.branches ?? []" :key="b.name" :class="{ cur: b.current }" @click="switchBranch(b.name)">
                <span>{{ b.name }}</span>
                <span class="muted">{{ b.current ? "● current" : b.upstream ? `→ ${b.upstream}` : "" }}</span>
              </button>
              <p v-if="!(status.branches ?? []).length" class="muted pad">no local branches</p>
            </div>
          </div>

          <div class="row ops">
            <button :disabled="!!busy" @click="op('fetch')">fetch</button>
            <button :disabled="!!busy" @click="op('pull')">pull</button>
            <button :disabled="!!busy" @click="op('log')">log</button>
            <button :disabled="!!busy" @click="op('branch')">branches</button>
            <button :disabled="!!busy" @click="op('diff')">diff</button>
          </div>

          <!-- commit: IntelliJ — big box + file checkboxes -->
          <section v-if="files.length" class="commit">
            <div class="files">
              <label class="file all">
                <input type="checkbox" :checked="someChecked" @change="toggleAll" />
                <span class="muted">{{ checked.size }}/{{ files.length }} changed files</span>
              </label>
              <label v-for="f in files" :key="f.path" class="file">
                <input type="checkbox" :checked="checked.has(f.path)" @change="toggle(f.path)" />
                <code class="xy">{{ f.x }}{{ f.y }}</code>
                <span class="path" :title="f.path">{{ f.path }}</span>
              </label>
            </div>
            <textarea v-model="commitMsg" rows="4" placeholder="Commit message…" />
            <button class="primary" :disabled="!!busy || !commitMsg.trim()" @click="commit">
              Commit{{ checked.size ? ` ${checked.size} file${checked.size > 1 ? "s" : ""}` : " -am" }}
            </button>
          </section>

          <!-- worktrees: local + linked, one click to a session -->
          <section class="wts">
            <div class="wt-head">
              <strong>Worktrees</strong>
              <button :disabled="!!busy" @click="wtMenu = !wtMenu">+ worktree</button>
              <div v-if="wtMenu" class="menu">
                <button v-for="b in (status.branches ?? []).filter((x) => !x.current)" :key="b.name" @click="addWorktree(b.name)">
                  <span>{{ b.name }}</span>
                  <span class="muted">existing branch</span>
                </button>
                <div class="new-branch">
                  <input v-model="newBranch" placeholder="or a NEW branch name…" @keyup.enter="addWorktree(newBranch.trim() || 'wt')" />
                  <button :disabled="!newBranch.trim()" @click="addWorktree(newBranch.trim())">create</button>
                </div>
              </div>
            </div>
            <div v-for="w in worktrees" :key="w.path" class="wt" :class="{ main: w.path === status.root }">
              <code :title="w.path">{{ w.path }}</code>
              <span class="muted">{{ w.branch ?? w.head }}</span>
              <span class="grow" />
              <button :disabled="!!busy" title="create a session on this worktree" @click="sessionOn(w.path, w.branch)">session</button>
              <button v-if="w.path !== status.root" :disabled="!!busy" @click="removeWorktree(w.path)"><X :size="12" /></button>
              <Check v-if="w.path === status.root" :size="12" class="muted" />
            </div>
          </section>

          <pre v-if="out" class="out">{{ out.slice(0, 6000) }}</pre>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.git-tab { display: grid; gap: 10px; font-size: 12px; padding: 8px 4px; }
.git-head { display: flex; align-items: center; gap: 8px; }
.git-head .cwd { font-size: 11px; opacity: 0.75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.branch-bar { position: relative; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.branch-btn { display: inline-flex; gap: 6px; align-items: center; padding: 4px 10px; font-size: 12px; }
.menu {
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 40; min-width: 260px; max-height: 260px; overflow: auto;
  background: var(--bg-2, #1c1c22); border: 1px solid var(--border, #333); border-radius: 8px; padding: 4px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 45%);
}
.menu button { display: flex; justify-content: space-between; gap: 12px; width: 100%; padding: 5px 8px; border: 0; background: none; color: inherit; text-align: left; cursor: pointer; }
.menu button:hover, .menu button.cur { background: rgb(127 127 127 / 15%); }
.menu .pad { padding: 6px 8px; margin: 0; }
.row { display: flex; gap: 6px; }
.ops { flex-wrap: wrap; }
.commit { display: grid; gap: 6px; }
.files { max-height: 180px; overflow: auto; border: 1px solid var(--border, #2a2a30); border-radius: 6px; padding: 2px 6px; }
.file { display: flex; gap: 6px; align-items: center; padding: 2px 0; }
.file.all { border-bottom: 1px solid var(--border, #2a2a30); }
.file .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.xy { opacity: 0.7; font-size: 10px; }
textarea { width: 100%; resize: vertical; min-height: 64px; font: inherit; }
button.primary { justify-self: start; }
.wts { display: grid; gap: 4px; }
.wt-head { position: relative; display: flex; align-items: center; gap: 8px; }
.wt { display: flex; gap: 8px; align-items: center; }
.wt code { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 46%; }
.wt.main code { font-weight: 600; }
.grow { flex: 1; }
.new-branch { display: flex; gap: 6px; padding: 6px 8px; border-top: 1px solid var(--border, #2a2a30); }
.new-branch input { flex: 1; min-width: 0; }
.muted { opacity: 0.65; }
.note { font-size: 11px; }
.stale { opacity: 0.55; transition: opacity 0.2s; }
.out { max-height: 300px; overflow: auto; background: rgb(0 0 0 / 25%); padding: 8px; border-radius: 6px; font-size: 11px; }
.empty { opacity: 0.75; }
.error { color: var(--danger, #f85149); }
</style>
