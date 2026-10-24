<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ArrowUp, ChevronDown, Clock3, LibraryBig, Octagon, Trash2, X } from "lucide-vue-next";
import type { WhenBusy } from "@sdk/api";
import { newId } from "../client/ids";
import { commands, parseCommand, type SlashCommand } from "../client/commands";
import {
  agent,
  agentHandle,
  agentState,
  attempt,
  busy,
  interrupt,
  interrupting,
  online,
  selected,
  streamState,
  ui,
} from "../client/store";

const mode = ref<WhenBusy>("followUp");
/** orca QuickCommandsPane, FE-only v1: named snippets in localStorage, one
 *  click into the composer. Saved prompts never leave the browser. */
const PROMPTS_KEY = "dpi-prompt-library";
const libOpen = ref(false);
const libName = ref("");
type Snippet = { name: string; text: string };
const snippets = ref<Snippet[]>([]);
const loadSnippets = () => {
  try {
    snippets.value = JSON.parse(localStorage.getItem(PROMPTS_KEY) ?? "[]") as Snippet[];
  } catch {
    snippets.value = [];
  }
};
const saveSnippets = () => localStorage.setItem(PROMPTS_KEY, JSON.stringify(snippets.value));
loadSnippets();
const saveCurrent = () => {
  const text = ui.composer.trim();
  const name = libName.value.trim() || text.slice(0, 24) || "snippet";
  if (!text) return;
  snippets.value = [{ name, text }, ...snippets.value.filter((p) => p.name !== name)].slice(0, 30);
  saveSnippets();
  libName.value = "";
};
const dropSnippet = (name: string) => {
  snippets.value = snippets.value.filter((p) => p.name !== name);
  saveSnippets();
};
const pending = ref(false);
const canSend = computed(
  () =>
    online.value &&
    agentState.value.ready &&
    agent.status.value === "live" &&
    streamState.value === "live",
);

// Typing "/" lists the slash commands; arrows pick, Tab or Enter completes.
const menuIndex = ref(0);
const menuClosed = ref(false);
const matches = computed(() => {
  const m = ui.composer.match(/^\/(\S*)$/);
  return m && !menuClosed.value
    ? commands.filter((c) => c.name.startsWith(m[1].toLowerCase()))
    : [];
});
watch(
  () => ui.composer,
  () => {
    menuIndex.value = 0;
    if (!ui.composer.startsWith("/")) menuClosed.value = false;
  },
);
// Enter on a fully typed name runs it unless it needs an argument; otherwise the name completes.
async function pick(command: SlashCommand, enter = false) {
  const runNow =
    !command.args || (enter && command.args.startsWith("[") && ui.composer === `/${command.name}`);
  if (!runNow) ui.composer = `/${command.name} `;
  else {
    ui.composer = `/${command.name}`;
    await send();
  }
}
function keydown(e: KeyboardEvent) {
  if (!matches.value.length) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send();
    }
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const n = matches.value.length;
    menuIndex.value = (menuIndex.value + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
  } else if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))
    void pick(matches.value[menuIndex.value], e.key === "Enter");
  else if (e.key === "Escape") menuClosed.value = true;
  else return;
  e.preventDefault();
  e.stopPropagation();
}

async function runCommand(text: string) {
  const parsed = parseCommand(text);
  if (!parsed) return false;
  pending.value = true;
  await attempt(async () => {
    await parsed.command.run(parsed.arg);
    ui.composer = "";
  });
  pending.value = false;
  return true;
}

// A retried send (same agent, text and mode) reuses its requestId, so the device admits it once.
async function send() {
  const content = ui.composer.trim();
  const handle = agentHandle.value;
  if (!content || pending.value || !handle || !canSend.value) return;
  if (content.startsWith("/") && (await runCommand(content))) return;
  pending.value = true;
  const t = selected.value!;
  const key = `${t.deviceId}/${t.sessionId}/${t.agentId}`;
  let saved: { key: string; content: string; mode: string; requestId: string } | undefined;
  try {
    saved = JSON.parse(sessionStorage.getItem("dpi.pending-send") ?? "null");
  } catch {}
  const requestId =
    saved?.key === key && saved.content === content && saved.mode === mode.value
      ? saved.requestId
      : newId();
  sessionStorage.setItem(
    "dpi.pending-send",
    JSON.stringify({ key, content, mode: mode.value, requestId }),
  );
  await attempt(async () => {
    await handle.send(content, mode.value, requestId);
    sessionStorage.removeItem("dpi.pending-send");
    ui.composer = "";
  });
  pending.value = false;
}

function withdraw(id: number) {
  void attempt(() => agentHandle.value!.withdraw(id));
}
</script>

