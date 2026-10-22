<script setup lang="ts">
/**
 * P2-25 — TokenManager: the public view of a device pairing. Only public
 * metadata ever renders here: pairing status, key fingerprint, paired-at,
 * credential generation, rotationPending. No token, no hash, no secret.
 *
 * Honesty contract:
 * - rotate 202 = queued intent → badge "rotation queued (waiting device ACK)";
 *   nothing says "delivered" until the device's new generation appears.
 * - revoke asks for confirmation; a 202 says the hub committed — it does NOT
 *   claim the device files were wiped (that is only known from the device's
 *   own matching notice / auth failure on a later connection).
 */
import { computed, ref } from "vue";
import { KeyRound, RefreshCw, ShieldOff } from "lucide-vue-next";
import type { NetworkDevice } from "@sdk/api";
import { pairingAdmin } from "../client/pair";
import { message } from "../client/hub";
import { ago, notify, ui } from "../client/store";

const props = defineProps<{ device: NetworkDevice }>();
const busy = ref(false);
const error = ref("");

const pairing = computed(() => props.device.pairing);

async function rotate(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await pairingAdmin.rotate(props.device.id);
    notify("Rotation queued — it completes when the device acknowledges the new credential.");
  } catch (e) {
    error.value = message(e);
  } finally {
    busy.value = false;
  }
}

async function revoke(): Promise<void> {
  if (busy.value) return;
  ui.dialog = {
    kind: "prompt",
    title: `Revoke ${props.device.id}?`,
    hint: "Every tunnel credential for this device dies at commit and the live tunnel is cut within a second. The device cleans its own files the next time it talks to the hub.",
    submit: "Revoke",
    danger: true,
    run: async () => {
      await pairingAdmin.revoke(props.device.id, "user");
      notify(
        "Revoke committed on the hub. The tunnel is cut; the device cleans up on its next contact.",
      );
    },
  };
}
</script>

<template>
  <section v-if="pairing" class="token-manager" aria-label="Credential manager">
    <header>
      <KeyRound :size="15" />
      <h3>Credential</h3>
      <span class="pairing-status" :class="pairing.status">{{ pairing.status }}</span>
    </header>
    <dl>
      <dt>Key fingerprint</dt>
      <dd>
        <code class="credential-fingerprint">{{ pairing.keyFingerprint }}</code>
      </dd>
      <dt>Paired</dt>
      <dd :title="new Date(pairing.pairedAt).toISOString()">{{ ago(pairing.pairedAt) }}</dd>
      <dt>Generation</dt>
      <dd>{{ pairing.credentialGeneration }}</dd>
    </dl>
    <p v-if="pairing.rotationPending" class="rotation-badge" role="status">
      <RefreshCw :size="13" class="spin" /> rotation queued — waiting for the device to ACK
    </p>
    <div class="token-actions">
      <button
        v-if="pairing.status === 'paired'"
        class="small"
        :disabled="busy || pairing.rotationPending"
        @click="rotate"
      >
        <RefreshCw :size="14" /> Rotate credential
      </button>
      <button
        v-if="pairing.status === 'paired'"
        class="small danger"
        :disabled="busy"
        @click="revoke"
      >
        <ShieldOff :size="14" /> Revoke
      </button>
    </div>
    <p v-if="error" class="message-error" role="alert">{{ error }}</p>
  </section>
</template>

<style>
.token-manager {
  border: 1px solid var(--border, #333);
  border-radius: 8px;
  padding: 0.6rem 0.8rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  font-size: 0.8rem;
}
.token-manager header {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.token-manager h3 {
  margin: 0;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.token-manager .pairing-status {
  margin-left: auto;
  font-size: 0.7rem;
  padding: 0.05rem 0.5rem;
  border-radius: 999px;
  border: 1px solid var(--border, #333);
}
.token-manager .pairing-status.paired {
  color: var(--ok, #6cc070);
}
.token-manager .pairing-status.revoked {
  color: var(--warn, #e0b040);
}
.token-manager dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.15rem 0.8rem;
  margin: 0;
}
.token-manager dt {
  color: var(--muted, #888);
}
.token-manager dd {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.token-manager .credential-fingerprint {
  white-space: normal;
  overflow-wrap: anywhere;
}
.token-manager .rotation-badge {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin: 0;
  color: var(--warn, #e0b040);
  font-size: 0.75rem;
}
.token-manager .token-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.token-manager .spin {
  animation: tm-spin 1.2s linear infinite;
}
@keyframes tm-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
