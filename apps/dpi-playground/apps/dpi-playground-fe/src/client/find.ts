// R16 find-in-session + reply-to-passage selection (Unit B): pure transcript
// search and selection targeting — no DOM, no store, no Vue — so the
// FindOverlay, AgentView's selection wiring and the node tests all share one
// flatten. Every excerpt goes through Unit A's oneLineExcerpt (paste.ts)
// before it is rendered, per the r15 sanitize discipline.
import type { TranscriptItem } from "@sdk/transcript";
import { oneLineExcerpt } from "./paste";

export interface SearchHit {
  itemId: string | number;
  /** Char offset of the match inside the entry's flattened text. */
  index: number;
  /** ≤160 chars around the match, one sanitized line. */
  excerpt: string;
}

export const MAX_FIND_RESULTS = 200;
const EXCERPT_LEN = 160;

/** Full text as one sanitized line with no cap (matching happens on this). */
const flatLine = (text: string): string => oneLineExcerpt(text, Number.MAX_SAFE_INTEGER);

/** Markdown → plain text: fenced code keeps its body, links keep their label,
 *  tags/heading marks/quote markers/bullets/emphasis drop out. Approximate on
 *  purpose — this feeds search, never rendering. */
function stripMarkdown(md: string): string {
  return md
    .replace(/```[^\n]*\n?/g, "")
    .replace(/~~~[^\n]*\n?/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]{0,3}>[ \t]?/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "")
    .replace(/^[ \t]*\d+[.)][ \t]+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/(^|\s)_([^_]+)_(?=\s|$)/gm, "$1$2")
    .replace(/~~([^~]+)~~/g, "$1");
}

/** The searchable text of one entry. Live `tool` slots carry no stable text —
 *  their results render from the tool-result entry, which is searched there. */
function itemText(item: TranscriptItem): string {
  switch (item.kind) {
    case "user":
      return item.text;
    case "assistant":
      return item.blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    case "tool-result":
      return `${item.name}: ${item.text}`;
    case "event":
      return item.note ? `${item.text}\n${item.note}` : item.text;
    default:
      return "";
  }
}

/** ≤EXCERPT_LEN chars centered on the match, one line, "…" when clipped. */
function excerptAround(text: string, at: number, len: number): string {
  if (len >= EXCERPT_LEN) return oneLineExcerpt(text.slice(at, at + EXCERPT_LEN), EXCERPT_LEN);
  const room = EXCERPT_LEN - len;
  let start = at - Math.floor(room / 2);
  let end = start + EXCERPT_LEN;
  if (start < 0) {
    start = 0;
    end = Math.min(text.length, EXCERPT_LEN);
  }
  if (end > text.length) {
    end = text.length;
    start = Math.max(0, end - EXCERPT_LEN);
  }
  const core = text.slice(start, end).trim();
  return oneLineExcerpt(
    (start > 0 ? "…" : "") + core + (end < text.length ? "…" : ""),
    EXCERPT_LEN,
  );
}

/** Search the loaded transcript, newest entry first: case-insensitive over
 *  flattened (markdown-stripped, one-line) text. Whitespace-only queries
 *  return nothing; results cap at MAX_FIND_RESULTS. */
export function searchTranscript(
  items: readonly TranscriptItem[],
  query: string,
): SearchHit[] {
  const needle = flatLine(query).toLowerCase();
  if (!needle) return [];
  const hits: SearchHit[] = [];
  for (let i = items.length - 1; i >= 0 && hits.length < MAX_FIND_RESULTS; i--) {
    const item = items[i];
    const text = flatLine(stripMarkdown(itemText(item)));
    const lower = text.toLowerCase();
    for (
      let at = lower.indexOf(needle);
      at >= 0 && hits.length < MAX_FIND_RESULTS;
      at = lower.indexOf(needle, at + needle.length)
    )
      hits.push({ itemId: item.id, index: at, excerpt: excerptAround(text, at, needle.length) });
  }
  return hits;
}

// ------------------------------------------------------------- reply targeting

export interface ReplyEntry {
  id: string | number;
  /** The transcript kind — only assistant ("Pi") replies can be quoted. */
  role: string;
}

export interface SelectionProbe {
  /** data-entry-id of the entry holding the selection's anchor/focus, or null
   *  when the selection reaches outside the transcript. */
  anchorId: string | null;
  focusId: string | null;
  /** window.getSelection().toString() as the caller captured it. */
  text: string;
}

export interface ReplyTarget {
  entryId: string | number;
  excerpt: string;
  label: string;
}

/** A selection becomes a reply quote only when it lies inside exactly ONE
 *  assistant reply — user messages and sweeps across two entries never quote.
 *  Pure: the caller resolves DOM nodes to entry ids, this decides. The excerpt
 *  is one sanitized line; Unit A's quote contract caps it at 1500. */
export function pickAssistantReply(
  entries: readonly ReplyEntry[],
  probe: SelectionProbe,
): ReplyTarget | null {
  const excerpt = flatLine(probe.text);
  if (!excerpt || !probe.anchorId || !probe.focusId) return null;
  const anchor = entries.find((e) => String(e.id) === probe.anchorId);
  const focus = entries.find((e) => String(e.id) === probe.focusId);
  if (!anchor || !focus || anchor !== focus) return null;
  if (anchor.role !== "assistant") return null;
  return { entryId: anchor.id, excerpt, label: `Pi · entry #${anchor.id}` };
}
