// R28 (live, seven rounds) — the mobile/uniform-scale contract:
//   1. every font-size rides rem (the 16px base + band knobs = the only px);
//   2. ONE code path on EVERY engine: rem type knobs per width band. The
//      zoom architecture is BANNED — @supports lied on legacy Chrome/WebView
//      (claimed zoom, zoom-on-:root misbehaved) and text rendered desktop-size;
//   3. each band divides the shell viewport height by its factor
//      (`:root .shell` — network.css' ≤760 .shell rule loads later);
//   4. ≤740 the shell IS the screen — the document never scrolls, topbar and
//      bottom nav are pinned flex rows;
//   5. the soft keyboard: inputs render the SAME size as surrounding text
//      (1rem), 16px computed only while editing (iOS reads it at focus → no
//      auto-zoom); Android resizes the layout viewport via the viewport meta;
//      iOS measures visualViewport into --vvh;
//   6. engines without zoom take the rem knob as fallback and never leak
//      desktop sizes;
//   7. ONE compact mobile header — every control on a single 42px row,
//      nothing removed, nothing wrapped, no dropdown clipped.
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
  [1599, "15px"],
  [1199, "14.5px"],
  [899, "14px"],
  [740, "13.5px"],
  [550, "13px"],
];
const media = (mw: number) => `@media \\(max-width: ${mw}px\\)`;

test("R28 type scale: every font-size is rem except sanctioned bases", () => {
  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/font-size:\s*([^;}\n]+)/g)) {
      const v = m[1]!.trim();
      const inStyle = f.endsWith("style.css");
      const rem = /^[\d.]+rem( !important)?$/.test(v) || /^clamp\([\d.]+rem,/.test(v);
      const sanctioned =
        inStyle && ["16px", "15px", "14.5px", "14px", "13.5px", "13px", "12.5px", "1rem !important", "16px !important"].includes(v);
      if (!rem && !sanctioned) offenders.push(`${f.replace(FE, "")}: ${v}`);
    }
  }
  assert.deepEqual(offenders, [], "non-rem font-size found (raw px ignores the scale; em/% compound)");
  const bases = files.filter((f) => readFileSync(f, "utf8").includes("font-size: 16px"));
  assert.deepEqual(bases, [join(FE, "style.css")], "the 16px base lives only in style.css");
  assert.doesNotMatch(readFileSync(join(FE, "style.css"), "utf8"), /font-size:\s*clamp\([^)]*px/);
});

