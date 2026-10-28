// Commands. Device calls go through the hub proxy (it injects the token, so the browser never
// holds one); status checks and UI state go to the hub itself.
import { DpiClient } from "@sdk/client";
import { DpiError } from "@sdk/errors";
import type { ErrorCode, NetworkDevice } from "@sdk/api";
import { notify } from "./store";

// R13 (R9-6.3 FE): the collapse of identical un-keyed creates is an accepted
// retry-safety tradeoff — but it must be VISIBLE. The device's replay verdict
// rides the tunnel envelope, the hub surfaces Idempotent-Replay, and the SDK
// hook turns it into a toast naming the escape hatch (own idempotency-key).
let replayToastAt = 0;
export const deviceClient = (id: string) =>
  new DpiClient(`/api/devices/${encodeURIComponent(id)}`, undefined, {
    onIdempotentReplay: (path) => {
      // Replays can arrive in bursts (a re-connected UI re-firing identical
      // creates) — one toast per 30 s is plenty of signal.
      if (Date.now() - replayToastAt < 30_000) return;
      replayToastAt = Date.now();
      notify(`Replayed an earlier identical request (${path}) — send a custom idempotency key for deliberate repeats.`);
    },
  });

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => undefined);
  if (!r.ok) {
    const error = (data as { error?: { code?: ErrorCode; message?: string } } | undefined)?.error;
    throw new DpiError(
      error?.code ?? "internal",
      error?.message ?? `${r.status} ${r.statusText}`,
      r.status,
    );
  }
  return data as T;
}

export const hub = {
  network: () => call<{ configFile?: string; devices: NetworkDevice[] }>("GET", "/network"),
  /** The hub's own version, for the "device is behind" badge. */
  version: () => call<{ version: string; node: string }>("GET", "/version"),
  /** Probe a device now. Devices themselves are configured in dpi-network.yaml, not here. */
  check: (id: string) =>
    call<NetworkDevice>("POST", `/devices/${encodeURIComponent(id)}/check`, {}),
  /** Conversation share (Wave 3): upload prepared transcripts, get a public link. */
  createShare: (input: { title: string; agents: Array<{ name: string; markdown: string }> }) =>
    call<{ token: string; url: string; expiresAt: string }>("POST", "/shares", input),
  async uiGet<T>(key: string): Promise<T | undefined> {
    return ((await call<{ value: T | null }>("GET", `/ui-state/${encodeURIComponent(key)}`))
      .value ?? undefined) as T | undefined;
  },
  uiSet: (key: string, value: unknown) =>
    call<{ ok: true }>("PUT", `/ui-state/${encodeURIComponent(key)}`, { value }),
};

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
