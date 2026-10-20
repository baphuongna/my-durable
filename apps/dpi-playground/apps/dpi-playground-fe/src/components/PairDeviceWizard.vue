<script setup lang="ts">
/**
 * P2-24 — PairDeviceWizard: create code → device proof → FULL fingerprint
 * approval → issued → (monitor probe) online.
 *
 * Security contract (P-8/P-14, plan §P2-24):
 * - Approve is enabled ONLY after proofVerified AND the operator ticks the
 *   explicit confirmation; approval always sends the hub-computed fingerprint
 *   from the codeState DTO — never the device-declared one.
 * - Name/UID/code alone can never enable approval.
 * - Key change (re-pair with a different key) requires replaceKey=true and a
 *   separate warning; 409 already_issued leads to an explicit Revoke offer,
 *   never a "cancelled" toast.
 * - The code is RAM-only: closing/cancelling the wizard cancels the code and
 *   clears every secret-adjacent field.
 * - /pair handoff: reads ?code/&origin once, replaces the URL (no query left),
 *   pre-fills — never auto-approves.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { CheckCircle2, Copy, RefreshCw, ShieldAlert, X } from "lucide-vue-next";
import {
  createPairingSession,
  pairingAdmin,
  pollCode,
  type PairingSession,
} from "../client/pair";
import { qrSvg } from "../client/qrcode";
import type { PairCodeIssue, PairCodeState } from "@sdk/api";
import { notify, network } from "../client/store";

const emit = defineEmits<{ close: [] }>();

type Step = "boot" | "code" | "proof" | "approve" | "issued" | "cancelled" | "expired";

const step = ref<Step>("boot");
const session = ref<PairingSession>();
const issue = ref<PairCodeIssue>();
const state = ref<PairCodeState>();
const error = ref("");
const busy = ref(false);
const confirmed = ref(false);
const replaceKey = ref(false);
const copied = ref(false);
const handoff = ref("");
const watcher = ref<(() => void) | undefined>();

const grouped = computed(() => {
  const code = issue.value?.code ?? "";
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
});
const qrData = computed(() => {
  if (!issue.value) return "";
  const origin = handoff.value || issue.value.hubOrigin;
  return `${origin.replace(/\/$/, "")}/pair?code=${issue.value.code}`;
});
const qr = computed(() => (qrData.value ? qrSvg(qrData.value, 148) : ""));
const fingerprint = computed(() => state.value?.enrollment?.keyFingerprint ?? "");
const deviceId = computed(() => state.value?.deviceId ?? "");

/** Online toast fires only after the MONITOR probe succeeds — never on WSS alone. */
watch(deviceId, (id) => {
  watcher.value?.();
  if (!id) return;
  watcher.value = watch(
    () => network.devices.value.find((d) => d.id === id)?.status,
    (status, _, stop) => {
      if (status === "online") {
        notify("Device paired and online.");
        stop();
        watcher.value = undefined;
      }
    },
    { immediate: true },
  );
});

async function createCode(): Promise<void> {
  step.value = "boot";
  error.value = "";
  confirmed.value = false;
  replaceKey.value = false;
  state.value = undefined;
  issue.value = undefined;
  session.value?.close();
  const s = createPairingSession();
  session.value = s;
  try {
    const created = await pairingAdmin.createCode();
    if (s.closed()) return;
    issue.value = created;
    step.value = "code";
    void pollCode(s, created.codeId, {
      intervalMs: 1_000,
      onState: (st) => {
        state.value = st;
        if (st.phase === "awaiting_proof") step.value = "proof";
        else if (st.phase === "awaiting_approval" || st.phase === "approved") step.value = "approve";
        else if (st.phase === "issued" || st.phase === "connected") step.value = "issued";
        else if (st.phase === "cancelled") step.value = "cancelled";
        else if (st.phase === "expired") step.value = "expired";
      },
    }).catch((e) => {
      if (s.closed()) return;
      error.value = e instanceof Error ? e.message : String(e);
      step.value = "expired";
    });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    step.value = "expired";
  }
}

