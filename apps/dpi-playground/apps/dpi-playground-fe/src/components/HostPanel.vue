<script setup lang="ts">
// Host vitals for the device behind the current selection (Wave 1b): uptime,
// load, memory, and the free space on the volume that holds the device's data
// dir. Asked for when the tab is opened — no polling, matching the lazy store.
import { computed, ref, watch } from "vue";
import { Activity, RefreshCw, Server } from "lucide-vue-next";
import type { DeviceVitals } from "@sdk/api";
import { deviceClient, message } from "../client/hub";
import { notify, selected } from "../client/store";

const vitals = ref<DeviceVitals>();
const busy = ref(false);
const error = ref("");

const deviceId = computed(() => selected.value?.deviceId);

const kib = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
};
const duration = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
};
const percent = (part: number, whole: number) =>
  whole > 0 ? Math.max(0, Math.min(100, Math.round((part / whole) * 100))) : 0;

const memUsed = computed(() => (vitals.value ? percent(vitals.value.memory.usedBytes, vitals.value.memory.totalBytes) : 0));
const diskUsed = computed(() =>
  vitals.value?.disk.known ? percent(vitals.value.disk.totalBytes - vitals.value.disk.freeBytes, vitals.value.disk.totalBytes) : 0,
);

async function load() {
  const id = deviceId.value;
  vitals.value = undefined;
  error.value = "";
  if (!id) return;
  busy.value = true;
  try {
    vitals.value = await deviceClient(id).vitals();
  } catch (e) {
    error.value = message(e).slice(0, 160);
  } finally {
    busy.value = false;
  }
}

watch(deviceId, load, { immediate: true });

async function refresh() {
  await load();
  if (!error.value) notify("Vitals refreshed.");
}
</script>

<template>
  <section class="host-panel" aria-label="Device vitals">
    <header class="panel-heading">
      <span><Server :size="16" />HOST</span>
      <button
        class="icon-button"
        :disabled="busy || !deviceId"
        aria-label="Refresh vitals"
        title="Refresh vitals"
        @click="refresh"
      >
        <RefreshCw :size="15" :class="{ spin: busy }" />
      </button>
    </header>

    <p v-if="!deviceId" class="hint">Select a session to see its device.</p>
    <p v-else-if="error" class="message-error">{{ error }}</p>
    <p v-else-if="!vitals" class="hint">{{ busy ? "Reading host…" : "No vitals." }}</p>

    <template v-else>
      <div class="vitals-grid">
        <div class="vital">
          <span class="label">Host uptime</span>
          <strong>{{ duration(vitals.uptime) }}</strong>
        </div>
        <div class="vital">
          <span class="label">Device process</span>
          <strong>{{ duration(vitals.processUptime) }}</strong>
          <em>pid {{ vitals.pid }}</em>
        </div>
        <div class="vital">
          <span class="label">Load (1/5/15m)</span>
          <strong>{{ vitals.loadavg.map((n) => n.toFixed(2)).join(" · ") }}</strong>
          <em>{{ vitals.cpuCount }} CPU{{ vitals.cpuCount === 1 ? "" : "s" }}</em>
        </div>
        <div class="vital">
          <span class="label">Sessions</span>
          <strong>{{ vitals.counts?.sessions ?? 0 }}</strong>
          <em>{{ vitals.counts?.archived ?? 0 }} archived</em>
        </div>
      </div>

      <div class="meter">
        <div class="meter-head">
          <span class="label">Memory</span>
          <span class="hint">
            {{ kib(vitals.memory.usedBytes) }} / {{ kib(vitals.memory.totalBytes) }} · device
            {{ kib(vitals.memory.processRssBytes) }}
          </span>
        </div>
        <div class="bar" role="meter" :aria-valuenow="memUsed" aria-valuemin="0" aria-valuemax="100" aria-label="Memory used">
          <i :style="{ width: `${memUsed}%` }" :class="{ high: memUsed >= 90 }" />
        </div>
      </div>

      <div class="meter">
        <div class="meter-head">
          <span class="label">Disk · data dir</span>
          <span class="hint">
            <template v-if="vitals.disk.known">
              {{ kib(vitals.disk.totalBytes - vitals.disk.freeBytes) }} used ·
              {{ kib(vitals.disk.freeBytes) }} free
            </template>
            <template v-else>unknown on this volume</template>
          </span>
        </div>
        <div class="bar" role="meter" :aria-valuenow="diskUsed" aria-valuemin="0" aria-valuemax="100" aria-label="Disk used">
          <i :style="{ width: `${diskUsed}%` }" :class="{ high: diskUsed >= 90 }" />
        </div>
        <code class="path">{{ vitals.disk.path }}</code>
      </div>

      <p class="hint">
        <Activity :size="13" /> Read on demand — open this tab or press refresh. Nothing polls the device.
      </p>
    </template>
  </section>
</template>

<style scoped>
.host-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 2px 12px;
  font-size: 16px;
}
.vitals-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}
.vital {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
}
.vital .label,
.meter .label {
  color: var(--fg-dim, var(--fg));
  opacity: 0.72;
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.vital strong {
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}
.vital em {
  font-style: normal;
  font-size: 13px;
  opacity: 0.7;
}
.meter {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.meter-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
}
.bar {
  height: 8px;
  border-radius: 999px;
  background: var(--line);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.3s ease;
}
.bar i.high {
  background: var(--warn, #e5a50a);
}
.path {
  font-size: 13px;
  opacity: 0.7;
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
