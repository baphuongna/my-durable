// R16 reply-to-passage (Unit A): shared quote state behind the composer's
// reply strip. Unit B (transcript selection) calls setQuote() through this
// same composable — module-singleton state, so every caller sees the one
// live quote. Composer renders the strip (oneLine excerpt, × to clear, Esc
// clears) and folds the quote into the outgoing message as a Markdown
// blockquote.
import { reactive } from "vue";
import { oneLineExcerpt } from "./paste";

export const QUOTE_MAX = 1500;

export interface ReplyQuote {
  text: string;
  srcLabel: string;
}

/** Cap at `max` characters including the trailing ellipsis, cutting at the
 *  last word boundary so a stored quote never ends mid-word. */
export function capAtWordBoundary(text: string, max: number): string {
  const clean = text.replace(/\r\n?/g, "\n").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  const head = (space >= Math.floor(max / 2) ? cut.slice(0, space) : cut).trimEnd();
  return head + "…";
}

const state = reactive({ quoted: null as ReplyQuote | null });

function setQuote(text: string, srcLabel: string): void {
  const body = capAtWordBoundary(text, QUOTE_MAX);
  if (!body) {
    state.quoted = null; // a blank quote is a clear, never an empty strip
    return;
  }
  state.quoted = { text: body, srcLabel: oneLineExcerpt(srcLabel, 80) };
}

function clear(): void {
  state.quoted = null;
}

export interface ReplyQuoteState {
  readonly quoted: ReplyQuote | null;
  setQuote(text: string, srcLabel: string): void;
  clear(): void;
}

/** The Unit A contract Unit B imports — exact shape, module-singleton state. */
export function useReplyQuote(): ReplyQuoteState {
  return {
    get quoted() {
      return state.quoted;
    },
    setQuote,
    clear,
  };
}

/** Fold the quote into the outgoing message: every quoted line prefixed
 *  "> " (empty lines become bare ">"), attribution as the last blockquote
 *  line, blank line, then the user's own text. */
export function buildQuotedMessage(quoted: ReplyQuote, userText: string): string {
  const lines = quoted.text.split("\n").map((l) => `> ${l}`.replace(/[ \t]+$/, ""));
  const label = oneLineExcerpt(quoted.srcLabel, 80);
  return `${lines.join("\n")}\n> — ${label}\n\n${userText}`;
}
