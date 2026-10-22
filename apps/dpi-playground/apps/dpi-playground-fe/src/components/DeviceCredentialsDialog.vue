<script setup lang="ts">
import { computed } from "vue";
import { X } from "lucide-vue-next";
import TokenManager from "./TokenManager.vue";
import { network } from "../client/store";

const props = defineProps<{ deviceId: string }>();
const emit = defineEmits<{ close: [] }>();
const device = computed(() => network.devices.value.find((d) => d.id === props.deviceId));
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="device-credentials-title">
      <header>
        <h2 id="device-credentials-title">Device credentials</h2>
        <button class="icon-button" aria-label="Close device credentials" @click="emit('close')"><X :size="18" /></button>
      </header>
      <template v-if="device">
        <p>{{ device.name }} <code>{{ device.id }}</code></p>
        <p class="hint">{{ device.status }} · tunnel {{ device.tunnel?.state ?? "disconnected" }} · {{ device.tunnel?.readerCount ?? 0 }} readers</p>
        <TokenManager :device="device" />
      </template>
      <p v-else class="hint">This device is no longer in the registry.</p>
      <footer><button class="secondary" @click="emit('close')">Close</button></footer>
    </section>
  </div>
</template>
