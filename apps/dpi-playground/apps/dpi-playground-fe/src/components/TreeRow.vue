<script setup lang="ts">
import { computed } from "vue";
import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  FolderOpen,
  GitFork,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Archive,
  KeyRound,
} from "lucide-vue-next";
import DeviceIcon from "./DeviceIcon.vue";
import type { TreeNode } from "@sdk/models";
import { ago, hubVersion } from "../client/store";
import { branchOf } from "../client/session-git";

const props = defineProps<{
  node: TreeNode;
  depth: number;
  open: boolean;
  selected: boolean;
  focused: boolean;
  online: boolean;
  /** Bulk-manage mode (orca ManageSessions): when set, session rows show a
   *  checkbox instead of the action menu. */
  checkbox?: boolean;
  checked?: boolean;
}>();
const emit = defineEmits<{ toggle: []; activate: []; action: [name: string]; check: [] }>();

const hasChildren = computed(() => props.node.children.length > 0);
const device = computed(() => (props.node.type === "device" ? props.node.device : undefined));
const session = computed(() => (props.node.type === "session" ? props.node.session : undefined));
const agent = computed(() => (props.node.type === "agent" ? props.node.agent : undefined));
const background = computed(() =>
  session.value
    ? session.value.agents.reduce((n, a) => n + a.background, 0)
    : (agent.value?.background ?? 0),
);
const busy = computed(() => session.value?.busy || agent.value?.busy);
/** Behind the hub's build: devices self-update, this is only a hint. */
const behind = computed(() => {
  const theirs = device.value?.info?.packageVersion;
  const ours = hubVersion.value;
  return Boolean(theirs && ours && ours !== "unknown" && theirs !== ours);
});
const statusText = computed(() => {
  const d = device.value;
  if (!d) return "";
  const count = d.tree?.sessions.length ?? 0;
  switch (d.status) {
    case "online":
      return `${count} session${count === 1 ? "" : "s"}`;
    case "checking":
      return "checking…";
    case "unauthorized":
      return d.hasToken ? "token rejected" : "no token";
    case "mismatch":
      return "identity changed";
    case "incompatible":
      return "incompatible";
    default:
      return `offline · ${ago(d.lastSeenAt)}`;
  }
});
const dot = computed(() => {
  const s = device.value?.status;
  return s === "online" ? "on" : s === "checking" ? "chk" : s === "offline" ? "off" : "err";
});
const branch = computed(() => {
  const n = props.node;
  return n.type === "session" ? branchOf(n.deviceId, n.session.cwd) : undefined;
});
const label = computed(
  () => device.value?.name ?? device.value?.id ?? session.value?.name ?? agent.value?.name ?? "",
);
const title = computed(() => {
  if (device.value)
    return `${device.value.name} · ${device.value.url}${device.value.error ? `\n${device.value.error}` : ""}`;
  if (session.value) return `${session.value.name}\n${session.value.cwd}`;
  const a = agent.value!;
  return a.kind === "fork"
    ? `Fork of agent #${a.parentId} at entry #${a.forkedAt}`
    : a.kind === "subagent"
      ? `Subagent owned by agent #${a.ownerAgentId}`
      : "Root agent";
});
</script>

