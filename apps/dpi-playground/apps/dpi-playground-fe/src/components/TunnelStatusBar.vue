<script setup lang="ts">
/**
 * P2-25 — TunnelStatusBar: two INDEPENDENT axes, both read straight from the
 * network DTO (no invented state):
 *  1. transport — how the hub reaches the device: LAN (url) or tunnel (WSS),
 *     with tunnel.state/readerCount when the hub exposes diagnostics.
 *  2. monitor — the six-value probe status (checking/online/offline/
 *     unauthorized/mismatch/incompatible).
 * url === null hides any endpoint link (tunnel devices have no hub-side URL);
 * no retry countdown is fabricated — the hub does not expose one.
 */
import { computed } from "vue";
import { Cable, Wifi, WifiOff } from "lucide-vue-next";
import type { NetworkDevice } from "@sdk/api";
import { ago } from "../client/store";

const props = defineProps<{ device: NetworkDevice }>();

const online = computed(() => props.device.status === "online");
const viaTunnel = computed(() => props.device.transport === "tunnel");
const transportLabel = computed(() =>
  online.value ? (viaTunnel.value ? "online · via tunnel" : "online · LAN") : viaTunnel.value ? "tunnel" : "LAN",
);
const tunnelLive = computed(() => props.device.tunnel?.state === "connected");
</script>

<template>
  <span class="tunnel-status" :data-status="device.status">
    <span class="axis transport" :title="viaTunnel ? 'Hub ⇄ device over the tunnel (WSS)' : 'Hub → device over LAN'">
      <Cable v-if="viaTunnel" :size="13" :class="{ live: tunnelLive }" />
      <Wifi v-else :size="13" :class="{ live: online }" />
      {{ transportLabel }}
    </span>
    <span class="axis monitor" :class="device.status">
      <WifiOff v-if="device.status === 'offline'" :size="13" />
      <template v-else>{{ device.status }}</template>
    </span>
    <span v-if="viaTunnel && tunnelLive && device.tunnel" class="axis muted" :title="`tunnel last seen ${ago(device.tunnel.lastSeenAt)}`">
      {{ device.tunnel.readerCount }} reader{{ device.tunnel.readerCount === 1 ? "" : "s" }}
    </span>
    <a v-if="device.url" class="axis url" :href="device.url" target="_blank" rel="noreferrer">{{ device.url }}</a>
    <span v-if="device.lastSeenAt" class="axis muted" :title="`last probe ${ago(device.lastSeenAt)}`">{{ ago(device.lastSeenAt) }}</span>
  </span>
</template>

<style>
.tunnel-status { display: inline-flex; align-items: center; gap: 0.5rem; font-size: 0.75rem; flex-wrap: wrap; }
.tunnel-status .axis { display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.1rem 0.5rem; border-radius: 999px; border: 1px solid var(--border, #333); }
.tunnel-status .axis.transport { color: var(--fg, #eee); }
.tunnel-status .axis.monitor.offline { color: var(--muted, #888); }
.tunnel-status .axis.monitor.unauthorized,
.tunnel-status .axis.monitor.mismatch,
.tunnel-status .axis.monitor.incompatible { color: var(--warn, #e0b040); }
.tunnel-status .axis.monitor.online { color: var(--ok, #6cc070); }
.tunnel-status .axis.muted { color: var(--muted, #888); border-style: dashed; }
.tunnel-status .axis.url { color: var(--accent, #7ab8ff); text-decoration: none; }
.tunnel-status .live { color: var(--ok, #6cc070); }
</style>
