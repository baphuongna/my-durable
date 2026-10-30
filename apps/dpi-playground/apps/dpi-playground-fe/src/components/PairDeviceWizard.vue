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
  qrPayload,
  type PairingSession,
  type PendingPairing,
} from "../client/pair";
import { qrSvg } from "../client/qrcode";
import DeviceHandoff from "./DeviceHandoff.vue";
import type { PairCodeIssue, PairCodeState } from "@sdk/api";
import { DpiError } from "@sdk/errors";
import { isPairCode } from "@sdk/protocol/pairing";
import { settledPairPath, type PairHandoff } from "../client/pair-handoff";
import { CANCEL_TIMEOUT_MS, closeWizard, type CancelResult } from "../client/pair-close";
import { notify, network } from "../client/store";

const emit = defineEmits<{ close: [] }>();
const props = defineProps<{ handoff?: PairHandoff }>();

type Step = "boot" | "code" | "proof" | "approve" | "issued" | "cancelled" | "expired";

const step = ref<Step>("boot");
const session = ref<PairingSession>();
const issue = ref<PairCodeIssue>();
const state = ref<PairCodeState>();
const error = ref("");
const busy = ref(false);
const closing = ref(false);
const confirmed = ref(false);
const replaceKey = ref(false);
const copied = ref(false);
const linkCopied = ref(false);
const watcher = ref<(() => void) | undefined>();
/** Machines that asked the hub for a code themselves (device-initiated enrollment). */
const pending = ref<PendingPairing[]>([]);

const grouped = computed(() => {
  const code = issue.value?.code ?? "";
  if (!isPairCode(code)) return code; // never invent separators around an unsupported value
  // A minted code is a UUID v4: its hyphens are structure, so it is shown as it is.
  if (code.includes("-")) return code;
  // Legacy base32 (12 | 8 chars) reads better in blocks of four: `ABCD-2345-EF67`.
  return (code.match(/.{4}/g) ?? []).join("-");
});
const qrData = computed(() => {
  if (!issue.value) return "";
  // Gap #3: the QR rides the #offer= fragment (qrPayload) — never the v1
  // pairUrl, whose ?code= query would land the pairing code in server logs.
  return qrPayload(issue.value);
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
    (status) => {
      if (status === "online") {
        notify("Device paired and online.");
        // F12: the STOP HANDLE is what watch() RETURNS — the callback's third
        // argument is the onCleanup REGISTRAR (needs a function argument).
        watcher.value?.();
        watcher.value = undefined;
      }
    },
    { immediate: true },
  );
});

