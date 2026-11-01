// Run-15 Unit A — u3-7 LOW: pairingViewLines passed status.fingerprint to
// wrapFingerprint unguarded — the DTO types it string by convention only, and
// a hostile pairing status (local HTTP, but relay-shaped in tests) rode a
// non-string straight into the fingerprint block. Guard with a typeof check:
// non-string renders NO fingerprint chunk rows.
import test from "node:test";
import assert from "node:assert/strict";
import { pairingViewLines } from "../src/pairing.ts";

const ESC = String.fromCharCode(27);
const LF = String.fromCharCode(10);
const strip = (lines: string[]) =>
  lines
    .map((l) => l.replace(new RegExp(ESC + "[[][0-9;]*m", "g"), ""))
    .map((l) => l.split(ESC).join(""))
    .join(LF);

test("run-15 u3-7: a non-string fingerprint renders no fingerprint rows, never throws", () => {
  for (const fp of [12345678, null, { hex: "ab" }, ["ab"]]) {
    let lines: string[] = [];
    assert.doesNotThrow(
      () => (lines = pairingViewLines({ state: "pairing", fingerprint: fp as never } as never, "", 80)),
      `fingerprint=${JSON.stringify(fp)} must not throw`,
    );
    const flat = strip(lines);
    assert.match(flat, /key fingerprint/, "the compare-with-hub header survives");
    assert.doesNotMatch(flat, /12345678|\[object Object\]/, "no non-string value leaks into the block");
    // After the fix there are NO chunk rows under the header: the next line is
    // the blank separator, not a secondary-styled chunk.
    const body = lines.join(String.fromCharCode(10));
    assert.ok(!body.includes("12345678"), "the raw value never renders");
  }
});

test("run-15 u3-7: a real fingerprint still wraps into chunk rows", () => {
  const fp = "ab".repeat(80); // 160 hex chars → several width-76 chunks
  const lines = pairingViewLines({ state: "pairing", fingerprint: fp } as never, "", 80);
  const flat = strip(lines);
  assert.match(flat, /abab/, "the fingerprint body renders");
  assert.ok(flat.includes("abab") && flat.split(LF).filter((l) => l.trim().startsWith("ab")).length >= 2, "wrapped across rows");
});
