<script setup lang="ts">
// Outbound notifications (Wave 2): webhook / ntfy sinks owned by the DEVICE.
// This panel only edits the records and can fire a test event; delivery happens
// on the device, so it works with no browser open.
import { computed, ref, watch } from "vue";
import { Bell, Plus, RefreshCw, Send, Trash2, Power } from "lucide-vue-next";
import type { NotifyDelivery, NotifySinkView } from "@sdk/api";
import { deviceClient, message } from "../client/hub";
import { isStaleDeviceError, staleDeviceHint } from "../client/stale";
import { notify, selected, ui } from "../client/store";

const sinks = ref<NotifySinkView[]>([]);
const busy = ref("");
const error = ref("");
const loading = ref(false);
const results = ref<NotifyDelivery[]>([]);
const deviceId = computed(() => selected.value?.deviceId);
const client = () => deviceClient(deviceId.value ?? "");

const adding = ref(false);
const draft = ref({ kind: "webhook" as "webhook" | "ntfy", url: "", label: "", events: "" });

async function load() {
  if (!deviceId.value) return void (sinks.value = []);
  loading.value = true;
  error.value = "";
  try {
    sinks.value = (await client().notifySinks()).sinks;
  } catch (e) {
    error.value = isStaleDeviceError(e)
      ? staleDeviceHint(deviceId.value, "notifications")
      : message(e).slice(0, 220);
  } finally {
    loading.value = false;
  }
}
watch(deviceId, load, { immediate: true });

const when = (at?: number) => {
  if (!at) return "never";
  const mins = Math.round((Date.now() - at) / 60_000);
  return mins < 1 ? "just now" : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
};

async function create() {
  const d = draft.value;
  if (!d.url.trim()) return;
  busy.value = "new";
  try {
    await client().createNotifySink({
      kind: d.kind,
      url: d.url.trim(),
      ...(d.label.trim() ? { label: d.label.trim() } : {}),
      ...(d.events.trim()
        ? { events: d.events.split(",").map((e) => e.trim()).filter(Boolean) }
        : {}),
    });
    adding.value = false;
    draft.value = { kind: "webhook", url: "", label: "", events: "" };
    await load();
    notify("Sink added on the device.");
  } catch (e) {
    notify(message(e).slice(0, 160));
  } finally {
    busy.value = "";
  }
}

async function toggle(sink: NotifySinkView) {
  busy.value = sink.id;
  try {
    await client().updateNotifySink(sink.id, { enabled: !sink.enabled });
    await load();
  } catch (e) {
    notify(message(e).slice(0, 140));
  } finally {
    busy.value = "";
  }
}

function remove(sink: NotifySinkView) {
  ui.dialog = {
    kind: "prompt",
    title: `Remove this ${sink.kind} sink?`,
    hint: "The device stops notifying this target. Nothing else changes.",
    submit: "Remove sink",
    danger: true,
    run: async () => {
      await client().removeNotifySink(sink.id);
      await load();
    },
  };
}

async function test() {
  busy.value = "test";
  results.value = [];
  try {
    results.value = (await client().testNotifySinks()).results;
    const failed = results.value.filter((r) => r.status === "failed").length;
    notify(
      results.value.length
        ? `Test: ${results.value.length - failed} sent${failed ? `, ${failed} failed` : ""}.`
        : "No enabled sinks matched — nothing was sent.",
    );
  } catch (e) {
    notify(message(e).slice(0, 160));
  } finally {
    busy.value = "";
  }
}
</script>

