<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { ArrowUp, ChevronDown, Clock3, LibraryBig, Octagon, Quote, Trash2, X } from "lucide-vue-next";
import type { WhenBusy } from "@sdk/api";
import { newId } from "../client/ids";
import { commands, parseCommand, type SlashCommand } from "../client/commands";
import { buildQuotedMessage, useReplyQuote } from "../client/quote";
import {
  addPaste,
  createPasteStore,
  expandPastes,
  insertPlaceholder,
  oneLineExcerpt,
  shouldFoldPaste,
} from "../client/paste";
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
// R16 reply-to-passage: Unit B's transcript selection sets the quote through
// the same composable; the strip here shows it and send() folds it in.
const replyQuote = useReplyQuote();
const quoteSrc = computed(() => oneLineExcerpt(replyQuote.quoted?.srcLabel ?? "", 80));
const quoteExcerpt = computed(() => oneLineExcerpt(replyQuote.quoted?.text ?? "", 120));
// R16 long pastes: >20 lines become a placeholder token; full text waits here.
const pastes = createPasteStore();

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
    // R16: with the reply strip up, Escape clears only the strip — and must
    // not reach the document Esc listeners (interrupt et al).
    if (e.key === "Escape" && replyQuote.quoted) {
      e.preventDefault();
      e.stopPropagation();
      replyQuote.clear();
      return;
    }
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

// A paste longer than 20 lines never floods the composer: prevent the
// default insertion, drop the placeholder token at the caret instead.
function onPaste(e: ClipboardEvent) {
  const text = e.clipboardData?.getData("text/plain") ?? "";
  if (!shouldFoldPaste(text)) return;
  e.preventDefault();
  const ta = e.currentTarget as HTMLTextAreaElement;
  const { text: next, caret } = insertPlaceholder(
    ui.composer,
    addPaste(pastes, text),
    ta.selectionStart ?? ui.composer.length,
    ta.selectionEnd ?? ui.composer.length,
  );
  ui.composer = next;
  void nextTick(() => {
    ta.focus();
    ta.setSelectionRange(caret, caret);
  });
}

// A retried send (same agent, text and mode) reuses its requestId, so the device admits it once.
async function send() {
  // R16: long-paste placeholders unfold (full text back in place) before the
  // trim; a quoted reply folds in as a leading blockquote — but a slash
  // command stays verbatim (expansion only, never quoted).
  const expanded = expandPastes(ui.composer, pastes);
  const userText = expanded.trim();
  const quoted = replyQuote.quoted;
  const content =
    userText.startsWith("/") || !quoted ? userText : buildQuotedMessage(quoted, expanded).trim();
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
  try {
    sessionStorage.setItem(
      "dpi.pending-send",
      JSON.stringify({ key, content, mode: mode.value, requestId }),
    );
  } catch {
    // R16: an expanded long paste can exceed the storage quota — losing the
    // retry-id reuse is fine, the send itself proceeds.
  }
  await attempt(async () => {
    await handle.send(content, mode.value, requestId);
    sessionStorage.removeItem("dpi.pending-send");
    ui.composer = "";
    replyQuote.clear(); // the quote went out with this message
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
      <!-- R16: quoted passage awaiting the reply. Esc (below) or × clears it. -->
      <div v-if="replyQuote.quoted" class="reply-strip">
        <Quote :size="14" aria-hidden="true" />
        <span class="src">{{ quoteSrc }}</span>
        <span class="excerpt">“{{ quoteExcerpt }}”</span>
        <button
          type="button"
          class="clear"
          aria-label="Clear quoted reply"
          title="Clear quoted reply"
          @click="replyQuote.clear()"
        >
          <X :size="16" />
        </button>
      </div>
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
        @paste="onPaste"
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
/* R16 reply strip: same var palette as the rest of the composer; the clear
   button keeps a 44px touch target (min 2.75rem) and is always visible. */
.reply-strip {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0.5rem 0.75rem 0;
  padding: 0.25rem 0.125rem 0.25rem 0.75rem;
  border: 1px solid var(--line);
  border-left: 0.1875rem solid var(--accent);
  border-radius: 0.5rem;
  background: color-mix(in oklab, var(--accent) 7%, var(--card));
}
.reply-strip .src {
  font-weight: 600;
  font-size: 0.75rem;
  white-space: nowrap;
}
.reply-strip .excerpt {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 0.8125rem;
  color: var(--secondary);
}
.reply-strip .clear {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 2.75rem;
  min-height: 2.75rem;
  background: none;
  border: none;
  border-radius: 0.375rem;
  cursor: pointer;
  color: inherit;
}
.reply-strip .clear:hover,
.reply-strip .clear:focus-visible {
  background: color-mix(in oklab, var(--accent) 18%, transparent);
}
.lib-wrap { position: relative; }
.lib {
  position: absolute; bottom: calc(100% + 0.5rem); left: 0; z-index: 70; width: 18.75rem; max-height: 16.25rem;
  overflow: auto; background: var(--bg-2, #221a1c); border: 1px solid var(--line); border-radius: 0.625rem;
  padding: 0.625rem 0.75rem; box-shadow: 0 0.625rem 1.875rem rgb(0 0 0 / 50%); display: grid; gap: 0.5rem;
}
.lib header { display: flex; justify-content: space-between; align-items: center; }
.lib .save-row { display: flex; gap: 0.375rem; }
.lib .save-row input { flex: 1; min-width: 0; font: inherit; }
.lib ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.25rem; }
.lib li { display: flex; align-items: center; gap: 0.25rem; }
.lib li .use { flex: 1; text-align: left; background: none; border: none; cursor: pointer; font: inherit; padding: 0.25rem 0.375rem; border-radius: 0.375rem; color: inherit; }
.lib li .use:hover { background: #403536; }
</style>
