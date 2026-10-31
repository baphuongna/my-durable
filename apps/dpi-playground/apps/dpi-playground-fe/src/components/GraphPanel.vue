<script setup lang="ts">
// Task-graphs (Wave 3): a DAG of prompt-tasks the DEVICE runs sequentially —
// each task that has all dependencies ok starts a fresh session. This panel
// reads and starts; statuses stream in with the tree (no polling).
import { computed, ref, watch } from "vue";
import { RefreshCw, Play, Plus, Trash2, Waypoints } from "lucide-vue-next";
import type { GraphRecord, GraphRunRecord } from "@sdk/api";
import { deviceClient, message } from "../client/hub";
import { isStaleDeviceError, staleDeviceHint } from "../client/stale";
import { notify, selected, ui } from "../client/store";

interface Listed extends GraphRecord {
  lastRun?: GraphRunRecord;
}

const graphs = ref<Listed[]>([]);
const runs = ref<Record<string, GraphRunRecord>>({});
const loading = ref(false);
const error = ref("");
const busy = ref("");
const adding = ref(false);
const draft = ref("");
const deviceId = computed(() => selected.value?.deviceId);
const client = () => deviceClient(deviceId.value ?? "");

async function load() {
  if (!deviceId.value) return void (graphs.value = []);
  loading.value = true;
  error.value = "";
  try {
    const result = await client().graphs();
    graphs.value = result.graphs;
    runs.value = {};
  } catch (e) {
    error.value = isStaleDeviceError(e)
      ? staleDeviceHint(deviceId.value, "running task-graphs")
      : message(e).slice(0, 220);
  } finally {
    loading.value = false;
  }
}
watch(deviceId, load, { immediate: true });

const STATUS_CLASS: Record<string, string> = {
  ok: "ok",
  failed: "bad",
  running: "run",
  pending: "",
  skipped: "skip",
};

function statusOf(g: Listed, taskId: string): string {
  return runs.value[g.id]?.tasks[taskId]?.status ?? g.lastRun?.tasks[taskId]?.status ?? "pending";
}

async function openRuns(g: Listed) {
  try {
    const detail = await client().graph(g.id);
    runs.value = { ...runs.value, [g.id]: detail.runs[0] ?? g.lastRun! };
    if (!detail.runs.length) notify("This graph has not run yet.");
  } catch (e) {
    notify(message(e).slice(0, 140));
  }
}

async function run(g: Listed) {
  busy.value = g.id;
  try {
    const { run } = await client().runGraph(g.id);
    runs.value = { ...runs.value, [g.id]: run };
    notify(`Run started: ${Object.keys(run.tasks).length} tasks.`);
    void openRuns(g);
  } catch (e) {
    notify(message(e).slice(0, 140));
  } finally {
    busy.value = "";
  }
}

function remove(g: Listed) {
  ui.dialog = {
    kind: "prompt",
    title: `Remove the graph "${g.name}"?`,
    hint: "The registry record goes. Sessions the graph created are never touched.",
    submit: "Remove graph",
    danger: true,
    run: async () => {
      await client().removeGraph(g.id);
      await load();
    },
  };
}

/** The same JSON document `dpi graph add --file` takes. */
async function add() {
  const text = draft.value.trim();
  if (!text) return;
  busy.value = "new";
  try {
    const doc = JSON.parse(text) as { name?: string; cwd?: string; tasks?: unknown };
    const created = await client().createGraph({
      name: String(doc.name ?? ""),
      cwd: String(doc.cwd ?? ""),
      tasks: doc.tasks as never,
    });
    adding.value = false;
    draft.value = "";
    notify(`Graph "${created.name}" added (${created.tasks.length} tasks).`);
    await load();
  } catch (e) {
    notify(message(e).slice(0, 200));
  } finally {
    busy.value = "";
  }
}
</script>

