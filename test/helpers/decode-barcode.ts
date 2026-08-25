import { CODE128_PATTERNS, EAN_L, EAN_G, EAN_R, EAN_PARITY } from '../../src/barcode.js';
import { qrMaskBit } from '../../src/qr.js';
import type { MatrixBarcode } from '../../src/barcode.js';

/** Reverse-lookup a 6-element pattern to its Code128 value (exact integer match). */
function patternValue(p: number[]): number {
  for (let v = 0; v < CODE128_PATTERNS.length; v++) {
    const row = CODE128_PATTERNS[v];
    if (row.length === p.length && row.every((w, i) => w === p[i])) return v;
  }
  return -1;
}

/** Decode a Code128 LinearBarcode's `modules` back to its payload string.
 *  Inverse of makeCode128; used only to prove the encoder round-trips. */
export function decode128(modules: number[]): string {
  // Symbols: [Start][data...][checksum][Stop]. Each is 6 elements except Stop (7).
  const syms: number[] = [];
  let i = 0;
  while (i < modules.length) {
    const len = i + 7 === modules.length ? 7 : 6; // final symbol is Stop (7 elements)
    syms.push(patternValue(modules.slice(i, i + len)));
    i += len;
  }
  const start = syms[0];              // 103 (A), 104 (B) or 105 (C)
  const values = syms.slice(1, -2);   // drop Start, checksum, Stop
  // Decode a data value in code set A or B back to its character.
  const ch = (v: number, set: 'A' | 'B'): string =>
    set === 'A'
      ? String.fromCharCode(v <= 63 ? v + 32 : v - 64) // 64-95 -> control 0x00-0x1F
      : String.fromCharCode(v + 32);                   // Code B: 0-95 -> 0x20-0x7F
  let set: 'A' | 'B' | 'C' = start === 105 ? 'C' : start === 103 ? 'A' : 'B';
  let shift: 'A' | 'B' | null = null;
  let out = '';
  for (const v of values) {
    if (set === 'C') {
      if (v === 100) { set = 'B'; continue; }  // Code B
      if (v === 101) { set = 'A'; continue; }  // Code A
      out += String(v).padStart(2, '0');       // 0-99 digit pair
      continue;
    }
    if (v === 99) { set = 'C'; continue; }      // Code C
    if (v === 100) { set = 'B'; continue; }     // Code B
    if (v === 101) { set = 'A'; continue; }     // Code A
    if (v === 98) { shift = set === 'A' ? 'B' : 'A'; continue; } // Shift
    out += ch(v, shift ?? set);
    shift = null;
  }
  return out;
}

/** Convert run-length `modules` (starting with a bar) back to a '0'/'1' string. */
function modulesToBits(modules: number[]): string {
  let s = '', bar = true;
  for (const w of modules) { s += (bar ? '1' : '0').repeat(w); bar = !bar; }
  return s;
}

/** Decode an EAN-13 / EAN-8 modules array back to its digit string. */
export function decodeEan(modules: number[], kind: 'ean13' | 'ean8'): string {
  const bits = modulesToBits(modules);
  if (kind === 'ean8') {
    // 3 + 4*7 + 5 + 4*7 + 3
    let p = 3, out = '';
    for (let i = 0; i < 4; i++, p += 7) out += EAN_L.indexOf(bits.slice(p, p + 7));
    p += 5;
    for (let i = 0; i < 4; i++, p += 7) out += EAN_R.indexOf(bits.slice(p, p + 7));
    return out;
  }
  // EAN-13: recover parity pattern of the 6 left digits to get the first digit.
  let p = 3, parity = '', left = '';
  for (let i = 0; i < 6; i++, p += 7) {
    const chunk = bits.slice(p, p + 7);
    const l = EAN_L.indexOf(chunk);
    if (l >= 0) { parity += 'L'; left += l; }
    else { parity += 'G'; left += EAN_G.indexOf(chunk); }
  }
  const first = EAN_PARITY.indexOf(parity);
  p += 5;
  let right = '';
  for (let i = 0; i < 6; i++, p += 7) right += EAN_R.indexOf(bits.slice(p, p + 7));
  return `${first}${left}${right}`;
}

/** Reverse mask + zigzag to recover the placed codeword stream.
 *  Inverse of encodeQr's placement — NOT a full decoder (no RS/format decode). */
export function readQrCodewords(
  matrix: MatrixBarcode, mask: number, reserved: boolean[],
): number[] {
  const n = matrix.size;
  const bits: number[] = [];
  let col = n - 1, upward = true;
  while (col > 0) {
    if (col === 6) col--;                        // skip vertical timing column
    for (let i = 0; i < n; i++) {
      const row = upward ? n - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const x = col - c;
        const idx = row * n + x;
        if (reserved[idx]) continue;
        let v = matrix.dark[idx] ? 1 : 0;
        if (qrMaskBit(mask, row, x)) v ^= 1;     // undo mask
        bits.push(v);
      }
    }
    col -= 2; upward = !upward;
  }
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0; for (let k = 0; k < 8; k++) b = (b << 1) | bits[i + k];
    out.push(b);
  }
  return out;
}
