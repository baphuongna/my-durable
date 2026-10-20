/**
 * Minimal local QR encoder for the PairDeviceWizard (P2-24: "QR render local;
 * no remote QR service"). Byte mode, EC level L, versions 1–5 (pair URLs are
 * ≤ ~106 bytes). Pure function: text → boolean[size][size] module matrix.
 * Cross-validated against the reference `python-qrcode` implementation.
 */

// -- GF(256), poly 0x11D ------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gmul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Generator polynomial, HIGH→low coefficients, monic (gen[0] = 1). */
function rsGenerator(degree: number): number[] {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j]; // multiply by x
      next[j + 1] ^= gmul(g[j], EXP[i]); // multiply by α^i
    }
    g = next;
  }
  return g;
}

function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsGenerator(ecLen);
  const rem = new Array<number>(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    // gen[0] is the x^ecLen term (cancels against the shifted-out lead); gen[i+1] is x^{ecLen-1-i}.
    for (let i = 0; i < ecLen; i++) rem[i] ^= gmul(gen[i + 1], factor);
  }
  return rem;
}

// -- version tables (EC level L, single data block for v1–5) -------------------

const SIZES = [21, 25, 29, 33, 37];
const DATA_CODEWORDS = [19, 34, 55, 80, 108];
const EC_PER_BLOCK = [7, 10, 15, 20, 26];
const ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30]]; // alignment centers
const REMAINDER_BITS = [0, 7, 7, 7, 7];

function selectVersion(byteLen: number): number {
  for (let v = 1; v <= 5; v++) {
    // byte mode: 4-bit indicator + 8-bit count (v1–9) + payload
    if (byteLen + 2 <= DATA_CODEWORDS[v - 1]) return v;
  }
  throw new Error(`qr: payload too long (${byteLen} bytes; v5L max ${DATA_CODEWORDS[4] - 2})`);
}

// -- bit stream ---------------------------------------------------------------

function buildCodewords(text: string, version: number): number[] {
  const bytes = [...new TextEncoder().encode(text)];
  const bits: number[] = [];
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  const dataCodewords = DATA_CODEWORDS[version - 1];
  const capacityBits = dataCodewords * 8;
  push(0, Math.min(4, capacityBits - bits.length)); // terminator
  while (bits.length % 8 !== 0) bits.push(0);
  const padBytes = [0xec, 0x11];
  let pi = 0;
  while (bits.length < capacityBits) push(padBytes[pi++ % 2], 8);
  const out: number[] = [];
  for (let i = 0; i < dataCodewords; i++) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i * 8 + j];
    out.push(byte);
  }
  return out;
}

// -- matrix scaffolding ---------------------------------------------------------

function makeMatrix(size: number): boolean[][] {
  return Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
}

function placeFunctionPatterns(m: boolean[][], version: number): void {
  const size = SIZES[version - 1];
  const finder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++)
      for (let c = -1; c <= 7; c++) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6);
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        m[rr][cc] = inRing || inCore;
      }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);
  // timing patterns
  for (let i = 8; i < size - 8; i++) {
    m[6][i] = i % 2 === 0;
    m[i][6] = i % 2 === 0;
  }
  // alignment patterns (skip those overlapping finders)
  const centers = ALIGN[version - 1];
  for (const r of centers)
    for (const c of centers) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (let rr = -2; rr <= 2; rr++)
        for (let cc = -2; cc <= 2; cc++)
          m[r + rr][c + cc] = Math.max(Math.abs(rr), Math.abs(cc)) !== 1;
    }
  // dark module
  m[size - 8][8] = true;
}

// format info: EC level L (01) + mask, BCH(15,5), XOR 0x5412
function formatBits(mask: number): boolean[] {
  const data = (0b01 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) & 1 ? 0x537 : 0);
  const bits15 = ((data << 10) | rem) ^ 0x5412;
  const out: boolean[] = [];
  for (let i = 14; i >= 0; i--) out.push(((bits15 >> i) & 1) === 1);
  return out;
}

function placeFormat(m: boolean[][], mask: number): void {
  const size = SIZES[0] * 0 + m.length;
  const bits = formatBits(mask);
  // around top-left finder
  for (let i = 0; i <= 5; i++) m[8][i] = bits[i];
  m[8][7] = bits[6];
  m[8][8] = bits[7];
  m[7][8] = bits[8];
  for (let i = 9; i < 15; i++) m[14 - i][8] = bits[i];
  // second copy: bottom-left (col 8, rows size-7..size-1) = bits 6..0; the
  // dark module at (size-8, 8) is NOT part of the format string.
  for (let i = 0; i < 7; i++) m[size - 1 - i][8] = bits[i];
  m[8][size - 8] = bits[7];
  // top-right (row 8, cols size-7..size-1) = bits 8..14 left→right
  for (let i = 8; i < 15; i++) m[8][size - 15 + i] = bits[i];
  // the dark module cell (size-8,8) is NOT part of format
  m[size - 8][8] = true;
}

