<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  Activity,
  ArrowUpRight,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  FolderOpen,
  GitFork,
  MessageSquare,
  Pencil,
  Reply,
  Search,
} from "lucide-vue-next";
import type { AgentSummary } from "@sdk/api";
import { lineage } from "@sdk/models";
import TranscriptItem from "./TranscriptItem.vue";
import DeviceIcon from "./DeviceIcon.vue";
import GitChip from "./GitChip.vue";
import Composer from "./Composer.vue";
import FindOverlay from "./FindOverlay.vue";
import {
  activeLineage,
  agent,
  agentHandle,
  agentState,
  busy,
  device,
  interrupt,
  notify,
  preset,
  select,
  selected,
  sessionAgents,
  sessionSummary,
  toggle,
  layout,
  ui,
} from "../client/store";
import { useReplyQuote } from "../client/quote";
import { pickAssistantReply } from "../client/find";
import { decideEscStop } from "../client/esc-stop";

const chat = ref<HTMLElement>();
const lineageNav = ref<HTMLElement>();
const picker = ref(false);
const items = computed(() => agentState.value.items);
const liveItem = computed(() => items.value.some((i) => i.kind === "assistant" && i.streaming));
const runningTool = computed(() =>
  items.value.some(
    (i) =>
      (i.kind === "tool" && i.call.status === "running") ||
      (i.kind === "assistant" &&
        i.blocks.some((b) => b.type === "tool" && b.call.status === "running")),
  ),
);

const source = (a: AgentSummary) =>
  a.kind === "fork"
    ? `Forked from agent #${a.parentId} at entry #${a.forkedAt}`
    : a.kind === "subagent"
      ? `Owned by agent #${a.ownerAgentId}`
      : "Root agent";
const choices = computed(() =>
  sessionAgents.value
    .map((a) => ({ ...a, lineage: lineage(sessionAgents.value, a.id) }))
    .sort((a, b) => {
      for (let i = 0; i < Math.min(a.lineage.length, b.lineage.length); i++)
        if (a.lineage[i].id !== b.lineage[i].id) return a.lineage[i].id - b.lineage[i].id;
      return a.lineage.length - b.lineage.length;
    }),
);
const current = computed(() => activeLineage.value.at(-1));

const kindLabel = (a: AgentSummary) => (a.kind === "root" ? "agent" : a.kind);

/** Device crumb: show it in the network tree. Workspace crumb: open its root agent. */
function revealDevice() {
  if (!selected.value) return;
  layout.tree = true;
  toggle(selected.value.deviceId, true);
}
function openWorkspace() {
  const root = sessionAgents.value.find((a) => a.kind === "root") ?? sessionAgents.value[0];
  if (root) choose(root.id);
}

function choose(id: number) {
  picker.value = false;
  if (selected.value) select({ ...selected.value, agentId: id });
}

function fork(entryId: number) {
  const handle = agentHandle.value;
  const t = selected.value;
  if (!handle || !t) return;
  ui.dialog = {
    kind: "prompt",
    title: "Fork conversation",
    hint: `${current.value?.name ?? `Agent #${t.agentId}`} / entry #${entryId}. Leave the name blank to use Fork #ID.`,
    label: "Fork name",
    optional: true,
    placeholder: "e.g. Alternative approach",
    submit: "Create fork",
    run: async (name) => {
      const created = await handle.fork({ entryId, name: name || undefined });
      select({ ...t, agentId: created.id });
      notify(`Forked at entry #${entryId}. App State stays shared.`);
    },
  };
}

function renameAgent() {
  const handle = agentHandle.value;
  const a = current.value;
  if (!handle || !a) return;
  ui.dialog = {
    kind: "prompt",
    title: "Rename agent",
    label: "Agent name",
    value: a.named ? a.name : "",
    placeholder: a.name,
    submit: "Save name",
    run: (name) => handle.rename(name),
  };
}

watch(selected, () => {
  picker.value = false;
});

// Follow the bottom of the transcript unless the reader scrolled up.
let pinned = true;
watch(
  agent.version,
  () => {
    const el = chat.value;
    pinned = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  },
  { flush: "pre" },
);
watch(agent.version, () => {
  if (pinned)
    void nextTick(() =>
      chat.value?.scrollTo({ top: chat.value.scrollHeight, behavior: "instant" }),
    );
});
watch(
  () => activeLineage.value.length,
  () =>
    void nextTick(
      () => lineageNav.value && (lineageNav.value.scrollLeft = lineageNav.value.scrollWidth),
    ),
);

