<script setup lang="ts">
// HelpDialog: herdr's scrim + dialog presentation around durable-pi's own operating-model steps.
// Closes through the shared ui.dialog state; no local state to clone or lose.
import { Info, X } from "lucide-vue-next";
import { ui } from "../client/store";

const steps = [
  {
    title: "Pick a device, start a session",
    body: "Every device in the tree runs dpi-backend. A session gets its own SQLite database on that device, in the directory you choose.",
  },
  {
    title: "Send work, then close the browser",
    body: "The device owns the run. Reopening restores committed messages, state and live progress.",
  },
  {
    title: "Change state and fork",
    body: "Edit App State by hand or through the agent. Every session and fork on a device shares it.",
  },
  {
    title: "Interrupt deliberately",
    body: "Interrupt stops foreground work and owned subagents. Background jobs continue. Stop all includes them.",
  },
  {
    title: "Explore the boundaries",
    body: "Queue a follow-up, steer after tools, wait for approval, compact context, reset or inspect raw state.",
  },
  {
    title: "Restart a device",
    body: "Its tree dims and shows the restart command. Checkpointed jobs recover on boot. Replay-safe tools may rerun. Other interrupted tools return an error.",
  },
];
</script>

<template>
  <div class="scrim" @click.self="ui.dialog = undefined">
    <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="help-title">
      <div class="dialog-head">
        <div>
          <span class="dialog-eyebrow">LEARN BY DOING</span>
          <h3 id="help-title">What makes this durable?</h3>
        </div>
        <button
          class="icon-button"
          aria-label="Close help"
          @click="ui.dialog = undefined"
        >
          <X :size="18" />
        </button>
      </div>
      <div class="dialog-body">
        <div v-for="(step, i) in steps" :key="step.title" class="help-step">
          <span class="n">{{ String(i + 1).padStart(2, "0") }}</span>
          <div>
            <b>{{ step.title }}</b>
            <div class="body">{{ step.body }}</div>
          </div>
        </div>
        <div class="help-callout">
          <Info :size="18" /><span
            >Durable does not mean exactly-once external effects. Checkpoints protect progress.
            Tools still need their own idempotency.</span
          >
        </div>
      </div>
      <div class="dialog-foot">
        <div class="right">
          <button class="secondary" type="button" @click="ui.dialog = undefined">Close</button>
        </div>
      </div>
    </section>
  </div>
</template>