<template>
  <div
    class="tree-row"
    :class="[node.type, { sel: selected, focus: focused, stale: node.stale }]"
    :style="{ '--depth': depth }"
    role="treeitem"
    :aria-level="depth + 1"
    :aria-expanded="hasChildren ? open : undefined"
    :aria-selected="selected"
    :data-key="node.key"
    :title="title"
    @click="emit('activate')"
  >
    <button
      v-if="hasChildren"
      class="chev"
      tabindex="-1"
      :aria-label="open ? `Collapse ${label}` : `Expand ${label}`"
      @click.stop="emit('toggle')"
    >
      <ChevronDown v-if="open" :size="16" /><ChevronRight v-else :size="16" />
    </button>
    <span v-else class="chev" />
    <template v-if="device">
      <i class="dot" :class="dot" />
      <DeviceIcon :device="device" :size="16" />
      <b class="name">{{ label }}</b>
      <span class="badge">{{ device.kind }}</span>
      <span
        v-if="behind"
        class="tag update"
        :title="`device runs ${device?.info?.packageVersion ?? '?'}; hub runs ${hubVersion}. Devices self-update: dpi update`"
        >update</span
      >
      <span class="meta" :class="{ err: dot === 'err' }">{{ statusText }}</span>
      <span class="acts" @click.stop>
        <button
          v-if="device.pairing"
          class="icon-button"
          :aria-label="`Manage credentials for ${label}`"
          title="Manage device credentials, including while offline"
          @click="emit('action', 'credentials')"
        >
          <KeyRound :size="16" />
        </button>
        <button
          class="icon-button"
          :disabled="!online"
          :aria-label="`New session on ${label}`"
          title="New session on this device"
          @click="emit('action', 'new-session')"
        >
          <Plus :size="16" /></button
        ><button
          class="icon-button"
          :aria-label="`Check ${label}`"
          title="Check connection now"
          @click="emit('action', 'check')"
        >
          <RefreshCw :size="16" />
        </button>
      </span>
    </template>
    <template v-else-if="session">
      <input
        v-if="checkbox"
        type="checkbox"
        class="bulk-check"
        :checked="checked"
        :aria-label="`Select ${label}`"
        tabindex="-1"
        @click.stop
        @change="emit('check')"
      />
      <FolderOpen class="ico" :size="16" />
      <b class="name">{{ label }}</b>
      <span class="path">…/{{ session.cwd.split("/").filter(Boolean).at(-1) }}</span>
      <span v-if="branch" class="branch" :title="`git branch of ${session.cwd}`">⎇ {{ branch }}</span>
      <i v-if="busy" class="dot work" title="Working" />
      <span v-if="background" class="bg-count" :title="`${background} background task(s)`"
        ><i class="dot bg" />{{ background }} bg</span
      >
      <span class="acts" @click.stop>
        <button
          class="icon-button"
          :disabled="!online"
          :aria-label="`New agent in ${label}`"
          title="New agent in this session"
          @click="emit('action', 'new-agent')"
        >
          <Plus :size="16" /></button
        ><button
          class="icon-button"
          :disabled="!online"
          :aria-label="`Rename session ${label}`"
          title="Rename session"
          @click="emit('action', 'rename')"
        >
          <Pencil :size="16" /></button
        ><button
          class="icon-button"
          :disabled="!online"
          :aria-label="`Archive session ${label}`"
          title="Archive session"
          @click="emit('action', 'archive')"
        >
          <Archive :size="16" />
        </button>
      </span>
    </template>
    <template v-else-if="agent">
      <GitFork v-if="agent.kind === 'fork'" class="ico" :size="16" />
      <CornerDownRight v-else-if="agent.kind === 'subagent'" class="ico" :size="16" />
      <MessageSquare v-else class="ico root" :size="16" />
      <span class="name">{{ label }}</span>
      <span v-if="agent.kind === 'fork' && agent.forkedAt !== undefined" class="meta"
        >@ #{{ agent.forkedAt }}</span
      >
      <i v-if="busy" class="dot work" title="Working" />
      <span v-if="background" class="bg-count" :title="`${background} background task(s)`"
        ><i class="dot bg" />{{ background }}</span
      >
      <span class="acts" @click.stop>
        <button
          class="icon-button"
          :disabled="!online"
          :aria-label="`Rename agent ${label}`"
          title="Rename agent"
          @click="emit('action', 'rename')"
        >
          <Pencil :size="16" />
        </button>
      </span>
    </template>
  </div>
</template>

<style scoped>.bulk-check { margin-left: 2px; flex-shrink: 0; }</style>
