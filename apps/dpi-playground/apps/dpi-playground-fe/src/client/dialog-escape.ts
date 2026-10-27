// Escape policy for open dialogs (App.vue's document-level keydown): an
// in-flight prompt keeps its dialog — closing it would orphan the running
// action and lose the error it renders — the pair wizard closes through its
// own flow, and everything else closes at once.
import type { Dialog } from "./store";

export type EscapeOutcome = "keep" | "close" | "pair";

export function escapeDialog(dialog: Dialog, promptBusy = false): EscapeOutcome {
  if (dialog.kind === "pair") return "pair";
  if (dialog.kind === "prompt" && promptBusy) return "keep";
  return "close";
}
