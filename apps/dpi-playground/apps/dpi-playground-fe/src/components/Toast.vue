<script setup lang="ts">
// Toast: bottom-center pill, bound to the existing ui.toast / notify() timer in the store.
import { Check } from "lucide-vue-next";
import { ui } from "../client/store";
</script>

<template>
  <Transition name="toast">
    <div v-if="ui.toast" class="toast" role="status">
      <Check :size="18" />{{ ui.toast }}
    </div>
  </Transition>
</template>
