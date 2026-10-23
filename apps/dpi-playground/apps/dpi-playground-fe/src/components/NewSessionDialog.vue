<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Plus, X } from "lucide-vue-next";
import DirBrowser from "./DirBrowser.vue";
import { deviceClient, message } from "../client/hub";
import { network, notify, select } from "../client/store";

const props = defineProps<{ deviceId?: string }>();
const emit = defineEmits<{ close: [] }>();

const devices = computed(() => network.devices.value.filter((d) => d.status === "online"));
const deviceId = ref(
  devices.value.find((d) => d.id === props.deviceId)?.id ?? devices.value[0]?.id ?? "",
);
const device = computed(() => devices.value.find((d) => d.id === deviceId.value));
const models = computed(() => {
  const list = device.value?.info?.models ?? [];
  if (list.length) return list;
  // No usable catalog (device has no provider key): still offer the device's
  // default so a session can be created — chatting needs the key, creating
  // must not. Caught live: the dropdown went empty and create always failed.
  const info = device.value?.info;
  if (info?.defaultModel && info.provider)
    return [
      {
        id: info.defaultModel,
        provider: info.provider,
        name: `${info.defaultModel} (device default)`,
        tier: "—",
        icon: "lab.png",
        contextWindow: 0,
        reasoning: false,
        cost: { input: 0, output: 0 },
      },
    ];
  return [];
});
const catalogEmpty = computed(
  () => !models.value.length || (device.value?.info?.models?.length ?? 0) === 0,
);
/** The device lists its built-in catalog but chat needs the key (0.0.12+ devices). */
const keyless = computed(() => !!(device.value?.info as { providerKeyMissing?: boolean } | undefined)?.providerKeyMissing);
const key = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;
const draft = ref({ name: "", cwd: "", model: "" });
const pending = ref(false);
const error = ref("");

watch(
  device,
  (d) => {
    const list = models.value;
    const fallback =
      list.find((m) => m.id === d?.info?.defaultModel) ?? list[0];
    draft.value.model = fallback ? key(fallback) : "";
    draft.value.cwd = "";
  },
  { immediate: true },
);

async function create() {
  if (pending.value || !device.value) return;
  pending.value = true;
  error.value = "";
  try {
    const model = models.value.find((m) => key(m) === draft.value.model) ?? models.value[0];
    if (!model) throw Error("Choose a model");
    const created = await deviceClient(device.value.id).createSession({
      name: draft.value.name.trim() || "New session",
      cwd: draft.value.cwd.trim(),
      model: { provider: model.provider, modelId: model.id },
    });
    const root = created.agents.find((a) => a.kind === "root") ?? created.agents[0];
    select({ deviceId: device.value.id, sessionId: created.id, agentId: root?.id ?? 1 });
    notify(`Session created on ${device.value.id}.`);
    emit("close");
  } catch (e) {
    error.value = message(e);
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <form class="modal session-modal" @submit.prevent="create">
      <header>
        <div>
          <span class="eyebrow">A PERSISTENT WORKSPACE</span>
          <h2>New session</h2>
        </div>
        <button
          type="button"
          class="icon-button"
          aria-label="Close new session"
          @click="emit('close')"
        >
          <X :size="18" />
        </button>
      </header>
      <p v-if="!devices.length" class="message-error">
        No device is online. Start one with just backend run or just net up &lt;id&gt;, then try
        again.
      </p>
      <template v-else>
        <label
          >Device<select v-model="deviceId" aria-label="Device">
            <option v-for="d in devices" :key="d.id" :value="d.id">
              {{ d.name }}{{ d.info?.hostname && d.info.hostname !== d.name ? ` · ${d.info.hostname}` : "" }}
            </option>
          </select></label
        >
        <label
          >Session name<input
            v-model="draft.name"
            autofocus
            placeholder="My durable agent"
            maxlength="100"
        /></label>
        <div class="field">
          <span>Working directory on {{ devices.find((d) => d.id === deviceId)?.name ?? deviceId }}</span>
          <DirBrowser v-model="draft.cwd" :device-id="deviceId" />
        </div>
        <label
          >Model<span
            v-if="catalogEmpty || keyless"
            class="hint"
            title="The device has no provider key — it lists its built-in catalog, and chat needs OPENROUTER_API_KEY set in the device's env file"
            >no API key on device — chat needs one</span
          ><select v-model="draft.model" aria-label="New session model">
            <option v-for="m in models" :key="key(m)" :value="key(m)">
              {{ m.tier }} / {{ m.name }}
            </option>
          </select></label
        >
      </template>
      <p v-if="error" class="message-error" role="alert">{{ error }}</p>
      <footer>
        <button type="button" class="secondary" @click="emit('close')">Cancel</button
        ><button class="primary" :disabled="pending || !draft.model || !draft.cwd || !device">
          <Plus :size="18" />{{ pending ? "Creating…" : "Create session" }}
        </button>
      </footer>
    </form>
  </div>
</template>
