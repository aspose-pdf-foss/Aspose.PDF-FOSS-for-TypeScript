// Minimal baseline (SOF0) JPEG encoder for tests. Zero deps. Not for production:
// uses an all-ones quantization table (lossless except DCT rounding) and simple
// fixed-length canonical Huffman tables built from the symbols actually used.

export interface JpegEncodeOptions {
  width: number; height: number;
  comps: 1 | 3 | 4;
  pixels: ArrayLike<number>; // 0..255 (8-bit) or 0..4095 (12-bit); comps*width*height samples
  subsample?: boolean;
  restartInterval?: number;
  successive?: boolean; // progressive only: emit DC/AC successive-approximation refinement scans
  precision?: 8 | 12;    // sample precision; 12-bit is grayscale-only in this encoder
  differential?: boolean; // hierarchical differential DCT frame: shift-0 FDCT, per-component residual, no colour transform
}

// Zig-zag scan order: natural (row-major) index for each zig-zag position.
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

// A[k][n] = alpha(k) * cos((2n+1)kπ/16); alpha(0)=1/√2 else 1.
const A: number[][] = (() => {
  const t: number[][] = [];
  for (let k = 0; k < 8; k++) {
    t[k] = []; const a = k === 0 ? Math.SQRT1_2 : 1;
    for (let n = 0; n < 8; n++) t[k][n] = a * Math.cos(((2 * n + 1) * k * Math.PI) / 16);
  }
  return t;
})();

const clamp = (v: number) => { v = Math.round(v); return v < 0 ? 0 : v > 255 ? 255 : v; };

// Forward DCT of one 8×8 block of spatial samples → 64 coeffs in zig-zag order,
// quantized by an all-ones table (i.e. rounded to integers). `shift` is the
// level shift subtracted before the transform (128 for 8-bit, 2048 for 12-bit).
function fdct(spatial: number[], out: Int32Array, shift: number): void {
  const F = new Float64Array(64);
  for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) {
    let s = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) s += A[u][y] * A[v][x] * (spatial[y * 8 + x] - shift);
    F[u * 8 + v] = s / 4;
  }
  for (let k = 0; k < 64; k++) out[k] = Math.round(F[ZIGZAG[k]]);
}

function category(v: number): number { let a = Math.abs(v), n = 0; while (a) { n++; a >>= 1; } return n; }
function valueBits(v: number, n: number): number { return v < 0 ? v + (1 << n) - 1 : v; }

// Fixed-length canonical Huffman: assign every used symbol a code of length L,
// where 2^L - 1 >= count (so the all-ones code is never used — a valid JPEG table).
function fixedHuff(syms: Set<number>): { bits: number[]; vals: number[]; enc: Map<number, { code: number; len: number }> } {
  const vals = [...syms].sort((a, b) => a - b);
  const n = vals.length;
  let L = 1; while ((1 << L) - 1 < n) L++;
  const bits = new Array(16).fill(0); bits[L - 1] = n;
  const enc = new Map<number, { code: number; len: number }>();
  for (let i = 0; i < n; i++) enc.set(vals[i], { code: i, len: L });
  return { bits, vals, enc };
}

class BitWriter {
  bytes: number[] = [];
  private buf = 0; private cnt = 0;
  put(code: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) { this.buf = (this.buf << 1) | ((code >> i) & 1); if (++this.cnt === 8) { this.emit(this.buf); this.buf = 0; this.cnt = 0; } }
  }
  private emit(b: number): void { b &= 0xff; this.bytes.push(b); if (b === 0xff) this.bytes.push(0); } // byte-stuffing
  flush(): void { if (this.cnt > 0) { const pad = 8 - this.cnt; this.emit(((this.buf << pad) | ((1 << pad) - 1)) & 0xff); this.buf = 0; this.cnt = 0; } }
}

export interface CompInfo { sp: number[]; cw: number; ch: number; h: number; v: number }
export interface CompBlocks { arr: Int32Array[]; bpl: number; bpc: number }

