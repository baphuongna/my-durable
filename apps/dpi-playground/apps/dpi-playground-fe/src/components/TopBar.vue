<script setup lang="ts">
// TopBar: the top strip, bound to the real client store — device/session/agent counts,
// stream state, and the panel/new-session actions. Presentation only; all data comes
// from client/store.ts.
import { computed, ref } from "vue";
import { CircleHelp, Network, PanelLeft, PanelRight, Plus, Bell } from "lucide-vue-next";
import {
  attempt,
  markNotificationsRead,
  network,
  notify,
  notifications,
  online,
  select,
  selected,
  sessionAgents,
  sessionHandle,
  streamState,
  ui,
  usage,
  showInspector,
  hideInspector,
} from "../client/store";

const bellOpen = ref(false);
const unread = computed(() => notifications.filter((n) => !n.read).length);
const openBell = () => {
  bellOpen.value = !bellOpen.value;
  if (bellOpen.value) markNotificationsRead();
};
const when = (at: number) => {
  const sec = Math.round((Date.now() - at) / 1000);
  return sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m` : `${Math.floor(sec / 3600)}h`;
};
const sessionTokens = computed(
  () => usage.value.input + usage.value.output + usage.value.cacheRead + usage.value.cacheWrite,
);
const sessionCost = computed(
  () =>
    (usage.value.inputCost ?? 0) +
    (usage.value.outputCost ?? 0) +
    (usage.value.cacheReadCost ?? 0) +
    (usage.value.cacheWriteCost ?? 0),
);

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
  // The device API requires a name (B6); without a prompt, number the new agent.
  const created = await attempt(() => handle.createAgent({ name: `Agent ${sessionAgents.value.length + 1}` }));
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
      <span
        class="network-summary"
        :title="`${onlineCount} of ${network.devices.value.length} devices online`"
        ><Network :size="16" />{{ onlineCount }} of {{ network.devices.value.length }} online</span
      ><span class="sep" aria-hidden="true">·</span
      ><span
        ><b>{{ sessionCount }}</b> sessions</span
      ><span class="sep" aria-hidden="true">·</span
      ><span
        ><b>{{ agentCount }}</b> agents</span
      >
    </div>
    <div class="top-actions">
      <span class="chip connection" :class="{ accent: streamState === 'live' }"
        ><span class="dot" :class="{ off: streamState !== 'live' }" aria-hidden="true" />{{
          streamState === "live" ? "Connected" : "Reconnecting"
        }}</span
      ><span v-if="sessionTokens" class="usage-chip" title="This session's token usage and cost">{{
        sessionTokens.toLocaleString()
      }}
      tok · ${{ sessionCost.toFixed(3) }}</span
      ><button
        class="icon-button"
        :aria-label="`Notifications${unread ? ` (${unread} unread)` : ''}`"
        :title="`Notification center${unread ? ` — ${unread} unread` : ''}`"
        @click="openBell"
      >
        <Bell :size="18" /><i v-if="unread" class="bell-dot">{{ unread > 9 ? "9+" : unread }}</i>
      </button>
      <!-- Teleported: the mobile topbar scrolls horizontally, and a scroll
           container always clips absolutely-positioned children — the panel
           lives on <body> instead, pinned under the bar. -->
      <Teleport to="body">
        <div v-if="bellOpen" class="notif-panel" @click.stop>
          <header>
            <b>Notifications</b>
            <button class="icon-button" aria-label="Close notifications" @click="bellOpen = false">✕</button>
          </header>
          <p v-if="!notifications.length" class="hint">Nothing yet — events land here as they happen.</p>
          <ul>
            <li v-for="n in notifications" :key="n.id" :class="{ unread: !n.read }">
              <span class="when">{{ when(n.at) }}</span><span>{{ n.text }}</span>
            </li>
          </ul>
        </div>
      </Teleport>
      <button
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

<style scoped>
.usage-chip { font-size: 0.75rem; opacity: 0.8; margin-right: 0.375rem; white-space: nowrap; }
.bell-host, .icon-button:has(.bell-dot) { position: relative; }
.bell-dot {
  position: absolute; top: -0.25rem; right: -0.25rem; font-size: 0.5625rem; font-style: normal;
  background: var(--warn, #e5a50a); color: #000; border-radius: 0.5rem; padding: 0 0.25rem;
}
.notif-panel {
  position: fixed; top: calc(var(--topbar-h, 4.0625rem) + 0.3125rem); right: 0.375rem; z-index: 80; width: 20rem; max-height: 21.25rem;
  overflow: auto; background: var(--bg-2, #221a1c); border: 1px solid var(--line); border-radius: 0.625rem;
  padding: 0.625rem 0.75rem; box-shadow: 0 0.625rem 1.875rem rgb(0 0 0 / 50%);
}
.notif-panel header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.375rem; }
.notif-panel ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.375rem; }
.notif-panel li { display: flex; gap: 0.5rem; font-size: 0.875rem; opacity: 0.85; }
.notif-panel li.unread { opacity: 1; font-weight: 550; }
.notif-panel .when { opacity: 0.6; font-size: 0.75rem; min-width: 3ch; text-align: right; }
</style>
