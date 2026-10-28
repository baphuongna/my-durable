<script setup lang="ts">
// Scheduled sessions (Wave 2): the DEVICE owns the clock — this panel only
// reads and edits the records over the tunnel, so the daemon runs them whether
// or not a browser is open. A run creates a fresh session per trigger.
import { computed, ref, watch } from "vue";
import { CalendarClock, Play, Plus, RefreshCw, Trash2, Power } from "lucide-vue-next";
import type { ScheduleView } from "@sdk/api";
import { deviceClient, message } from "../client/hub";
import { isStaleDeviceError, staleDeviceHint } from "../client/stale";
import { notify, selected, ui } from "../client/store";

const schedules = ref<ScheduleView[]>([]);
const busy = ref("");
const error = ref("");
const loading = ref(false);
const deviceId = computed(() => selected.value?.deviceId);
const client = () => deviceClient(deviceId.value ?? "");

const every = ref("60");
const daily = ref("");
const adding = ref(false);
const draft = ref({ name: "", cwd: "", prompt: "", model: "" });

async function load() {
  if (!deviceId.value) return void (schedules.value = []);
  loading.value = true;
  error.value = "";
  try {
    schedules.value = (await client().schedules()).schedules;
  } catch (e) {
    error.value = isStaleDeviceError(e)
      ? staleDeviceHint(deviceId.value, "schedules")
      : message(e).slice(0, 220);
  } finally {
    loading.value = false;
  }
}
/** The empty state must wait for the first fetch: a tunnel first-hit can take
 * seconds, and "No schedules yet." painted at ~11ms was a lie the real list
 * replaced at ~4s. Same class as the modelsLoading fix (0.0.47). */
watch(deviceId, load, { immediate: true });

const when = (at: number | null) => {
  if (!at) return "—";
  const delta = at - Date.now();
  const mins = Math.round(Math.abs(delta) / 60_000);
  const human = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return delta >= 0 ? `in ${human}` : `${human} ago`;
};
const trigger = (s: ScheduleView) => (s.everyMinutes ? `every ${s.everyMinutes}m` : `daily ${s.dailyAt}`);

async function withBusy(id: string, fn: () => Promise<unknown>, done: string) {
  busy.value = id;
  try {
    await fn();
    await load();
    notify(done);
  } catch (e) {
    notify(message(e).slice(0, 140));
  } finally {
    busy.value = "";
  }
}

const toggle = (s: ScheduleView) =>
  withBusy(s.id, () => client().updateSchedule(s.id, { enabled: !s.enabled }), s.enabled ? "Schedule paused." : "Schedule resumed.");

const runNow = (s: ScheduleView) =>
  withBusy(s.id, () => client().runSchedule(s.id), `${s.name}: run started.`);

const remove = (s: ScheduleView) =>
  (ui.dialog = {
    kind: "prompt",
    title: `Remove ${s.name}?`,
    hint: "The schedule stops being run. Sessions it already created are untouched.",
    submit: "Remove schedule",
    danger: true,
    run: () => withBusy(s.id, () => client().removeSchedule(s.id), "Schedule removed."),
  });

/** The model is picked from the device's own catalog, not typed from memory. */
const models = ref<{ key: string }[]>([]);
/** While the device's model catalog loads the form must say so — a silent
 * dead Create button is how live-driving caught this (tunnel first-hit lag). */
const modelsLoading = ref(false);
async function openAdd() {
  adding.value = true;
  draft.value = { name: "", cwd: "", prompt: "", model: "" };
  models.value = [];
  modelsLoading.value = true;
  try {
    const device = await client().device();
    models.value = device.models.map((m) => ({ key: `${m.provider}/${m.id}` }));
    draft.value.model = device.defaultModel;
  } catch {
    models.value = [];
  } finally {
    modelsLoading.value = false;
  }
}

async function save() {
  const d = draft.value;
  const [provider, ...rest] = d.model.split("/");
  const modelId = rest.join("/");
  if (!d.name.trim() || !d.cwd.trim() || !d.prompt.trim()) return;
  if (!provider || !modelId) {
    notify(modelsLoading.value ? "Still loading the model list — one moment." : "Pick a model first.");
    return;
  }
  busy.value = "new";
  try {
    await client().createSchedule({
      name: d.name.trim(),
      cwd: d.cwd.trim(),
      prompt: d.prompt,
      model: { provider, modelId },
      // One trigger only: exactly what the registry demands.
      ...(daily.value.trim() ? { dailyAt: daily.value.trim() } : { everyMinutes: Number(every.value) || 60 }),
    });
    adding.value = false;
    await load();
    notify("Schedule created. The device runs it on its own clock.");
  } catch (e) {
    notify(message(e).slice(0, 160));
  } finally {
    busy.value = "";
  }
}
</script>

