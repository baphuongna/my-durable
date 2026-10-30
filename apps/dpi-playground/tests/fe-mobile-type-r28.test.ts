// R28 (live, six rounds of user verdicts) — the mobile/uniform-scale contract:
//   1. every font-size rides rem (base 16px + fallback knob = the only px);
//   2. the whole app renders at a 6-band zoom curve, steps of 0.05, no cliff;
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
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/font-size:\s*([^;}\n]+)/g)) {
      const v = m[1]!.trim();
      const inStyle = f.endsWith("style.css");
      const rem = /^[\d.]+rem( !important)?$/.test(v) || /^clamp\([\d.]+rem,/.test(v);
      const sanctioned =
        inStyle && (v === "16px" || v === "13.5px" || v === "12.5px" || v === "1rem !important" || v === "16px !important");
      if (!rem && !sanctioned) offenders.push(`${f.replace(FE, "")}: ${v}`);
    }
  }
  assert.deepEqual(offenders, [], "non-rem font-size found (raw px ignores the scale; em/% compound)");
  const bases = files.filter((f) => readFileSync(f, "utf8").includes("font-size: 16px"));
  assert.deepEqual(bases, [join(FE, "style.css")], "the 16px base lives only in style.css");
  assert.doesNotMatch(readFileSync(join(FE, "style.css"), "utf8"), /font-size:\s*clamp\([^)]*px/);
});

test("R28 ui scale: the 6-band zoom curve, compensated heights on :root .shell", () => {
  const s = readFileSync(join(FE, "style.css"), "utf8");
  for (const [mw, z] of BANDS) {
    const zs = z.replace(".", "\\.");
    assert.match(s, new RegExp(`${media(mw)}\\s*\\{\\s*:root\\s*\\{\\s*zoom: ${zs};`), `≤${mw} band zooms ${z}`);
    assert.match(
      s,
      new RegExp(`height: var\\(--vvh, calc\\(100dvh \\/ ${zs}\\)\\)`),
      `≤${mw}: shell height = var(--vvh, dvh-calc)`,
    );
  }
  assert.match(s, /:root \.shell \{ height: var\(--vvh, calc\(100dvh \/ 0\.95\)\); \}/);
  assert.match(
    s,
    /@media \(max-width: 740px\)\s*\{[\s\S]*?:root \.shell\s*\{\s*height: var\(--vvh, calc\(100dvh \/ 0\.82\)\);\s*min-height: 0;\s*overflow: hidden;\s*\}/,
    "≤740: fixed-height, non-scrolling shell",
  );
  assert.match(s, /@media \(max-width: 740px\)\s*\{[\s\S]*?\.net-workspace\s*\{\s*overflow: hidden;/, "workspace never scrolls the page");
  assert.match(s, /max-height: calc\(55vh \/ 0\.82\)/, "inspector cap compensated ≤740");
  assert.match(s, /max-height: calc\(55vh \/ 0\.78\)/, "inspector cap compensated ≤550");
  assert.match(s, /@supports not \(zoom: 2\)\s*\{[\s\S]*?@media \(max-width: 740px\)\s*\{\s*:root\s*\{\s*font-size: 13\.5px;/, "rem fallback ≤740");
  assert.match(s, /@media \(max-width: 550px\)\s*\{\s*:root\s*\{\s*font-size: 12\.5px;\s*\}\s*\}/, "rem fallback ≤550");
  assert.match(s, /text-size-adjust: 100%/, "Safari cannot re-inflate");
  assert.doesNotMatch(readFileSync(join(FE, "components/GraphPanel.vue"), "utf8"), /font:\s*[\d.]+px\//, "no px font shorthand");
});

test("R28 keyboard: inputs ride the scale, 16px computed only while editing", () => {
  const s = readFileSync(join(FE, "style.css"), "utf8");
  assert.match(
    s,
    /@media \(max-width: 1599px\)\s*\{\s*input,\s*textarea,\s*select\s*\{[\s\S]*?font-size: 1rem !important;/,
    "inputs = 1rem, the same rendered size as the text around them",
  );
  assert.match(
    s,
    /input:focus,\s*textarea:focus,\s*select:focus\s*\{\s*font-size: 16px !important;/,
    "16px computed exactly while editing (iOS reads it at focus → no auto-zoom)",
  );
  assert.doesNotMatch(s, /var\(--uiz/, "--uiz is gone (it existed only for the oversized input rule)");
  const html = readFileSync(join(FE, "../index.html"), "utf8");
  assert.match(html, /interactive-widget=resizes-content/, "Android/Chrome resize the layout viewport for dvh");
  const main = readFileSync(join(FE, "main.ts"), "utf8");
  assert.match(main, /visualViewport/, "iOS: visualViewport is measured…");
  assert.match(main, /--vvh/, "…and fed to the shell heights");
});

test("R28 no-zoom engines: the fallback shrinks text and never leaks desktop sizes", () => {
  const s = readFileSync(join(FE, "style.css"), "utf8");
  assert.match(s, /@supports not \(zoom: 2\)\s*\{[\s\S]*?@media \(max-width: 740px\)\s*\{\s*:root\s*\{\s*font-size: 13\.5px;/, "rem fallback ≤740");
  assert.match(s, /@media \(max-width: 550px\)\s*\{\s*:root\s*\{\s*font-size: 12\.5px;\s*\}\s*\}/, "rem fallback ≤550");
  assert.doesNotMatch(s, /var\(--uiz/, "no --uiz left to leak a desktop-size divide");
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
