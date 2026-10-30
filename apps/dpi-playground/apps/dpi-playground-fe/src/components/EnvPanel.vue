<script setup lang="ts">
// Env-var management (Wave 2): the DEVICE's own env file — the one loadConfig
// reads at boot. orca edits a host's default agent environment the same way.
//
// Guardrails from the backend, mirrored here: managed keys and process-only
// vars are read-only, secret values arrive masked and stay masked. Every
// change needs a daemon restart to apply — the panel says so, it does not
// pretend otherwise.
import { computed, ref, watch } from "vue";
import { RefreshCw, Plus, Pencil, Trash2, FileCog, KeyRound } from "lucide-vue-next";
import type { EnvFileView, EnvVarView, PiAuthView } from "@sdk/api";
import { deviceClient, message } from "../client/hub";
import { isStaleDeviceError, staleDeviceHint } from "../client/stale";
import { notify, selected, ui } from "../client/store";

const view = ref<EnvFileView | null>(null);
const loading = ref(false);
const error = ref("");
const busy = ref("");
const deviceId = computed(() => selected.value?.deviceId);
const client = () => deviceClient(deviceId.value ?? "");

const adding = ref(false);
const draft = ref({ key: "", value: "" });

async function load() {
  if (!deviceId.value) return void (view.value = null);
  loading.value = true;
  error.value = "";
  try {
    view.value = await client().envView();
  } catch (e) {
    error.value = isStaleDeviceError(e)
      ? staleDeviceHint(deviceId.value, "editing env vars")
      : message(e).slice(0, 220);
  } finally {
    loading.value = false;
  }
  void loadKeys();
}
watch(deviceId, load, { immediate: true });

// ---------------------------------------------------------------- pi keys
// Gate #2: WRITE-ONLY provider keys in pi's own auth.json. Values are never
// shown — the list carries masked tails only — and the input is a password
// field that is cleared the moment a save lands.
const keys = ref<PiAuthView | null>(null);
const keysError = ref("");
const addingKey = ref(false);
const keyDraft = ref({ providerId: "", key: "" });

async function loadKeys() {
  if (!deviceId.value) return void (keys.value = null);
  try {
    keys.value = await client().piAuth();
    keysError.value = "";
  } catch (e) {
    const text = message(e);
    keysError.value = isStaleDeviceError(e)
      ? staleDeviceHint(deviceId.value, "managing pi keys")
      : message(e).slice(0, 220);
  }
}

async function addKey() {
  const providerId = keyDraft.value.providerId.trim();
  if (!providerId || !keyDraft.value.key) return;
  busy.value = "pi-key";
  try {
    const r = await client().setPiApiKey(providerId, keyDraft.value.key);
    keyDraft.value = { providerId: "", key: "" };
    addingKey.value = false;
    await loadKeys();
    notify(`${providerId} saved (now ${r.masked}) — restart the device to apply it.`);
  } catch (e) {
    notify(message(e).slice(0, 160));
  } finally {
    busy.value = "";
  }
}

function removeKey(providerId: string) {
  ui.dialog = {
    kind: "prompt",
    title: `Remove the ${providerId} key?`,
    hint: "The entry is deleted from pi's auth.json. pi's own logins are never touched. Restart the device to apply.",
    submit: "Remove",
    danger: true,
    run: async () => {
      await client().removePiApiKey(providerId);
      await loadKeys();
      notify(`${providerId} removed — restart the device to apply it.`);
    },
  };
}

const editable = (v: EnvVarView) => v.source === "file" && !v.managed;

async function add() {
  const key = draft.value.key.trim().toUpperCase();
  if (!key || !draft.value.value) return;
  busy.value = "new";
  try {
    await client().setEnvVar(key, draft.value.value);
    adding.value = false;
    draft.value = { key: "", value: "" };
    await load();
    notify(`${key} saved — restart the device to apply it.`);
  } catch (e) {
    notify(message(e).slice(0, 160));
  } finally {
    busy.value = "";
  }
}

function edit(v: EnvVarView) {
  ui.dialog = {
    kind: "prompt",
    title: `Set ${v.key}`,
    label: "Value",
    hint: v.secret
      ? "The current value is secret and stays masked. Type a new value to replace it."
      : "Single line. Applies after the next device restart.",
    value: v.secret ? "" : v.masked,
    placeholder: v.secret ? v.masked : "",
    submit: "Save value",
    run: async (value) => {
      if (!value) throw Error("A value is required");
      await client().setEnvVar(v.key, value);
      await load();
      notify(`${v.key} saved — restart the device to apply it.`);
    },
  };
}

function remove(v: EnvVarView) {
  ui.dialog = {
    kind: "prompt",
    title: `Remove ${v.key} from the env file?`,
    hint: "The line is deleted from the file. Restart the device to apply it.",
    submit: "Remove",
    danger: true,
    run: async () => {
      await client().removeEnvVar(v.key);
      await load();
      notify(`${v.key} removed — restart the device to apply it.`);
    },
  };
}
</script>

