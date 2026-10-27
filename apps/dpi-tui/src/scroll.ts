// Transcript viewport math (R5 findings 2+3). Pure — no TTY, no timers — so
// the scroll model is unit-testable exactly like the views.
//
// The old model stored ONLY an offset counted back from the END of the
// content and recomputed the top as `content.length - inner - offset` every
// frame. Two bugs fell out of that:
//   • j/k deltas added straight onto the offset, so j scrolled INTO history
//     and k clamped dead at the bottom (the offset's direction was inverted
//     relative to the keys);
//   • every new frame grew content.length, which SLID a scrolled-back viewport
//     down through history (top row AGENT #10 → #11) — autoscroll fighting the
//     user who had explicitly scrolled away from the tail.
// ScrollState fixes both: `top` is an ABSOLUTE line index pinned while
// offset > 0, and scrollBy()'s delta moves the top line, not the tail
// distance — j/↓ = +1 = toward newer, k/↑ = -1 = toward older.

export interface ScrollState {
  /** Lines back from the tail; 0 = follow the tail (top is ignored). */
  offset: number;
  /** Absolute top line of the viewport while offset > 0. */
  top: number;
}

/** Following the tail: offset 0, newest content visible. */
export const FOLLOW_TAIL: ScrollState = { offset: 0, top: 0 };

const tailTopOf = (contentLen: number, inner: number) => Math.max(0, contentLen - inner);

/**
 * Step the viewport. `deltaTop > 0` moves the top line DOWN the document
 * (toward newer content — the j/↓ direction), `deltaTop < 0` moves it UP
 * (toward older — k/↑). From the follow-tail state, scrolling up first pins
 * the anchor at the tail top, then steps it; scrolling back down to the tail
 * releases the anchor (offset 0 again).
 */
export function scrollBy(s: ScrollState, deltaTop: number, contentLen: number, inner: number): ScrollState {
  const tailTop = tailTopOf(contentLen, inner);
  const base = s.offset === 0 ? tailTop : s.top;
  const top = Math.max(0, Math.min(tailTop, base + deltaTop));
  return top >= tailTop ? FOLLOW_TAIL : { offset: tailTop - top, top };
}

/**
 * The viewport's absolute top line for a render, with the state to persist.
 * While offset > 0 the anchor is honored as-is (clamped into range): content
 * growth must NOT slide the viewport. While offset = 0 the tail is followed.
 * The returned state is re-clamped, so a shrunken transcript falls back to the
 * tail instead of pinning past the end.
 */
export function viewportTop(
  s: ScrollState,
  contentLen: number,
  inner: number,
): { from: number; state: ScrollState } {
  const tailTop = tailTopOf(contentLen, inner);
  if (s.offset === 0) return { from: tailTop, state: FOLLOW_TAIL };
  const from = Math.max(0, Math.min(tailTop, s.top));
  return from >= tailTop ? { from, state: FOLLOW_TAIL } : { from, state: { offset: tailTop - from, top: from } };
}
