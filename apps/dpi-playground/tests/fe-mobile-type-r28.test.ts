// R28 (live, nine rounds) — the mobile/uniform-scale contract.
// Architecture after all verdicts:
//   - every font-size rides rem; per-band ROOT knobs scale the type
//     (zoom is BANNED — @supports lied on legacy engines);
//   - the compact/mobile layout applies by WIDTH (≤780) **OR by touch**
//     ((max-width: 1100px) and (pointer: coarse)) — a fold-class touch
//     viewport must never sit on desktop rules (live: desktop-size text in a
//     working topbar, oversized composer);
//   - the mobile shell IS the screen; panes scroll inside;
//   - the keyboard shrinks it via --vvh (visualViewport) — Android by meta
//     gone, iOS measured in main.ts; iOS-only 16px at :focus, zero
//     !important;
//   - ONE compact 42px header row, every control reachable, nothing beyond
//     the viewport edge (a swipe bar HIDES items), the bell panel teleported;
//   - the composer shrinks progressively (1100 → 780/touch).
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

/** The compact band: width OR touch. */
const MOBILE = String.raw`@media \(max-width: 780px\), \(max-width: 1100px\) and \(pointer: coarse\)`;
const LEGACY_BAND = String.raw`@media \(max-width: 740px\), \(max-width: 1100px\) and \(pointer: coarse\)`;

test("R28 type scale: every font-size is rem except sanctioned bases", () => {
  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/font-size:\s*([^;}\n]+)/g)) {
      const v = m[1]!.trim();
      const inStyle = f.endsWith("style.css");
      const rem = /^[\d.]+rem( !important)?$/.test(v) || /^clamp\([\d.]+rem,/.test(v);
      const sanctioned =
        inStyle && ["16px", "15px", "14.5px", "14px", "13.5px", "13px", "12.5px", "0", "1rem !important", "16px !important"].includes(v);
      if (!rem && !sanctioned) offenders.push(`${f.replace(FE, "")}: ${v}`);
    }
  }
  assert.deepEqual(offenders, [], "non-rem font-size found (raw px ignores the scale; em/% compound)");
  const bases = files.filter((f) => readFileSync(f, "utf8").includes("font-size: 16px"));
  assert.deepEqual(bases, [join(FE, "style.css")], "the 16px base lives only in style.css");
});

