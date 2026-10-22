<script setup lang="ts">
// The admin gate: one centered card with one password-type input. Shown when any
// admin call answered 401 (client/auth.ts); a successful login retries the call
// that was interrupted. The token itself lives only in the HttpOnly cookie — it
// is never stored or echoed anywhere the page can read.
import { nextTick, onMounted, ref } from "vue";
import { auth, login } from "../client/auth";

const token = ref("");
const input = ref<HTMLInputElement>();

async function submit() {
  if (auth.busy || !token.value.trim()) return;
  const ok = await login(token.value.trim());
  token.value = "";
  if (ok) input.value?.blur();
}

onMounted(() => void nextTick(() => input.value?.focus()));
</script>

<template>
  <div class="login-veil" data-testid="login-card">
    <form
      class="modal login-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="login-title"
      @submit.prevent="submit"
    >
      <header>
        <h2 id="login-title">Admin token</h2>
      </header>
      <p class="hint">
        This hub is locked. Sign in with the token from its <code>admin.token</code> file.
      </p>
      <label for="admin-token">Admin token</label>
      <input
        id="admin-token"
        ref="input"
        v-model="token"
        type="password"
        name="admin-token"
        autocomplete="off"
        spellcheck="false"
        placeholder="adm_…"
        aria-label="Admin token"
        :disabled="auth.busy"
        @keydown.esc="auth.error = ''"
      />
      <p v-if="auth.error" class="message-error" role="alert">{{ auth.error }}</p>
      <footer>
        <button class="primary" type="submit" :disabled="auth.busy || !token.trim()">
          {{ auth.busy ? "Checking…" : "Sign in" }}
        </button>
      </footer>
    </form>
  </div>
</template>
