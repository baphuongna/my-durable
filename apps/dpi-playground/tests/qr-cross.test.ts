/**
 * P2-24 — QR encoder cross-validation against python-qrcode (byte mode forced,
 * every mask 0..7, payloads spanning v1/v3/v4). Comparison covers the CODEWORD
 * region (data+EC bits in standard zigzag order) and all function modules;
 * remainder modules are decoder-ignored and excluded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { qrMatrix } from "../apps/dpi-playground-fe/src/client/qrcode.js";

const PAYLOADS = [
  "HELLO WORLD", // v1
  "https://hub.example.com/pair?code=AB12CD34", // v3
  "https://192.168.1.55:5988/pair?code=XY9Z8W7Q", // v4
  "DPI-PAIR:0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", // v5-ish
];

const SIZES = [21, 25, 29, 33, 37];
const DATA = [19, 34, 55, 80, 108];
const EC = [7, 10, 15, 20, 26];
const ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30]];

function versionOf(len: number): number {
  for (let v = 1; v <= 5; v++) if (len + 2 <= DATA[v - 1]) return v;
  throw new Error("too long");
}

/** Standard data-module order + function predicate (mirrors the spec). */
function layout(version: number) {
  const size = SIZES[version - 1];
  const isFn = (r: number, c: number): boolean => {
    if (r <= 8 && c <= 8) return true;
    if (r <= 8 && c >= size - 8) return true;
    if (r >= size - 8 && c <= 8) return true;
    if (r === 6 || c === 6) return true;
    for (const ar of ALIGN[version - 1])
      for (const ac of ALIGN[version - 1]) {
        if ((ar <= 8 && ac <= 8) || (ar <= 8 && ac >= size - 9) || (ar >= size - 9 && ac <= 8))
          continue;
        if (Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2) return true;
      }
    return false;
  };
  const order: Array<[number, number]> = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const c of [col, col - 1]) if (!isFn(row, c)) order.push([row, c]);
    }
    upward = !upward;
  }
  return { size, isFn, order };
}

const refScript = `
import qrcode, sys
from qrcode.util import QRData, MODE_8BIT_BYTE
payloads = sys.argv[1:]
out = []
for p in payloads:
    for mask in range(8):
        qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_L, mask_pattern=mask, border=0)
        qr.add_data(QRData(p.encode(), mode=MODE_8BIT_BYTE)); qr.make(fit=True)
        out.append("\\n".join("".join("1" if v else "0" for v in row) for row in qr.get_matrix()))
print("\\n===\\n".join(out))
`;

test("QR matrices match python-qrcode (codeword bits + function modules, all masks)", () => {
  const refOut = execFileSync("python3", ["-c", refScript, ...PAYLOADS], {
    encoding: "utf8",
    timeout: 120_000,
  });
  const refs = refOut.trim().split("\n===\n");
  let i = 0;
  for (const payload of PAYLOADS) {
    const version = versionOf(new TextEncoder().encode(payload).length);
    const cwBits = (DATA[version - 1] + EC[version - 1]) * 8;
    const { size, isFn, order } = layout(version);
    const codewordCells = new Set(order.slice(0, cwBits).map(([r, c]) => `${r},${c}`));
    for (let mask = 0; mask < 8; mask++) {
      const refRows = refs[i++].split("\n");
      const mine = qrMatrix(payload, mask);
      assert.equal(mine.length, size);
      for (let r = 0; r < size; r++)
        for (let c = 0; c < size; c++) {
          if (!isFn(r, c) && !codewordCells.has(`${r},${c}`)) continue; // remainder cell
          assert.equal(
            mine[r][c],
            refRows[r][c] === "1",
            `${JSON.stringify(payload)} mask ${mask} cell ${r},${c}`,
          );
        }
    }
  }
});

test("auto mask selection produces a decodable structure (format info + finder)", () => {
  const m = qrMatrix("https://hub.example.com/pair?code=AB12CD34");
  // finder cores dark
  assert.ok(m[3][3] && m[3][m.length - 4] && m[m.length - 4][3]);
  // dark module
  assert.ok(m[m.length - 8][8]);
  // timing alternates
  for (let i = 8; i < m.length - 8; i++) assert.equal(m[6][i], i % 2 === 0);
});
