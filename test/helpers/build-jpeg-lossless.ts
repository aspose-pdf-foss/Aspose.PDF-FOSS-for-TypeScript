// Minimal lossless (SOF3 Huffman / SOF11 arithmetic) JPEG encoder for tests.
// Test-only counterpart to src/jpeglossless.ts. Operates on raw samples (no FDCT
// — lossless is exact). All components use 1×1 sampling (a single interleaved
// scan). Zero deps beyond build-jpeg-arith's ArithEncoder.
import { ArithEncoder } from './build-jpeg-arith.js';

export interface LosslessEncodeOptions {
  width: number; height: number;
  comps: 1 | 3 | 4;
  pixels: ArrayLike<number>;         // 0..255 (8-bit) or 0..4095 (12-bit)
  mode?: 'huffman' | 'arithmetic';   // default 'huffman'
  predictor?: 1 | 2 | 3 | 4 | 5 | 6 | 7; // default 1
  pointTransform?: number;           // Pt, default 0
  restartInterval?: number;          // in MCUs (= samples per component); default 0
  precision?: 8 | 12;                // default 8 (12-bit is grayscale-only)
  dac?: { L: number; U: number };    // arithmetic conditioning override
  differential?: boolean;            // hierarchical differential frame: Psv=0, per-component residual, no colour
}

// H.1.2.1 predictor selection (psv 1..7) from neighbours.
function predict(psv: number, ra: number, rb: number, rc: number): number {
  switch (psv) {
    case 1: return ra; case 2: return rb; case 3: return rc;
    case 4: return ra + rb - rc;
    case 5: return ra + ((rb - rc) >> 1);
    case 6: return rb + ((ra - rc) >> 1);
    case 7: return (ra + rb) >> 1;
    default: throw new Error(`bad predictor ${psv}`);
  }
}
function category(v: number): number { let a = Math.abs(v), n = 0; while (a) { n++; a >>= 1; } return n; }
function valueBits(v: number, n: number): number { return v < 0 ? v + (1 << n) - 1 : v; }

function fixedHuff(syms: Set<number>): { bits: number[]; vals: number[]; enc: Map<number, { code: number; len: number }> } {
  const vals = [...syms].sort((a, b) => a - b);
  const n = vals.length; let L = 1; while ((1 << L) - 1 < n) L++;
  const bits = new Array(16).fill(0); bits[L - 1] = n;
  const enc = new Map<number, { code: number; len: number }>();
  for (let i = 0; i < n; i++) enc.set(vals[i], { code: i, len: L });
  return { bits, vals, enc };
}

class BitWriter {
  bytes: number[] = []; private buf = 0; private cnt = 0;
  put(code: number, len: number): void { for (let i = len - 1; i >= 0; i--) { this.buf = (this.buf << 1) | ((code >> i) & 1); if (++this.cnt === 8) { this.emit(this.buf); this.buf = 0; this.cnt = 0; } } }
  private emit(b: number): void { b &= 0xff; this.bytes.push(b); if (b === 0xff) this.bytes.push(0); }
  flush(): void { if (this.cnt > 0) { const pad = 8 - this.cnt; this.emit(((this.buf << pad) | ((1 << pad) - 1)) & 0xff); this.buf = 0; this.cnt = 0; } }
}

// Arithmetic DC-difference encode (mirror of src decodeArithDiff): encodes the
// signed `diff` against DC statistics `dcS` with conditioning L/U, updating ctx.
function encodeArithDiff(enc: ArithEncoder, dcS: Uint8Array, ctx: Int32Array, ci: number, diff: number, L: number, U: number): void {
  let st = ctx[ci]; let v = diff;
  if (v === 0) { enc.encode(dcS, st, 0); ctx[ci] = 0; return; }
  enc.encode(dcS, st, 1);
  if (v > 0) { enc.encode(dcS, st + 1, 0); st += 2; ctx[ci] = 4; }
  else { v = -v; enc.encode(dcS, st + 1, 1); st += 3; ctx[ci] = 8; }
  let m = 0;
  if (--v) { enc.encode(dcS, st, 1); m = 1; let v2 = v; st = 20; while (v2 >>= 1) { enc.encode(dcS, st, 1); m <<= 1; st += 1; } }
  enc.encode(dcS, st, 0);
  if (m < ((1 << L) >> 1)) ctx[ci] = 0; else if (m > ((1 << U) >> 1)) ctx[ci] += 8;
  st += 14; while (m >>= 1) enc.encode(dcS, st, (m & v) ? 1 : 0);
}