test("R28 ui scale: rem knobs per band — one path, zoom banned", () => {
  const s = readFileSync(join(FE, "style.css"), "utf8");
  for (const [mw, fs] of [[1599, "15px"], [1199, "14.5px"], [899, "14px"], [550, "13px"]] as const)
    assert.match(s, new RegExp(`@media \\(max-width: ${mw}px\\)\\s*\\{\\s*:root\\s*\\{\\s*font-size: ${fs.replace(".", "\\.")};`), `≤${mw} knob ${fs}`);
  assert.match(s, new RegExp(`${LEGACY_BAND}\\s*\\{\\s*:root\\s*\\{\\s*font-size: 13\\.5px;`), "≤740-or-touch knob 13.5px");
  // touch screens ≤1100 read as phones regardless of pixel width
  assert.match(s, /@media \(max-width: 1100px\) and \(pointer: coarse\)\s*\{\s*:root\s*\{\s*font-size: 13\.5px;/, "touch knob");
  assert.doesNotMatch(s, /(^|[^-])zoom\s*:/, "no zoom declarations anywhere");
  assert.doesNotMatch(s, /100dvh \/ /, "no viewport-height compensation math");
  assert.doesNotMatch(s, /@supports not \(zoom/, "no zoom fallback split — one path");
  assert.match(s, /text-size-adjust: 100%/, "Safari cannot re-inflate");
});

test("R28 app shell: fixed height, panes scroll, keyboard via --vvh", () => {
  const s = readFileSync(join(FE, "style.css"), "utf8");
  assert.match(s, new RegExp(`${MOBILE}[\\s\\S]*?:root \\.shell\\s*\\{\\s*height: var\\(--vvh, 100dvh\\);\\s*min-height: 0;\\s*overflow: hidden;`), "the shell IS the screen on the compact band");
  assert.match(s, new RegExp(`${MOBILE}[\\s\\S]*?\\.net-workspace\\s*\\{\\s*overflow: hidden;`), "workspace never scrolls the page");
  const html = readFileSync(join(FE, "../index.html"), "utf8");
  assert.match(html, /width=device-width, initial-scale=1\.0/, "viewport meta pins the device width");
  assert.doesNotMatch(html, /interactive-widget/, "no interactive-widget meta");
  const main = readFileSync(join(FE, "main.ts"), "utf8");
  assert.match(main, /visualViewport/, "iOS: visualViewport measured");
  assert.match(main, /--vvh/, "…fed to the shell heights");
});

test("R28 header: ONE compact 42px row, nothing removed or beyond the edge", () => {
  const s = readFileSync(join(FE, "style.css"), "utf8");
  assert.match(s, new RegExp(`${MOBILE}\\s*\\{[\\s\\S]*?\\.topbar\\s*\\{\\s*position: static;\\s*flex-wrap: nowrap;\\s*gap: 4px;\\s*padding: 0 5px;\\s*height: 42px;`), "one 42px pinned row on the compact band");
  assert.equal([...s.matchAll(/min-height:\s*68px/g)].length, 0, "the 68px header is gone");
  assert.doesNotMatch(s, /\.topbar\s*\{[^}]*height:\s*auto/, "no auto-height topbar anywhere");
  assert.doesNotMatch(s, /\.topbar\s*\{[^}]*flex-wrap:\s*wrap/, "the topbar never wraps");
  assert.match(s, /\.topbar \.tree-toggle,\s*\.topbar \.inspector-toggle\s*\{\s*display: none;/, "toggles defer to the bottom tabs");
  assert.match(s, /\.chip\.connection\s*\{[^}]*font-size: 0;/, "the connection chip collapses to its dot");
  const anchor = s.indexOf(".topbar {\n    position: static;");
  assert.ok(anchor > 0, "the compact topbar block exists");
  const block = s.slice(anchor, s.indexOf("\n  }", anchor));
  assert.match(block, /overflow-x:\s*auto/, "the toolbar swipes instead of clipping");
  const topbar = readFileSync(join(FE, "components/TopBar.vue"), "utf8");
  assert.match(topbar, /Teleport to="body"/, "the bell panel escapes the bar");
  assert.match(topbar, /position: fixed;/, "panel is viewport-pinned");
});

test("R28 body headers: the chat header matches, no stale offsets, no stray wraps", () => {
  const s = readFileSync(join(FE, "style.css"), "utf8");
  assert.match(s, new RegExp(`${MOBILE}\\s*\\{[\\s\\S]*?\\.chat-header\\s*\\{\\s*padding: 0 10px;\\s*min-height: 42px;`), "chat header = 42px on the compact band");
  assert.match(s, new RegExp(`${MOBILE}\\s*\\{[\\s\\S]*?\\.model-button img\\s*\\{\\s*width: 26px;`), "26px avatar");
  assert.match(s, /\.drawer-backdrop\s*\{\s*top: 42px;/, "drawer backdrop tracks the 42px header");
  // the stray BASE wrap (loaded last, overrode every band) stays dead
  assert.doesNotMatch(s, /\.chat-header\s*\{\s*flex-wrap:\s*wrap;\s*\}/, "no base chat-header wrap");
});

test("R28 composer + inputs: shrink progressively; iOS-only 16px at focus; zero !important", () => {
  const s = readFileSync(join(FE, "style.css"), "utf8");
  assert.match(s, /@media \(max-width: 1100px\)\s*\{\s*\.composer textarea\s*\{\s*min-height: 56px;/, "composer ≤1100 → 56px");
  assert.match(s, new RegExp(`${MOBILE}\\s*\\{\\s*\\.composer textarea\\s*\\{\\s*min-height: 40px;`), "compact band composer → 40px");
  assert.match(s, new RegExp(`${MOBILE}\\s*\\{\\s*input,\\s*textarea,\\s*select\\s*\\{\\s*padding: 6px 9px;`), "6/9 input padding");
  assert.equal([...s.matchAll(/font-size:[^;\n]*!important/g)].length, 0, "style.css carries zero font-size !important");
  assert.match(
    s,
    /@supports \(-webkit-touch-callout: none\)\s*\{\s*@media \(max-width: 1599px\)\s*\{\s*:root input:focus,\s*:root textarea:focus,\s*:root select:focus\s*\{\s*font-size: 16px;/,
    "iOS-only 16px at focus",
  );
});

test("R28 mid band (781–1100, mouse): progressive compaction, no desktop blocks leaking", () => {
  const s = readFileSync(join(FE, "style.css"), "utf8");
  assert.match(s, /@media \(max-width: 1100px\)\s*\{\s*\.usage-chip\s*\{\s*display: none;/, "usage defers to the panel ≤1100");
  assert.match(s, /@media \(max-width: 900px\)\s*\{\s*\.chip\.connection\s*\{[^}]*font-size: 0;/, "connection chip is a dot ≤900");
  assert.match(s, /@media \(min-width: 781px\) and \(max-width: 1599px\)/, "the wrap band starts at 781 — no seam with the compact band");
});