<template>
  <section class="schedules-panel" aria-label="Scheduled sessions">
    <header class="panel-heading">
      <span><CalendarClock :size="16" />SCHEDULES</span>
      <button class="icon-button" :disabled="loading || !deviceId" aria-label="Refresh schedules" title="Refresh schedules" @click="load">
        <RefreshCw :size="15" :class="{ spin: loading }" />
      </button>
      <button class="icon-button" :disabled="!deviceId" aria-label="Add schedule" title="Add schedule" @click="openAdd">
        <Plus :size="15" />
      </button>
    </header>

    <p class="hint">Runs on the device's own clock — no browser needs to be open.</p>
    <p v-if="!deviceId" class="hint">Select a session to see its device.</p>
    <p v-else-if="error" class="message-error">{{ error }}</p>

    <form v-if="adding" class="add-form" @submit.prevent="save">
      <label>Name<input v-model="draft.name" placeholder="Nightly smoke" required /></label>
      <label>Directory<input v-model="draft.cwd" placeholder="/home/me/project" required /></label>
      <label>Prompt<textarea v-model="draft.prompt" rows="3" placeholder="Run the tests and summarise failures" required /></label>
      <label
        >Model
        <select v-model="draft.model" :disabled="modelsLoading">
          <option v-if="modelsLoading" value="">loading…</option>
          <option v-else-if="!models.length" value="">(no models — check the device)</option>
          <option v-for="m in models" :key="m.key" :value="m.key">{{ m.key }}</option>
        </select>
      </label>
      <div class="trigger-row">
        <label class="inline">Every <input v-model="every" class="num" :disabled="!!daily.trim()" /> min</label>
        <span class="muted">or</span>
        <label class="inline">daily at <input v-model="daily" class="num time" placeholder="03:00" :disabled="!!every" /></label>
      </div>
      <div class="row">
        <button class="primary small" type="submit" :disabled="busy === 'new' || modelsLoading || !draft.model">
          {{ busy === "new" ? "creating…" : modelsLoading ? "loading models…" : "Create schedule" }}
        </button>
        <button class="small" type="button" @click="adding = false">Cancel</button>
      </div>
    </form>

    <p v-if="!adding && !schedules.length && deviceId && !error" class="hint">
      {{ loading ? "Reading schedules…" : "No schedules yet. Press ＋ to add one." }}
    </p>

    <ul v-if="schedules.length" class="schedule-list">
      <li v-for="s in schedules" :key="s.id" class="schedule" :class="{ off: !s.enabled }">
        <div class="head">
          <b>{{ s.name }}</b>
          <span class="tag">{{ trigger(s) }}</span>
          <span v-if="s.running" class="tag running">running</span>
          <span v-else-if="s.lastOutcome === 'failed'" class="tag bad" :title="s.lastError">last run failed</span>
          <span class="next">{{ s.enabled ? `next ${when(s.nextRunAt)}` : "paused" }}</span>
        </div>
        <code class="cwd">{{ s.cwd }}</code>
        <p v-if="s.lastError" class="message-error">{{ s.lastError.slice(0, 160) }}</p>
        <div class="row">
          <button class="small" :disabled="busy === s.id" @click="runNow(s)"><Play :size="12" />run now</button>
          <button class="small" :disabled="busy === s.id" @click="toggle(s)">
            <Power :size="12" />{{ s.enabled ? "pause" : "resume" }}
          </button>
          <button class="small danger" :disabled="busy === s.id" @click="remove(s)"><Trash2 :size="12" />remove</button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.schedules-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 2px 12px;
  font-size: 16px;
}
.schedule-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.schedule {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
}
.schedule.off {
  opacity: 0.6;
}
.schedule .head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.schedule .next {
  margin-left: auto;
  font-size: 13px;
  opacity: 0.7;
}
.schedule .tag.running {
  border-color: var(--accent);
  color: var(--accent);
}
.schedule .tag.bad {
  border-color: var(--warn, #e5a50a);
}
.schedule .cwd {
  font-size: 13px;
  opacity: 0.7;
  word-break: break-all;
}
.schedule .row,
.trigger-row {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.add-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
}
.add-form label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 13px;
  opacity: 0.85;
}
.add-form input,
.add-form textarea,
.add-form select {
  font: inherit;
  font-size: 15px;
  padding: 5px 8px;
  color: var(--fg);
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 8px;
}
.add-form .inline {
  flex-direction: row;
  align-items: center;
  gap: 5px;
  opacity: 1;
}
.add-form input.num {
  width: 72px;
}
.add-form .muted {
  font-size: 13px;
  opacity: 0.6;
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
