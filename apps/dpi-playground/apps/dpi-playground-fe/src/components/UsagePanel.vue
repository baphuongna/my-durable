<script setup lang="ts">
// Inspector USAGE tab — what the selected device has actually spent: the whole
// device rollup (totals, by model, by project, by session), not just this
// session's usage chip. Asked for when the tab is opened — no polling, matching
// the lazy host tab. The API already sorts each list by cost, desc.
import { computed, ref, watch } from "vue";
import { Activity, Cpu, FolderGit2, RefreshCw } from "lucide-vue-next";
import type { DeviceUsageReport } from "@sdk/api";
import { deviceClient, message } from "../client/hub";
import { isStaleDeviceError, staleDeviceHint } from "../client/stale";
import { notify, selected } from "../client/store";

const usage = ref<DeviceUsageReport>();
const busy = ref(false);
const error = ref("");

const deviceId = computed(() => selected.value?.deviceId);

/** Same numbers, same shapes as the TopBar usage chip: thousands separators and
 *  four decimals of dollars — cents are too coarse for cache reads. */
const tokens = (n: number) => Math.round(n || 0).toLocaleString("en-US");
/** Sub-cent costs are real here (one small turn is $0.0000467): fixed 4dp
 *  would print $0.0000, so small non-zero amounts keep their significant digits. */
const cost = (n: number) => {
  const v = n || 0;
  if (v === 0) return "$0.0000";
  if (v < 0.0001) return `$${v.toPrecision(2)}`;
  if (v < 0.01) return `$${v.toFixed(6)}`;
  return `$${v.toFixed(4)}`;
};
/** Compact form for the per-type columns, where the magnitude matters more than
 *  the last digit and the row must stay one line. */
/** Shares are relative to the biggest model — a device-wide bar chart. */
const topModelCost = computed(() =>
  (usage.value?.models ?? []).reduce((max, m) => Math.max(max, m.cost || 0), 0),
);
const share = (value: number) =>
  topModelCost.value > 0 ? Math.max(0, Math.min(100, Math.round(((value || 0) / topModelCost.value) * 100))) : 0;

