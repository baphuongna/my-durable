<script setup lang="ts">
// Git chip for the session breadcrumb: branch + dirty at a glance. Rides the
// same LAZY shared store as the Git tab — one fetch per folder while fresh,
// no polling, survives every tab/overlay switch. Click opens the Git tab.
import { computed, onServerPrefetch, watch } from "vue";
import { ChevronDown, GitBranch } from "lucide-vue-next";
import { deviceId, sessionSummary, showInspector } from "../client/store";
import { ensureGit, gitEntry } from "../client/git-store";

const props = defineProps<{ deviceId?: string; cwd?: string }>();

const cwd = computed(() => props.cwd ?? sessionSummary.value?.cwd ?? "");
const devId = computed(() => props.deviceId ?? deviceId.value);
const entry = computed(() => gitEntry(devId.value || "?", cwd.value || "?"));
const status = computed(() => entry.value.status);
const loading = computed(() => entry.value.loading);
const dirty = computed(() => (status.value?.staged ?? 0) + (status.value?.unstaged ?? 0) + (status.value?.untracked ?? 0));

if (!import.meta.env.SSR) void ensureGit(devId.value || "?", cwd.value || "?");
onServerPrefetch(() => ensureGit(devId.value || "?", cwd.value || "?"));
watch([devId, cwd], () => void ensureGit(devId.value || "?", cwd.value || "?"));
</script>

<template>
  <span v-if="status?.repo || loading" class="git-chip-wrap">
    <button
      class="crumb git-chip"
      :title="status ? `${status.root} · ${status.head ?? ''} ${status.subject ?? ''} — opens the Git tab` : 'loading git…'"
      @click="showInspector('git')"
    >
      <GitBranch :size="16" aria-hidden="true" />
      <span class="branch">{{ status?.branch ?? status?.head ?? "…" }}</span>
      <span v-if="dirty" class="dirty">±{{ dirty }}</span>
      <span v-if="status?.ahead" class="ahead">↑{{ status.ahead }}</span>
      <span v-if="status?.behind" class="behind">↓{{ status.behind }}</span>
      <ChevronDown :size="14" aria-hidden="true" />
    </button>
  </span>
</template>

<style scoped>
.git-chip-wrap { position: relative; display: inline-flex; align-items: center; }
.git-chip { gap: 4px; }
.git-chip .branch { max-width: 14ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dirty { color: var(--warn, #e5a50a); }
.ahead { color: var(--ok, #2ea043); }
.behind { color: var(--info, #58a6ff); }
</style>
