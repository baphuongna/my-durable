// Admin session for the browser. The ONLY browser credential is the hub's
// `dpi_admin` cookie (HttpOnly — script can never read it); no token is kept in
// localStorage, sessionStorage or the URL.
//
// `installAdminLoginFetch` wraps window.fetch once at startup: any 401 from an
// admin call raises the login card (LoginCard.vue), waits for a successful
// login, then retries the failed call exactly once and the app continues where
// it was. The login call itself is never intercepted.
import { reactive } from "vue";

export const auth = reactive({
  /** True while a 401 is waiting for the operator to sign in. */
  needed: false,
  busy: false,
  error: "",
});

type Waiter = (ok: boolean) => void;
let waiters = new Set<Waiter>();

const release = (ok: boolean) => {
  const pending = [...waiters];
  waiters = new Set();
  for (const w of pending) w(ok);
};

const waitForLogin = () => new Promise<boolean>((done) => waiters.add(done));

/** POST /api/session with the typed token; on success every waiting call retries. */
export async function login(token: string): Promise<boolean> {
  if (auth.busy || !token) return false;
  auth.busy = true;
  auth.error = "";
  try {
    const r = await fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    // Read the body in full: an unconsumed fetch body is cancelled once its Response is
    // garbage-collected, and harnesses that record response bodies must still read it.
    const body = await r.text().catch(() => "");
    if (r.ok) {
      auth.needed = false;
      release(true);
      return true;
    }
    auth.error =
      r.status === 401
        ? "That token was not accepted."
        : r.status === 429
          ? "Too many attempts. Wait a minute and try again."
          : `Login failed (${r.status}).`;
    void body;
    return false;
  } catch {
    auth.error = "Cannot reach the hub.";
    return false;
  } finally {
    auth.busy = false;
  }
}

/** Dismiss the card: waiting calls get their original 401 back. */
export function cancelLogin(): void {
  auth.needed = false;
  auth.error = "";
  release(false);
}

const isSessionCall = (url: string) => {
  try {
    return new URL(url, location.href).pathname === "/api/session";
  } catch {
    return url === "/api/session";
  }
};

/**
 * Wrap `fetch`: a 401 on anything except the login call itself raises the login
 * card, and after a successful login the SAME request is retried once. A stream
 * body cannot be replayed, so those are left alone.
 */
export function withAdminLogin(native: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = () => native(input, init);
    const response = await call();
    if (response.status !== 401) return response;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (isSessionCall(url) || init?.body instanceof ReadableStream) return response;
    auth.needed = true;
    // Drain the refused body now: an unconsumed fetch body is cancelled when its Response
    // is garbage-collected, and harnesses that record response bodies (tests/pairing-ui.mjs)
    // must still be able to read it afterwards. A cancelled login hands the caller an
    // equivalent Response so its own r.json() keeps working.
    const text = await response.text().catch(() => "");
    if (!(await waitForLogin()))
      return new Response(text, { status: response.status, headers: response.headers });
    return call();
  }) as typeof fetch;
}

/** Patch window.fetch with the 401 retry; install once, before the first call. */
export function installAdminLoginFetch(): void {
  if (typeof window === "undefined" || (window as { __adminFetch?: boolean }).__adminFetch) return;
  (window as { __adminFetch?: boolean }).__adminFetch = true;
  window.fetch = withAdminLogin(window.fetch.bind(window));
}
