// R28 (final architecture, ~10 rounds of live verdicts):
//   - EVERY dimension in the stylesheets is rem (text, spacing, boxes, radii,
//     offsets, icons via svg.lucide em) — the per-band ROOT font-size knob is
//     the single scale control, so the whole ui shrinks/grows UNIFORMLY on
//     every engine (zoom was banned after @supports lied on legacy WebView);
//   - the compact band is width ≤780 OR touch ≤1100 (pointer: coarse);
//   - the mobile shell is a fixed-height frame; panes scroll inside; the
//     keyboard shrinks it via --vvh; iOS-only 16px at :focus; ZERO !important
//     in font rules;
//   - structural compaction stays: icon-only crumbs, dot chip, toggles defer
//     to the bottom tabs, tables scroll inside the chat, teleported dropdown.
// px survives ONLY in: @media conditions (viewport units), 1px hairlines,
// box-shadows, and the sanctioned font sizes (base/knob/10px-toolbar/focus).
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
assert.ok(files.length > 10, `walked the real FE tree (${files.length} files)`);

const PX_ALLOWED_CONTEXT = /box-shadow|text-shadow/;

function pxViolations(src: string): string[] {
  const out: string[] = [];
  // strip comments; split off @media condition lines (viewport px is correct)
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const line of noComments.split("\n")) {
    if (/@media|@import|@font-face/.test(line)) continue;
    for (const m of line.matchAll(/(\d+(?:\.\d+)?)px/g)) {
      const v = m[1]!;
      if (v === "0" || v === "1") continue; // 0 is nothing, 1px hairlines stay crisp
      out.push(`${v}px :: ${line.trim().slice(0, 90)}`);
    }
  }
  return out;
}

test("R28 scale: no stray px anywhere — every dimension rides rem", () => {
  let offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const styleOnly = f.endsWith(".vue") ? [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n") : src;
    for (const v of pxViolations(styleOnly)) offenders.push(`${f.replace(FE, "")}: ${v}`);
  }
  // the sanctioned NON-rem font sizes (base, knobs, 10px toolbar, iOS focus)
  const allowedFontPx = /font-size:\s*(16|15|14\.5|14|13\.5|13|12\.5|10)px\s*(!important)?\s*;/;
  offenders = offenders.filter((line) => !/font-size/.test(line) || !allowedFontPx.test(line));
  // box-shadows keep px (blur radii don't read as size)
  offenders = offenders.filter((line) => !/box-shadow|text-shadow/i.test(line));
  assert.deepEqual(offenders, [], "raw px leaked into the rem scale");
});

