// R28 (live, four rounds of user verdicts): oversized phone text; a
// phone-only shrink was half-done; "make it uniformly small on every
// screen"; the bottom bar/header/sidebar scrolled away on mobile; the form
// broke when the soft keyboard opened. The shipped answer, all pinned here:
//   1. every font-size rides rem (base 16px + the fallback knob = only px);
//   2. the whole app renders at a 6-band zoom curve, steps of 0.05, no cliff;
//   3. each band divides the shell viewport height by its factor
//      (`:root .shell` — network.css' ≤760 .shell rule loads later);
//   4. ≤740 the shell IS the screen (fixed height, overflow hidden) — the
//      document never scrolls, topbar/mnav are pinned flex rows;
//   5. the soft keyboard: shell height prefers the JS-measured visual
//      viewport (--vvh), Android resizes the layout viewport via the
//      interactive-widget meta, and inputs render a 16px minimum so iOS
//      never auto-zooms the form on focus.
// Static source contract — survives every refactor.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FE = new URL("../apps/dpi-playground-fe/src/", import.meta.url).pathname;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith(".css") || p.endsWith(".vue")) yield p;
  }
}

const files = [...walk(FE)];
assert.ok(files.length > 10, `walked the real FE tree (${files.length} css/vue files)`);

const BANDS: [number, string][] = [
  [1599, "0.95"],
  [1199, "0.9"],
  [899, "0.85"],
  [740, "0.82"],
  [550, "0.78"],
];
const media = (mw: number) => `@media \\(max-width: ${mw}px\\)`;

test("R28 type scale: every font-size is rem except sanctioned bases", () => {
  const offenders: string[] = [];
  for (const f of files) {
    const s = readFileSync(f, "utf8");
    for (const m of s.matchAll(/font-size:\s*([^;}\n]+)/g)) {
      const v = m[1]!.trim();
      const inStyle = f.endsWith("style.css");
      const rem = /^[\d.]+rem( !important)?$/.test(v) || /^clamp\([\d.]+rem,/.test(v);
      const sanctioned =
        inStyle && (v === "16px" || v === "13.5px" || v === "12.5px" || v === "calc(16px / var(--uiz, 1)) !important");
      if (!rem && !sanctioned) offenders.push(`${f.replace(FE, "")}: ${v}`);
    }
  }
  assert.deepEqual(offenders, [], "non-rem font-size found (raw px ignores the scale; em/% compound)");
  const bases = files.filter((f) => readFileSync(f, "utf8").includes("font-size: 16px"));
  assert.deepEqual(bases, [join(FE, "style.css")], "the 16px base lives only in style.css");
  assert.doesNotMatch(readFileSync(join(FE, "style.css"), "utf8"), /font-size:\s*clamp\([^)]*px/);
});

test("R28 ui scale: the 6-band zoom curve, --uiz per band, compensated heights on :root .shell", () => {
  const s = readFileSync(join(FE, "style.css"), "utf8");
  for (const [mw, z] of BANDS) {
    const zs = z.replace(".", "\\.");
    // the band declares zoom AND its factor
    assert.match(s, new RegExp(`${media(mw)}\\s*\\{\\s*:root\\s*\\{\\s*zoom: ${zs}; --uiz: ${zs};`), `≤${mw} band`);
    // heights prefer --vvh (keyboard), fall back to the dvh calc
    assert.match(
      s,
      new RegExp(`height: var\\(--vvh, calc\\(100dvh \\/ ${zs}\\)\\)`),
      `≤${mw}: shell height = var(--vvh, dvh-calc)`,
    );
  }
  // :root .shell specificity — plain .shell loses to network.css' ≤760 rule
  assert.match(s, /:root \.shell \{ height: var\(--vvh, calc\(100dvh \/ 0\.95\)\); \}/);
  // ≤740: the shell IS the screen
  assert.match(
    s,
    /@media \(max-width: 740px\)\s*\{[\s\S]*?:root \.shell\s*\{\s*height: var\(--vvh, calc\(100dvh \/ 0\.82\)\);\s*min-height: 0;\s*overflow: hidden;\s*\}/,
    "≤740: fixed-height, non-scrolling shell",
  );
  assert.match(s, /@media \(max-width: 740px\)\s*\{[\s\S]*?\.net-workspace\s*\{\s*overflow: hidden;/, "workspace never scrolls the page");
  assert.match(s, /\.topbar\s*\{\s*position: static;\s*padding: 0 12px;\s*height: 58px;\s*min-height: 58px;\s*flex: 0 0 auto;/, "header is a pinned flex row");
  assert.match(s, /max-height: calc\(55vh \/ 0\.82\)/, "inspector cap compensated ≤740");
  assert.match(s, /max-height: calc\(55vh \/ 0\.78\)/, "inspector cap compensated ≤550");
  assert.match(s, /@supports not \(zoom: 2\)\s*\{\s*@media \(max-width: 740px\)\s*\{\s*:root\s*\{\s*font-size: 13\.5px;/, "rem fallback ≤740");
  assert.match(s, /@media \(max-width: 550px\)\s*\{\s*:root\s*\{\s*font-size: 12\.5px;\s*\}\s*\}/, "rem fallback ≤550");
  assert.match(s, /text-size-adjust: 100%/, "Safari cannot re-inflate");
  assert.doesNotMatch(readFileSync(join(FE, "components/GraphPanel.vue"), "utf8"), /font:\s*[\d.]+px\//, "no px font shorthand");
});

test("R28 keyboard: visual-viewport shell, 16px inputs, resize meta", () => {
  const s = readFileSync(join(FE, "style.css"), "utf8");
  assert.match(
    s,
    /@media \(max-width: 1599px\)\s*\{\s*input,\s*textarea,\s*select\s*\{\s*font-size: calc\(16px \/ var\(--uiz, 1\)\) !important;/,
    "inputs render 16px on every zoomed band (iOS would focus-zoom otherwise)",
  );
  const html = readFileSync(join(FE, "../index.html"), "utf8");
  assert.match(html, /interactive-widget=resizes-content/, "Android/Chrome resize the layout viewport for dvh");
  const main = readFileSync(join(FE, "main.ts"), "utf8");
  assert.match(main, /visualViewport/, "iOS: visualViewport is measured…");
  assert.match(main, /--vvh/, "…and fed to the shell heights");
});