const empty = computed(() => {
  const u = usage.value;
  return !u || (!u.models.length && !u.sessions.length && !u.projects.length);
});
const readAt = computed(() =>
  usage.value ? new Date(usage.value.at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "",
);
const plural = (n: number, one: string) => `${tokens(n)} ${one}${n === 1 ? "" : "s"}`;

async function load() {
  const id = deviceId.value;
  usage.value = undefined;
  error.value = "";
  if (!id) return;
  busy.value = true;
  try {
    usage.value = await deviceClient(id).deviceUsage();
  } catch (e) {
    error.value = isStaleDeviceError(e)
      ? staleDeviceHint(deviceId.value, "usage")
      : message(e).slice(0, 220);
  } finally {
    busy.value = false;
  }
}

watch(deviceId, load, { immediate: true });

async function refresh() {
  await load();
  if (!error.value) notify("Usage refreshed.");
}
</script>

<template>
  <section class="usage-panel" aria-label="Device usage">
    <header class="panel-heading">
      <span><Activity :size="16" />USAGE</span>
      <button
        class="icon-button"
        :disabled="busy || !deviceId"
        aria-label="Refresh usage"
        title="Refresh usage"
        @click="refresh"
      >
        <RefreshCw :size="15" :class="{ spin: busy }" />
      </button>
    </header>

    <p v-if="!deviceId" class="hint">Select a session to see its device's usage.</p>
    <p v-else-if="error" class="message-error">{{ error }}</p>
    <p v-else-if="!usage" class="hint">{{ busy ? "Reading usage…" : "No usage recorded yet." }}</p>
    <p v-else-if="empty" class="hint">No usage recorded yet.</p>

    <template v-else>
      <!-- 1 · TOTALS -->
      <section class="usage-block" aria-labelledby="usage-totals">
        <div class="section-label block-label"><span id="usage-totals">TOTALS</span></div>
        <div class="totals">
          <div class="total">
            <span class="label">Tokens</span>
            <strong>{{ tokens(usage.totals.tokens) }}</strong>
          </div>
          <div class="total">
            <span class="label">Cost</span>
            <strong>{{ cost(usage.totals.cost) }}</strong>
          </div>
          <div class="total">
            <span class="label">Sessions</span>
            <strong>{{ tokens(usage.sessions.length) }}</strong>
            <em>{{ tokens(usage.projects.length) }} projects</em>
          </div>
          <div class="total">
            <span class="label">Models</span>
            <strong>{{ tokens(usage.models.length) }}</strong>
            <em>costliest first</em>
          </div>
        </div>
      </section>

      <!-- 2 · BY MODEL -->
      <section class="usage-block" aria-labelledby="usage-models">
        <div class="section-label block-label">
          <span id="usage-models">BY MODEL</span><Cpu :size="13" />
        </div>
        <div class="table-scroll">
        <table class="usage-table" aria-label="Usage by model">
          <colgroup>
            <col /><col /><col /><col />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col" class="num">Tokens</th>
              <th scope="col" class="num">Cost</th>
              <th scope="col" class="share-col">Share</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in usage.models" :key="m.key">
              <th
                scope="row"
                class="model-key"
                :title="`${m.key} — in ${m.input} · out ${m.output} · cache read ${m.cacheRead} · cache write ${m.cacheWrite}`"
              >
                {{ m.key }}
              </th>
              <td class="num">{{ tokens(m.tokens) }}</td>
              <td class="num">{{ cost(m.cost) }}</td>
              <td class="share-col">
                <div class="share">
                  <div
                    class="bar"
                    role="meter"
                    :aria-valuenow="share(m.cost)"
                    aria-valuemin="0"
                    aria-valuemax="100"
                    :aria-label="`${m.key} share of the costliest model`"
                  >
                    <i :style="{ width: `${share(m.cost)}%` }" :class="{ high: share(m.cost) > 90 }" />
                  </div>
                  <em class="pct">{{ share(m.cost) }}%</em>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
      </section>

      <!-- 3a · BY PROJECT -->
      <section class="usage-block" aria-labelledby="usage-projects">
        <div class="section-label block-label">
          <span id="usage-projects">BY PROJECT</span><FolderGit2 :size="13" />
        </div>
        <p v-if="!usage.projects.length" class="hint">No project usage recorded yet.</p>
        <ul v-else class="rows">
          <li v-for="p in usage.projects" :key="p.rootPath" class="row" :title="p.rootPath">
            <span class="row-main">
              <strong>{{ p.name }}</strong>
              <em>{{ p.rootPath }}</em>
            </span>
            <span class="row-num">{{ tokens(p.tokens) }} tok</span>
            <span class="row-num">{{ cost(p.cost) }}</span>
            <span class="row-meta">{{ plural(p.sessions, "session") }}</span>
          </li>
        </ul>
      </section>

      <!-- 3b · BY SESSION -->
      <section class="usage-block" aria-labelledby="usage-sessions">
        <div class="section-label block-label"><span id="usage-sessions">BY SESSION</span></div>
        <p v-if="!usage.sessions.length" class="hint">No session usage recorded yet.</p>
        <ul v-else class="rows scroll">
          <li v-for="s in usage.sessions" :key="s.id" class="row" :title="s.cwd">
            <span class="row-main">
              <strong>{{ s.name }}</strong>
              <em>{{ s.project ?? s.cwd }}</em>
            </span>
            <span class="row-num">{{ tokens(s.tokens) }} tok</span>
            <span class="row-num">{{ cost(s.cost) }}</span>
            <span class="row-meta">{{ plural(s.agents, "agent") }}</span>
          </li>
        </ul>
      </section>

      <p class="hint">
        <Activity :size="13" /> Read on demand — open this tab or press refresh ({{ readAt }}). Nothing polls the
        device.
      </p>
    </template>
  </section>
</template>

<style scoped>
.usage-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 2px 12px;
  font-size: 16px;
}
.usage-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.block-label {
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--fg-dim, var(--fg));
  opacity: 0.72;
  margin-bottom: 0;
  align-items: center;
}
.totals {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
}
.total {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
}
.total .label {
  color: var(--fg-dim, var(--fg));
  opacity: 0.72;
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.total strong {
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}
.total em {
  font-style: normal;
  font-size: 13px;
  opacity: 0.7;
}
.table-scroll {
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 10px;
}
.usage-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 14px;
  border: 0;
}
.usage-table th,
.usage-table td {
  padding: 6px 8px;
  text-align: left;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}
.usage-table thead th {
  font-size: 13px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--fg-dim, var(--fg));
  opacity: 0.72;
}
.usage-table tbody tr:last-child th,
.usage-table tbody tr:last-child td {
  border-bottom: 0;
}
.usage-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.usage-table .dim {
  opacity: 0.7;
}
/* A 390px inspector cannot hold four full-width columns: fixed layout plus a
   single-line ellipsis, with the full figures in the row's tooltip. */
.usage-table col:nth-child(1) { width: 44%; }
.usage-table col:nth-child(2) { width: 17%; }
.usage-table col:nth-child(3) { width: 15%; }
.usage-table col:nth-child(4) { width: 24%; }
.model-key {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.share {
  display: flex;
  align-items: center;
  gap: 6px;
}
.share .bar {
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: var(--line);
  overflow: hidden;
}
.share .bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.3s ease;
}
.share .bar i.high {
  background: var(--warn, #e5a50a);
}
.share .pct {
  font-style: normal;
  font-size: 13px;
  opacity: 0.72;
  font-variant-numeric: tabular-nums;
  width: 4ch;
  text-align: right;
}
.rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 4px 10px;
  list-style: none;
  border: 1px solid var(--line);
  border-radius: 10px;
}
.rows.scroll {
  max-height: 280px;
  overflow: auto;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
  font-size: 14px;
}
.row + .row {
  border-top: 1px solid var(--line);
}
.row-main {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1;
  min-width: 0;
}
.row-main strong {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-main em {
  font-style: normal;
  font-size: 13px;
  opacity: 0.65;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-num {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.row-meta {
  font-size: 13px;
  opacity: 0.72;
  white-space: nowrap;
  min-width: 9ch;
  text-align: right;
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