<template>
  <section class="env-panel" aria-label="Device environment">
    <header class="panel-heading">
      <span><FileCog :size="16" />ENV</span>
      <button class="icon-button" :disabled="loading || !deviceId" aria-label="Refresh env" title="Refresh" @click="load">
        <RefreshCw :size="15" :class="{ spin: loading }" />
      </button>
      <button
        class="icon-button"
        :disabled="!deviceId || !!error"
        aria-label="Add an env var"
        title="Add an env var to the device's env file"
        @click="adding = !adding"
      >
        <Plus :size="15" />
      </button>
    </header>

    <p class="hint">
      The device's env file — loaded once at boot. Keys here reach the daemon and its sessions.
    </p>
    <p v-if="!deviceId" class="hint">Select a session to see its device.</p>
    <p v-else-if="error" class="message-error">{{ error }}</p>
    <p v-else-if="view?.restartRequired" class="message-restart">
      Changed since boot — restart the device (<code>dpi device stop &amp;&amp; dpi device start</code>) to apply.
    </p>

    <form v-if="adding" class="add-form" @submit.prevent="add">
      <label
        >Key (UPPER_SNAKE_CASE)<input v-model="draft.key" placeholder="DPI_NOTIFY_ALLOW_PRIVATE" required />
      </label>
      <label>Value<input v-model="draft.value" placeholder="1" required /></label>
      <div class="row">
        <button class="primary small" type="submit" :disabled="busy === 'new'">
          {{ busy === "new" ? "saving…" : "Save to env file" }}
        </button>
        <button class="small" type="button" @click="adding = false">Cancel</button>
      </div>
      <p class="hint">
        Managed keys (DPI_TOKEN, DPI_PORT, start dirs…) have their own settings and are refused here.
      </p>
    </form>

    <p v-if="!adding && view && !view.vars.length && !error" class="hint">
      No vars in the env file yet.
    </p>

    <ul v-if="view?.vars.length" class="var-list">
      <li v-for="v in view.vars" :key="v.key" class="var" :class="{ ro: !editable(v) }">
        <div class="head">
          <code class="key">{{ v.key }}</code>
          <span class="tag">{{ v.source === "process" ? "process" : "file" }}</span>
          <span v-if="v.managed" class="tag" title="Has its own setting; edit that instead">managed</span>
          <span class="spacer" />
          <button
            v-if="editable(v)"
            class="icon-button"
            :aria-label="`Edit ${v.key}`"
            :title="v.secret ? 'Replace the value' : 'Edit the value'"
            @click="edit(v)"
          >
            <Pencil :size="13" />
          </button>
          <button
            v-if="editable(v)"
            class="icon-button"
            :aria-label="`Remove ${v.key}`"
            title="Remove from the env file"
            @click="remove(v)"
          >
            <Trash2 :size="13" />
          </button>
        </div>
        <code class="value" :title="v.secret ? 'secret — masked' : v.masked">{{ v.masked }}</code>
      </li>
    </ul>

    <p v-if="view" class="hint path">{{ view.envFile }}</p>

    <header class="panel-heading keys-heading">
      <span><KeyRound :size="16" />PI KEYS</span>
      <button
        class="icon-button"
        :disabled="loading || !deviceId"
        aria-label="Refresh pi keys"
        title="Refresh"
        @click="loadKeys"
      >
        <RefreshCw :size="15" />
      </button>
      <button
        class="icon-button"
        :disabled="!deviceId || !!keysError"
        aria-label="Add a pi provider key"
        title="Add a provider key to pi's auth.json"
        @click="addingKey = !addingKey"
      >
        <Plus :size="15" />
      </button>
    </header>

    <p class="hint">
      Provider keys in pi's own <code>auth.json</code> — write-only: values are never shown, pi's interactive
      logins (oauth) are never touched.
    </p>
    <p v-if="keysError" class="message-error">{{ keysError }}</p>

    <form v-if="addingKey" class="add-form" @submit.prevent="addKey">
      <label
        >Provider id<input v-model="keyDraft.providerId" placeholder="zai" required />
      </label>
      <label
        >Key<input
          v-model="keyDraft.key"
          type="password"
          autocomplete="off"
          placeholder="paste the api key"
          required
        />
      </label>
      <div class="row">
        <button class="primary small" type="submit" :disabled="busy === 'pi-key'">
          {{ busy === 'pi-key' ? "saving…" : "Save to auth.json" }}
        </button>
        <button class="small" type="button" @click="addingKey = false">Cancel</button>
      </div>
      <p class="hint">Applies after the next device restart. Existing keys for other providers stay as they are.</p>
    </form>

    <p v-if="!addingKey && keys && !keys.entries.length && !keysError" class="hint">
      No provider keys found.
    </p>

    <ul v-if="keys?.entries.length" class="var-list">
      <li v-for="k in keys.entries" :key="k.providerId" class="var">
        <div class="head">
          <code class="key">{{ k.providerId }}</code>
          <span class="tag">{{ k.source }}</span>
          <span v-if="k.type !== 'api_key'" class="tag" title="Set by pi /login — read-only here">{{ k.type }}</span>
          <span class="spacer" />
          <button
            v-if="k.type === 'api_key'"
            class="icon-button"
            :aria-label="`Remove ${k.providerId} key`"
            title="Remove from auth.json"
            @click="removeKey(k.providerId)"
          >
            <Trash2 :size="13" />
          </button>
        </div>
        <code class="value" title="write-only — masked tail">{{ k.masked }}</code>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.env-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 2px 12px;
  font-size: 1rem;
}
.var-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.var {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
}
.var.ro {
  opacity: 0.72;
}
.var .head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.var .spacer {
  margin-left: auto;
}
.var .key {
  font-size: 0.9375rem;
}
.var .value {
  font-size: 0.8125rem;
  opacity: 0.75;
  word-break: break-all;
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
  font-size: 0.8125rem;
  opacity: 0.85;
}
.add-form input {
  font: inherit;
  font-size: 0.9375rem;
  padding: 5px 8px;
  color: var(--fg);
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 8px;
}
.add-form .row {
  display: flex;
  gap: 6px;
}
.message-restart {
  font-size: 0.875rem;
  color: var(--warn, #e5a50a);
}
.hint.path {
  font-size: 0.75rem;
  opacity: 0.55;
  word-break: break-all;
}
.keys-heading {
  margin-top: 14px;
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
