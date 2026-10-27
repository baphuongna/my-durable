/**
 * Transcript wrap regression (R5 finding 1) — the old wrap() split each line
 * exactly ONCE on UTF-16 units: the remainder was never re-wrapped and
 * pi-tui hard-clipped it, so a 400-char message showed ~154 chars at 80
 * columns, and CJK/emoji (2 cells per glyph) overflowed their budget because
 * `l.length` counts UTF-16 units, not display columns. wrapByColumn must
 * lose NOTHING (every visible column lands on some row) and never exceed the
 * frame width. Pure — no PTY.
 * Run: npx tsx --test tests/wrap.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { wrapByColumn } from "../src/wrap.ts";
import { stripAnsi } from "./harness/strip.ts";

test("wrap: a 400-char line at width 80 wraps over multiple rows with ZERO loss", () => {
  const line = "x".repeat(400);
  const rows = wrapByColumn(line, 80);
  assert.ok(rows.length > 2, `expected several rows, got ${rows.length}`);
  for (const row of rows) assert.ok(visibleWidth(row) <= 80, `row ${visibleWidth(row)} > 80: ${row}`);
  // No loss: stripping the two-space indent and re-joining rebuilds the input.
  assert.equal(rows.map((r) => stripAnsi(r).slice(2)).join(""), line);
  // Every wrapped row is full except the last — the old single-split left the
  // tail raw and unindented.
  for (const row of rows.slice(0, -1)) assert.equal(stripAnsi(row).length, rows[0]!.length, "ragged full rows");
  assert.ok(stripAnsi(rows.at(-1)!).length > 0, "empty tail row");
});

test("wrap: the old bug's shape — remainder is wrapped too, not left raw", () => {
  // 100 chars at width 20: the old code produced exactly
  // [16-unit head, 84-unit raw tail] — the tail then hard-clipped.
  const rows = wrapByColumn("y".repeat(100), 20);
  // budget = 20 - 4 - 2(indent) = 14 columns per row
  assert.equal(rows.length, Math.ceil(100 / 14), `expected full re-wrap, got ${rows.length} rows`);
  for (const row of rows) assert.ok(visibleWidth(row) <= 20, `row overflows: ${row}`);
});

test("wrap: CJK text counts 2 cells per glyph and never splits a character", () => {
  // 60 CJK glyphs = 120 display columns; each row's budget at width 24 is 18
  // columns = 9 glyphs per row, all whole.
  const line = "漢字テキスト".repeat(12);
  const rows = wrapByColumn(line, 24);
  assert.ok(rows.length >= 2, `CJK line did not wrap: ${rows.length}`);
  for (const row of rows) assert.ok(visibleWidth(row) <= 24, `CJK row ${visibleWidth(row)} > 24: ${row}`);
  // No loss across glyph boundaries (strict slice moves wide chars whole).
  assert.equal(rows.map((r) => stripAnsi(r).slice(2)).join(""), line);
});

test("wrap: emoji (surrogate pairs + ZWJ) stay whole and lossless", () => {
  const line = "🚀✨🙂".repeat(20); // astral chars — UTF-16 length ≠ display width
  for (const w of [80, 40, 21]) {
    const rows = wrapByColumn(line, w);
    for (const row of rows) assert.ok(visibleWidth(row) <= w, `emoji row ${visibleWidth(row)} > ${w}`);
    assert.equal(rows.map((r) => stripAnsi(r).slice(2)).join(""), line, `loss at width ${w}`);
  }
});

test("wrap: newlines structure the output; short lines pass through untouched", () => {
  const rows = wrapByColumn("one\ntwo\nthree", 80);
  assert.deepEqual(rows.map((r) => stripAnsi(r)), ["  one", "  two", "  three"]);
  const styled = wrapByColumn("plain", 80);
  assert.deepEqual(styled, ["  plain"]);
});

test("wrap: no-loss invariant across widths for mixed content (the audit's 400-char + CJK cases)", () => {
  const cases = [
    "a".repeat(400),
    "漢字".repeat(200),
    `mixed ${"b".repeat(300)} 漢字テスト ${"🚀".repeat(50)} tail`,
  ];
  for (const w of [200, 120, 80, 60, 41]) {
    for (const text of cases) {
      const rows = wrapByColumn(text, w);
      assert.equal(rows.map((r) => stripAnsi(r).slice(2)).join(""), text, `content loss at width ${w}`);
      for (const row of rows) assert.ok(visibleWidth(row) <= w, `row ${visibleWidth(row)} > ${w} at width ${w}`);
    }
  }
});