// Build per-component padded sample planes and FDCT'd (zig-zag, all-ones-quant)
// coefficient blocks. Shared by the baseline, progressive, and arithmetic encoders.
export function buildComponentBlocks(o: JpegEncodeOptions): {
  cinfo: CompInfo[]; blocks: CompBlocks[]; mcusPerLine: number; mcusPerColumn: number; adobe: number | undefined;
} {
  const { width, height, pixels } = o;
  const precision = o.precision ?? 8;
  const shift = o.differential ? 0 : 1 << (precision - 1);
  if (precision !== 8 && o.comps !== 1) throw new Error('12-bit encoding is grayscale-only in this test helper');
  let planes: { data: number[]; h: number; v: number }[];
  let adobe: number | undefined;
  if (o.differential) { // hierarchical differential frame: per-component signed residual, no colour transform
    planes = []; for (let ci = 0; ci < o.comps; ci++) { const d: number[] = []; for (let i = 0; i < width * height; i++) d.push(pixels[i * o.comps + ci]); planes.push({ data: d, h: 1, v: 1 }); }
  } else if (o.comps === 1) {
    const g: number[] = []; for (let i = 0; i < width * height; i++) g.push(pixels[i]);
    planes = [{ data: g, h: 1, v: 1 }];
  } else if (o.comps === 3) {
    const Y: number[] = [], Cb: number[] = [], Cr: number[] = [];
    for (let i = 0; i < width * height; i++) {
      const R = pixels[i * 3], G = pixels[i * 3 + 1], B = pixels[i * 3 + 2];
      Y.push(clamp(0.299 * R + 0.587 * G + 0.114 * B));
      Cb.push(clamp(-0.168736 * R - 0.331264 * G + 0.5 * B + 128));
      Cr.push(clamp(0.5 * R - 0.418688 * G - 0.081312 * B + 128));
    }
    const s = o.subsample ? 2 : 1;
    planes = [{ data: Y, h: s, v: s }, { data: Cb, h: 1, v: 1 }, { data: Cr, h: 1, v: 1 }]; adobe = 1;
  } else {
    const C: number[] = [], M: number[] = [], Yc: number[] = [], K: number[] = [];
    for (let i = 0; i < width * height; i++) { // store Adobe-inverted CMYK
      C.push(255 - pixels[i * 4]); M.push(255 - pixels[i * 4 + 1]); Yc.push(255 - pixels[i * 4 + 2]); K.push(255 - pixels[i * 4 + 3]);
    }
    planes = [{ data: C, h: 1, v: 1 }, { data: M, h: 1, v: 1 }, { data: Yc, h: 1, v: 1 }, { data: K, h: 1, v: 1 }]; adobe = 0;
  }
  const maxH = Math.max(...planes.map((p) => p.h));
  const maxV = Math.max(...planes.map((p) => p.v));
  const mcusPerLine = Math.ceil(width / (8 * maxH));
  const mcusPerColumn = Math.ceil(height / (8 * maxV));
  const cinfo: CompInfo[] = planes.map((p) => {
    const cw = mcusPerLine * p.h * 8, ch = mcusPerColumn * p.v * 8;
    const sp = new Array(cw * ch).fill(0);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const fx = Math.min(width - 1, Math.floor(((x + 0.5) * maxH) / p.h));
      const fy = Math.min(height - 1, Math.floor(((y + 0.5) * maxV) / p.v));
      sp[y * cw + x] = p.data[fy * width + fx];
    }
    return { sp, cw, ch, h: p.h, v: p.v };
  });
  const blocks: CompBlocks[] = cinfo.map((c) => {
    const bpl = mcusPerLine * c.h, bpc = mcusPerColumn * c.v; const arr: Int32Array[] = [];
    for (let br = 0; br < bpc; br++) for (let bc = 0; bc < bpl; bc++) {
      const spatial = new Array(64);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) spatial[y * 8 + x] = c.sp[(br * 8 + y) * c.cw + (bc * 8 + x)];
      const zz = new Int32Array(64); fdct(spatial, zz, shift); arr.push(zz);
    }
    return { arr, bpl, bpc };
  });
  return { cinfo, blocks, mcusPerLine, mcusPerColumn, adobe };
}

