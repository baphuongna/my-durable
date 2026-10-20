/**
 * P2-26 — TUI pairing controller smoke tests: argument parsing, fingerprint
 * wrapping at 40/80/200 columns (never truncated), actionable error mapping,
 * and the panel view (no token ever rendered; hub origin shown).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parsePairArgs, wrapFingerprint, describePairingError, pairingViewLines, type PairingStatusDTO } from "../src/pairing.ts";

const FP = `sha256:${"a".repeat(64)}`;

test("parsePairArgs: code, pair URL, --hub, --force, mixed order", () => {
  assert.deepEqual(parsePairArgs("AB12CD34 --hub https://hub.example.com --force"), {
    code: "AB12CD34",
    hub: "https://hub.example.com",
    force: true,
  });
  assert.deepEqual(parsePairArgs("https://hub.example.com/pair?code=AB12CD34"), {
    pairUrl: "https://hub.example.com/pair?code=AB12CD34",
  });
  assert.deepEqual(parsePairArgs("--force --hub=h https://x/pair?c=1"), {
    force: true,
    hub: "h",
    pairUrl: "https://x/pair?c=1",
  });
  assert.deepEqual(parsePairArgs(""), {});
});

test("wrapFingerprint: full fingerprint wraps, never truncates, at 40/80/200", () => {
  for (const width of [40, 80, 200]) {
    const lines = wrapFingerprint(FP, width);
    assert.equal(lines.join(""), FP, `width ${width} keeps every character`);
    for (const line of lines) assert.ok(line.length <= Math.max(8, width - 4), `width ${width} line fits`);
  }
});

test("describePairingError: every known code is actionable", () => {
  const cases: Array<[string, RegExp]> = [
    ["clock_skew", /clock/i],
    ["enrollment_lost", /fresh code/i],
    ["paired_elsewhere", /another hub|--force/i],
    ["hub_mismatch", /another hub|--force/i],
    ["revoked", /revoked/i],
    ["hub_required", /--hub/i],
    ["busy", /already in progress/i],
    ["code_invalid", /does not know this code/i],
    ["code_expired", /expired/i],
    ["unauthorized", /DPI_TOKEN/i],
  ];
  for (const [code, re] of cases)
    assert.match(describePairingError(Object.assign(new Error(code), { code })), re, code);
  assert.equal(describePairingError(new Error("boom")), "boom");
});

test("pairingViewLines: awaiting approval shows origin + full fp, never a token", () => {
  const status: PairingStatusDTO = {
    state: "pairing",
    deviceUid: "uid-1",
    deviceName: "mac-mini",
    fingerprint: FP,
    pending: { hubOrigin: "https://hub.example.com", startedAt: 1, note: "polling for approval" },
  };
  for (const width of [40, 80, 200]) {
    const lines = pairingViewLines(status, "", width, "https://hub.example.com");
    const text = lines.join("\n");
    assert.match(text, /hub: https:\/\/hub\.example\.com/);
    assert.match(text, /Awaiting approval/);
    // The full fingerprint (joined) is present — no width truncation.
    const plain = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "");
    // Everything between the fingerprint header and the next blank line.
    const start = lines.findIndex((l) => plain(l).includes("key fingerprint"));
    const fpLines: string[] = [];
    for (let k = start + 1; k < lines.length && plain(lines[k]).trim(); k++) fpLines.push(lines[k]);
    assert.equal(
      fpLines.map(plain).join("").replace(/\s+/g, "").includes(FP.replace("sha256:", "")),
      true,
      `fp intact at ${width}`,
    );
    assert.ok(!text.includes("dpt_"), "no tunnel token in view");
    assert.ok(!text.includes("dpi_"), "no device token in view");
  }
  const paired = pairingViewLines({ ...status, state: "paired", hubOrigin: "https://hub.example.com", generation: 2 }, "", 80);
  assert.match(paired.join("\n"), /generation 2/);
});