async function approve(): Promise<void> {
  const st = state.value;
  const s = session.value;
  if (!st?.enrollment || !s || busy.value) return;
  // P-8: the tuple must be exactly what the hub verified; P-14: key change
  // needs the explicit replaceKey confirmation.
  busy.value = true;
  error.value = "";
  try {
    const next = await pairingAdmin.approve(issue.value!.codeId, {
      enrollmentId: st.enrollment.enrollmentId,
      deviceUid: st.enrollment.deviceUid,
      keyFingerprint: st.enrollment.keyFingerprint,
      ...(replaceKey.value ? { replaceKey: true } : {}),
    });
    state.value = next;
    if (next.phase === "issued" || next.phase === "connected") step.value = "issued";
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

/** Cancel before issuance; 409 already_issued → explicit Revoke path. */
async function cancelCode(): Promise<void> {
  if (!issue.value) return;
  try {
    await pairingAdmin.cancel(issue.value.codeId);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function revokeIssued(): Promise<void> {
  const id = deviceId.value;
  if (!id) return;
  busy.value = true;
  try {
    await pairingAdmin.revoke(id, "user");
    notify("Issued credential revoked.");
    emit("close");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function copyCode(): Promise<void> {
  if (!issue.value) return;
  try {
    await navigator.clipboard.writeText(issue.value.code); // canonical, ungrouped
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    error.value = "Clipboard unavailable; copy the code manually.";
  }
}

async function close(): Promise<void> {
  const s = session.value;
  const created = issue.value;
  session.value = undefined;
  s?.close();
  watcher.value?.();
  // RAM-only: cancel the live code (best effort) unless it already terminated.
  if (created && s && !["issued", "cancelled", "expired"].includes(s.state?.phase ?? "")) {
    await cancelCode().catch(() => undefined);
  }
  emit("close");
}

onMounted(() => {
  // /pair handoff: read code/origin once, scrub the URL, pre-fill — no router.
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const origin = url.searchParams.get("origin");
  if (code || origin) {
    url.search = "";
    window.history.replaceState({}, "", url);
  }
  if (origin) handoff.value = origin;
  void createCode().then(() => {
    // A handoff code only pre-fills the wizard; it never auto-approves.
    if (code && issue.value && issue.value.code !== code) {
      notify("Handoff code does not match the fresh code; use the new code.");
    }
  });
});
onBeforeUnmount(() => {
  session.value?.close();
  watcher.value?.();
});
</script>

<template>
  <div class="modal-backdrop" @click.self="close">
    <div class="modal pair-wizard" role="dialog" aria-modal="true" aria-labelledby="pair-title">
      <header>
        <h2 id="pair-title">Pair a device</h2>
        <button type="button" class="icon-button" aria-label="Close dialog" @click="close">
          <X :size="18" />
        </button>
      </header>

      <p v-if="step === 'boot'" class="hint">Minting a pairing code…</p>

      <template v-else-if="issue">
        <ol class="pair-steps" aria-label="Pairing progress">
          <li :class="{ on: true }">Code</li>
          <li :class="{ on: ['proof', 'approve', 'issued'].includes(step) }">Proof</li>
          <li :class="{ on: ['approve', 'issued'].includes(step) }">Fingerprint</li>
          <li :class="{ on: step === 'issued' }">Online</li>
        </ol>

        <div class="pair-grid">
          <div class="pair-code-box">
            <div class="pair-code" aria-label="Pairing code">{{ grouped }}</div>
            <button type="button" class="small" @click="copyCode">
              <Copy :size="14" /> {{ copied ? "Copied" : "Copy code" }}
            </button>
            <p class="hint">
              Run the device pairing command and scan, or enter this code on the device. Expires in
              5 minutes.
            </p>
            <div class="pair-qr" aria-label="Pairing QR code" v-html="qr" />
          </div>

          <div class="pair-side">
            <template v-if="step === 'code' || step === 'proof'">
              <p class="hint">
                <RefreshCw :size="14" class="spin" /> Waiting for the device to submit its signing
                proof…
              </p>
            </template>

            <template v-else-if="step === 'approve'">
              <div class="pair-fingerprint">
                <h3>Device key fingerprint</h3>
                <code class="fp">{{ fingerprint }}</code>
                <p class="hint">
                  Compare ALL 64 hex characters with the fingerprint shown on the device screen.
                </p>
              </div>
              <label class="pair-confirm">
                <input v-model="confirmed" type="checkbox" />
                The fingerprint matches the device display exactly
              </label>
              <label v-if="state?.enrollment?.keyChanged" class="pair-confirm warn">
                <input v-model="replaceKey" type="checkbox" />
                <ShieldAlert :size="14" />
                Device is already paired with a DIFFERENT key — replace the stored key
                (replaceKey)
              </label>
              <button
                type="button"
                class="primary"
                :disabled="!confirmed || busy || (state?.enrollment?.keyChanged === true && !replaceKey)"
                @click="approve"
              >
                Approve device
              </button>
              <button type="button" class="small" :disabled="busy" @click="cancelCode">
                Cancel pairing
              </button>
            </template>

            <template v-else-if="step === 'issued'">
              <p class="hint">
                <CheckCircle2 :size="14" /> Credential issued. The device is connecting through the
                tunnel — you will get a toast once the monitor probe reports it online.
              </p>
              <button type="button" class="small" @click="close">Close</button>
              <button
                type="button"
                class="small danger"
                :disabled="!deviceId || busy"
                title="Mistaken approval? Revoke the credential now."
                @click="revokeIssued"
              >
                Revoke this credential
              </button>
            </template>

            <template v-else-if="step === 'cancelled'">
              <p class="hint">Pairing was cancelled (or the signature failed too many times).</p>
              <button type="button" class="small" @click="createCode">Start over</button>
            </template>

            <template v-else-if="step === 'expired'">
              <p class="hint">The pairing code expired.</p>
              <button type="button" class="small" @click="createCode">New code</button>
            </template>

            <p v-if="error" class="error" role="alert">{{ error }}</p>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style>
.pair-wizard .pair-steps {
  display: flex;
  gap: 0.5rem;
  list-style: none;
  padding: 0;
  margin: 0.25rem 0 0.75rem;
  font-size: 0.78rem;
  color: var(--muted, #888);
}
.pair-wizard .pair-steps li { padding: 0.15rem 0.6rem; border: 1px solid transparent; border-radius: 999px; }
.pair-wizard .pair-steps li.on { color: var(--fg, #eee); border-color: currentColor; }
.pair-wizard .pair-grid { display: grid; grid-template-columns: auto 1fr; gap: 1rem; align-items: start; }
.pair-wizard .pair-code { font-size: 1.7rem; letter-spacing: 0.18em; font-family: var(--mono, monospace); margin-bottom: 0.35rem; }
.pair-wizard .pair-qr svg { border: 1px solid var(--border, #333); border-radius: 6px; }
.pair-wizard .pair-side { display: flex; flex-direction: column; gap: 0.6rem; min-width: 0; }
.pair-wizard .fp { display: block; word-break: break-all; font-size: 0.78rem; background: var(--bg2, #222); padding: 0.4rem; border-radius: 6px; }
.pair-wizard .pair-confirm { display: flex; align-items: center; gap: 0.45rem; font-size: 0.85rem; }
.pair-wizard .pair-confirm.warn { color: var(--warn, #e0b040); }
.pair-wizard .spin { animation: pair-spin 1.2s linear infinite; }
@keyframes pair-spin { to { transform: rotate(360deg); } }
</style>
