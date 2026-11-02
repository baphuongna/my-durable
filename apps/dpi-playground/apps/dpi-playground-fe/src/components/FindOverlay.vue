<script setup lang="ts">
// R16 find-in-session (Unit B): newest-first search over the loaded
// transcript. The pure search lives in client/find.ts; this overlay only
// debounces input (150ms), renders hits with a role badge + one-line
// excerpt, and navigates with ↑↓/Enter. Escape is deliberately NOT handled
// here — AgentView's document keydown runs the esc-stop policy, so the
// overlay closes first and an Escape never leaks into a stop.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Search, X } from "lucide-vue-next";
import type { TranscriptItem } from "@sdk/transcript";
import { MAX_FIND_RESULTS, searchTranscript, type SearchHit } from "../client/find";

const props = defineProps<{ items: readonly TranscriptItem[] }>();
const emit = defineEmits<{ close: []; jump: [entryId: string | number] }>();

const FIND_DEBOUNCE_MS = 150;

const query = ref("");
/** The query actually searched — lags `query` by the debounce. */
const applied = ref("");
const results = ref<SearchHit[]>([]);
const active = ref(0);
const input = ref<HTMLInputElement>();
let debounce: number | undefined;

function run() {
  results.value = searchTranscript(props.items, applied.value);
  active.value = 0;
}
function onInput() {
  window.clearTimeout(debounce);
  debounce = window.setTimeout(() => {
    applied.value = query.value;
    run();
  }, FIND_DEBOUNCE_MS);
}
// The transcript keeps streaming while the overlay is open — refresh in place.
watch(
  () => props.items,
  () => run(),
);

function move(delta: number) {
  if (!results.value.length) return;
  active.value = (active.value + delta + results.value.length) % results.value.length;
}
function go(hit: SearchHit) {
  emit("jump", hit.itemId);
  emit("close");
}
function onKey(e: KeyboardEvent) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    move(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    move(-1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const hit = results.value[active.value];
    if (hit) go(hit);
  }
}

const ROLE_LABEL: Record<string, string> = {
  user: "YOU",
  assistant: "AGENT",
  "tool-result": "TOOL",
  event: "EVENT",
  tool: "TOOL",
};
const roleOf = (itemId: string | number): string => {
  const kind = props.items.find((i) => String(i.id) === String(itemId))?.kind ?? "event";
  return ROLE_LABEL[kind] ?? "EVENT";
};
const count = computed(() => {
  if (!applied.value.trim()) return "";
  return results.value.length
    ? `${results.value.length}${results.value.length >= MAX_FIND_RESULTS ? "+" : ""} matches`
    : "no matches";
});

onMounted(() => input.value?.focus());
onBeforeUnmount(() => window.clearTimeout(debounce));
</script>

<template>
  <div class="find-backdrop" data-testid="find-overlay" @click.self="emit('close')">
    <section class="find-overlay" role="dialog" aria-label="Find in session">
      <header class="find-bar">
        <Search :size="18" aria-hidden="true" />
        <input
          ref="input"
          v-model="query"
          type="text"
          placeholder="Find in session…"
          aria-label="Find in session"
          autocomplete="off"
          spellcheck="false"
          @input="onInput"
          @keydown="onKey"
        />
        <span class="find-count" aria-live="polite">{{ count }}</span>
        <button class="icon-button find-close" aria-label="Close find" @click="emit('close')">
          <X :size="18" />
        </button>
      </header>
      <ul v-if="applied.trim()" class="find-results" aria-label="Find results">
        <li v-if="!results.length" class="find-empty">No matches in this session.</li>
        <li v-for="(hit, i) in results" :key="`${String(hit.itemId)}:${hit.index}`">
          <button
            class="find-result"
            :class="{ active: i === active }"
            role="option"
            :aria-selected="i === active"
            @click="go(hit)"
            @pointermove="active = i"
          >
            <span class="find-role" :data-role="roleOf(hit.itemId)">{{ roleOf(hit.itemId) }}</span>
            <span class="find-excerpt">{{ hit.excerpt }}</span>
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.find-backdrop {
  position: fixed;
  inset: 0;
  z-index: 90; /* session chrome; modals stay above (100) */
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 4.5rem 1rem 1rem;
  background: color-mix(in oklab, var(--bg) 55%, transparent);
}
.find-overlay {
  width: min(34rem, 100%);
  max-height: min(26rem, 70vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--card);
  box-shadow: 0 1.25rem 2.5rem color-mix(in oklab, var(--bg) 80%, transparent);
}
.find-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.625rem;
  border-bottom: 1px solid var(--line);
  color: var(--secondary);
}
.find-bar input {
  flex: 1;
  min-width: 0;
  min-height: 2.75rem; /* ≥44px target, and it is the primary keyboard surface */
  border: none;
  background: transparent;
  color: var(--fg);
  font: inherit;
}
.find-bar input:focus {
  outline: none;
}
.find-count {
  flex: none;
  font-size: 0.75rem;
  color: var(--faint);
  white-space: nowrap;
}
.find-close {
  flex: none;
}
.find-results {
  margin: 0;
  padding: 0.25rem;
  list-style: none;
  overflow-y: auto;
}
.find-empty {
  padding: 1rem;
  color: var(--faint);
  font-size: 0.875rem;
}
.find-result {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  width: 100%;
  min-height: 2.75rem; /* ≥44px touch target — no hover dependency */
  padding: 0.375rem 0.625rem;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--fg);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.find-result.active {
  background: color-mix(in oklab, var(--accent) 18%, transparent);
}
.find-role {
  flex: none;
  min-width: 3.25rem;
  padding: 0.125rem 0.375rem;
  border: 1px solid var(--line);
  border-radius: 0.625rem;
  font-size: 0.6875rem;
  letter-spacing: 0.06em;
  color: var(--secondary);
  text-align: center;
}
.find-role[data-role="AGENT"] {
  color: var(--accent);
  border-color: color-mix(in oklab, var(--accent) 45%, transparent);
}
.find-excerpt {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  color: var(--fg);
}
</style>
