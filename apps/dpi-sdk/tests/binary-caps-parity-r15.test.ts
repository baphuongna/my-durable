/**
 * Run-15 (u4-1, SDK hunter): the three binary body caps are ONE contract —
 * the SDK client's reader (BINARY_BODY_MAX), the hub LanTransport's reader
 * (BINARY_RESPONSE_MAX_BYTES) and dpi-backend's tunnel reader
 * (BINARY_RESPONSE_MAX_BYTES) must all enforce the same 12 MiB
 * (12_582_912 = 12*1024*1024). Before run-15 the two server legs used
 * 12_000_000 — 582_912 bytes under the client's 12*1024*1024 — so a body
 * could clear one leg's reader and be refused by the next.
 *
 * The constants are module-private by design (reader plumbing, not policy),
 * so this test reads the source lines and evaluates the literal expressions
 * — the cross-package source-pinning pattern of r10-caps.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Numeric literals only — `1_234_567` or a 3-factor product like
 *  `12 * 1024 * 1024`. Deliberately NOT eval: a contract test must not
 *  execute edited source, only read it. */
function readCap(sourcePath: string, constant: string): number {
  const line = readFileSync(sourcePath, "utf8")
    .split("\n")
    .find((l) => l.includes(`const ${constant} =`));
  assert.ok(line, `${constant} is still declared in ${sourcePath}`);
  const expr = line!.split("=").slice(1).join("=").split(";")[0]!.trim();
  if (/^\d[\d_]*$/.test(expr)) return Number(expr.replace(/_/g, ""));
  const product = /^(\d[\d_]*)\s*\*\s*(\d[\d_]*)\s*\*\s*(\d[\d_]*)$/.exec(expr);
  assert.ok(product, `${constant} in ${sourcePath} must stay a plain literal or 3-factor product (got: ${expr})`);
  return product!.slice(1).map((factor) => Number(factor.replace(/_/g, ""))).reduce((a, b) => a * b, 1);
}

test("u4-1: all three binary caps are exactly 12 MiB (12_582_912) — one contract, three legs", () => {
  const legs: Record<string, number> = {
    "dpi-sdk client (BINARY_BODY_MAX)": readCap(join(here, "../src/client.ts"), "BINARY_BODY_MAX"),
    "dpi-backend tunnel (BINARY_RESPONSE_MAX_BYTES)": readCap(
      join(here, "../../dpi-backend/src/tunnel.ts"),
      "BINARY_RESPONSE_MAX_BYTES",
    ),
    "hub LanTransport (BINARY_RESPONSE_MAX_BYTES)": readCap(
      join(here, "../../dpi-playground/apps/dpi-playground-hub/src/transport.ts"),
      "BINARY_RESPONSE_MAX_BYTES",
    ),
  };
  for (const [leg, value] of Object.entries(legs)) {
    assert.equal(value, 12 * 1024 * 1024, `${leg} enforces the unified 12 MiB cap`);
    assert.equal(value, 12_582_912, `${leg} is the literal run-15 number`);
  }
});