async function createCode(handoffCode?: string): Promise<void> {
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
    const created = handoffCode
      ? await pairingAdmin.resolveCode(handoffCode)
      : await pairingAdmin.createCode();
    if (s.closed()) {
      await pairingAdmin.cancel(created.codeId).catch(() => {
        notify(
          "The late pairing code could not be cancelled. Check device credentials before retrying.",
        );
      });
      return;
    }
    issue.value = created;
    step.value = "code";
    if (handoffCode) {
      const path = settledPairPath(new URL(window.location.href));
      if (path) window.history.replaceState(window.history.state, "", path);
    }
    void pollCode(s, created.codeId, {
      intervalMs: 1_000,
      onState: (st) => {
        state.value = st;
        if (st.phase === "awaiting_proof") step.value = "proof";
        else if (st.phase === "awaiting_approval" || st.phase === "approved")
          step.value = "approve";
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
async function cancelLive(keepalive: boolean): Promise<CancelResult> {
  if (!issue.value) return "cancelled";
  try {
    const next = await pairingAdmin.cancel(issue.value.codeId, undefined, keepalive);
    state.value = next;
    if (session.value) session.value.state = next;
    step.value = next.phase === "expired" ? "expired" : "cancelled";
    session.value?.close();
    return "cancelled";
  } catch (e) {
    if (e instanceof DpiError && e.status === 409 && String(e.code) === "already_issued") {
      const latest = await pairingAdmin.codeState(issue.value.codeId).catch(() => undefined);
      if (latest) {
        state.value = latest;
        if (session.value) session.value.state = latest;
      }
      step.value = "issued";
      error.value =
        "Credential already issued. Closing does not revoke it; choose Revoke explicitly if needed.";
      return "issued";
    }
    error.value = e instanceof Error ? e.message : String(e);
    return "failed";
  }
}
const cancelCode = () => cancelLive(false);

const settled = () =>
  ["issued", "connected", "cancelled", "expired"].includes(state.value?.phase ?? "");

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

/** Copies the v2 offer link (code never in a query); falls back to the v1 pair URL. */
async function copyLink(): Promise<void> {
  if (!issue.value) return;
  try {
    await navigator.clipboard.writeText(issue.value.offerUrl ?? issue.value.pairUrl);
    linkCopied.value = true;
    setTimeout(() => (linkCopied.value = false), 1500);
  } catch {
    error.value = "Clipboard unavailable; copy the link manually.";
  }
}

async function close(): Promise<void> {
  if (closing.value) return;
  closing.value = true;
  busy.value = true;
  try {
    const outcome = await closeWizard({
      needsCancel: !!issue.value && !settled(),
      cancel: cancelCode,
      timeoutMs: CANCEL_TIMEOUT_MS,
    });
    if (!outcome.closed) return;
    session.value?.close();
    watcher.value?.();
    if (!outcome.confirmed)
      notify(
        "Pairing cancellation was not confirmed. The code expires on its own; check device credentials before retrying.",
      );
    emit("close");
  } finally {
    closing.value = false;
    busy.value = false;
  }
}

defineExpose({ close });

let pendingTimer: ReturnType<typeof setInterval> | undefined;
async function refreshPending(): Promise<void> {
  try {
    pending.value = (await pairingAdmin.pending()).codes;
  } catch {
    // The list is a convenience; a failure must never break the manual flow.
  }
}
/** Open the approval flow for a machine that already asked (no code to carry). */
async function reviewPending(p: PendingPairing): Promise<void> {
  issue.value = undefined;
  state.value = undefined;
  error.value = "";
  const s = createPairingSession();
  session.value = s;
  step.value = p.phase === "approved_ready" ? "approve" : "proof";
  void pollCode(s, p.codeId, {
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
    error.value = e instanceof Error ? e.message : String(e);
  });
}

onMounted(() => {
  void refreshPending();
  pendingTimer = setInterval(() => void refreshPending(), 3_000);
  if (props.handoff && "error" in props.handoff) {
    error.value = props.handoff.error;
    step.value = "expired";
    return;
  }
  void createCode(props.handoff?.code);
});
onBeforeUnmount(() => {
  clearInterval(pendingTimer);
  const s = session.value;
  if (s && !s.closed() && issue.value && !settled()) {
    void cancelLive(true).then((result) => {
      if (result !== "cancelled")
        notify("Pairing cancellation was not confirmed. Check device credentials before retrying.");
    });
  }
  s?.close();
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

      <DeviceHandoff
        v-if="props.handoff && 'offerFragment' in props.handoff && props.handoff.offerFragment"
        :offer-fragment="props.handoff.offerFragment"
      />

      <!-- Machines that asked the hub for a code themselves. This is the
           device-initiated enrollment: the operator reads WHO is asking (name,
           host, platform, hub-computed fingerprint) before approving — the shape
           the reference clients put in their QR/offer. -->
      <section v-if="pending.length" class="pair-pending" aria-label="Machines waiting for approval">
        <h3>Machines waiting for you</h3>
        <ul>
          <li v-for="p in pending" :key="p.codeId">
            <div class="who">
              <strong>{{ p.deviceName ?? "unnamed device" }}</strong>
              <span v-if="p.hostname" class="muted">{{ p.hostname }}</span>
              <span v-if="p.platform" class="muted">{{ p.platform }}</span>
            </div>
            <div class="fp">{{ p.keyFingerprint }}</div>
            <div class="row">
              <span class="phase">{{ p.phase.replaceAll("_", " ") }}</span>
              <button type="button" class="small" @click="reviewPending(p)">Review</button>
            </div>
          </li>
        </ul>
        <p class="hint">
          Compare each fingerprint with the machine's own terminal before approving. Codes are
          minted by the hub — nothing has to be copied to the machine.
        </p>
      </section>

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
            <div class="pair-copy-actions">
              <button type="button" class="small" @click="copyCode">
                <Copy :size="14" /> {{ copied ? "Copied" : "Copy code" }}
              </button>
              <button
                type="button"
                class="small"
                @click="copyLink"
                title="Self-contained link: hub, code and expiry all in the fragment — it never reaches server logs"
              >
                <Copy :size="14" /> {{ linkCopied ? "Copied link" : "Copy link" }}
              </button>
            </div>
            <p class="hint">
              Run the device pairing command and scan, or enter this code on the device. Expires in
              5 minutes.
            </p>
            <div
              class="pair-qr"
              aria-label="Pairing QR code"
              title="Same offer link as Copy link: hub, code and expiry all in the #offer= fragment — it never reaches server logs"
              v-html="qr"
            />
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
                Device is already paired with a DIFFERENT key — replace the stored key (replaceKey)
              </label>
              <button
                type="button"
                class="primary"
                :disabled="
                  !confirmed || busy || (state?.enrollment?.keyChanged === true && !replaceKey)
                "
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
              <button type="button" class="small" @click="createCode()">Start over</button>
            </template>

            <template v-else-if="step === 'expired'">
              <p class="hint">The pairing code expired.</p>
              <button type="button" class="small" @click="createCode()">New code</button>
            </template>

            <p v-if="error" class="error" role="alert">{{ error }}</p>
          </div>
        </div>
      </template>
      <div v-else>
        <p class="error" role="alert">{{ error || "This pairing link is unavailable." }}</p>
        <button type="button" class="small" @click="createCode()">New code</button>
      </div>
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
.pair-wizard .pair-steps li {
  padding: 0.15rem 0.6rem;
  border: 1px solid transparent;
  border-radius: 999px;
}
.pair-wizard .pair-steps li.on {
  color: var(--fg, #eee);
  border-color: currentColor;
}
.pair-wizard .pair-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 1rem;
  align-items: start;
}
.pair-wizard .pair-code {
  font-size: 1.7rem;
  letter-spacing: 0.18em;
  font-family: var(--mono, monospace);
  margin-bottom: 0.35rem;
}
.pair-wizard .pair-copy-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}
.pair-wizard .pair-qr svg {
  border: 1px solid var(--border, #333);
  border-radius: 6px;
}
.pair-wizard .pair-side {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  min-width: 0;
}
.pair-wizard .fp {
  display: block;
  word-break: break-all;
  font-size: 0.78rem;
  background: var(--bg2, #222);
  padding: 0.4rem;
  border-radius: 6px;
}
.pair-wizard .pair-confirm {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.85rem;
}
.pair-wizard .pair-confirm.warn {
  color: var(--warn, #e0b040);
}
.pair-wizard .spin {
  animation: pair-spin 1.2s linear infinite;
}
@keyframes pair-spin {
  to {
    transform: rotate(360deg);
  }
}

.pair-pending {
  margin: 0 0 18px;
  padding: 14px 16px;
  border: 1px solid #2a3442;
  border-radius: 12px;
}
.pair-pending h3 { margin: 0 0 10px; font-size: 0.875rem; }
.pair-pending ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.pair-pending li { display: grid; gap: 4px; padding-bottom: 10px; border-bottom: 1px solid #222b36; }
.pair-pending li:last-child { border-bottom: 0; padding-bottom: 0; }
.pair-pending .who { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.pair-pending .fp { font-family: ui-monospace, monospace; font-size: 0.75rem; word-break: break-all; color: #7ee2a8; }
.pair-pending .row { display: flex; gap: 10px; align-items: center; justify-content: space-between; }
.pair-pending .phase { font-size: 0.75rem; color: #8fa0b5; }
</style>