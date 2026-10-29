// Audit run-1 (terminal escape injection): strings from lower-trust principals
// (model/tool output inside a session, paired-device names/status/git fields,
// hub relays) must never carry terminal control sequences into the operator's
// terminal. The vendored pi-tui passes ESC-initiated sequences through as
// zero-width text and writes document lines verbatim to process.stdout, so the
// APP layer owns this invariant: strip ESC-initiated sequences (OSC/CSI/DCS/
// APC/anything ESC-led), C0 controls except \n (0A) and \t (09), and the C1
// range (U+0080-U+009F — U+009B is CSI in 8-bit-mode emulators). A trailing
// lone ESC is dropped too. Width accounting then matches what is emitted.
const ESC_SEQ = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[PX^_][^\x1b]*\x1b\\|.)/g;
const C0 = /[\u0000-\u0008\u000B-\u001F\u007F\u0080-\u009F]/g;

/** Neutralize terminal control sequences in an untrusted string before render/stdout. */
export function sanitizeTerminal(s: string): string {
  // run-7 D4-A: wire fields are typed strings only by CONVENTION — a hostile
  // device's name/modelId/branch/error-message arrived as any JSON value and
  // the bare s.replace() below killed the whole TUI render (no try/catch in
  // pi-tui's render loop, no process.on handler installed).
  if (typeof s !== "string") return String(s ?? "");
  return s.replace(ESC_SEQ, "").replace(C0, "");
}

/**
 * R20 (run-6 h5): single-line chrome compose chokepoint. sanitizeTerminal
 * strips escape sequences but KEEPS \n/\t by design (multi-line content is
 * legitimate elsewhere) — a wire string interpolated into a one-line frame row
 * must also collapse whitespace, or it splits its own row and forges chrome
 * below it. Hoisted here from commands.ts so every compose site shares one
 * definition.
 */
export function oneLine(text: string): string {
  return sanitizeTerminal(text).replace(/\s+/g, " ");
}
