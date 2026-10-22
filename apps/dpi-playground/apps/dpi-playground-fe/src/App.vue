<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { Database, GitFork, Activity, Info, Plus, X } from "lucide-vue-next";
import TopBar from "./components/TopBar.vue";
import MobileNav from "./components/MobileNav.vue";
import NetworkSidebar from "./components/NetworkSidebar.vue";
import AgentView from "./components/AgentView.vue";
import Inspector from "./components/Inspector.vue";
import OfflinePanel from "./components/OfflinePanel.vue";
import NewSessionDialog from "./components/NewSessionDialog.vue";
import PairDeviceWizard from "./components/PairDeviceWizard.vue";
import DeviceCredentialsDialog from "./components/DeviceCredentialsDialog.vue";
import PromptDialog from "./components/PromptDialog.vue";
import ModelPicker from "./components/ModelPicker.vue";
import HelpDialog from "./components/HelpDialog.vue";
import LoginCard from "./components/LoginCard.vue";
import Toast from "./components/Toast.vue";
import {
  boot,
  busy,
  device,
  interrupt,
  network,
  online,
  selected,
  stream,
  treeWidth,
  ui,
  layout,
  showInspector,
  hideInspector,
  panelHotkey,
  toggleTree,
  toggleInspector,
} from "./client/store";
import { auth } from "./client/auth";

const onlineCount = () => network.devices.value.filter((d) => d.status === "online").length;
const pairWizard = ref<{ close(): Promise<void> }>();

function openNewSession() {
  ui.dialog = { kind: "new-session", deviceId: selected.value?.deviceId };
}

function keydown(e: KeyboardEvent) {
  const panel = ui.dialog ? undefined : panelHotkey(e);
  if (panel) {
    e.preventDefault();
    return panel === "tree" ? toggleTree() : toggleInspector();
  }
  if (e.key !== "Escape") return;
  if (ui.dialog) {
    if (ui.dialog.kind === "pair") void pairWizard.value?.close();
    else ui.dialog = undefined;
    return;
  }
  if (!e.repeat && !e.isComposing && busy.value) {
    e.preventDefault();
    void interrupt();
  }
  ui.drawer = false;
  ui.inspectorOverlay = false;
}

// Drag the tree's right edge; the width persists in the hub's ui_state.
function resize(e: PointerEvent) {
  const start = e.clientX;
  const width = treeWidth.value;
  const move = (m: PointerEvent) =>
    (treeWidth.value = Math.max(220, Math.min(560, width + m.clientX - start)));
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

onMounted(() => {
  document.addEventListener("keydown", keydown);
  void boot();
});
onBeforeUnmount(() => {
  stream.stop();
  document.removeEventListener("keydown", keydown);
});
</script>

<template>
  <div class="shell" data-testid="app-shell">
    <TopBar @new-session="openNewSession" />
    <div v-if="ui.error" class="error-banner" role="alert">
      <Info :size="18" /><span>{{ ui.error }}</span
      ><button class="icon-button" aria-label="Dismiss error" @click="ui.error = ''">×</button>
    </div>
    <main class="net-workspace" :style="{ '--tree-w': `${treeWidth}px` }">
      <NetworkSidebar />
      <div
        v-if="layout.tree"
        class="tree-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize network tree"
        @pointerdown.prevent="resize"
      />
      <div v-if="ui.drawer" class="tree-backdrop" @click="ui.drawer = false" />
      <template v-if="selected && device && online">
        <Inspector />
        <div v-if="ui.inspectorOverlay" class="inspector-backdrop" @click="hideInspector()" />
        <AgentView :key="`${selected.deviceId}/${selected.sessionId}`" />
      </template>
      <OfflinePanel v-else-if="selected && device" :device="device" />
      <section v-else class="welcome" data-testid="welcome-empty">
        <img class="welcome-symbol" src="/icons/durable-pi.svg" alt="Durable Pi" />
        <span class="eyebrow">THE DURABLE AGENT NETWORK</span>
        <h1>Close the tab.<br />The work continues.</h1>
        <p>Agents run on your devices. This page is only a window into them.</p>
        <button class="primary" :disabled="!onlineCount()" @click="openNewSession">
          <Plus :size="18" />{{
            network.devices.value.length ? "Create a session" : "Add a device to dpi-network.yaml"
          }}
        </button>
        <div class="welcome-features">
          <span><Database :size="18" />SQLite on each device</span
          ><span><GitFork :size="18" />Branch any agent</span
          ><span><Activity :size="18" />Watch from anywhere</span>
        </div>
      </section>
    </main>

    <MobileNav />
    <PairDeviceWizard
      ref="pairWizard"
      v-if="ui.dialog?.kind === 'pair'"
      :handoff="ui.dialog.handoff"
      @close="ui.dialog = undefined"
    />
    <DeviceCredentialsDialog
      v-if="ui.dialog?.kind === 'credentials'"
      :device-id="ui.dialog.deviceId"
      @close="ui.dialog = undefined"
    />
    <NewSessionDialog
      v-if="ui.dialog?.kind === 'new-session'"
      :device-id="ui.dialog.deviceId"
      @close="ui.dialog = undefined"
    />
    <PromptDialog
      v-else-if="ui.dialog?.kind === 'prompt'"
      :dialog="ui.dialog"
      @close="ui.dialog = undefined"
    />
    <ModelPicker v-else-if="ui.dialog?.kind === 'models'" @close="ui.dialog = undefined" />
    <div
      v-else-if="ui.dialog?.kind === 'path'"
      class="modal-backdrop"
      @click.self="ui.dialog = undefined"
    >
      <section
        class="modal path-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="path-title"
      >
        <header>
          <h2 id="path-title">Working directory</h2>
          <button
            class="icon-button"
            aria-label="Close working directory"
            @click="ui.dialog = undefined"
          >
            <X :size="18" />
          </button>
        </header>
        <code class="full-directory">{{ ui.dialog.path }}</code>
        <footer><button class="secondary" @click="ui.dialog = undefined">Close</button></footer>
      </section>
    </div>
    <HelpDialog v-else-if="ui.dialog?.kind === 'help'" />
    <LoginCard v-if="auth.needed" />
    <Toast />
  </div>
</template>
