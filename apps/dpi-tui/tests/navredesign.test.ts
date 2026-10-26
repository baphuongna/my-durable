/**
 * Navigation redesign (v0.0.52) — unit level: digit keys 1-4 map EXACTLY to
 * the viewbar labels, and renderViewbar is width-exact at every advertised
 * width with the digits present. Pure string builders, no PTY.
 * Run: npx tsx --test tests/navredesign.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { VIEW_TABS, renderViewbar, type View } from "../src/views.ts";
import { stripAnsi } from "./harness/strip.ts";

test("VIEW_TABS: order and labels are exactly network/herd/agent/log", () => {
  assert.deepEqual(
    VIEW_TABS.map((t) => t.id),
    ["network", "herd", "agent", "log"],
  );
  assert.deepEqual(
    VIEW_TABS.map((t) => t.label),
    ["network", "herd", "agent", "log"],
  );
});

test("renderViewbar: every tab carries its digit — '1 network', '2 herd', '3 agent', '4 log'", () => {
  for (const view of ["network", "herd", "agent", "log"] as View[]) {
    const bar = stripAnsi(renderViewbar(120, view, ""));
    for (const label of ["1 network", "2 herd", "3 agent", "4 log"]) {
      assert.ok(bar.includes(label), `${view} viewbar missing "${label}": ${bar}`);
    }
  }
});

test("renderViewbar: digit order matches VIEW_TABS order (1 = first tab, 4 = last)", () => {
  const bar = stripAnsi(renderViewbar(120, "log", ""));
  const pos = (s: string) => bar.indexOf(s);
  assert.ok(
    pos("1 network") < pos("2 herd") && pos("2 herd") < pos("3 agent") && pos("3 agent") < pos("4 log"),
    `tab digits out of order: ${bar}`,
  );
});

test("renderViewbar: width-exact at 200/100/60/40 columns with the digits still present", () => {
  for (const w of [200, 100, 60, 40]) {
    for (const view of ["network", "herd", "agent", "log"] as View[]) {
      const line = renderViewbar(w, view, "ctx 50%  dev keybox");
      assert.equal(visibleWidth(line), w, `viewbar width !== ${w} for ${view}`);
      const bar = stripAnsi(line);
      // At the narrowest widths truncation may eat trailing tabs, but the
      // digit+label pairs that survive must never be garbled or duplicated.
      for (const label of ["1 network", "2 herd", "3 agent", "4 log"]) {
        if (bar.includes(label.slice(0, 4))) {
          assert.ok(bar.includes(label), `width ${w} ${view}: garbled tab "${label}" in: ${bar}`);
        }
      }
    }
  }
});
