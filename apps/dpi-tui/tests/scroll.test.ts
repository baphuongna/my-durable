/**
 * Transcript scroll regression (R5 findings 2+3) — pure, no PTY.
 * Finding 2: the offset counts lines BACK from the tail, so the old
 * `scrollOffset + delta` made j scroll INTO history and clamped k dead at the
 * bottom. New contract: scrollBy's delta moves the absolute top line —
 * k/↑ = -1 = toward older (offset grows), j/↓ = +1 = toward newer (offset
 * shrinks to 0 at the tail).
 * Finding 3: while scrolled up, the viewport top is an ABSOLUTE anchor — new
 * frames must not slide the page; only offset 0 follows the tail.
 * Run: npx tsx --test tests/scroll.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOLLOW_TAIL, scrollBy, viewportTop } from "../src/scroll.ts";

const LEN = 100;
const INNER = 10;
const TAIL_TOP = LEN - INNER; // 90 — the top row while following the tail

test("scroll: k/↑ scrolls INTO history (offset grows) — the old code clamped it dead", () => {
  let s = scrollBy(FOLLOW_TAIL, -1, LEN, INNER);
  assert.equal(s.offset, 1, "one k press did not leave the tail");
  assert.equal(s.top, TAIL_TOP - 1);
  s = scrollBy(s, -1, LEN, INNER);
  s = scrollBy(s, -1, LEN, INNER);
  assert.equal(s.offset, 3, "k presses did not accumulate");
  assert.equal(s.top, TAIL_TOP - 3);
});

test("scroll: j/↓ scrolls toward NEWER (offset shrinks) and releases at the tail", () => {
  const up3 = scrollBy(scrollBy(scrollBy(FOLLOW_TAIL, -1, LEN, INNER), -1, LEN, INNER), -1, LEN, INNER);
  assert.equal(up3.offset, 3);
  let s = scrollBy(up3, 1, LEN, INNER);
  assert.equal(s.offset, 2, "j did not step back toward the tail");
  s = scrollBy(s, 1, LEN, INNER);
  s = scrollBy(s, 1, LEN, INNER);
  assert.deepEqual(s, FOLLOW_TAIL, "reaching the tail did not release the anchor");
  // And one more j at the tail STAYS at the tail — it must never scroll into
  // history (the old code did exactly that).
  assert.deepEqual(scrollBy(FOLLOW_TAIL, 1, LEN, INNER), FOLLOW_TAIL);
});

test("scroll: the j/k inversion pins the exact old-vs-new behavior", () => {
  // Old (wrong): offset + delta → j=+1 grew the offset (into history), k=-1
  // stayed clamped at 0. New: opposite directions, same keys.
  const k = scrollBy(FOLLOW_TAIL, -1, LEN, INNER);
  const j = scrollBy(FOLLOW_TAIL, 1, LEN, INNER);
  assert.equal(k.offset, 1, "k must scroll toward older");
  assert.equal(j.offset, 0, "j at the tail must stay at the tail");
  assert.ok(k.offset > j.offset, "k (older) must be further from the tail than j (newer)");
});

test("anchor: while scrolled up, content growth does NOT move the viewport top", () => {
  const up = scrollBy(FOLLOW_TAIL, -5, LEN, INNER); // top 85, offset 5
  const grown = viewportTop(up, LEN + 20, INNER);
  assert.equal(grown.from, TAIL_TOP - 5, "the absolute anchor slid with growth");
  assert.equal(grown.state.top, TAIL_TOP - 5);
  assert.equal(grown.state.offset, 25, "distance from the tail grows with the content");
  // More frames, still pinned.
  const grownMore = viewportTop(grown.state, LEN + 60, INNER);
  assert.equal(grownMore.from, TAIL_TOP - 5);
});

test("anchor: at offset 0 the viewport follows the tail", () => {
  const follow = viewportTop(FOLLOW_TAIL, LEN, INNER);
  assert.equal(follow.from, TAIL_TOP);
  const grown = viewportTop(follow.state, LEN + 7, INNER);
  assert.equal(grown.from, TAIL_TOP + 7, "tail following did not track growth");
  assert.deepEqual(grown.state, FOLLOW_TAIL);
});

test("anchor: clamps into range when the content shrinks below the anchor", () => {
  const up = scrollBy(FOLLOW_TAIL, -5, LEN, INNER); // top 85, offset 5
  const shrunk = viewportTop(up, 40, INNER); // tailTop = 30 — above the anchor
  assert.equal(shrunk.from, 30, "anchor pointed past the content");
  assert.deepEqual(shrunk.state, FOLLOW_TAIL, "clamped to the tail but kept a stale offset");
});

test("anchor: scroll steps from the pinned anchor, not from the tail", () => {
  const up = scrollBy(FOLLOW_TAIL, -5, LEN, INNER); // top 85
  const upMore = scrollBy(up, -2, LEN, INNER); // k twice more
  assert.equal(upMore.top, TAIL_TOP - 7, "k stepped from the tail, not from the anchor");
  const down = scrollBy(upMore, 1, LEN, INNER);
  assert.equal(down.top, TAIL_TOP - 6, "j stepped the wrong direction");
});

test("anchor: clamps at the document top — offset never exceeds the content", () => {
  let s = FOLLOW_TAIL;
  for (let i = 0; i < 200; i += 1) s = scrollBy(s, -1, LEN, INNER);
  assert.equal(s.top, 0);
  assert.equal(s.offset, TAIL_TOP);
  const view = viewportTop(s, LEN, INNER);
  assert.equal(view.from, 0);
});
