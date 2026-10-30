<script setup lang="ts">
/**
 * The no-admin "Pair THIS device" card (gap #4): when /pair carries an
 * #offer= fragment, the machine whose BROWSER opened it can relay the offer —
 * unchanged, fragment-only — to its own dpi backend's pairing page. No login,
 * no hub API: the hub wizard stays the operator side (mint + approve).
 */
import { computed, ref } from "vue";
import { MonitorSmartphone, Copy, ExternalLink } from "lucide-vue-next";

const props = defineProps<{ offerFragment: string }>();
const port = ref("4780");
const copied = ref(false);

const deviceUrl = computed(() => {
  const p = /^\d{1,5}$/.test(port.value) ? Number(port.value) : 0;
  if (!p || p < 1 || p > 65535) return undefined;
  return `http://127.0.0.1:${p}/pair#${props.offerFragment}`;
});

function open() {
  const url = deviceUrl.value;
  if (url) window.open(url, "_blank", "noopener");
}

async function copy() {
  const url = deviceUrl.value;
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1600);
  } catch {
    /* clipboard denied: the open button still works */
  }
}
</script>

<template>
  <section class="device-handoff" aria-label="Pair this machine">
    <header>
      <MonitorSmartphone :size="18" />
      <h3>Pair THIS machine</h3>
    </header>
    <p class="what">
      If this browser runs on the device itself, open its local pairing page — the offer is relayed
      inside the link, nothing is sent to the hub. Start <code>dpi device</code> there first.
    </p>
    <div class="row">
      <label>
        local port
        <input
          v-model="port"
          inputmode="numeric"
          spellcheck="false"
          aria-label="Local dpi backend port"
        />
      </label>
      <button class="primary" type="button" :disabled="!deviceUrl" @click="open">
        <ExternalLink :size="15" />Open the device page
      </button>
      <button class="secondary" type="button" :disabled="!deviceUrl" @click="copy">
        <Copy :size="15" />{{ copied ? "Copied" : "Copy link" }}
      </button>
    </div>
    <p class="target" v-if="deviceUrl" data-testid="device-url">{{ deviceUrl }}</p>
    <p class="err" v-if="!deviceUrl">port must be 1–65535</p>
  </section>
</template>

<style scoped>
.device-handoff {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 14px 16px;
  margin-bottom: 14px;
  background: var(--panel);
}
header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 650;
  margin-bottom: 6px;
}
h3 {
  margin: 0;
  font-size: 0.90625rem;
}
.what {
  margin: 0 0 10px;
  font-size: 0.8125rem;
  color: var(--muted);
}
code {
  font-family: ui-monospace, monospace;
  font-size: 0.75rem;
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: end;
}
label {
  display: grid;
  gap: 4px;
  font-size: 0.75rem;
  color: var(--muted);
}
input {
  width: 90px;
  padding: 7px 9px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: inherit;
  font: inherit;
}
.err {
  color: var(--danger, #f28b82);
  font-size: 0.78125rem;
  margin: 8px 0 0;
}
.target {
  margin: 10px 0 0;
  font-family: ui-monospace, monospace;
  font-size: 0.75rem;
  color: var(--muted);
  word-break: break-all;
}
</style>