<template>
  <section class="notify-panel" aria-label="Notification sinks">
    <header class="panel-heading">
      <span><Bell :size="16" />NOTIFY</span>
      <button class="icon-button" :disabled="loading || !deviceId" aria-label="Refresh sinks" title="Refresh sinks" @click="load">
        <RefreshCw :size="15" :class="{ spin: loading }" />
      </button>
      <button
        class="icon-button"
        :disabled="!deviceId || !sinks.length || busy === 'test'"
        aria-label="Send a test notification"
        title="Send a test event through every enabled sink"
        @click="test"
      >
        <Send :size="15" />
      </button>
      <button class="icon-button" :disabled="!deviceId" aria-label="Add a sink" title="Add a sink" @click="adding = !adding">
        <Plus :size="15" />
      </button>
    </header>

    <p class="hint">Delivered by the device — no browser needs to be open.</p>
    <p v-if="!deviceId" class="hint">Select a session to see its device.</p>
    <p v-else-if="error" class="message-error">{{ error }}</p>

    <form v-if="adding" class="add-form" @submit.prevent="create">
      <label
        >Kind
        <select v-model="draft.kind">
          <option value="webhook">webhook (JSON POST)</option>
          <option value="ntfy">ntfy (topic)</option>
        </select>
      </label>
      <label
        >URL
        <input v-model="draft.url" :placeholder="draft.kind === 'ntfy' ? 'https://ntfy.sh/my-topic' : 'https://example.com/hook'" required />
      </label>
      <label>Label<input v-model="draft.label" placeholder="phone" /></label>
      <label
        >Events
        <input v-model="draft.events" placeholder="empty = all — e.g. session.failed,schedule.*" />
      </label>
      <div class="row">
        <button class="primary small" type="submit" :disabled="busy === 'new'">
          {{ busy === "new" ? "adding…" : "Add sink" }}
        </button>
        <button class="small" type="button" @click="adding = false">Cancel</button>
      </div>
      <p class="hint">LAN targets (192.168.x, localhost) need <code>DPI_NOTIFY_ALLOW_PRIVATE=1</code> on the device.</p>
    </form>

    <p v-if="!adding && !sinks.length && deviceId && !error" class="hint">
      No sinks yet. Press ＋ to add a webhook or an ntfy topic.
    </p>

    <ul v-if="sinks.length" class="sink-list">
      <li v-for="s in sinks" :key="s.id" class="sink" :class="{ off: !s.enabled }">
        <div class="head">
          <span class="tag">{{ s.kind }}</span>
          <b>{{ s.label || s.url }}</b>
          <em class="next">{{ s.lastError ? `last failed` : `sent ${when(s.lastDeliveryAt)}` }}</em>
        </div>
        <code class="url">{{ s.url }}</code>
        <p v-if="s.events?.length" class="hint">events: {{ s.events.join(", ") }}</p>
        <p v-if="s.lastError" class="message-error">{{ s.lastError.slice(0, 160) }}</p>
        <div class="row">
          <button class="small" :disabled="busy === s.id" @click="toggle(s)">
            <Power :size="12" />{{ s.enabled ? "disable" : "enable" }}
          </button>
          <button class="small danger" :disabled="busy === s.id" @click="remove(s)"><Trash2 :size="12" />remove</button>
        </div>
      </li>
    </ul>

    <ul v-if="results.length" class="results" aria-label="Test results">
      <li v-for="r in results" :key="r.id" :class="r.status">
        <span class="tag">{{ r.status }}</span> {{ r.kind }} {{ r.id.slice(0, 8) }}
        <em v-if="r.detail">{{ r.detail }}</em>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.notify-panel {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  padding: 0.25rem 0.125rem 0.75rem;
  font-size: 1rem;
}
.sink-list,
.results {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.sink {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--line);
  border-radius: 0.625rem;
}
.sink.off {
  opacity: 0.6;
}
.sink .head {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  flex-wrap: wrap;
}
.sink .next {
  margin-left: auto;
  font-style: normal;
  font-size: 0.8125rem;
  opacity: 0.7;
}
.sink .url,
.url {
  font-size: 0.8125rem;
  opacity: 0.7;
  word-break: break-all;
}
.sink .row,
.add-form .row {
  display: flex;
  gap: 0.375rem;
  flex-wrap: wrap;
}
.results li {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.9375rem;
}
.results li.failed {
  color: var(--warn, #e5a50a);
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
  gap: 0.1875rem;
  font-size: 0.8125rem;
  opacity: 0.85;
}
.add-form input,
.add-form select {
  font: inherit;
  font-size: 0.9375rem;
  padding: 0.3125rem 0.5rem;
  color: var(--fg);
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 0.5rem;
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
