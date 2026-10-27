// Display-width transcript wrapping (R5 finding 1). Pure — unit-testable like
// the views.
//
// The old wrap split each line exactly ONCE on UTF-16 code units
// (`[l.slice(0, w-4), l.slice(w-4)]`): the remainder was never re-wrapped, so
// pi-tui hard-clipped the tail of every overlong row — a 400-char message
// showed ~154 chars at 80 columns. And `l.length` counts UTF-16 units, not
// terminal columns, so CJK/emoji (2 cells each) overflowed their budget and
// got clipped too.
//
// wrapByColumn walks grapheme COLUMNS instead, pi-tui sliceByColumn/truncate
// semantics (the 0.0.53 panelLine lesson): every visible column lands on some
// row (no content loss), and a wide char that would straddle the budget moves
// whole to the next row (strict slice) instead of being clipped mid-glyph.
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Hard-wrap `text` on newlines, then to a display-column budget per row, and
 * indent every row. Budget = width - 4 - indent, the old `w - 4` margin kept
 * (with the indent now counted) so wrapped rows can never reach the frame's
 * hard-clip edge even if a grapheme measures one cell wide in practice.
 */
export function wrapByColumn(text: string, width: number, indent = "  "): string[] {
  const budget = Math.max(4, width - 4 - visibleWidth(indent));
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const total = visibleWidth(line);
    if (total <= budget) {
      out.push(line);
      continue;
    }
    let col = 0;
    while (col < total) {
      const part = sliceByColumn(line, col, budget, true);
      const partWidth = visibleWidth(part);
      if (partWidth <= 0) break; // only zero-width columns remain — nothing visible lost
      out.push(part);
      col += partWidth;
    }
  }
  return out.map((l) => indent + l);
}