function placeData(m: boolean[][], codewords: number[], version: number, mask: number): void {
  const size = m.length;
  const total = SIZES[version - 1] * SIZES[version - 1];
  const bitAt = (i: number): boolean => {
    const cw = codewords[i >> 3] ?? 0;
    return ((cw >> (7 - (i & 7))) & 1) === 1;
  };
  let bitIndex = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip timing column
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const c of [col, col - 1]) {
        if (isFunctionModule(row, c, version)) continue;
        if (bitIndex >= (DATA_CODEWORDS[version - 1] + EC_PER_BLOCK[version - 1]) * 8) {
          // past data+ec bits → remainder modules (decoders ignore them)
          bitIndex++;
          continue;
        }
        let bit = bitAt(bitIndex++);
        if (maskModule(row, c, mask)) bit = !bit;
        m[row][c] = bit;
      }
    }
    upward = !upward;
  }
}

function maskModule(row: number, col: number, mask: number): boolean {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

function isFunctionModule(row: number, col: number, version: number): boolean {
  const size = SIZES[version - 1];
  // finders + separators
  if (row <= 8 && col <= 8) return true;
  if (row <= 8 && col >= size - 8) return true;
  if (row >= size - 8 && col <= 8) return true;
  // timing
  if (row === 6 || col === 6) return true;
  // alignment
  const centers = ALIGN[version - 1];
  for (const r of centers)
    for (const c of centers) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      if (Math.abs(row - r) <= 2 && Math.abs(col - c) <= 2) return true;
    }
  return false;
}

// -- penalty scoring -------------------------------------------------------------

function penalty(m: boolean[][]): number {
  const size = m.length;
  let score = 0;
  // N1: runs ≥5 same colour in rows/cols
  for (let axis = 0; axis < 2; axis++)
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const cur = axis === 0 ? m[i][j] : m[j][i];
        const prev = axis === 0 ? m[i][j - 1] : m[j - 1][i];
        if (cur === prev) {
          run++;
          if (j === size - 1 && run >= 5) score += 3 + (run - 5);
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
    }
  // N2: 2×2 blocks
  for (let r = 0; r < size - 1; r++)
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (m[r][c + 1] === v && m[r + 1][c] === v && m[r + 1][c + 1] === v) score += 3;
    }
  // N3: finder-like 1:1:3:1:1 patterns (simplified: exact pattern with quiet edges)
  const pat = [true, false, true, true, true, false, true, false, false, false, false];
  const matches = (get: (i: number) => boolean, len: number) => {
    for (let start = 0; start + 11 <= len; start++) {
      let ok = true;
      for (let k = 0; k < 11; k++) if (get(start + k) !== pat[k]) { ok = false; break; }
      if (ok) score += 40;
    }
  };
  for (let r = 0; r < size; r++) matches((c) => m[r][c], size);
  for (let c = 0; c < size; c++) matches((r) => m[r][c], size);
  // N4: dark ratio
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

// -- public API -------------------------------------------------------------------

function matrixWithMask(text: string, mask: number): boolean[][] {
  const version = selectVersion(new TextEncoder().encode(text).length);
  const size = SIZES[version - 1];
  const data = buildCodewords(text, version);
  const ec = rsEncode(data, EC_PER_BLOCK[version - 1]);
  const all = [...data, ...ec];
  const m = makeMatrix(size);
  placeFunctionPatterns(m, version);
  placeData(m, all, version, mask);
  placeFormat(m, mask);
  return m;
}

/** Encode text into a QR matrix (true = dark module), EC level L, versions 1–5. */
export function qrMatrix(text: string, maskOverride?: number): boolean[][] {
  if (maskOverride !== undefined) return matrixWithMask(text, maskOverride);
  let best: { m: boolean[][]; score: number } | undefined;
  for (let mask = 0; mask < 8; mask++) {
    const m = matrixWithMask(text, mask);
    const score = penalty(m);
    if (!best || score < best.score) best = { m, score };
  }
  return best!.m;
}

/** Render the matrix as an SVG string (quiet zone 4 modules, black on white). */
export function qrSvg(text: string, pixelSize = 160): string {
  const m = qrMatrix(text);
  const n = m.length;
  const quiet = 4;
  const total = n + quiet * 2;
  const cell = pixelSize / total;
  let rects = "";
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (m[r][c]) rects += `<rect x="${((c + quiet) * cell).toFixed(2)}" y="${((r + quiet) * cell).toFixed(2)}" width="${cell.toFixed(3)}" height="${cell.toFixed(3)}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pixelSize} ${pixelSize}" shape-rendering="crispEdges"><rect width="${pixelSize}" height="${pixelSize}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}