// --------------------------------------------- R16 view features (Unit B)
// Find-in-session, reply-to-passage and Esc-Esc stop. The pure pieces live in
// client/find.ts and client/esc-stop.ts; only the DOM wiring is here.

const findOpen = ref(false);
const replyQuote = useReplyQuote();
const replyTarget = ref<{
  x: number;
  y: number;
  below: boolean;
  excerpt: string;
  label: string;
} | null>(null);
let lastEscAt: number | null = null;

const cssEscape = (value: string): string =>
  typeof CSS !== "undefined" && CSS.escape
    ? CSS.escape(value)
    : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");

/** The data-entry-id of the transcript entry a DOM node sits in, if any. */
const entryIdOf = (node: Node | null): string | null =>
  (node instanceof Element ? node : (node?.parentElement ?? null))
    ?.closest("[data-entry-id]")
    ?.getAttribute("data-entry-id") ?? null;

/** Selection → Reply: float a Reply chip when the selection lies inside
 * exactly one assistant reply. The decision itself is pure (client/find.ts). */
function refreshSelection() {
  replyTarget.value = null;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount || !chat.value) return;
  const target = pickAssistantReply(
    items.value.map((i) => ({ id: i.id, role: i.kind })),
    {
      anchorId: entryIdOf(sel.anchorNode),
      focusId: entryIdOf(sel.focusNode),
      text: sel.toString(),
    },
  );
  if (!target) return;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  const below = window.matchMedia?.("(pointer: coarse)")?.matches ?? false; // touch: chip under the selection
  replyTarget.value = {
    x: Math.min(Math.max(rect.left, 8), Math.max(8, window.innerWidth - 176)),
    y: below ? rect.bottom + 8 : rect.top - 52,
    below,
    excerpt: target.excerpt,
    label: target.label,
  };
}
function quoteSelection() {
  const target = replyTarget.value;
  if (!target) return;
  replyQuote.setQuote(target.excerpt, target.label); // Unit A's pinned contract
  replyTarget.value = null;
  window.getSelection()?.removeAllRanges();
}

/** Find result → center the entry and flash it for 1.5s (TranscriptItem's
 * .flash hook owns the animation; this only toggles the class). */