<template>
  <div class="composer-region">
    <div v-if="agentState.inbox.length" class="queue">
      <div v-for="item in agentState.inbox" :key="item.id">
        <Clock3 :size="18" /><span
          >{{ item.mode === "steer" ? "Steer" : "Queued" }}:
          {{ item.content ?? "Context update" }}</span
        ><button
          class="icon-button"
          :aria-label="`Withdraw submission ${item.id}`"
          title="Withdraw queued input"
          @click="withdraw(item.id)"
        >
          <X :size="18" />
        </button>
      </div>
    </div>
    <div class="composer">
      <ul v-if="matches.length" class="slash-menu" role="listbox" aria-label="Slash commands">
        <li
          v-for="(c, i) in matches"
          :key="c.name"
          role="option"
          :aria-selected="i === menuIndex"
          :class="{ active: i === menuIndex }"
          @mousedown.prevent="pick(c)"
        >
          <code>/{{ c.name }}</code
          ><span v-if="c.args" class="slash-args">{{ c.args }}</span
          ><span class="slash-desc">{{ c.description }}</span>
        </li>
      </ul>
      <textarea
        v-model="ui.composer"
        rows="2"
        placeholder="Give your agent something to do, or type / for commands…"
        aria-label="Message your agent"
        @keydown="keydown"
      />
      <div class="composer-toolbar">
        <div class="composer-left">
          <div class="lib-wrap">
            <button
              type="button"
              class="icon-button"
              :aria-label="`Prompt library (${snippets.length})`"
              title="Prompt library — saved snippets"
              @click="libOpen = !libOpen"
            >
              <LibraryBig :size="18" />
            </button>
            <div v-if="libOpen" class="lib" @click.stop>
              <header><b>Prompts</b><button class="icon-button" aria-label="Close library" @click="libOpen = false"><X :size="14" /></button></header>
              <p v-if="!snippets.length" class="hint">Type something below, give it a name, save it.</p>
              <div class="save-row">
                <input v-model="libName" placeholder="name…" @keyup.enter="saveCurrent" />
                <button type="button" class="small" :disabled="!ui.composer.trim()" @click="saveCurrent">save composer as</button>
              </div>
              <ul>
                <li v-for="p in snippets" :key="p.name">
                  <button type="button" class="use" :title="p.text" @click="((ui.composer = p.text), (libOpen = false))">
                    <b>{{ p.name }}</b>
                  </button>
                  <button type="button" class="icon-button" :aria-label="`Delete ${p.name}`" @click="dropSnippet(p.name)">
                    <Trash2 :size="13" />
                  </button>
                </li>
              </ul>
            </div>
          </div>
          <div class="queue-mode">
            <select
              v-model="mode"
              aria-label="When busy"
              title="Follow-up waits for this run. Steer joins after a tool round."
            >
              <option value="followUp">Follow-up</option>
              <option value="steer">Steer</option>
              <option value="reject">Reject if busy</option></select
            ><ChevronDown :size="24" aria-hidden="true" />
          </div>
        </div>
        <div class="composer-right">
          <button
            class="interrupt"
            :disabled="!busy || interrupting"
            title="Stop foreground work and owned subagents (Escape). Background jobs continue."
            @click="interrupt"
          >
            <Octagon :size="24" class="stop-sign" fill="currentColor" />Interrupt</button
          ><button
            class="send"
            aria-label="Send message"
            :disabled="!ui.composer.trim() || pending || !canSend"
            @click="send"
          >
            <ArrowUp :size="20" />
          </button>
        </div>
      </div>
    </div>
    <div class="composer-footnote">
      <span><i class="live-dot" />Closing this window never interrupts your agent.</span>
    </div>
  </div>
</template>

<style scoped>
.lib-wrap { position: relative; }
.lib {
  position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 70; width: 300px; max-height: 260px;
  overflow: auto; background: var(--bg-2, #221a1c); border: 1px solid var(--line); border-radius: 10px;
  padding: 10px 12px; box-shadow: 0 10px 30px rgb(0 0 0 / 50%); display: grid; gap: 8px;
}
.lib header { display: flex; justify-content: space-between; align-items: center; }
.lib .save-row { display: flex; gap: 6px; }
.lib .save-row input { flex: 1; min-width: 0; font: inherit; }
.lib ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.lib li { display: flex; align-items: center; gap: 4px; }
.lib li .use { flex: 1; text-align: left; background: none; border: none; cursor: pointer; font: inherit; padding: 4px 6px; border-radius: 6px; color: inherit; }
.lib li .use:hover { background: #403536; }
</style>