// Build raw per-component sample planes (all 1×1, plane = width×height), applying
// the point transform (>> Pt) and Adobe-inverting CMYK. Returns Adobe transform.
function buildPlanes(o: LosslessEncodeOptions): { planes: number[][]; adobe: number | undefined } {
  const { width, height, pixels } = o; const Pt = o.pointTransform ?? 0; const n = width * height;
  const sh = (v: number) => v >> Pt;
  if (o.differential) { // per-component signed residual; container carries colour info from the base frame
    const planes: number[][] = []; for (let ci = 0; ci < o.comps; ci++) { const pl: number[] = []; for (let i = 0; i < n; i++) pl.push(pixels[i * o.comps + ci]); planes.push(pl); }
    return { planes, adobe: undefined };
  }
  if (o.comps === 1) { const g: number[] = []; for (let i = 0; i < n; i++) g.push(sh(pixels[i])); return { planes: [g], adobe: undefined }; }
  if (o.comps === 3) {
    const R: number[] = [], G: number[] = [], B: number[] = [];
    for (let i = 0; i < n; i++) { R.push(sh(pixels[i * 3])); G.push(sh(pixels[i * 3 + 1])); B.push(sh(pixels[i * 3 + 2])); }
    return { planes: [R, G, B], adobe: 0 }; // transform 0 → decoder stores RGB verbatim (exact)
  }
  const C: number[] = [], M: number[] = [], Y: number[] = [], K: number[] = [];
  for (let i = 0; i < n; i++) { C.push(sh(255 - pixels[i * 4])); M.push(sh(255 - pixels[i * 4 + 1])); Y.push(sh(255 - pixels[i * 4 + 2])); K.push(sh(255 - pixels[i * 4 + 3])); }
  return { planes: [C, M, Y, K], adobe: 0 };
}

export function encodeLosslessJpeg(o: LosslessEncodeOptions): Uint8Array {
  const { width, height } = o; const w = width, h = height;
  const nc = o.comps; const psv = o.differential ? 0 : (o.predictor ?? 1); const Pt = o.pointTransform ?? 0;
  const precision = o.precision ?? 8; const ri = o.restartInterval ?? 0;
  const arith = o.mode === 'arithmetic';
  if (precision === 12 && nc !== 1) throw new Error('12-bit lossless is grayscale-only in this helper');
  const { planes, adobe } = buildPlanes(o);
  const def = 1 << (precision - Pt - 1);

  // Prediction at (x,y) in component plane; `reset` forces the default (start of
  // scan / restart interval).
  const predAt = (plane: number[], x: number, y: number, reset: boolean): number => {
    if (o.differential) return 0;               // Psv=0: residual coded directly
    if (reset) return def;
    if (y === 0) return plane[x - 1];          // first row (x>0): Ra
    if (x === 0) return plane[(y - 1) * w];     // first col of later rows: Rb
    return predict(psv, plane[y * w + x - 1], plane[(y - 1) * w + x], plane[(y - 1) * w + x - 1]);
  };

  // --- Entropy coding: iterate MCUs (one sample per component per MCU, 1×1). ---
  const total = w * h; // MCUs (= samples, since 1×1)
  const entropy: number[] = [];

  if (!arith) {
    // Pass 1: collect DC-difference categories actually used.
    const dcSyms = new Set<number>([0]);
    { const reset = new Array(nc).fill(true); let mcu = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        for (let ci = 0; ci < nc; ci++) { const diff = planes[ci][y * w + x] - predAt(planes[ci], x, y, reset[ci]); reset[ci] = false; dcSyms.add(category(diff)); }
        mcu++; if (ri && mcu % ri === 0 && mcu < total) reset.fill(true);
      } }
    const dcH = fixedHuff(dcSyms);
    // Pass 2: emit, splicing RSTn at restart boundaries.
    const bw = new BitWriter(); const marks: { at: number; marker: number }[] = [];
    { const reset = new Array(nc).fill(true); let mcu = 0, rstIdx = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        for (let ci = 0; ci < nc; ci++) {
          const diff = planes[ci][y * w + x] - predAt(planes[ci], x, y, reset[ci]); reset[ci] = false;
          const cat = category(diff); const c = dcH.enc.get(cat)!; bw.put(c.code, c.len); if (cat) bw.put(valueBits(diff, cat), cat);
        }
        mcu++; if (ri && mcu % ri === 0 && mcu < total) { bw.flush(); marks.push({ at: bw.bytes.length, marker: 0xd0 + (rstIdx++ & 7) }); reset.fill(true); }
      } }
    bw.flush();
    // Splice markers.
    let prev = 0; for (const m of marks) { for (let i = prev; i < m.at; i++) entropy.push(bw.bytes[i]); entropy.push(0xff, m.marker); prev = m.at; }
    for (let i = prev; i < bw.bytes.length; i++) entropy.push(bw.bytes[i]);
    return assembleFile(o, planes, adobe, dcH, entropy, precision, psv, Pt, ri, false);
  }

  // Arithmetic (SOF11).
  const L = o.dac?.L ?? 0, U = o.dac?.U ?? 1;
  const dcS = new Uint8Array(64); const ctx = new Int32Array(nc);
  let enc = new ArithEncoder();
  { const reset = new Array(nc).fill(true); let mcu = 0, rstIdx = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      for (let ci = 0; ci < nc; ci++) { const diff = planes[ci][y * w + x] - predAt(planes[ci], x, y, reset[ci]); reset[ci] = false; encodeArithDiff(enc, dcS, ctx, ci, diff, L, U); }
      mcu++;
      if (ri && mcu % ri === 0 && mcu < total) { for (const b of enc.finish()) entropy.push(b); entropy.push(0xff, 0xd0 + (rstIdx++ & 7)); enc = new ArithEncoder(); dcS.fill(0); ctx.fill(0); reset.fill(true); }
    } }
  for (const b of enc.finish()) entropy.push(b);
  return assembleFile(o, planes, adobe, null, entropy, precision, psv, Pt, ri, true, o.dac);
}

