<script setup lang="ts">
// TopBar: the top strip, bound to the real client store — device/session/agent counts,
// stream state, and the panel/new-session actions. Presentation only; all data comes
// from client/store.ts.
import { computed, ref } from "vue";
import { CircleHelp, Network, PanelLeft, PanelRight, Plus } from "lucide-vue-next";
import {
  attempt,
  network,
  notify,
  online,
  select,
  selected,
  sessionHandle,
  streamState,
  ui,
  showInspector,
  hideInspector,
} from "../client/store";

const onlineCount = computed(
  () => network.devices.value.filter((d) => d.status === "online").length,
);
const sessionCount = computed(() =>
  network.devices.value.reduce((n, d) => n + (d.tree?.sessions.length ?? 0), 0),
);
const agentCount = computed(() =>
  network.devices.value.reduce(
    (n, d) => n + (d.tree?.sessions.reduce((m, s) => m + s.agents.length, 0) ?? 0),
    0,
  ),
);
const creatingAgent = ref(false);

async function newAgent() {
  const handle = sessionHandle.value;
  const t = selected.value;
  if (!handle || !t || creatingAgent.value) return;
  creatingAgent.value = true;
  const created = await attempt(() => handle.createAgent({}));
  creatingAgent.value = false;
  if (created) {
    select({ ...t, agentId: created.id });
    notify("New agent. Same session, same shared App State.");
  }
}

const emit = defineEmits<{ newSession: [] }>();
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <button
        class="icon-button tree-toggle"
        aria-label="Toggle network"
        title="Network"
        @click="ui.drawer = !ui.drawer"
      >
        <PanelLeft :size="19" /></button
      ><img class="brandmark" src="/icons/durable-pi.svg" alt="Durable Pi" /><strong
        >Durable Pi</strong
      >
    </div>
    <span class="topbar-sep" aria-hidden="true"></span>
    <div class="daemon" data-testid="topbar-stats">
      <span class="dot" :class="{ off: !onlineCount }" aria-hidden="true"></span>
      <span class="network-summary" :title="`${onlineCount} of ${network.devices.value.length} devices online`"
        ><Network :size="16" />{{ onlineCount }} of {{ network.devices.value.length }} online</span
      ><span class="sep" aria-hidden="true">·</span
      ><span><b>{{ sessionCount }}</b> sessions</span><span class="sep" aria-hidden="true">·</span
      ><span><b>{{ agentCount }}</b> agents</span>
    </div>
    <div class="top-actions">
      <span class="chip connection" :class="{ accent: streamState === 'live' }"
        ><span class="dot" :class="{ off: streamState !== 'live' }" aria-hidden="true" />{{
          streamState === "live" ? "Connected" : "Reconnecting"
        }}</span
      ><button
        class="icon-button"
        title="How this works"
        aria-label="How this works"
        @click="ui.dialog = { kind: 'help' }"
      >
        <CircleHelp :size="19" /></button
      ><button
        class="secondary small new-agent-button"
        :disabled="!selected || !online || creatingAgent"
        title="Start a fresh agent in this session"
        @click="newAgent"
      >
        <Plus :size="18" />New agent
      </button>
      <button class="primary small" @click="emit('newSession')">
        <Plus :size="18" />New session
      </button>
      <button
        class="icon-button inspector-toggle"
        aria-label="Toggle inspector"
        title="Inspector"
        :disabled="!selected || !online"
        @click="ui.inspectorOverlay ? hideInspector() : showInspector()"
      >
        <PanelRight :size="19" />
      </button>
    </div>
  </header>
</template>
