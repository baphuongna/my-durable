<script setup lang="ts">
// MobileNav: three-view phone nav (chat | details | network) mapped onto the existing
// store state instead of a new mview field — net = the tree drawer, details = the inspector
// overlay, chat = neither. The store keeps the overlays mutually exclusive.
import { MessageSquare, PanelRight, Waypoints } from "lucide-vue-next";
import {
  inspectorExpanded,
  tasks,
  ui,
  hideInspector,
  showInspector,
  toggleTree,
} from "../client/store";

function showChat() {
  ui.drawer = false;
  ui.inspectorOverlay = false;
}
</script>

<template>
  <nav class="mnav" aria-label="Panels">
    <button type="button" :class="{ 'is-on': !ui.drawer && !inspectorExpanded }" @click="showChat">
      <MessageSquare :size="18" />Chat
    </button>
    <button
      type="button"
      :class="{ 'is-on': inspectorExpanded }"
      @click="inspectorExpanded ? hideInspector() : showInspector()"
    >
      <PanelRight :size="18" />Details<span v-if="tasks.length" class="badge">{{
        tasks.length
      }}</span>
    </button>
    <button type="button" :class="{ 'is-on': ui.drawer }" @click="toggleTree()">
      <Waypoints :size="18" />Network
    </button>
  </nav>
</template>