test("R28 scale: the type knobs + the icons ride em", () => {
  const s = readFileSync(join(FE, "style.css"), "utf8");
  for (const [mw, fs] of [[1599, "15px"], [1199, "14.5px"], [899, "14px"], [550, "13px"]] as const)
    assert.match(s, new RegExp(`@media \\(max-width: ${mw}px\\)\\s*\\{\\s*:root\\s*\\{\\s*font-size: ${fs.replace(".", "\\.")};`), `≤${mw} knob ${fs}`);
  assert.match(s, /@media \(max-width: 740px\), \(max-width: 1100px\) and \(pointer: coarse\)\s*\{\s*:root\s*\{\s*font-size: 13\.5px;/, "≤740-or-touch knob 13.5px");
  assert.match(s, /svg\.lucide\s*\{\s*width: 1\.125em;\s*height: 1\.125em;/, "icons scale with text via em");
  assert.match(s, /text-size-adjust: 100%/, "Safari cannot re-inflate");
  assert.doesNotMatch(s, /(^|[^-])zoom\s*:/, "zoom stays banned");
  assert.doesNotMatch(s, /@supports not \(zoom/, "no zoom fallback split");
});

test("R28 app shell + keyboard: fixed-height frame, --vvh, iOS-only focus 16px, zero font !important", () => {
  const s = readFileSync(join(FE, "style.css"), "utf8");
  assert.match(s, new RegExp(String.raw`@media \(max-width: 780px\), \(max-width: 1100px\) and \(pointer: coarse\)[\s\S]*?:root \.shell\s*\{\s*height: var\(--vvh, 100dvh\);\s*min-height: 0;\s*overflow: hidden;`), "the shell IS the screen on the compact band");
  assert.match(s, new RegExp(String.raw`@media \(max-width: 780px\), \(max-width: 1100px\) and \(pointer: coarse\)[\s\S]*?\.net-workspace\s*\{\s*overflow: hidden;`), "workspace never scrolls the page");
  const html = readFileSync(join(FE, "../index.html"), "utf8");
  assert.match(html, /width=device-width, initial-scale=1\.0/, "viewport meta pins device width");
  assert.doesNotMatch(html, /interactive-widget/, "no interactive-widget meta");
  const main = readFileSync(join(FE, "main.ts"), "utf8");
  assert.match(main, /visualViewport/);
  assert.match(main, /--vvh/);
  // iOS-only 16px at focus (scoped by -webkit-touch-callout), never !important
  assert.match(s, /@supports \(-webkit-touch-callout: none\)\s*\{\s*@media \(max-width: 1599px\)\s*\{\s*:root input:focus,\s*:root textarea:focus,\s*:root select:focus\s*\{\s*font-size: 16px;/, "iOS-only 16px at focus");
  assert.equal([...s.matchAll(/font-size:[^;\n]*!important/g)].length, 0, "zero font-size !important");
});

test("R28 structure: icon-only crumbs, dot chip, deferred toggles, contained tables, teleported panel", () => {
  const s = readFileSync(join(FE, "style.css"), "utf8");
  assert.match(s, /\.topbar \.tree-toggle,\s*\.topbar \.inspector-toggle\s*\{\s*display: none;/, "toggles defer to the bottom tabs");
  assert.match(s, /\.crumb-kind\s*\{\s*display: none;/, "decorative crumb labels hidden");
  assert.match(s, /\.crumbs \.crumb\s*\{\s*flex-direction: row;/, "crumbs are a horizontal row");
  assert.match(s, /\.crumb \.device-chip,\s*\.crumb-name,\s*\.git-chip \.branch\s*\{\s*display: none;/, "icon-only crumbs");
  assert.match(s, /@media \(max-width: 1100px\)\s*\{\s*\.usage-chip\s*\{\s*display: none;/, "usage defers to the Usage panel");
  assert.match(s, /\.markdown table\s*\{\s*display: block;/, "tables scroll inside the chat");
  assert.match(s, /\.chat-header\s*\{\s*position: relative;\s*z-index: 2;/, "the header paints above escaped content");
  const topbar = readFileSync(join(FE, "components/TopBar.vue"), "utf8");
  assert.match(topbar, /Teleport to="body"/, "the bell panel escapes the scroll container");
});

test("R28 band semantics: the compact band is 780-or-touch, the wrap band starts at 781", () => {
  const s = readFileSync(join(FE, "style.css"), "utf8");
  assert.match(s, /@media \(min-width: 781px\) and \(max-width: 1599px\)/, "no seam between the compact band and the wrap band");
  assert.match(s, /@media \(max-width: 1100px\)\s*\{\s*\.usage-chip\s*\{\s*display: none;/, "usage defers ≤1100");
  assert.match(s, /@media \(max-width: 900px\)\s*\{\s*\.chip\.connection\s*\{[^}]*font-size: 0;/, "connection chip is a dot ≤900");
  assert.match(s, /\.drawer-backdrop\s*\{[^}]*inset: var\(--topbar-h\) 0 0;/, "drawer backdrop tracks the bar height");
});

// ── r29 uniform restatement ban: one font-size per element on EVERY band ──
// The compact-band media blocks may not restate a font-size for an element
// that already has one outside them — that double-shrinks (or grows) parts
// of the UI against the knob. Only the sanctioned list survives.
test("r29 uniform: no band-dependent font-size restatements (one value per element)", () => {
  const css = readFileSync(FE + "style.css", "utf8");
  const allowed = new Set([
    ":root", // the knobs themselves
    ".welcome h1", // clamp fluid hero (0.0.99, user-approved)
    ".chip.connection", // dot: font-size 0 hides text
    ".mnav button", ".mnav .badge", // mobile-only element: single value, not a restatement
    ".composer-left .queue-mode select", // 10px toolbar trio (0.0.105, user-requested)
    '.composer-toolbar button[title*="Stop foreground"]',
    ".composer-toolbar .send",
    "input:focus", "textarea:focus", "select:focus", // iOS 16px-at-focus
    ":root input:focus", ":root textarea:focus", ":root select:focus",
  ]);
  const offenders: string[] = [];
  // walk media blocks that are compact bands
  const re = /@media \([^)]*max-width: 780px\)[^\{]*\{([\s\S]*?)\n\}\n/g;
  let m: RegExpExecArray | null;
  const seen = new Set();
  while ((m = re.exec(css))) {
    const block = m[1];
    const fr = /([.:#\w\-\[\]"'=* ,()>]+)\s*\{[^}]*?font-size:\s*([^;]+);/g;
    let f: RegExpExecArray | null;
    while ((f = fr.exec(block))) {
      const sel = f[1].trim();
      const val = f[2].trim();
      if (val === "0" || val.startsWith("clamp(")) continue; // dot-hiding + fluid hero are structural
      const key = sel + "→" + val;
      if (seen.has(key)) continue;
      seen.add(key);
      if (![...allowed].some(a => sel === a || sel.includes(a))) offenders.push(key);
    }
  }
  assert.deepStrictEqual(offenders, [], "band-dependent font-size restatements found (each element must keep ONE value across bands): " + offenders.join(", "));
});

test("r29 uniform: git lanes ride the scale (viewBox + rem, no px attrs)", () => {
  const gp = readFileSync(FE + "components/GitPanel.vue", "utf8");
  assert.match(gp, /class="lane" :viewBox=/, "lane svg must carry a viewBox so internals scale");
  assert.match(gp, /height: '1\.5rem'/, "lane height must be rem (rides the knob)");
  assert.doesNotMatch(gp, /class="lane"[^>]*height="24"/, "no px height attr on lanes");
});

// ── r29 spacing rhythm: content areas must not restate spacing per band ──
// Same disease as fonts, second layer: compact-band gap/padding/margin
// restatements double-shrank the rhythm (welcome gap 31→17 etc.). Fit zones
// (topbar, composer, mnav, crumbs, chips, banners, tabs) stay allowed.
test("r29 uniform: no compact-band spacing restatements outside the fit zones", () => {
  const css = readFileSync(FE + "style.css", "utf8");
  const rhythm = [".welcome-features", ".welcome-symbol", ".modal", ".markdown ul", ".markdown ol", ".message-label", ".inspector-body", ".session-heading,", ".model-section"];
  const offenders: string[] = [];
  const re = /@media \([^)]*max-width: 780px\)[^\{]*\{([\s\S]*?)\n\}\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    for (const line of m[1].split("\n")) {
      const t = line.trim();
      if (!/(padding|margin|gap)[a-z-]*:/.test(t)) continue;
      for (const sel of rhythm) {
        if (css.slice(Math.max(0, m.index), m.index).length >= 0) break;
      }
      // attribute the decl to its selector: walk back to the nearest "{" header
      const idx = m[1].split("\n").indexOf(line);
      const head = m[1].split("\n").slice(0, idx).reverse().find((l) => l.includes("{"));
      const owner = (head || "").trim().replace("{", "");
      if (rhythm.some((r) => owner === r || owner.startsWith(r.replace(/,$/, "") + " {"))) offenders.push(owner + " → " + t);
    }
  }
  assert.deepStrictEqual(offenders, [], "compact-band spacing restatements in rhythm selectors: " + offenders.join("; "));
});
