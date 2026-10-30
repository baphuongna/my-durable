// R28 (live): 16px type read oversized on phones. The whole type scale now
// rides rem with ONE mobile knob, so this test pins the invariant forever:
//  - every font-size in src is rem, EXCEPT the sanctioned :root 16px base and
//    the two knob overrides (raw px elsewhere would ignore the knob; %/em
//    would compound against it);
//  - the knob exists at both breakpoints;
//  - text-size-adjust is pinned so mobile Safari cannot re-inflate.
// Level: static source contract (no build needed — the rule is about SOURCE).
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

test("R28 type scale: every font-size is rem except the sanctioned :root base", () => {
  const offenders: string[] = [];
  for (const f of files) {
    const s = readFileSync(f, "utf8");
    for (const m of s.matchAll(/font-size:\s*([^;}\n]+)/g)) {
      const v = m[1]!.trim();
      const inStyle = f.endsWith("style.css");
      const rem = /^[\d.]+rem( !important)?$/.test(v) || /^clamp\([\d.]+rem,/.test(v); // rem-based clamp (e.g. the hero headline)
      // the single desktop base, and the two knob values (both in style.css)
      const sanctioned = (v === "16px" || v === "13.5px" || v === "12.5px") && inStyle;
      if (!rem && !sanctioned) offenders.push(`${f.replace(FE, "")}: ${v}`);
    }
  }
  assert.deepEqual(offenders, [], "non-rem font-size found (raw px ignores the mobile knob; em/% compound)");
  // the hero clamp is rem too, so even the display headline follows the knob
  assert.doesNotMatch(readFileSync(join(FE, "style.css"), "utf8"), /font-size:\s*clamp\([^)]*px/);
  // the base exists exactly once
  const bases = files.filter((f) => readFileSync(f, "utf8").includes("font-size: 16px"));
  assert.deepEqual(bases, [join(FE, "style.css")], "the 16px base lives only in style.css");
});

test("R28 mobile: the WHOLE ui scales — zoom is the knob, vh heights are compensated, rem scale is the fallback", () => {
  const s = readFileSync(join(FE, "style.css"), "utf8");
  // uniform shrink on modern engines: type + spacing + icons together
  assert.match(s, /@media \(max-width: 740px\)\s*\{\s*:root\s*\{\s*zoom: 0\.85;/s, "the ≤740 zoom knob");
  assert.match(s, /@media \(max-width: 390px\)\s*\{\s*:root\s*\{\s*zoom: 0\.8;/s, "the ≤390 zoom knob");
  // zoom multiplies rendered lengths: uncompensated 100dvh would strand a
  // dead strip at the bottom of a full-height shell
  assert.match(s, /min-height: calc\(100dvh \/ 0\.85\)/, "shell height compensated under 0.85");
  assert.match(s, /min-height: calc\(100dvh \/ 0\.8\)/, "shell height compensated under 0.8");
  assert.match(s, /max-height: calc\(55vh \/ 0\.85\)/, "inspector cap compensated");
  // engines without standardised zoom still shrink, text-only
  assert.match(s, /@supports not \(zoom: 2\)\s*\{\s*@media \(max-width: 740px\)\s*\{\s*:root\s*\{\s*font-size: 13\.5px;/s, "rem fallback ≤740");
  assert.match(s, /@media \(max-width: 390px\)\s*\{\s*:root\s*\{\s*font-size: 12\.5px;\s*\}\s*\}\s*\}/s, "rem fallback ≤390");
});

test("R28 type scale: text-size-adjust pinned so Safari cannot re-inflate", () => {
  const s = readFileSync(join(FE, "style.css"), "utf8");
  assert.match(s, /text-size-adjust: 100%/);
});

test("R28 type scale: the graph mono shorthand follows the knob too", () => {
  const s = readFileSync(join(FE, "components/GraphPanel.vue"), "utf8");
  assert.doesNotMatch(s, /font:\s*[\d.]+px\//, "the old px shorthand bypassed the knob");
  assert.match(s, /font:\s*[\d.]+rem\//);
});
