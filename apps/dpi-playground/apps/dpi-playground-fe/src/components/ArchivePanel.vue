<script setup lang="ts">
// Old sessions (policy #3): the archive is a feature surface, not a graveyard.
// Everything the device ever archived, browsable — name, turns, size, last
// message — with a read-only transcript and a one-click restore back to live.
// Nothing here deletes: deletion stays `dpi gc`, operator-only by decision.
import { computed, ref, watch } from "vue";
import { Archive, RefreshCw, RotateCcw, Download } from "lucide-vue-next";
import type { ArchivedView } from "@sdk/api";
import { deviceClient, message } from "../client/hub";
import { isStaleDeviceError, staleDeviceHint } from "../client/stale";
import { notify, selected, ui } from "../client/store";

const sessions = ref<ArchivedView[] | null>(null);
const loading = ref(false);
const error = ref("");
const deviceId = computed(() => selected.value?.deviceId);
const client = () => deviceClient(deviceId.value ?? "");

async function load() {
  if (!deviceId.value) return void (sessions.value = null);
  loading.value = true;
  error.value = "";
  try {
    sessions.value = (await client().archived()).sessions;
  } catch (e) {
    error.value = isStaleDeviceError(e)
      ? staleDeviceHint(deviceId.value, "browsing old sessions")
      : message(e).slice(0, 220);
  } finally {
    loading.value = false;
  }
}
watch(deviceId, load, { immediate: true });

const kib = (bytes: number) => {
  if (bytes <= 0) return "0";
  const units = ["B", "KiB", "MiB", "GiB"];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v >= 100 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
};
const ago = (ms: number) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

function restore(s: ArchivedView) {
  ui.dialog = {
    kind: "prompt",
    title: `Restore “${s.name}”?`,
    hint: "The session returns to the live list with its transcript and jobs intact. Nothing is copied — the bundle simply moves back.",
    submit: "Restore",
    run: async () => {
      await client().restoreArchived(s.sessionId);
      await load();
      notify(`${s.name} restored to the live list.`);
    },
  };
}

async function download(s: ArchivedView) {
  try {
    const r = await client().archivedTranscript(s.sessionId, "markdown");
    const blob = new Blob([r.text ?? ""], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${s.name.replace(/[^\w.-]+/g, "_") || s.sessionId}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    notify(message(e).slice(0, 160));
  }
}
</script>

<template>
  <section class="archive-panel" aria-label="Old sessions">
    <header class="panel-heading">
      <span><Archive :size="16" />ARCHIVE</span>
      <button
        class="icon-button"
        :disabled="loading || !deviceId"
        aria-label="Refresh archive"
        title="Refresh archive"
        @click="load"
      >
        <RefreshCw :size="15" :class="{ spin: loading }" />
      </button>
    </header>

    <p class="hint">
      Every session this device ever archived — read-only. Restore brings one back to the live list;
      nothing here deletes.
    </p>
    <p v-if="!deviceId" class="hint">Select a session to see its device.</p>
    <p v-else-if="error" class="message-error">{{ error }}</p>
    <p v-else-if="sessions && !sessions.length" class="hint">Nothing archived on this device yet.</p>

    <ul v-if="sessions?.length" class="old-list">
      <li v-for="s in sessions" :key="`${s.sessionId}-${s.archivedAt}`" class="old">
        <div class="head">
          <b>{{ s.name }}</b>
          <span class="tag" :title="s.hasManifest ? 'bundled with full identity' : 'old bundle — name unknown'">
            {{ s.hasManifest ? "manifest" : "legacy" }}
          </span>
          <span class="meta">archived {{ ago(s.archivedAt) }}</span>
          <span class="spacer" />
          <button
            class="icon-button"
            :aria-label="`Download transcript of ${s.name}`"
            title="Download transcript (markdown)"
            @click="download(s)"
          >
            <Download :size="13" />
          </button>
          <button
            class="icon-button"
            :aria-label="`Restore ${s.name}`"
            title="Restore to the live list"
            @click="restore(s)"
          >
            <RotateCcw :size="13" />
          </button>
        </div>
        <div class="facts">
          <span v-if="s.cwd" class="cwd">{{ s.cwd }}</span>
          <span v-if="s.model" class="tag">{{ s.model }}</span>
          <span class="meta">{{ s.turns >= 0 ? `${s.turns} turns` : "turns unknown" }}</span>
          <span class="meta">{{ kib(s.bytes) }}</span>
          <span v-if="s.lastMessageAt" class="meta">last message {{ ago(s.lastMessageAt) }}</span>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.archive-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 2px 12px;
  font-size: 16px;
}
.old-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.old {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
}
.old .head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.old .spacer {
  margin-left: auto;
}
.old .facts {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
  opacity: 0.75;
}
.old .cwd {
  font-family: inherit;
  opacity: 0.8;
  word-break: break-all;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
