// R28 (live, two rounds of user verdicts): 16px type was oversized on phones;
// a phone-only shrink was half-done (small words, desktop chrome); the final
// ask was a uniformly smaller ui on EVERY screen. The shipped answer:
//   - the whole app renders at a viewport-dependent zoom (6 bands, 0.05 steps);
//   - every band divides the shell's viewport height by its own factor
//     (zoom multiplies rendered lengths — an uncompensated 100dvh strands a
//     dead strip above the tab bar);
//   - the shell rules use `:root .shell`, because network.css' ≤760
//     `.shell{height:100dvh}` loads later and dead-striped 741–760px;
//   - engines without standardised zoom fall back to the all-rem type scale.
// This file pins that contract on SOURCE, so it survives every refactor.
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
      const rem = /^[\d.]+rem( !important)?$/.test(v) || /^clamp\([\d.]+rem,/.test(v); // rem or rem-clamp
      const sanctioned = (v === "16px" || v === "13.5px" || v === "12.5px") && inStyle;
      if (!rem && !sanctioned) offenders.push(`${f.replace(FE, "")}: ${v}`);
    }
  }
  assert.deepEqual(offenders, [], "non-rem font-size found (raw px ignores the scale; em/% compound)");
  const bases = files.filter((f) => readFileSync(f, "utf8").includes("font-size: 16px"));
  assert.deepEqual(bases, [join(FE, "style.css")], "the 16px base lives only in style.css");
  // the hero clamp is rem too, so even the display headline follows the knob
  assert.doesNotMatch(readFileSync(join(FE, "style.css"), "utf8"), /font-size:\s*clamp\([^)]*px/);
});

test("R28 ui scale: one zoom curve for EVERY screen, heights compensated, fallback pinned", () => {
  const s = readFileSync(join(FE, "style.css"), "utf8");
  const esc = (t: string) => t.replace(/\./g, "\\.");
  // the curve itself — six bands, 0.05 apart, no cliff at 740
  for (const [mw, z] of [[1599, "0.95"], [1199, "0.9"], [899, "0.85"], [740, "0.82"], [550, "0.78"]] as const)
    assert.match(
      s,
      new RegExp(`@media \\(max-width: ${mw}px\\)\\s*\\{\\s*:root\\s*\\{\\s*zoom: ${esc(z)};`),
      `the ≤${mw} band must zoom ${z}`,
    );
  // each band divides the shell viewport height by ITS factor, via
  // `:root .shell` — plain `.shell` loses to network.css' ≤760
  // `.shell{height:100dvh}` (later import) which dead-striped 741–760 live
  for (const [mw, z] of [[1599, "0.95"], [1199, "0.9"], [899, "0.85"]] as const)
    assert.match(
      s,
      new RegExp(`@media \\(max-width: ${mw}px\\)\\s*\\{\\s*:root\\s*\\{\\s*zoom: ${esc(z)};\\s*\\}\\s*:root \\.shell\\s*\\{\\s*height: calc\\(100dvh \\/ ${esc(z)}\\)`),
      `≤${mw}: shell height ÷ ${z} on :root .shell`,
    );
  assert.match(s, /@media \(max-width: 740px\)\s*\{\s*:root\s*\{\s*zoom: 0\.82;\s*\}\s*:root \.shell\s*\{\s*height: auto;\s*min-height: calc\(100dvh \/ 0\.82\)/, "≤740: auto height + compensated min-height");
  assert.match(s, /:root \.shell\s*\{\s*min-height: calc\(100dvh \/ 0\.78\)/, "≤550: compensated min-height");
  assert.match(s, /max-height: calc\(55vh \/ 0\.82\)/, "inspector cap compensated ≤740");
  assert.match(s, /max-height: calc\(55vh \/ 0\.78\)/, "inspector cap compensated ≤550");
  // engines without standardised zoom still shrink, text-only
  assert.match(s, /@supports not \(zoom: 2\)\s*\{\s*@media \(max-width: 740px\)\s*\{\s*:root\s*\{\s*font-size: 13\.5px;/, "rem fallback ≤740");
  assert.match(s, /@media \(max-width: 550px\)\s*\{\s*:root\s*\{\s*font-size: 12\.5px;\s*\}\s*\}/, "rem fallback ≤550");
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
