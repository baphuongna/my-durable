// R16 long-paste folding (Unit A): pasting more than 20 lines never floods
// the composer — a short placeholder token goes in instead and the full text
// waits in a store here, expanded back into place only when the message is
// sent. Tokens carry a sequential id and a line count; expansion replaces a
// token only when BOTH match a paste this store actually issued, so a
// hand-typed lookalike is never touched. Pure logic, no Vue, no globals.

export const PASTE_LINE_LIMIT = 20;

/** Flatten for one-line displays (strips, tooltips): control characters,
 *  line separators and zero-width runes collapse to single spaces, then cap
 *  at `max` chars on a word boundary. Every excerpt rendered from user or
 *  agent text goes through this first (r15 sanitize discipline). */
export function oneLineExcerpt(text: string, max = 120): string {
  const flat = text
    .replace(/\r\n?/g, " ")
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  const head = (space >= Math.floor(max / 2) ? cut.slice(0, space) : cut).replace(/\s+$/, "");
  return head + "…";
}

/** Newline-separated line count: "a\nb\nc" is 3 lines; CRLF counts as one
 *  break. The (possibly empty) line after a trailing break still counts. */
export function lineCount(text: string): number {
  return text.replace(/\r\n?/g, "\n").split("\n").length;
}

/** Fold at the boundary: 20 lines paste as-is, 21+ become a placeholder. */
export function shouldFoldPaste(text: string): boolean {
  return lineCount(text) > PASTE_LINE_LIMIT;
}

export interface PasteEntry {
  id: number;
  lines: number;
  text: string;
}

export interface PasteStore {
  nextId: number;
  pastes: Map<number, PasteEntry>;
}

export function createPasteStore(): PasteStore {
  return { nextId: 1, pastes: new Map() };
}

/** The literal token this feature issues — the middot is U+00B7. */
export function pasteToken(id: number, lines: number): string {
  return `[Pasted text #${id} · ${lines} lines]`;
}

/** Store the full paste, consume the next sequential id, return its token. */
export function addPaste(store: PasteStore, text: string): string {
  const id = store.nextId++;
  const lines = lineCount(text);
  store.pastes.set(id, { id, lines, text });
  return pasteToken(id, lines);
}

/** Put `token` where the selection is (replacing it) and report the caret
 *  offset just past the token. The composer's caret-aware pure helper. */
export function insertPlaceholder(
  composerText: string,
  token: string,
  selectionStart: number,
  selectionEnd = selectionStart,
): { text: string; caret: number } {
  const start = Math.max(0, Math.min(selectionStart, composerText.length));
  const end = Math.max(start, Math.min(selectionEnd, composerText.length));
  return {
    text: composerText.slice(0, start) + token + composerText.slice(end),
    caret: start + token.length,
  };
}

export function hasPasteTokens(text: string): boolean {
  return text.includes("[Pasted text #");
}

/** Replace ONLY system-issued tokens: the id must have been issued by this
 *  store AND the line count in the token must match the stored paste. A
 *  hand-typed "[Pasted text #1 · 5 lines]" (wrong store, unissued id, or
 *  mismatched count) stays literal. */
export function expandPastes(text: string, store: PasteStore): string {
  return text.replace(/\[Pasted text #(\d+) · (\d+) lines\]/g, (whole, id, lines) => {
    const entry = store.pastes.get(Number(id));
    return entry && String(entry.lines) === lines ? entry.text : whole;
  });
}