test("R28 ui scale: rem knobs per band — one path, zoom banned", () => {
  const s = readFileSync(join(FE, "style.css"), "utf8");
  for (const [mw, fs] of BANDS) {
    const esc = fs.replace(".", "\\.");
    assert.match(
      s,
      new RegExp(`${media(mw)}\\s*\\{\\s*:root\\s*\\{\\s*font-size: ${esc};`),
      `≤${mw} sets the type knob ${fs}`,
    );
  }
  // the zoom architecture is GONE — @supports lied on legacy engines and the
  // ui rendered desktop-size; nothing may reintroduce it or its math
  assert.doesNotMatch(s, /(^|[^-])zoom\s*:/, "no zoom declarations anywhere");
  assert.doesNotMatch(s, /100dvh \/ /, "no viewport-height compensation math");
  assert.doesNotMatch(s, /55vh \/ /, "no vh compensation math");
  assert.doesNotMatch(s, /@supports not \(zoom/, "no zoom fallback split — one path");
  // shell heights: plain viewport height (keyboard via --vvh still); the
  // desktop base .shell{height:100dvh} needs no band override anymore
  assert.match(
    s,
    /@media \(max-width: 740px\)\s*\{[\s\S]*?:root \.shell\s*\{\s*height: var\(--vvh, 100dvh\);\s*min-height: 0;\s*overflow: hidden;/,
    "≤740: fixed-height, non-scrolling shell",
  );
  assert.match(s, /@media \(max-width: 740px\)\s*\{[\s\S]*?\.net-workspace\s*\{\s*overflow: hidden;/, "workspace never scrolls the page");
  assert.match(s, /text-size-adjust: 100%/, "Safari cannot re-inflate");
  assert.doesNotMatch(readFileSync(join(FE, "components/GraphPanel.vue"), "utf8"), /font:\s*[\d.]+px\//, "no px font shorthand");
});

test("R28 keyboard: inputs keep their designed sizes, iOS-only 16px at focus, zero !important", () => {
  const s = readFileSync(join(FE, "style.css"), "utf8");
  // NO forced input font at all — components carry their own rem sizes and
  // scale with the type system (a forced 1rem read bigger than the designed
  // sizes around it — live report). Best practice per the user: no !important.
  assert.equal(
    [...s.matchAll(/font-size:[^;\n]*!important/g)].length,
    0,
    "style.css carries zero font-size !important",
  );
  // iOS alone zooms the viewport when a focused control computes under 16px:
  // 16px at focus, scoped to iOS by -webkit-touch-callout, winning over scoped
  // component styles via :root specificity — never !important
  assert.match(
    s,
    /@supports \(-webkit-touch-callout: none\)\s*\{\s*@media \(max-width: 1599px\)\s*\{\s*:root input:focus,\s*:root textarea:focus,\s*:root select:focus\s*\{\s*font-size: 16px;/,
    "iOS-only 16px at focus",
  );
  // Android/Chrome: the layout viewport (dvh) follows the keyboard
  const html = readFileSync(join(FE, "../index.html"), "utf8");
  assert.match(html, /interactive-widget=resizes-content/, "viewport meta opts into keyboard resize");
  // iOS: visualViewport is measured and fed to the shell heights
  const main = readFileSync(join(FE, "main.ts"), "utf8");
  assert.match(main, /visualViewport/, "iOS: visualViewport is measured…");
  assert.match(main, /--vvh/, "…and fed to the shell heights");
});

test("R28 narrow screens: the toolbar swipes, dropdowns teleport, nothing wraps or hides", () => {
  const s = readFileSync(join(FE, "style.css"), "utf8");
  const tbBlock = s.match(/@media \(max-width: 740px\)\s*\{[\s\S]*?\.topbar\s*\{([^}]*)\}/)![1].replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(tbBlock, /overflow-x:\s*auto/, "the toolbar swipes horizontally instead of clipping");
  assert.match(s, /\.topbar::-webkit-scrollbar\s*\{\s*display: none;/, "hidden scrollbar");
  const topbar = readFileSync(join(FE, "components/TopBar.vue"), "utf8");
  assert.match(topbar, /Teleport to="body"/, "the bell panel escapes the scroll container");
  assert.match(topbar, /\.notif-panel\s*\{\s*position: fixed;/, "panel is viewport-pinned");
  assert.match(topbar, /top: calc\(var\(--topbar-h, 65px\) \+ 5px\)/, "panel clears the bar at every width");
  assert.match(s, /--topbar-h: 42px;/, "mobile declares its 42px bar height");
});

test("R28 header: ONE compact mobile topbar — nothing removed, nothing allowed to wrap", () => {
  const s = readFileSync(join(FE, "style.css"), "utf8");
  assert.match(
    s,
    /@media \(max-width: 740px\)\s*\{[\s\S]*?\.topbar\s*\{\s*position: static;\s*flex-wrap: nowrap;\s*gap: 4px;\s*padding: 0 5px;\s*height: 42px;\s*min-height: 42px;\s*max-height: 42px;/,
    "one 42px pinned row",
  );
  assert.equal([...s.matchAll(/min-height:\s*68px/g)].length, 0, "the 68px header is gone");
  assert.doesNotMatch(s, /\.topbar\s*\{[^}]*height:\s*auto/, "no auto-height topbar anywhere");
  assert.doesNotMatch(s, /\.topbar\s*\{[^}]*flex-wrap:\s*wrap/, "the topbar never wraps on any width");
  assert.doesNotMatch(s, /\.top-actions \.icon-button\s*\{\s*display:\s*none/, "bell/help/toggles stay visible");
  assert.doesNotMatch(s, /\.chip\.connection,\s*\.usage-chip\s*\{\s*display:\s*none/, "connection + usage chips stay visible");
  const topbarBlock = s.match(/@media \(max-width: 740px\)\s*\{[\s\S]*?\.topbar\s*\{([^}]*)\}/)![1].replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(topbarBlock, /overflow:\s*hidden/, "topbar must not clip dropdown panels");
  assert.match(s, /\.brandmark\s*\{\s*width: 24px;\s*height: 14px;/, "24px logo");
  assert.match(s, /\.brand\s*\{\s*gap: 4px;\s*flex-shrink: 0;\s*\}/, "the brand never collapses to nothing (the lost-text bug)");
  assert.match(s, /\.brand strong\s*\{[^}]*flex-shrink: 0;/, "brand text never shrinks away");
  assert.match(s, /\.chip\.connection\s*\{[^}]*max-width: 74px;/, "connection chip capped at 74px");
  assert.match(s, /\.top-actions \.primary\.small\s*\{\s*padding: 0 7px;\s*min-height: 26px;\s*gap: 2px;\s*font-size: 0\.75rem;/, "compact New session");
});

test("R28 body headers: the chat header matches the topbar, no stale offsets", () => {
  const s = readFileSync(join(FE, "style.css"), "utf8");
  assert.match(s, /@media \(max-width: 740px\)\s*\{[\s\S]*?\.chat-header\s*\{\s*padding: 0 10px;\s*min-height: 42px;\s*max-height: 42px;/, "chat header = 42px like the topbar");
  assert.match(s, /@media \(max-width: 740px\)\s*\{[\s\S]*?\.model-button img\s*\{\s*width: 26px;\s*height: 26px;/, "26px model avatar");
  assert.doesNotMatch(s, /@media \(max-width: 740px\)\s*\{[^@]*\.model-button img\s*\{[^}]*40px/, "no 40px avatar anywhere on mobile");
  assert.match(s, /\.drawer-backdrop\s*\{\s*top: 42px;/, "drawer backdrop tracks the 42px header");
  assert.doesNotMatch(s, /top:\s*68px/, "no 68px offsets left");
  assert.match(s, /\.session-heading\s*\{\s*padding: 10px 14px 8px;/, "slim session heading");
});