// Assemble the JPEG byte stream (SOF3 or SOF11). Lossless has no DQT.
function assembleFile(
  o: LosslessEncodeOptions, planes: number[][], adobe: number | undefined,
  dcH: { bits: number[]; vals: number[] } | null, entropy: number[],
  precision: number, psv: number, Pt: number, ri: number, arith: boolean,
  dac?: { L: number; U: number },
): Uint8Array {
  const nc = planes.length; const out: number[] = [];
  const u16 = (n: number) => { out.push((n >> 8) & 0xff, n & 0xff); };
  out.push(0xff, 0xd8); // SOI
  if (adobe !== undefined) { out.push(0xff, 0xee); u16(14); for (const ch of 'Adobe') out.push(ch.charCodeAt(0)); out.push(0, 0x64, 0, 0, 0, 0, adobe); }
  if (arith && dac) { out.push(0xff, 0xcc); u16(2 + 2); out.push(0x00, (dac.U << 4) | dac.L); } // DAC: DC table 0 (U high, L low per T.81 B.2.4.3)
  out.push(0xff, arith ? 0xcb : 0xc3); u16(8 + nc * 3); out.push(precision); u16(o.height); u16(o.width); out.push(nc); // SOF3/SOF11
  for (let i = 0; i < nc; i++) out.push(i + 1, 0x11, 0); // id, sampling 1×1, Tq=0
  if (ri) { out.push(0xff, 0xdd); u16(4); u16(ri); } // DRI
  if (!arith && dcH) { out.push(0xff, 0xc4); u16(2 + 1 + 16 + dcH.vals.length); out.push(0x00); for (let i = 0; i < 16; i++) out.push(dcH.bits[i]); for (const v of dcH.vals) out.push(v); } // DHT: DC table 0
  out.push(0xff, 0xda); u16(6 + nc * 2); out.push(nc);
  for (let i = 0; i < nc; i++) out.push(i + 1, 0x00); // comp selector, Td=0 Ta=0
  out.push(psv, 0, Pt & 15); // Ss=predictor, Se=0, Ah/Al=(0<<4)|Pt
  for (const b of entropy) out.push(b);
  out.push(0xff, 0xd9); // EOI
  return Uint8Array.from(out);
}