<template>
  <section class="graph-panel" aria-label="Task graphs">
    <header class="panel-heading">
      <span><Waypoints :size="16" />DAG</span>
      <button class="icon-button" :disabled="loading || !deviceId" aria-label="Refresh graphs" title="Refresh" @click="load">
        <RefreshCw :size="15" :class="{ spin: loading }" />
      </button>
      <button
        class="icon-button"
        :disabled="!deviceId || !!error"
        aria-label="Add a graph"
        title="Add a graph from JSON"
        @click="adding = !adding"
      >
        <Plus :size="15" />
      </button>
    </header>

    <p class="hint">Tasks run on the device, in dependency order — one fresh session each.</p>
    <p v-if="!deviceId" class="hint">Select a session to see its device.</p>
    <p v-else-if="error" class="message-error">{{ error }}</p>
    <p v-else-if="!graphs.length && !adding" class="hint">
      No graphs yet. Press ＋ and paste a graph JSON ({ name, cwd, tasks: [{ id, name, prompt, dependsOn }] }).
    </p>

    <form v-if="adding" class="add-form" @submit.prevent="add">
      <label
        >Graph JSON
        <textarea
          v-model="draft"
          rows="8"
          placeholder='{ "name": "nightly", "cwd": "~/work/app", "tasks": [{ "id": "build", "name": "Build", "prompt": "run the build", "dependsOn": [] }, { "id": "report", "name": "Report", "prompt": "summarise", "dependsOn": ["build"] }] }'
        /> </label
      >
      <div class="row">
        <button class="primary small" type="submit" :disabled="busy === 'new'">
          {{ busy === "new" ? "adding…" : "Add graph" }}
        </button>
        <button class="small" type="button" @click="adding = false">Cancel</button>
      </div>
    </form>

    <div v-for="g in graphs" :key="g.id" class="graph">
      <div class="head">
        <b>{{ g.name }}</b>
        <code class="cwd" :title="g.cwd">{{ g.cwd.split("/").filter(Boolean).at(-1) || g.cwd }}</code>
        <span class="tag" :class="STATUS_CLASS[g.lastRun?.status ?? 'pending'] ?? ''">{{
          g.lastRun ? g.lastRun.status : "never run"
        }}</span>
        <span class="spacer" />
        <button class="icon-button" :aria-label="`Run ${g.name}`" title="Run now" :disabled="busy === g.id" @click="run(g)">
          <Play :size="14" />
        </button>
        <button class="icon-button" :aria-label="`Remove ${g.name}`" title="Remove graph" @click="remove(g)">
          <Trash2 :size="14" />
        </button>
      </div>
      <ul class="tasks">
        <li v-for="t in g.tasks" :key="t.id" :class="STATUS_CLASS[statusOf(g, t.id)]">
          <span class="dot" aria-hidden="true" />
          <span class="name" :title="t.prompt">{{ t.name }}</span>
          <code v-if="t.dependsOn.length" class="deps">← {{ t.dependsOn.join(", ") }}</code>
          <span class="tag">{{ statusOf(g, t.id) }}</span>
          <em v-if="runs[g.id]?.tasks[t.id]?.error" class="err">{{ runs[g.id].tasks[t.id]!.error!.slice(0, 120) }}</em>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.graph-panel {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  padding: 0.25rem 0.125rem 0.75rem;
  font-size: 1rem;
}
.graph {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--line);
  border-radius: 0.625rem;
}
.graph .head {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  flex-wrap: wrap;
}
.graph .spacer {
  margin-left: auto;
}
.graph .cwd {
  font-size: 0.8125rem;
  opacity: 0.7;
}
.tasks {
  display: flex;
  flex-direction: column;
  gap: 0.1875rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.tasks li {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  flex-wrap: wrap;
  font-size: 0.9375rem;
}
.tasks .dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--line);
  align-self: center;
}
.tasks li.ok .dot {
  background: var(--accent, #4f8cc9);
}
.tasks li.bad .dot {
  background: var(--warn, #e5a50a);
}
.tasks li.run .dot {
  animation: pulse 1.2s ease-in-out infinite;
}
.tasks .name {
  font-weight: 600;
}
.tasks .deps {
  font-size: 0.75rem;
  opacity: 0.6;
}
.tasks .err {
  font-style: normal;
  font-size: 0.8125rem;
  color: var(--warn, #e5a50a);
}
.tag.ok {
  color: var(--accent, #4f8cc9);
}
.tag.bad,
.tag.skip {
  opacity: 0.7;
}
.add-form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.625rem;
  border: 1px solid var(--line);
  border-radius: 0.625rem;
}
.add-form label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.8125rem;
  opacity: 0.85;
}
.add-form textarea {
  font: 0.78125rem/1.5 ui-monospace, monospace;
  padding: 0.375rem 0.5rem;
  color: var(--fg);
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  resize: vertical;
}
.add-form .row {
  display: flex;
  gap: 0.375rem;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes pulse {
  50% {
    opacity: 0.3;
  }
}
</style>
