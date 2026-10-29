/**
 * P2-26 — TUI local pairing controller.
 *
 * Contract (plan §P2-26):
 * - Talks ONLY to the local, token-authed dpi-backend (127.0.0.1:DPI_PORT with
 *   DPI_TOKEN) — never to the currently selected remote registry target.
 * - The TUI never creates a keypair, signs requests, writes pairing.json or
 *   runs a second connector loop: the backend owns all of that (03 §7).
 * - Interrupting (esc/Ctrl-C) cancels the LOCAL operation best-effort and says
 *   honestly that the hub side is NOT cancelled by it.
 * - Errors map to actionable text; a --force hub switch carries a warning.
 * - The full fingerprint wraps at the terminal width (40/80/200) — never
 *   truncated, and no token is ever rendered.
 */
import type { App } from "./app.ts";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Panel } from "./pickers.ts";
import { c } from "./theme.ts";
import { sanitizeTerminal } from "./sanitize.ts";

export interface PairArgs {
  code?: string;
  pairUrl?: string;
  hub?: string;
  force?: boolean;
}

/** Parse `/pair [CODE|PAIR_URL] [--hub ORIGIN] [--force]`. */
export function parsePairArgs(arg: string): PairArgs {
  const out: PairArgs = {};
  const tokens = arg.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--force") out.force = true;
    else if (t === "--hub") out.hub = tokens[++i];
    else if (t.startsWith("--hub=")) out.hub = t.slice(6);
    else if (t.startsWith("http://") || t.startsWith("https://")) out.pairUrl = t;
    else out.code ??= t;
  }
  return out;
}

/** Wrap the full fingerprint into ≤width chunks — readable at 40/80/200 cols. */
export function wrapFingerprint(fp: string, width: number): string[] {
  const chunk = Math.max(8, Math.min(64, width - 4));
  const lines: string[] = [];
  for (let i = 0; i < fp.length; i += chunk) lines.push(fp.slice(i, i + chunk));
  return lines.length ? lines : [fp];
}

/** Actionable text for every pairing failure code (03 §7). */
export function describePairingError(e: unknown): string {
  const code = typeof e === "string" ? e.split(":", 1)[0] : (e as { code?: string } | null)?.code;
  if (code) {
    switch (code) {
      case "clock_skew":
        return "This device's clock disagrees with the hub by more than a minute — sync the system clock and retry.";
      case "enrollment_lost":
        return "The hub lost this enrollment (restart or new code). Mint a fresh code in the hub wizard and retry.";
      case "paired_elsewhere":
      case "hub_mismatch":
        return "This device is already paired to another hub. Revoke there first, or use /pair --force to switch hubs.";
      case "revoked":
        return "This pairing was revoked on the hub. Mint a fresh code to pair again.";
      case "hub_required":
        return "No hub configured yet — pass the origin: /pair CODE --hub https://hub.example.com";
      case "busy":
        return "A pairing is already in progress. Cancel it first (esc in the pairing panel).";
      case "code_invalid":
        return "The hub does not know this code — check for typos or mint a new one.";
      case "code_expired":
        return "The code expired. Mint a fresh one in the hub wizard.";
      case "unauthorized":
        return "The local backend rejected DPI_TOKEN — the token must be the device's own (dpi_…), at least 32 chars.";
      default:
        break;
    }
  }
  return e instanceof Error ? e.message : String(e);
}

export interface PairingStatusDTO {
  state: "unpaired" | "pairing" | "paired" | "revoked";
  deviceUid?: string;
  deviceName?: string;
  fingerprint: string;
  hubOrigin?: string;
  deviceId?: string;
  pairingEpoch?: string;
  generation?: number;
  pending?: { hubOrigin: string; startedAt: number; note?: string };
  lastError?: string;
}

/** Local authenticated pairing endpoints (never the remote registry target). */
export class LocalPairing {
  readonly base: string;
  constructor(
    private token: string,
    port: number,
  ) {
    this.base = `http://127.0.0.1:${port}`;
  }
  static fromEnv(env: NodeJS.ProcessEnv = process.env): LocalPairing {
    const token = env.DPI_TOKEN ?? "";
    if (token.length < 32)
      throw new Error("DPI_TOKEN is unset — local pairing talks to this machine's dpi-backend and needs its token.");
    return new LocalPairing(token, Number(env.DPI_PORT ?? 4780));
  }
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await r.json().catch(() => undefined)) as
      | T
      | { error?: { code?: string; message?: string } }
      | undefined;
    if (!r.ok) {
      const error = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
      const e = new Error(error?.message ?? `${r.status} ${r.statusText}`) as Error & { code?: string; status?: number };
      e.code = error?.code;
      e.status = r.status;
      throw e;
    }
    return data as T;
  }
  status(): Promise<PairingStatusDTO> {
    return this.call<PairingStatusDTO>("GET", "/v1/pairing");
  }
  start(input: PairArgs): Promise<PairingStatusDTO> {
    return this.call<PairingStatusDTO>("POST", "/v1/pairing/start", {
      ...(input.pairUrl ? { pairUrl: input.pairUrl } : { code: input.code }),
      ...(input.hub ? { hub: input.hub } : {}),
      ...(input.force ? { force: true } : {}),
    });
  }
  cancel(): Promise<PairingStatusDTO> {
    return this.call<PairingStatusDTO>("POST", "/v1/pairing/cancel");
  }
}

