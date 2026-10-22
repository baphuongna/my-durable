/**
 * P2-24 — QR encoder cross-validation against python-qrcode (byte mode forced,
 * every mask 0..7, payloads spanning v1..v12 — legacy pair URLs through full
 * #offer= links with hub-fingerprint headroom). Comparison covers the CODEWORD
 * region (data+EC bits in standard zigzag order) and all function modules;
 * remainder modules are decoder-ignored and excluded. The reference also pins
 * the fit version per payload, so a capacity-table drift fails loudly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { qrMatrix } from "../apps/dpi-playground-fe/src/client/qrcode.js";

const b64 = (n: number) =>
  "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_".repeat(Math.ceil(n / 34)).slice(0, n);
const offer = (len: number) => `https://hub.example.test/pair#offer=${b64(len)}`;

const PAYLOADS = [
  "HELLO WORLD", // v1
  "https://hub.example.com/pair?code=AB12CD34", // v3 (legacy pair URL)
  "https://192.168.1.55:5988/pair?code=XY9Z8W7Q", // v4 (legacy pair URL)
  "DPI-PAIR:0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", // v5-ish
  offer(83), // v6
  offer(113), // v7
  offer(153), // v8
  offer(192), // v9 — a real offer link today (~229 bytes total)
  offer(223), // v10 (16-bit count indicator)
  offer(273), // v11 — offer + hub identity fingerprint (~310 bytes total)
  offer(313), // v12 headroom
];

// -- per-version tables, EC level L (mirror of the encoder's own tables) ------
const SIZES = [21, 25, 29, 33, 37, 41, 45, 49, 53, 57, 61, 65];
const DATA = [19, 34, 55, 80, 108, 136, 156, 194, 232, 274, 324, 370];
const EC = [7, 10, 15, 20, 26, 36, 40, 48, 60, 72, 80, 96];
const ALIGN = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
];

function versionOf(len: number): number {
  for (let v = 1; v <= 12; v++) {
    const header = v <= 9 ? 4 + 8 : 4 + 16; // mode + count indicator bits
    if (header + len * 8 <= DATA[v - 1] * 8) return v;
  }
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
    // version information strips (v>=7)
    if (
      version >= 7 &&
      ((r >= size - 11 && r <= size - 9 && c <= 5) || (c >= size - 11 && c <= size - 9 && r <= 5))
    )
      return true;
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
vers = []
out = []
for p in payloads:
    for mask in range(8):
        qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_L, mask_pattern=mask, border=0)
        qr.add_data(QRData(p.encode(), mode=MODE_8BIT_BYTE)); qr.make(fit=True)
        if mask == 0: vers.append(qr.version)
        out.append("\\n".join("".join("1" if v else "0" for v in row) for row in qr.get_matrix()))
print("VERSIONS:" + ",".join(map(str, vers)))
print("\\n===\\n".join(out))
`;

test("QR matrices match python-qrcode (codeword bits + function modules, all masks, v1..v12)", () => {
  const refOut = execFileSync("python3", ["-c", refScript, ...PAYLOADS], {
    encoding: "utf8",
    timeout: 180_000,
  });
  const nl = refOut.indexOf("\n");
  const versions = refOut.slice(0, nl).replace("VERSIONS:", "").split(",").map(Number);
  const refs = refOut
    .slice(nl + 1)
    .trim()
    .split("\n===\n");
  assert.equal(versions.length, PAYLOADS.length);
  let i = 0;
  for (const payload of PAYLOADS) {
    const version = versionOf(new TextEncoder().encode(payload).length);
    assert.equal(
      versions[PAYLOADS.indexOf(payload)],
      version,
      `fit version for ${JSON.stringify(payload.slice(0, 44))}…`,
    );
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
            `${JSON.stringify(payload.slice(0, 44))}… v${version} mask ${mask} cell ${r},${c}`,
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

test("a full-size offer link (v11, kfp-shaped) encodes on every mask", () => {
  const url = offer(273);
  for (let mask = 0; mask < 8; mask++) {
    const m = qrMatrix(url, mask);
    assert.equal(m.length, 61, `v11 is 61×61 modules (mask ${mask})`);
  }
});
