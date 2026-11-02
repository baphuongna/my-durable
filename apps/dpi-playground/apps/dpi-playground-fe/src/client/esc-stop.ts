// R16 Esc-Esc stop (Unit B): the pure Escape policy for AgentView's
// document-level keydown, mirroring client/dialog-escape.ts. App.vue owns
// Escape while a dialog is open; the Find overlay closes first, then the
// composer's quote strip, and only two Escapes within a second while a turn
// runs stop it — a single Escape never interrupts. Pure: no DOM, no store,
// no Vue (quoteOpen arrives as a boolean, never an import of client/quote.ts).
export type EscStopAction = "none" | "close-overlay" | "clear-strip" | "stop";

export const ESC_STOP_WINDOW_MS = 1000;

export interface EscStopState {
  dialogOpen: boolean;
  overlayOpen: boolean;
  quoteOpen: boolean;
  busy: boolean;
  now: number;
  /** Timestamp of the previous Escape (ms), or null when none is remembered. */
  lastEscAt: number | null;
}

export function decideEscStop(state: EscStopState): EscStopAction {
  if (state.dialogOpen) return "none"; // App.vue's keydown already owns this one
  if (state.overlayOpen) return "close-overlay";
  if (state.quoteOpen) return "clear-strip";
  const since =
    state.lastEscAt === null || state.now < state.lastEscAt
      ? Infinity // no earlier press, or the clock jumped backwards
      : state.now - state.lastEscAt;
  return state.busy && since <= ESC_STOP_WINDOW_MS ? "stop" : "none";
}