/** Render the pairing panel body. Pure — unit-tested. */
export function pairingViewLines(
  status: PairingStatusDTO | undefined,
  note: string,
  width: number,
  hubOrigin?: string,
): string[] {
  const lines: string[] = [c.bold(c.accent("Pair this device"))];
  if (hubOrigin) lines.push(c.muted(`hub: ${sanitizeTerminal(hubOrigin)}`));
  if (!status) {
    lines.push(c.muted(sanitizeTerminal(note)));
    return lines.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
  }
  lines.push(c.muted(sanitizeTerminal(`device: ${status.deviceName ?? status.deviceUid ?? "?"} · uid ${status.deviceUid ?? "?"}`)));
  lines.push("");
  lines.push(c.bold("key fingerprint (compare with the hub wizard):"));
  for (const line of wrapFingerprint(status.fingerprint, width)) lines.push(`  ${c.secondary(sanitizeTerminal(line))}`);
  lines.push("");
  if (status.pending) {
    lines.push(c.warn("Awaiting approval on the hub…"));
    if (status.pending.note) lines.push(c.muted(`  ${sanitizeTerminal(status.pending.note)}`));
  } else if (status.lastError) {
    lines.push(c.err(sanitizeTerminal(describePairingError(status.lastError))));
    if (status.state === "paired")
      lines.push(c.muted(sanitizeTerminal(`Existing pairing to ${status.hubOrigin} is unchanged.`)));
  } else if (status.state === "paired") {
    lines.push(c.ok(sanitizeTerminal(`Paired to ${status.hubOrigin} (generation ${status.generation}).`)));
    lines.push(c.muted("The connector keeps the tunnel up; /pair again to re-pair."));
  } else if (status.state === "revoked") {
    lines.push(c.warn("Revoked on the hub. /pair CODE to pair again."));
  } else {
    lines.push(c.muted(sanitizeTerminal(note)));
  }
  if (note && status.state !== "pairing") lines.push(c.muted(sanitizeTerminal(note)));
  return lines.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
}

const pairingActive = (status: PairingStatusDTO) => !!status.pending || status.state === "pairing";

/** What closing the panel reports when there was no local operation left to cancel: a failure stays a failure. */
function closedIdle(status: PairingStatusDTO): [text: string, error: boolean] {
  if (status.lastError) {
    const kept = status.state === "paired" ? "existing credentials are unchanged." : "nothing was paired.";
    return [`Pairing did not complete: ${describePairingError(status.lastError)} No active local operation to cancel; ${kept}`, true];
  }
  if (status.state === "paired") return [`Pairing panel closed. Paired to ${status.hubOrigin} (generation ${status.generation}).`, false];
  return ["Pairing panel closed. No active local operation to cancel; existing credentials are unchanged.", false];
}

/**
 * Run the local pairing flow in an overlay: start → poll the local status →
 * show origin + full fingerprint + awaiting-approval → stop at paired/revoked.
 * Closing the panel (esc) cancels the LOCAL operation best-effort.
 */
export async function runPairing(app: App, args: PairArgs): Promise<void> {
  if (!args.code && !args.pairUrl) {
    app.flash("Usage: /pair CODE --hub https://hub.example.com [--force] — mint a code in the hub wizard first.", true);
    return;
  }
  if (args.force) app.flash("Warning: --force re-points this device at a different hub. Old credentials there stay until revoked.", true);
  let local: LocalPairing;
  try {
    local = LocalPairing.fromEnv();
  } catch (e) {
    app.flash(describePairingError(e), true);
    return;
  }
  let live = true;
  let status: PairingStatusDTO | undefined;
  let note = "Starting…";
  let hubOrigin: string | undefined;
  try {
    hubOrigin = args.pairUrl ? new URL(args.pairUrl).origin : args.hub;
  } catch {
    hubOrigin = args.hub;
  }
  const starting = local.start(args);
  const panel = new Panel(
    (w) => pairingViewLines(status, note, w, hubOrigin),
    () => app.closeOverlay(),
  );
  app.overlay(panel, () => {
    if (!live) return;
    live = false;
    void (async () => {
      // A slow start may not have created its local operation yet. Wait for its
      // response before deciding, instead of letting it outlive this panel.
      let started: PairingStatusDTO;
      try {
        started = await starting;
      } catch (e) {
        // The backend answered and refused: nothing started, and the refusal was already shown.
        if (typeof (e as { status?: unknown }).status === "number") return;
        app.flash("Pairing panel closed — local cancel was not confirmed. Check the local backend and hub; the hub-side code was not cancelled.", true);
        return;
      }
      const last = status ?? started;
      if (!pairingActive(last)) {
        const [text, error] = closedIdle(last);
        app.flash(text, error);
        return;
      }
      // Best-effort LOCAL cancel; the hub side is NOT cancelled by this.
      try {
        await local.cancel();
        app.flash("Pairing panel closed — the local operation was cancelled. The hub-side code stays until it expires; revoke there if it was already approved.", true);
      } catch {
        app.flash("Pairing panel closed — local cancel was not confirmed. Check the local backend and hub; the hub-side code was not cancelled.", true);
      }
    })();
  });
  const render = () => {
    panel.invalidate();
    app.tui.invalidate();
    app.tui.requestRender();
  };
  try {
    status = await starting;
    if (!live) return;
    note = "";
    render();
    const deadline = Date.now() + 330_000;
    while (live && Date.now() < deadline) {
      if (!pairingActive(status)) break;
      await new Promise((r) => setTimeout(r, 1_000));
      if (!live) break;
      status = await local.status();
      if (!live) break;
      render();
    }
    if (live && status && pairingActive(status)) {
      note = "Still waiting after 5 minutes — mint a fresh code if the hub wizard was closed.";
      render();
    }
  } catch (e) {
    if (live) {
      note = describePairingError(e);
      render();
      app.flash(note, true);
    }
  }
}
