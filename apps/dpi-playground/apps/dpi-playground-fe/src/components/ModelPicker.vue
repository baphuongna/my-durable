<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { Check, X } from "lucide-vue-next";
import type { ModelInfo } from "@sdk/api";
import {
  agentHandle,
  attempt,
  device,
  icon,
  models,
  notify,
  number,
  refreshDetail,
  sessionModel,
} from "../client/store";

const emit = defineEmits<{ close: [] }>();
const search = ref("");
const searchInput = ref<HTMLInputElement>();
// House pattern (LoginCard, PromptDialog): land the cursor in the primary input
// when the dialog opens.
onMounted(() => void nextTick(() => searchInput.value?.focus()));
const filtered = computed(() =>
  models.value.filter((m) =>
    `${m.name} ${m.id} ${m.tier}`.toLowerCase().includes(search.value.toLowerCase()),
  ),
);
const isCurrent = (m: ModelInfo) => {
  const c = sessionModel.value;
  return !!c && m.id === c.modelId && m.provider === c.provider;
};
/** The active model when this device's catalog does not list it (picked on
 *  another device, or a newer catalog there): pinned and disabled, so the
 *  current model is always visible — searching the catalog alone cannot find
 *  it. */
const offCatalog = computed(() => {
  const m = sessionModel.value;
  return m && !models.value.some((x) => x.provider === m.provider && x.id === m.modelId)
    ? m
    : undefined;
});

async function choose(m: ModelInfo) {
  const done = await attempt(() =>
    agentHandle.value!.configure({ model: { provider: m.provider, modelId: m.id } }),
  );
  if (done) {
    await refreshDetail();
    notify("Model saved. Used on the next turn.");
    emit("close");
  }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="modal model-modal" role="dialog" aria-modal="true" aria-label="Model picker">
      <header>
        <div>
          <span class="eyebrow">PER AGENT · {{ device?.name ?? device?.id }}</span>
          <h2>Choose a model</h2>
        </div>
        <button class="icon-button" aria-label="Close model picker" @click="emit('close')">
          <X :size="18" />
        </button>
      </header>
      <input
        ref="searchInput"
        v-model="search"
        placeholder="Search models or tiers…"
        aria-label="Search models"
      />
      <div class="model-list">
        <div v-if="offCatalog" class="model-row off-catalog" aria-disabled="true">
          <img :src="icon(offCatalog.modelId)" alt="" />
          <div>
            <strong>{{ offCatalog.modelId }}</strong>
            <small>{{ offCatalog.provider }} / current · not in this device's catalog</small>
          </div>
        </div>
        <button
          v-for="m in filtered"
          :key="`${m.provider}/${m.id}`"
          :class="{ selected: isCurrent(m) }"
          @click="choose(m)"
        >
          <img :src="icon(m.id)" alt="" />
          <div>
            <strong>{{ m.name }}</strong
            ><small>{{ m.tier }} / {{ m.provider }} / {{ number(m.contextWindow) }} context</small>
          </div>
          <Check v-if="isCurrent(m)" :size="18" />
        </button>
      </div>
      <p class="hint">Models available on {{ device?.id }}. Provider keys stay on the device.</p>
    </section>
  </div>
</template>