export function encodeBaselineJpeg(o: JpegEncodeOptions): Uint8Array {
  const { width, height } = o;
  const ri = o.restartInterval ?? 0;
  const { cinfo, blocks, mcusPerLine, mcusPerColumn, adobe } = buildComponentBlocks(o);

  // MCU traversal helper (shared by symbol-collection and emit passes).
  const total = mcusPerLine * mcusPerColumn;
  const traverse = (onBlock: (ci: number, zz: Int32Array) => void, onRestart: () => void) => {
    let mcu = 0;
    for (let my = 0; my < mcusPerColumn; my++) for (let mx = 0; mx < mcusPerLine; mx++) {
      for (let ci = 0; ci < cinfo.length; ci++) {
        const B = blocks[ci], c = cinfo[ci];
        for (let by = 0; by < c.v; by++) for (let bx = 0; bx < c.h; bx++)
          onBlock(ci, B.arr[(my * c.v + by) * B.bpl + (mx * c.h + bx)]);
      }
      mcu++;
      if (ri && mcu % ri === 0 && mcu < total) onRestart();
    }
  };

  // Pass 1: collect the DC and AC symbols actually used.
  const dcSyms = new Set<number>([0]);
  const acSyms = new Set<number>([0x00]);
  {
    const pred = new Array(cinfo.length).fill(0);
    traverse((ci, zz) => {
      const diff = zz[0] - pred[ci]; pred[ci] = zz[0]; dcSyms.add(category(diff));
      let k = 1;
      while (k < 64) {
        let run = 0; while (k < 64 && zz[k] === 0) { run++; k++; }
        if (k === 64) break;
        while (run > 15) { acSyms.add(0xf0); run -= 16; }
        acSyms.add((run << 4) | category(zz[k])); k++;
      }
    }, () => pred.fill(0));
  }
  const dcH = fixedHuff(dcSyms), acH = fixedHuff(acSyms);

  // Pass 2: entropy-code, resetting DC predictors + flushing at each restart.
  const bw = new BitWriter();
  const rstBytes: { at: number; marker: number }[] = [];
  {
    const pred = new Array(cinfo.length).fill(0);
    let rstIdx = 0;
    traverse((ci, zz) => {
      const diff = zz[0] - pred[ci]; pred[ci] = zz[0];
      const dcat = category(diff); const d = dcH.enc.get(dcat)!;
      bw.put(d.code, d.len); if (dcat) bw.put(valueBits(diff, dcat), dcat);
      let k = 1;
      while (k < 64) {
        let run = 0; while (k < 64 && zz[k] === 0) { run++; k++; }
        if (k === 64) { const e = acH.enc.get(0x00)!; bw.put(e.code, e.len); break; }
        while (run > 15) { const z = acH.enc.get(0xf0)!; bw.put(z.code, z.len); run -= 16; }
        const acat = category(zz[k]); const sym = (run << 4) | acat; const e = acH.enc.get(sym)!;
        bw.put(e.code, e.len); bw.put(valueBits(zz[k], acat), acat); k++;
      }
    }, () => {
      bw.flush(); rstBytes.push({ at: bw.bytes.length, marker: 0xd0 + (rstIdx & 7) }); rstIdx++; pred.fill(0);
    });
    bw.flush();
  }
  // Splice RSTn markers into the entropy byte stream.
  const entropy: number[] = [];
  let prev = 0;
  for (const r of rstBytes) { for (let i = prev; i < r.at; i++) entropy.push(bw.bytes[i]); entropy.push(0xff, r.marker); prev = r.at; }
  for (let i = prev; i < bw.bytes.length; i++) entropy.push(bw.bytes[i]);

  // ---- Assemble the file ----
  const out: number[] = [];
  const u16 = (n: number) => { out.push((n >> 8) & 0xff, n & 0xff); };
  out.push(0xff, 0xd8); // SOI
  if (adobe !== undefined) { out.push(0xff, 0xee); u16(14); for (const ch of 'Adobe') out.push(ch.charCodeAt(0)); out.push(0, 0x64, 0, 0, 0, 0, adobe); }
  out.push(0xff, 0xdb); u16(2 + 65); out.push(0x00); for (let i = 0; i < 64; i++) out.push(1); // DQT: table 0, all ones
  const precision = o.precision ?? 8;
  // SOF0 (baseline) for 8-bit; SOF1 (extended sequential) for 12-bit — baseline is 8-bit only.
  out.push(0xff, precision === 8 ? 0xc0 : 0xc1); u16(8 + cinfo.length * 3); out.push(precision); u16(height); u16(width); out.push(cinfo.length);
  for (let i = 0; i < cinfo.length; i++) out.push(i + 1, (cinfo[i].h << 4) | cinfo[i].v, 0); // id, sampling, quant table 0
  const writeDHT = (tc: number, th: number, t: { bits: number[]; vals: number[] }) => {
    out.push(0xff, 0xc4); u16(2 + 1 + 16 + t.vals.length); out.push((tc << 4) | th);
    for (let i = 0; i < 16; i++) out.push(t.bits[i]); for (const v of t.vals) out.push(v);
  };
  writeDHT(0, 0, dcH); writeDHT(1, 0, acH);
  if (ri) { out.push(0xff, 0xdd); u16(4); u16(ri); }
  out.push(0xff, 0xda); u16(6 + cinfo.length * 2); out.push(cinfo.length);
  for (let i = 0; i < cinfo.length; i++) out.push(i + 1, 0x00); // comp selector, Td=0 Ta=0
  out.push(0, 63, 0); // Ss, Se, Ah/Al
  for (const b of entropy) out.push(b);
  out.push(0xff, 0xd9); // EOI
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// Progressive (SOF2) encoder — spectral selection (+ successive approximation
// in successive mode, added in the follow-up task). Mirrors the decoder's four
// scan procedures so decodeJpeg can be validated against the baseline decode.
// ---------------------------------------------------------------------------

type HuffEnc = Map<number, { code: number; len: number }>;

// AC point transform: magnitude-preserving right shift (sign * (|v| >> Al)). Unlike
// DC (arithmetic shift + bit-OR reconstruction), AC refinement adds sign*(1<<Al), so
// a magnitude-1 coefficient must transform to 0 at Al>0, not to -1 as `v >> Al` would.
function ptMag(v: number, Al: number): number { return v < 0 ? -((-v) >> Al) : (v >> Al); }

// Non-interleaved block counts for a component (matches the decoder's setupGeometry).
function actualBlocks(width: number, height: number, c: CompInfo, maxH: number, maxV: number): { bpl: number; bpc: number } {
  return { bpl: Math.ceil(Math.ceil((width * c.h) / maxH) / 8), bpc: Math.ceil(Math.ceil((height * c.v) / maxV) / 8) };
}

interface ScanEntropy { bytes: number[]; marks: { at: number; marker: number }[] }

// Splice RSTn markers into an entropy byte stream at the recorded byte offsets.
function spliceRst(bytes: number[], marks: { at: number; marker: number }[]): number[] {
  if (marks.length === 0) return bytes;
  const out: number[] = []; let prev = 0;
  for (const m of marks) { for (let i = prev; i < m.at; i++) out.push(bytes[i]); out.push(0xff, m.marker); prev = m.at; }
  for (let i = prev; i < bytes.length; i++) out.push(bytes[i]);
  return out;
}

// Collect DC diff categories for the interleaved DC scan at point transform Al.
// Mirrors the emit's restart-boundary predictor reset so every emitted diff
// category is present in the table.
function collectDC(cinfo: CompInfo[], blocks: CompBlocks[], mpl: number, mpc: number, Al: number, syms: Set<number>, ri: number): void {
  const nc = cinfo.length; const pred = new Array(nc).fill(0);
  const total = mpl * mpc; let mcu = 0;
  for (let my = 0; my < mpc; my++) for (let mx = 0; mx < mpl; mx++) {
    for (let ci = 0; ci < nc; ci++) { const c = cinfo[ci], B = blocks[ci];
      for (let by = 0; by < c.v; by++) for (let bx = 0; bx < c.h; bx++) { const zz = B.arr[(my * c.v + by) * B.bpl + (mx * c.h + bx)]; const t = zz[0] >> Al; const diff = t - pred[ci]; pred[ci] = t; syms.add(category(diff)); } }
    mcu++;
    if (ri && mcu % ri === 0 && mcu < total) pred.fill(0);
  }
}

// Collect AC run/size symbols (+ EOBn) for a component's band at point transform Al.
function collectAC(B: CompBlocks, blocksPerLine: number, blocksPerColumn: number, Al: number, syms: Set<number>): void {
  for (let by = 0; by < blocksPerColumn; by++) for (let bx = 0; bx < blocksPerLine; bx++) {
    const zz = B.arr[by * B.bpl + bx]; let run = 0;
    for (let k = 1; k <= 63; k++) {
      const v = ptMag(zz[k], Al); if (v === 0) { run++; continue; }
      while (run > 15) { syms.add(0xf0); run -= 16; }
      syms.add((run << 4) | category(v)); run = 0;
    }
  }
  for (let s = 0; s <= 14; s++) syms.add(s << 4); // possible EOBn symbols
}

// Interleaved DC scan entropy at point transform Al. refine=true appends one bit.
// Restarts (RSTn) every `ri` MCUs when ri > 0.
function writeDCScan(cinfo: CompInfo[], blocks: CompBlocks[], mpl: number, mpc: number, Al: number, refine: boolean, dcEnc: HuffEnc, ri: number): ScanEntropy {
  const bw = new BitWriter(); const marks: { at: number; marker: number }[] = [];
  const nc = cinfo.length; const pred = new Array(nc).fill(0);
  const total = mpl * mpc; let mcu = 0, rstIdx = 0;
  for (let my = 0; my < mpc; my++) for (let mx = 0; mx < mpl; mx++) {
    for (let ci = 0; ci < nc; ci++) { const c = cinfo[ci], B = blocks[ci];
      for (let by = 0; by < c.v; by++) for (let bx = 0; bx < c.h; bx++) {
        const zz = B.arr[(my * c.v + by) * B.bpl + (mx * c.h + bx)];
        if (!refine) { const t = zz[0] >> Al; const diff = t - pred[ci]; pred[ci] = t; const cat = category(diff); const d = dcEnc.get(cat)!; bw.put(d.code, d.len); if (cat) bw.put(valueBits(diff, cat), cat); }
        else { bw.put((zz[0] >> Al) & 1, 1); }
      } }
    mcu++;
    if (ri && mcu % ri === 0 && mcu < total) { bw.flush(); marks.push({ at: bw.bytes.length, marker: 0xd0 + (rstIdx++ & 7) }); pred.fill(0); }
  }
  bw.flush();
  return { bytes: bw.bytes, marks };
}

// AC first-scan entropy for one component band (Ss=1..Se=63) at point transform
// Al, coalescing empty-band blocks into EOB runs. Restarts every `ri` blocks.
function writeACFirst(B: CompBlocks, blocksPerLine: number, blocksPerColumn: number, Al: number, enc: HuffEnc, ri: number): ScanEntropy {
  const bw = new BitWriter(); const marks: { at: number; marker: number }[] = [];
  const total = blocksPerLine * blocksPerColumn; let count = 0, rstIdx = 0; let eobrun = 0;
  const flushEob = () => {
    if (eobrun === 0) return;
    let nbits = 0; while ((1 << (nbits + 1)) <= eobrun) nbits++; // floor(log2(eobrun))
    const e = enc.get(nbits << 4)!; bw.put(e.code, e.len);
    if (nbits) bw.put(eobrun & ((1 << nbits) - 1), nbits);
    eobrun = 0;
  };
  for (let by = 0; by < blocksPerColumn; by++) for (let bx = 0; bx < blocksPerLine; bx++) {
    const zz = B.arr[by * B.bpl + bx]; let run = 0; let emitted = false;
    for (let k = 1; k <= 63; k++) {
      const v = ptMag(zz[k], Al);
      if (v === 0) { run++; continue; }
      flushEob();
      while (run > 15) { const z = enc.get(0xf0)!; bw.put(z.code, z.len); run -= 16; }
      const size = category(v); const e = enc.get((run << 4) | size)!; bw.put(e.code, e.len); bw.put(valueBits(v, size), size);
      run = 0; emitted = true;
    }
    if (run > 0 || !emitted) { eobrun++; if (eobrun === 0x7fff) flushEob(); } // band ended early
    count++;
    if (ri && count % ri === 0 && count < total) { flushEob(); bw.flush(); marks.push({ at: bw.bytes.length, marker: 0xd0 + (rstIdx++ & 7) }); }
  }
  flushEob(); bw.flush();
  return { bytes: bw.bytes, marks };
}

// AC refinement scan for one component band at point transform Al: correction
// bits for already-nonzero coeffs + new ±(1<<Al) coeffs, with EOB-run tracking.
// Mirrors libjpeg jcphuff.c encode_mcu_AC_refine.
function writeACRefine(B: CompBlocks, blocksPerLine: number, blocksPerColumn: number, Al: number, enc: HuffEnc, ri: number): ScanEntropy {
  const bw = new BitWriter(); const marks: { at: number; marker: number }[] = [];
  const total = blocksPerLine * blocksPerColumn; let count = 0, rstIdx = 0;
  let eobrun = 0; let eobBits: number[] = []; // correction bits deferred to the current EOB run
  const emitEobRun = () => {
    if (eobrun === 0) return;
    let nbits = 0; while ((1 << (nbits + 1)) <= eobrun) nbits++;
    const e = enc.get(nbits << 4)!; bw.put(e.code, e.len);
    if (nbits) bw.put(eobrun & ((1 << nbits) - 1), nbits);
    for (const b of eobBits) bw.put(b, 1);
    eobrun = 0; eobBits = [];
  };
  for (let by = 0; by < blocksPerColumn; by++) for (let bx = 0; bx < blocksPerLine; bx++) {
    const zz = B.arr[by * B.bpl + bx];
    const absv = new Int32Array(64); let EOB = 0; // last index with point-transformed magnitude 1
    for (let k = 1; k <= 63; k++) { const v = zz[k]; absv[k] = (v < 0 ? -v : v) >> Al; if (absv[k] === 1) EOB = k; }
    let r = 0; const BR: number[] = []; // zero run + buffered correction bits since last symbol
    for (let k = 1; k <= 63; k++) {
      const a = absv[k];
      if (a === 0) { r++; continue; }
      while (r > 15 && k <= EOB) { emitEobRun(); const z = enc.get(0xf0)!; bw.put(z.code, z.len); r -= 16; for (const b of BR) bw.put(b, 1); BR.length = 0; }
      if (a > 1) { BR.push(a & 1); continue; } // already-nonzero → correction bit
      emitEobRun();
      const e = enc.get((r << 4) | 1)!; bw.put(e.code, e.len); // newly nonzero coeff
      bw.put(zz[k] > 0 ? 1 : 0, 1); // sign
      for (const b of BR) bw.put(b, 1); BR.length = 0; r = 0;
    }
    if (r > 0 || BR.length > 0) { eobrun++; for (const b of BR) eobBits.push(b); if (eobrun === 0x7fff) emitEobRun(); }
    count++;
    if (ri && count % ri === 0 && count < total) { emitEobRun(); bw.flush(); marks.push({ at: bw.bytes.length, marker: 0xd0 + (rstIdx++ & 7) }); }
  }
  emitEobRun(); bw.flush();
  return { bytes: bw.bytes, marks };
}

interface ScanSpec { comps: number[]; Ss: number; Se: number; Ah: number; Al: number; bytes: number[] }

export function encodeProgressiveJpeg(o: JpegEncodeOptions): Uint8Array {
  const { cinfo, blocks, mcusPerLine, mcusPerColumn, adobe } = buildComponentBlocks(o);
  const nc = cinfo.length;
  const maxH = Math.max(...cinfo.map((c) => c.h)), maxV = Math.max(...cinfo.map((c) => c.v));
  const width = o.width, height = o.height;

  const ri = o.restartInterval ?? 0;
  const dcAl = o.successive ? 1 : 0; // first-scan point transform (refine scans go down to 0)
  const acAl = o.successive ? 1 : 0;

  // ---- Symbol collection ----
  const dcSyms = new Set<number>([0]);
  const acSyms = new Set<number>([0x00]);
  collectDC(cinfo, blocks, mcusPerLine, mcusPerColumn, dcAl, dcSyms, ri);
  for (let ci = 0; ci < nc; ci++) { const ab = actualBlocks(width, height, cinfo[ci], maxH, maxV); collectAC(blocks[ci], ab.bpl, ab.bpc, acAl, acSyms); }
  if (o.successive) { for (let r2 = 0; r2 <= 15; r2++) acSyms.add((r2 << 4) | 1); acSyms.add(0xf0); } // AC-refine new-coeff + ZRL symbols
  const dcH = fixedHuff(dcSyms), acH = fixedHuff(acSyms);

  // ---- DC scans (interleaved, Ss=0 Se=0): first at Al, then refine to 0 ----
  const dcScans: ScanSpec[] = [];
  { const s = writeDCScan(cinfo, blocks, mcusPerLine, mcusPerColumn, dcAl, false, dcH.enc, ri); dcScans.push({ comps: cinfo.map((_, i) => i + 1), Ss: 0, Se: 0, Ah: 0, Al: dcAl, bytes: spliceRst(s.bytes, s.marks) }); }
  if (o.successive) { const s = writeDCScan(cinfo, blocks, mcusPerLine, mcusPerColumn, 0, true, dcH.enc, ri); dcScans.push({ comps: cinfo.map((_, i) => i + 1), Ss: 0, Se: 0, Ah: 1, Al: 0, bytes: spliceRst(s.bytes, s.marks) }); }

  // ---- AC scans (per component, non-interleaved, Ss=1 Se=63): first at Al, then refine to 0 ----
  const acScans: ScanSpec[] = [];
  for (let ci = 0; ci < nc; ci++) {
    const ab = actualBlocks(width, height, cinfo[ci], maxH, maxV);
    const s1 = writeACFirst(blocks[ci], ab.bpl, ab.bpc, acAl, acH.enc, ri);
    acScans.push({ comps: [ci + 1], Ss: 1, Se: 63, Ah: 0, Al: acAl, bytes: spliceRst(s1.bytes, s1.marks) });
    if (o.successive) { const s2 = writeACRefine(blocks[ci], ab.bpl, ab.bpc, 0, acH.enc, ri); acScans.push({ comps: [ci + 1], Ss: 1, Se: 63, Ah: 1, Al: 0, bytes: spliceRst(s2.bytes, s2.marks) }); }
  }

  // ---- Assemble ----
  const out: number[] = [];
  const u16 = (n: number) => { out.push((n >> 8) & 0xff, n & 0xff); };
  out.push(0xff, 0xd8); // SOI
  if (adobe !== undefined) { out.push(0xff, 0xee); u16(14); for (const ch of 'Adobe') out.push(ch.charCodeAt(0)); out.push(0, 0x64, 0, 0, 0, 0, adobe); }
  out.push(0xff, 0xdb); u16(2 + 65); out.push(0x00); for (let i = 0; i < 64; i++) out.push(1); // DQT all ones
  out.push(0xff, 0xc2); u16(8 + nc * 3); out.push(8); u16(height); u16(width); out.push(nc); // SOF2
  for (let i = 0; i < nc; i++) out.push(i + 1, (cinfo[i].h << 4) | cinfo[i].v, 0);
  const writeDHT = (tc: number, th: number, t: { bits: number[]; vals: number[] }) => { out.push(0xff, 0xc4); u16(2 + 1 + 16 + t.vals.length); out.push((tc << 4) | th); for (let i = 0; i < 16; i++) out.push(t.bits[i]); for (const v of t.vals) out.push(v); };
  writeDHT(0, 0, dcH); writeDHT(1, 0, acH);
  if (ri) { out.push(0xff, 0xdd); u16(4); u16(ri); } // DRI
  const sos = (s: ScanSpec) => { out.push(0xff, 0xda); u16(6 + s.comps.length * 2); out.push(s.comps.length); for (const id of s.comps) out.push(id, 0x00); out.push(s.Ss, s.Se, (s.Ah << 4) | s.Al); for (const b of s.bytes) out.push(b); };
  for (const s of dcScans) sos(s);
  for (const s of acScans) sos(s);
  out.push(0xff, 0xd9); // EOI
  return Uint8Array.from(out);
}