const flashTimers = new WeakMap<Element, number>();
function jumpToEntry(entryId: string | number) {
  findOpen.value = false;
  void nextTick(() => {
    const el = chat.value?.querySelector(`[data-entry-id="${cssEscape(String(entryId))}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("flash");
    void (el as HTMLElement).offsetWidth; // restart the animation on repeat jumps
    el.classList.add("flash");
    window.clearTimeout(flashTimers.get(el));
    flashTimers.set(el, window.setTimeout(() => el.classList.remove("flash"), 1500));
  });
}

/** Keep an owned Escape away from every other listener (App.vue's keydown
 * still single-Esc-interrupts a busy turn — the policy must run first). */
const consume = (e: KeyboardEvent) => {
  e.preventDefault();
  e.stopImmediatePropagation();
};

/** Ctrl/⌘+F opens Find even while the composer is focused; Escape runs the
 * esc-stop policy. Registered in the CAPTURE phase on purpose: capture on
 * document fires before App.vue's bubble listener, which is the only way a
 * lone Escape can be kept from stopping a turn without touching App.vue.
 * Dialogs stay App.vue's — we defer the moment ui.dialog is set. */
function onKeydown(e: KeyboardEvent) {
  if (
    (e.ctrlKey || e.metaKey) &&
    !e.altKey &&
    !e.shiftKey &&
    (e.code === "KeyF" || e.key === "f" || e.key === "F")
  ) {
    e.preventDefault(); // keep the browser's find bar out of the way
    findOpen.value = true;
    return;
  }
  if (e.key !== "Escape" || e.isComposing || ui.dialog) return;
  const action = decideEscStop({
    dialogOpen: false,
    overlayOpen: findOpen.value,
    quoteOpen: !!replyQuote.quoted,
    busy: busy.value,
    now: Date.now(),
    lastEscAt,
  });
  if (action === "close-overlay") {
    consume(e);
    findOpen.value = false;
    return;
  }
  if (action === "clear-strip") {
    consume(e);
    replyQuote.clear();
    return;
  }
  if (action === "stop") {
    consume(e);
    lastEscAt = null;
    void interrupt(); // the store's own stop path — no new stop function
    return;
  }
  if (busy.value) {
    // First Escape of a possible double: remember it, and keep it away from
    // App.vue's legacy single-Esc interrupt — one press never stops a turn.
    consume(e);
    if (!e.repeat) lastEscAt = Date.now();
    return;
  }
  lastEscAt = null; // no turn running: this Escape belongs to the chrome
}

onMounted(() => {
  document.addEventListener("keydown", onKeydown, true);
  document.addEventListener("selectionchange", refreshSelection);
});
onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown, true);
  document.removeEventListener("selectionchange", refreshSelection);
});
</script>

<template>
  <section class="chat-panel">
    <header class="chat-header">
      <div class="lineage-picker">
        <div class="lineage-toolbar">
          <nav
            ref="lineageNav"
            class="crumbs conversation-lineage"
            aria-label="Conversation lineage"
          >
            <button class="crumb" :title="`${device?.name} · ${device?.url}`" @click="revealDevice">
              <span class="crumb-kind">device</span>
              <span class="crumb-main"
                ><DeviceIcon :device="device" :size="18" /><span class="device-chip">{{
                  device?.name ?? device?.id
                }}</span></span
              >
            </button>
            <ChevronRight class="crumb-sep" :size="18" aria-hidden="true" />
            <button class="crumb" :title="sessionSummary?.cwd" @click="openWorkspace">
              <span class="crumb-kind">workspace</span>
              <span class="crumb-main"
                ><FolderOpen :size="18" aria-hidden="true" /><span class="crumb-name">{{
                  sessionSummary?.name
                }}</span></span
              >
            </button>
            <GitChip v-if="sessionSummary?.cwd" />
            <template v-for="c in activeLineage" :key="c.id">
              <ChevronRight class="crumb-sep" :size="18" aria-hidden="true" />
              <button
                class="crumb"
                :class="{ current: c.id === selected?.agentId }"
                :aria-current="c.id === selected?.agentId ? 'page' : undefined"
                :title="source(c)"
                @click="choose(c.id)"
              >
                <span class="crumb-kind">{{ kindLabel(c) }}</span>
                <span class="crumb-main"
                  ><GitFork
                    v-if="c.kind === 'fork'"
                    :size="18"
                    aria-hidden="true"
                  /><CornerDownRight
                    v-else-if="c.kind === 'subagent'"
                    :size="18"
                    aria-hidden="true"
                  /><MessageSquare v-else :size="18" aria-hidden="true" /><span
                    class="crumb-name"
                    >{{ c.name }}</span
                  ></span
                >
              </button>
            </template>
          </nav>
          <button
            class="icon-button"
            aria-label="Rename agent"
            title="Rename this agent"
            :disabled="!current"
            @click="renameAgent"
          >
            <Pencil :size="18" />
          </button>
          <button
            class="icon-button find-button"
            aria-label="Find in session"
            title="Find in session (Ctrl/⌘+F)"
            @click="findOpen = true"
          >
            <Search :size="18" />
          </button>
          <button
            class="icon-button conversation-menu-toggle"
            aria-label="Browse conversations"
            aria-haspopup="dialog"
            :aria-expanded="picker"
            aria-controls="conversation-picker"
            title="Browse roots and forks"
            @click="picker = !picker"
          >
            <ChevronDown :size="18" />
          </button>
        </div>
        <div v-if="current && current.kind !== 'root'" class="lineage-source">
          {{ source(current) }}
        </div>
        <template v-if="picker">
          <button
            class="conversation-menu-dismiss"
            aria-label="Close conversation picker"
            @click="picker = false"
          />
          <section
            id="conversation-picker"
            class="conversation-picker"
            role="dialog"
            aria-label="Choose conversation"
          >
            <div class="conversation-picker-heading">Roots &amp; forks</div>
            <button
              v-for="c in choices"
              :key="c.id"
              class="conversation-choice"
              :class="{ selected: c.id === selected?.agentId }"
              :aria-label="c.lineage.map((x) => x.name).join(' → ')"
              :aria-current="c.id === selected?.agentId ? 'page' : undefined"
              @click="choose(c.id)"
            >
              <div class="conversation-choice-content">
                <span class="choice-lineage">
                  <template v-for="(ancestor, index) in c.lineage" :key="ancestor.id">
                    <ChevronRight v-if="index" :size="18" aria-hidden="true" />
                    <span :class="{ 'choice-ancestor': index < c.lineage.length - 1 }">{{
                      ancestor.name
                    }}</span>
                  </template>
                </span>
                <span class="choice-source">{{ source(c) }}</span>
              </div>
              <Check v-if="c.id === selected?.agentId" :size="18" aria-hidden="true" />
              <GitFork v-else-if="c.kind === 'fork'" :size="18" aria-hidden="true" />
              <MessageSquare v-else :size="18" aria-hidden="true" />
            </button>
          </section>
        </template>
      </div>
    </header>
    <div
      v-if="
        agent.fault.value ||
        agent.status.value === 'fault' ||
        agent.status.value === 'reconnecting' ||
        (agentState.ready && agent.status.value === 'connecting')
      "
      class="agent-stream-status"
      role="alert"
    >
      <div>
        <strong>{{
          agentState.ready ? "Cached transcript is stale." : "Agent stream unavailable."
        }}</strong>
        <p>{{ agent.fault.value || "Updates are paused while the stream reconnects." }}</p>
        <p>Sending is paused until a fresh snapshot arrives. Your draft is kept.</p>
      </div>
      <button :disabled="agent.status.value === 'connecting'" @click="agent.retry">
        Retry stream
      </button>
    </div>
    <div
      ref="chat"
      class="chat-scroll"
      data-testid="chat"
      @mouseup="refreshSelection"
      @scroll.passive="replyTarget = null"
    >
      <div v-if="!agentState.ready" class="chat-empty">
        <Activity :size="30" />
        <h2 v-if="agent.status.value === 'fault'">This agent is unavailable.</h2>
        <h2 v-else>Connecting to the agent…</h2>
        <p>The agent keeps working on {{ device?.id }} while this view connects.</p>
      </div>
      <template v-else>
        <div v-if="!items.length" class="chat-empty">
          <div class="agent-orb"><img src="/icons/durable-pi.svg" alt="Durable Pi" /><i /></div>
          <span class="eyebrow">YOUR DURABLE AGENT IS READY</span>
          <h2>A conversation with continuity.</h2>
          <p>Messages, tools and state live on {{ device?.id }}, beyond this window.</p>
          <div class="starter-grid">
            <button
              @click="
                preset(
                  'Inspect this directory using your tools and give me a brief overview. Do not modify any files.',
                )
              "
            >
              <FolderOpen :size="18" /><strong>Explore this directory</strong
              ><span>See coding tools in action</span><ArrowUpRight :size="18" /></button
            ><button
              @click="
                preset(
                  'Use read_state, then update_state to add a field called progress with value 1 and a boolean called ready with value false.',
                )
              "
            >
              <Braces :size="18" /><strong>Make a state change</strong
              ><span>Watch the workspace update</span><ArrowUpRight :size="18" />
            </button>
          </div>
        </div>
        <TranscriptItem v-for="item in items" :key="item.id" :item="item" @fork="fork" />
        <div v-if="agentState.running && !liveItem && !runningTool" class="entry live-generation">
          <div class="message-label">
            AGENT
            <span class="streaming">{{ agentState.retry ? "Retry scheduled" : "Working" }}</span>
          </div>
          <div class="typing"><i /><i /><i /></div>
        </div>
        <p v-if="agentState.retry" class="hint retry-note">
          Retrying: {{ agentState.retry.error }}
        </p>
        <p v-for="(n, i) in agentState.notices" :key="i" class="message-error">{{ n }}</p>
      </template>
    </div>
    <button
      v-if="replyTarget"
      class="reply-quote-chip"
      :class="{ below: replyTarget.below }"
      :style="{ left: `${replyTarget.x}px`, top: `${replyTarget.y}px` }"
      :aria-label="`Reply quoting ${replyTarget.label}`"
      :title="replyTarget.label"
      @mousedown.prevent
      @click="quoteSelection"
    >
      <Reply :size="16" aria-hidden="true" />Reply
    </button>
    <Composer />
    <FindOverlay v-if="findOpen" :items="items" @close="findOpen = false" @jump="jumpToEntry" />
  </section>
</template>

<style scoped>
/* R16 (Unit B): the Find affordance keeps the toolbar's icon size but grows
 * its touch target to ≥44px — mobile-safe, no hover dependency. */
.find-button {
  position: relative;
}
.find-button::after {
  content: "";
  position: absolute;
  inset: -0.5rem;
}
.reply-quote-chip {
  position: fixed;
  z-index: 40;
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  min-height: 2.75rem; /* ≥44px target */
  padding: 0 0.875rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--card);
  color: var(--fg);
  font: inherit;
  font-size: 0.875rem;
  box-shadow: 0 0.375rem 1rem color-mix(in oklab, var(--bg) 70%, transparent);
  cursor: pointer;
}
.reply-quote-chip:hover {
  border-color: color-mix(in oklab, var(--accent) 55%, transparent);
}
</style>
