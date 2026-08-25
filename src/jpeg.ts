// Baseline (SOF0/SOF1) and progressive (SOF2) DCT JPEG decoder at 8- or 12-bit
// sample precision. Zero deps beyond ./errors.js. Arithmetic and lossless coding
// are unsupported. 12-bit samples are downscaled to 8-bit in the output.
import { PdfParseError, UnsupportedFeatureError } from './errors.js';
import { decodeArithScan } from './jpegarith.js';
import { setupLosslessGeometry, decodeLosslessScan, assembleLossless } from './jpeglossless.js';
import { isHierarchical, decodeHierarchical } from './jpeghier.js';

export interface JpegImage { width: number; height: number; comps: number; data: Uint8Array }

export const ZIGZAG = new Int32Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

// A[k][n] = alpha(k) * cos((2n+1)kπ/16); alpha(0)=1/√2 else 1.
const A: number[][] = (() => {
  const t: number[][] = [];
  for (let k = 0; k < 8; k++) {
    t[k] = []; const a = k === 0 ? Math.SQRT1_2 : 1;
    for (let n = 0; n < 8; n++) t[k][n] = a * Math.cos(((2 * n + 1) * k * Math.PI) / 16);
  }
  return t;
})();

// Inverse DCT of a natural-order 8×8 coefficient block → spatial samples
// (0..maxv, level-shifted by +`shift`), written into `out` (row-major, length
// 64). `shift`/`maxv` are 128/255 for 8-bit precision, 2048/4095 for 12-bit.
export function idct(coef: Int32Array, off: number, out: number[], shift: number, maxv: number, differential = false): void {
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    let s = 0;
    for (let u = 0; u < 8; u++) { const ay = A[u][y], base = off + u * 8; for (let v = 0; v < 8; v++) s += ay * A[v][x] * coef[base + v]; }
    if (differential) { out[y * 8 + x] = Math.round(s / 4); continue; } // signed residual, no level shift / clamp
    const v = Math.round(s / 4 + shift);
    out[y * 8 + x] = v < 0 ? 0 : v > maxv ? maxv : v;
  }
}

export function extend(v: number, n: number): number { return n === 0 ? 0 : v < (1 << (n - 1)) ? v - (1 << n) + 1 : v; }

export interface Huff { map: Map<number, number> } // key = (len<<16)|code → symbol
export function buildHuff(bits: number[], vals: number[]): Huff {
  const map = new Map<number, number>(); let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) { for (let i = 0; i < bits[len - 1]; i++) { map.set((len << 16) | code, vals[k++]); code++; } code <<= 1; }
  return { map };
}

export class BitReader {
  private buf = 0; private cnt = 0;
  constructor(private d: Uint8Array, public pos: number) {}
  private next(): number { // one entropy byte, or -1 at a marker (byte-stuffing removed)
    const b = this.d[this.pos++];
    if (b === 0xff) { const n = this.d[this.pos]; if (n === 0) { this.pos++; } else { this.pos--; return -1; } }
    return b === undefined ? -1 : b;
  }
  readBit(): number { if (this.cnt === 0) { const b = this.next(); if (b < 0) return 0; this.buf = b; this.cnt = 8; } this.cnt--; return (this.buf >> this.cnt) & 1; }
  receive(n: number): number { let v = 0; while (n-- > 0) v = (v << 1) | this.readBit(); return v; }
  restart(): void { // align to and consume the next RSTn marker
    this.cnt = 0;
    while (this.pos < this.d.length) {
      if (this.d[this.pos] === 0xff) { const n = this.d[this.pos + 1]; if (n >= 0xd0 && n <= 0xd7) { this.pos += 2; return; } if (n !== 0) return; }
      this.pos++;
    }
  }
}
export function decodeHuff(r: BitReader, h: Huff): number {
  let code = 0;
  for (let len = 1; len <= 16; len++) { code = (code << 1) | r.readBit(); const s = h.map.get((len << 16) | code); if (s !== undefined) return s; }
  throw new PdfParseError('JPEG: invalid Huffman code');
}

export interface Comp { id: number; h: number; v: number; tq: number; blocks: Int32Array; bpl: number; bpc: number; blocksPerLine: number; blocksPerColumn: number; samples?: Int32Array; quant?: Int32Array }
export interface Frame { width: number; height: number; comps: Comp[]; maxH: number; maxV: number; progressive: boolean; arithmetic: boolean; lossless: boolean; differential: boolean; precision: number; mcusPerLine: number; mcusPerColumn: number }

export function setupGeometry(frame: Frame): void {
  frame.mcusPerLine = Math.ceil(frame.width / (frame.maxH * 8));
  frame.mcusPerColumn = Math.ceil(frame.height / (frame.maxV * 8));
  for (const c of frame.comps) {
    c.bpl = frame.mcusPerLine * c.h;
    c.bpc = frame.mcusPerColumn * c.v;
    c.blocksPerLine = Math.ceil(Math.ceil((frame.width * c.h) / frame.maxH) / 8);
    c.blocksPerColumn = Math.ceil(Math.ceil((frame.height * c.v) / frame.maxV) / 8);
    c.blocks = new Int32Array(c.bpl * c.bpc * 64);
  }
}

export function parseDQT(data: Uint8Array, seg: number, segEnd: number, qt: (Int32Array | undefined)[]): void {
  const u16 = (p: number) => (data[p] << 8) | data[p + 1];
  let p = seg;
  while (p < segEnd) { const pq = data[p] >> 4, tq = data[p] & 15; p++; const t = new Int32Array(64); for (let i = 0; i < 64; i++) { t[i] = pq ? u16(p) : data[p]; p += pq ? 2 : 1; } qt[tq] = t; }
}

export function parseDHT(data: Uint8Array, seg: number, segEnd: number, huffDC: (Huff | undefined)[], huffAC: (Huff | undefined)[]): void {
  let p = seg;
  while (p < segEnd) {
    const tc = data[p] >> 4, th = data[p] & 15; p++;
    const bits: number[] = []; let tot = 0; for (let i = 0; i < 16; i++) { bits.push(data[p + i]); tot += data[p + i]; } p += 16;
    const vals: number[] = []; for (let i = 0; i < tot; i++) vals.push(data[p++]);
    const hf = buildHuff(bits, vals); if (tc === 0) huffDC[th] = hf; else huffAC[th] = hf;
  }
}

export function parseDAC(data: Uint8Array, seg: number, segEnd: number, dcCond: { L: number; U: number }[], acCond: { Kx: number }[]): void {
  let p = seg;
  while (p < segEnd) {
    const tc = data[p] >> 4, tb = data[p] & 15, val = data[p + 1]; p += 2;
    if (tc === 0) dcCond[tb] = { L: val & 15, U: val >> 4 };   // T.81 B.2.4.3: L low nibble, U high
    else acCond[tb] = { Kx: val };
  }
}

// Parse a SOF (or DHP) header into a Frame with process flags, geometry, and a
// per-component quant-table snapshot (immune to later DQT redefinition).
export function parseSof(data: Uint8Array, seg: number, marker: number, qt: (Int32Array | undefined)[]): Frame {
  const u16 = (p: number) => (data[p] << 8) | data[p + 1];
  const precision = data[seg]; if (precision !== 8 && precision !== 12) throw new UnsupportedFeatureError('JPEG: only 8-bit and 12-bit precision are supported');
  const height = u16(seg + 1), width = u16(seg + 3), nc = data[seg + 5];
  let maxH = 1, maxV = 1; const comps: Comp[] = []; let p = seg + 6;
  for (let i = 0; i < nc; i++) { const id = data[p], h = data[p + 1] >> 4, v = data[p + 1] & 15, tq = data[p + 2]; p += 3; maxH = Math.max(maxH, h); maxV = Math.max(maxV, v); comps.push({ id, h, v, tq, blocks: new Int32Array(0), bpl: 0, bpc: 0, blocksPerLine: 0, blocksPerColumn: 0, quant: qt[tq] }); }
  const differential = (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xcd && marker <= 0xcf);
  const progressive = marker === 0xc2 || marker === 0xc6 || marker === 0xca || marker === 0xce;
  const lossless = marker === 0xc3 || marker === 0xc7 || marker === 0xcb || marker === 0xcf;
  const arithmetic = marker >= 0xc9 && marker <= 0xcf && marker !== 0xcc;
  const frame: Frame = { width, height, comps, maxH, maxV, progressive, arithmetic, lossless, differential, precision, mcusPerLine: 0, mcusPerColumn: 0 };
  if (lossless) setupLosslessGeometry(frame); else setupGeometry(frame);
  return frame;
}

export interface JpegFrameResult {
  frame: Frame;
  /** Quantization tables in WIRE (zig-zag) order, indexed by table id. */
  qt: (Int32Array | undefined)[];
  /** The Adobe APP14 transform byte, if the file carried one. */
  adobe: number | undefined;
}

/**
 * Parse and entropy-decode a JPEG, stopping at its quantized coefficients.
 *
 * `decodeJpeg` is this plus dequantization, the IDCT and the colour transform.
 * Split out for `jpegtranscode.ts`, which greys a YCbCr JPEG by keeping those
 * coefficients and needs none of the three.
 *
 * Hierarchical JPEGs are NOT handled here -- they have no single frame -- so a
 * caller that may see one tests `isHierarchical` first, as `decodeJpeg` does.
 */
export function decodeJpegFrame(data: Uint8Array): JpegFrameResult {
  if (data.length < 2 || data[0] !== 0xff || data[1] !== 0xd8) throw new PdfParseError('JPEG: missing SOI');
  const u16 = (p: number) => (data[p] << 8) | data[p + 1];
  const qt: (Int32Array | undefined)[] = [];
  const huffDC: (Huff | undefined)[] = [];
  const huffAC: (Huff | undefined)[] = [];
  const dcCond: { L: number; U: number }[] = []; // arithmetic DC conditioning (DAC)
  const acCond: { Kx: number }[] = [];           // arithmetic AC conditioning (DAC)
  let frame: Frame | undefined;
  let adobe: number | undefined;
  let restartInterval = 0;
  let pos = 2;

  while (pos < data.length) {
    if (data[pos] !== 0xff) { pos++; continue; }
    const marker = data[pos + 1]; pos += 2;
    if (marker === 0xd9) break;                                  // EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // TEM / stray RSTn
    const len = u16(pos); const seg = pos + 2; const segEnd = pos + len; pos += len;

    if (marker === 0xdb) {                                       // DQT
      parseDQT(data, seg, segEnd, qt);
    } else if (marker === 0xc4) {                                // DHT
      parseDHT(data, seg, segEnd, huffDC, huffAC);
    } else if (marker === 0xdd) {                                // DRI
      restartInterval = u16(seg);
    } else if (marker === 0xcc) {                                // DAC (arithmetic conditioning)
      parseDAC(data, seg, segEnd, dcCond, acCond);
    } else if (marker === 0xee) {                                // APP14 Adobe
      if (len >= 14 && data[seg] === 0x41 && data[seg + 1] === 0x64 && data[seg + 2] === 0x6f && data[seg + 3] === 0x62 && data[seg + 4] === 0x65) adobe = data[seg + 11];
    } else if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3 || marker === 0xc9 || marker === 0xca || marker === 0xcb) { // SOF0/1 seq, SOF2 prog, SOF3 lossless, SOF9/10 arith DCT, SOF11 arith lossless
      frame = parseSof(data, seg, marker, qt);
    } else if ((marker >= 0xc3 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8) {
      throw new UnsupportedFeatureError(`JPEG: unsupported coding process (SOF${marker - 0xc0})`);
    } else if (marker === 0xda) {                                // SOS
      if (!frame) throw new PdfParseError('JPEG: SOS before SOF');
      pos = frame.lossless
        ? decodeLosslessScan(data, seg, frame, huffDC, dcCond, restartInterval)
        : frame.arithmetic
        ? decodeArithScan(data, seg, segEnd, frame, dcCond, acCond, restartInterval)
        : decodeScan(data, seg, segEnd, frame, huffDC, huffAC, restartInterval);
    }
    // other markers (APPn, COM, ...) are skipped by the length advance
  }
  if (!frame) throw new PdfParseError('JPEG: no frame header');
  return { frame, qt, adobe };
}

export function decodeJpeg(data: Uint8Array): JpegImage {
  if (data.length < 2 || data[0] !== 0xff || data[1] !== 0xd8) throw new PdfParseError('JPEG: missing SOI');
  if (isHierarchical(data)) return decodeHierarchical(data);
  const { frame, qt, adobe } = decodeJpegFrame(data);
  return frame.lossless ? assembleLossless(frame, adobe) : assemble(frame, adobe, qt);
}

/** Walk a scan's blocks in decode order, invoking `decodeBlock(si, off)` per
 *  block (off = coefficient offset into that component's `blocks`). Fires
 *  `onRestart` at each restart-interval boundary (before the next block).
 *  Shared by the Huffman and arithmetic entropy paths. */
export function forEachBlockInScan(
  frame: Frame,
  scan: { c: Comp }[],
  restartInterval: number,
  decodeBlock: (si: number, off: number) => void,
  onRestart: () => void,
): void {
  let mcu = 0;
  if (scan.length > 1) { // interleaved multi-component scan
    const total = frame.mcusPerLine * frame.mcusPerColumn;
    for (let my = 0; my < frame.mcusPerColumn; my++) for (let mx = 0; mx < frame.mcusPerLine; mx++) {
      for (let si = 0; si < scan.length; si++) { const c = scan[si].c; for (let by = 0; by < c.v; by++) for (let bx = 0; bx < c.h; bx++) decodeBlock(si, ((my * c.v + by) * c.bpl + (mx * c.h + bx)) * 64); }
      mcu++;
      if (restartInterval && mcu % restartInterval === 0 && mcu < total) onRestart();
    }
  } else { // non-interleaved single-component scan
    const c = scan[0].c;
    const total = c.blocksPerLine * c.blocksPerColumn;
    for (let by = 0; by < c.blocksPerColumn; by++) for (let bx = 0; bx < c.blocksPerLine; bx++) {
      decodeBlock(0, (by * c.bpl + bx) * 64);
      mcu++;
      if (restartInterval && mcu % restartInterval === 0 && mcu < total) onRestart();
    }
  }
}

export function decodeScan(
  data: Uint8Array, seg: number, entropy: number, frame: Frame,
  huffDC: (Huff | undefined)[], huffAC: (Huff | undefined)[], restartInterval: number,
): number {
  const ns = data[seg]; let p = seg + 1;
  const sel: { c: Comp; td: number; ta: number }[] = [];
  for (let i = 0; i < ns; i++) {
    const cs = data[p], td = data[p + 1] >> 4, ta = data[p + 1] & 15; p += 2;
    const c = frame.comps.find((k) => k.id === cs); if (!c) throw new PdfParseError('JPEG: bad scan component');
    sel.push({ c, td, ta });
  }
  const Ss = data[p], Se = data[p + 1], Ah = data[p + 2] >> 4, Al = data[p + 2] & 15; // baseline is 0,63,0,0

  // Which table CLASSES this scan actually references. A progressive scan codes
  // either the DC coefficient (Ss = Se = 0) or a band of AC ones (Ss >= 1),
  // never both -- and T.81 G.1.1.1 lets it name a table it does not use, whose
  // DHT may not have been sent yet. Demanding both refused every real
  // progressive file at its very first scan: mozjpeg opens with a DC-only scan
  // and sends the AC tables later, so `huffAC[0]` is legitimately absent there.
  // Sequential frames keep requiring both, which is what they always use.
  const needDc = frame.progressive ? Ss === 0 : true;
  const needAc = frame.progressive ? Se > 0 : true;
  const scan = sel.map((s) => {
    const dc = huffDC[s.td], ac = huffAC[s.ta];
    if ((needDc && !dc) || (needAc && !ac)) throw new PdfParseError('JPEG: missing Huffman table');
    // The cast is sound because the same Ss/Se choose the decoder below: a
    // decoder never reads the class its own scan did not reference.
    return { c: s.c, dc: dc as Huff, ac: ac as Huff };
  });

  const r = new BitReader(data, entropy);
  const pred = new Int32Array(scan.length);
  let eobrun = 0;

  // Baseline sequential: full DC+AC block (raw coefficients).
  const decodeBaseline = (si: number, off: number) => {
    const sc = scan[si], c = sc.c;
    const t = decodeHuff(r, sc.dc); const diff = t === 0 ? 0 : extend(r.receive(t), t); pred[si] += diff;
    c.blocks[off] = pred[si];
    let k = 1;
    while (k < 64) {
      const rs = decodeHuff(r, sc.ac); const run = rs >> 4, size = rs & 15;
      if (size === 0) { if (run === 15) { k += 16; continue; } break; }
      k += run; if (k > 63) break;
      c.blocks[off + ZIGZAG[k]] = extend(r.receive(size), size); k++;
    }
  };
  // Progressive DC first scan: coeff[0] = accumulated predictor << Al.
  const decodeDCFirst = (si: number, off: number) => {
    const t = decodeHuff(r, scan[si].dc); const diff = t === 0 ? 0 : extend(r.receive(t), t); pred[si] += diff;
    scan[si].c.blocks[off] = pred[si] << Al;
  };
  // Progressive AC first scan: run/size over band Ss..Se, with EOB-run tracking.
  const decodeACFirst = (si: number, off: number) => {
    const c = scan[si].c;
    if (eobrun > 0) { eobrun--; return; }
    let k = Ss;
    while (k <= Se) {
      const rs = decodeHuff(r, scan[si].ac); const run = rs >> 4, size = rs & 15;
      if (size === 0) { if (run < 15) { eobrun = (1 << run) + (run ? r.receive(run) : 0) - 1; break; } k += 16; continue; }
      k += run; if (k > Se) break;
      c.blocks[off + ZIGZAG[k]] = extend(r.receive(size), size) << Al; k++;
    }
  };
  // Progressive DC refinement: append one lower-order bit to the DC coefficient.
  const decodeDCRefine = (si: number, off: number) => {
    if (r.readBit()) scan[si].c.blocks[off] |= (1 << Al);
  };
  // Progressive AC refinement: correction bits for existing coeffs + new ±(1<<Al) coeffs, with EOB-run.
  const decodeACRefine = (si: number, off: number) => {
    const c = scan[si].c; const bit = 1 << Al; let k = Ss;
    if (eobrun > 0) { // inside an EOB run: only correction bits for already-nonzero coeffs
      for (; k <= Se; k++) { const z = ZIGZAG[k], v = c.blocks[off + z]; if (v !== 0 && r.readBit()) c.blocks[off + z] += v > 0 ? bit : -bit; }
      eobrun--; return;
    }
    while (k <= Se) {
      const rs = decodeHuff(r, scan[si].ac); let run = rs >> 4; const size = rs & 15; let value = 0;
      if (size === 0) {
        if (run < 15) { eobrun = (1 << run) + (run ? r.receive(run) : 0) - 1; for (; k <= Se; k++) { const z = ZIGZAG[k], v = c.blocks[off + z]; if (v !== 0 && r.readBit()) c.blocks[off + z] += v > 0 ? bit : -bit; } return; }
        // run === 15 → skip 16 zero-history coefficients (ZRL)
      } else { value = r.readBit() ? bit : -bit; }
      while (k <= Se) { const z = ZIGZAG[k], v = c.blocks[off + z]; if (v !== 0) { if (r.readBit()) c.blocks[off + z] += v > 0 ? bit : -bit; } else { if (run === 0) break; run--; } k++; }
      if (value !== 0 && k <= Se) c.blocks[off + ZIGZAG[k]] = value;
      k++;
    }
  };

  const progressive = frame.progressive;
  let decodeBlock: (si: number, off: number) => void;
  if (!progressive) decodeBlock = decodeBaseline;
  else if (Ss === 0) decodeBlock = Ah === 0 ? decodeDCFirst : decodeDCRefine;
  else decodeBlock = Ah === 0 ? decodeACFirst : decodeACRefine;

  const resetPredictors = () => { pred.fill(0); eobrun = 0; };
  forEachBlockInScan(frame, scan, restartInterval, decodeBlock, () => { r.restart(); resetPredictors(); });
  return r.pos;
}

function assemble(frame: Frame, adobeTransform: number | undefined, qt: (Int32Array | undefined)[]): JpegImage {
  const { comps, precision } = frame;
  const shift = 1 << (precision - 1);          // level shift: 128 (8-bit) / 2048 (12-bit)
  const maxv = (1 << precision) - 1;           // 255 (8-bit) / 4095 (12-bit)
  const down = precision - 8;                  // right-shift to map maxv → 255 (0 for 8-bit, 4 for 12-bit)
  const planes = comps.map((c) => {
    const q = qt[c.tq]; if (!q) throw new PdfParseError('JPEG: missing quant table');
    const qn = new Int32Array(64); for (let k = 0; k < 64; k++) qn[ZIGZAG[k]] = q[k]; // natural-order quant
    const pw = c.bpl * 8, ph = c.bpc * 8; const plane = new Uint8Array(pw * ph);
    const out = new Array(64); const dq = new Int32Array(64);
    for (let br = 0; br < c.bpc; br++) for (let bc = 0; bc < c.bpl; bc++) {
      const off = (br * c.bpl + bc) * 64;
      for (let i = 0; i < 64; i++) dq[i] = c.blocks[off + i] * qn[i];
      idct(dq, 0, out, shift, maxv);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) plane[(br * 8 + y) * pw + (bc * 8 + x)] = out[y * 8 + x] >> down;
    }
    return { plane, pw, ph, h: c.h, v: c.v };
  });
  return combinePlanes(frame, planes, adobeTransform);
}

export interface Plane { plane: Uint8Array; pw: number; ph: number; h: number; v: number }

// Upsample each component plane to full resolution, interleave, and apply the
// JPEG→output colour transform (YCbCr→RGB / CMYK). Shared by the DCT `assemble`
// and the lossless assembler.
/**
 * The JPEG→output colour transform in force: 0 = none, 1 = YCbCr, 2 = YCCK.
 *
 * Three components with SOF ids 'R','G','B' are ALREADY RGB and must not be
 * inverse-transformed. libjpeg's jpeg_default_colorspace makes the same test,
 * and it is the only signal such a file carries: it has no Adobe APP14 marker
 * (whose transform byte would otherwise decide) and no JFIF marker either.
 * libtiff writes exactly this shape for a JPEG-compressed TIFF whose
 * photometric is 2 (RGB), so without the test every such file decodes to
 * garbage -- R and B pinned near zero. An Adobe marker still outranks it,
 * since that states the producer's intent explicitly.
 *
 * ONE owner, because `jpegtranscode.ts` asks the same question for a different
 * reason: transform 0 means component 0 is RED, and greying by keeping it would
 * emit the red channel as luma -- a plausible-looking picture that is entirely
 * wrong, with nothing anywhere to flag it.
 */
export function jpegTransform(frame: Frame, adobeTransform: number | undefined): number {
  const nc = frame.comps.length;
  const rgbIds = nc === 3 && frame.comps[0].id === 0x52
    && frame.comps[1].id === 0x47 && frame.comps[2].id === 0x42;
  return adobeTransform !== undefined ? adobeTransform : rgbIds ? 0 : nc === 3 ? 1 : 0;
}

export function combinePlanes(frame: Frame, planes: Plane[], adobeTransform: number | undefined): JpegImage {
  const { width, height, maxH, maxV } = frame;
  const nc = planes.length;
  const data = new Uint8Array(width * height * nc);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const di = (y * width + x) * nc;
    for (let ci = 0; ci < nc; ci++) {
      const pl = planes[ci];
      const sx = Math.min(pl.pw - 1, ((x * pl.h) / maxH) | 0);
      const sy = Math.min(pl.ph - 1, ((y * pl.v) / maxV) | 0);
      data[di + ci] = pl.plane[sy * pl.pw + sx];
    }
  }

  const transform = jpegTransform(frame, adobeTransform);
  if (nc === 3 && transform !== 0) ycbcrToRgb(data);
  else if (nc === 4) cmyk(data, transform, adobeTransform !== undefined);
  return { width, height, comps: nc, data };
}

const cl = (v: number) => { v = Math.round(v); return v < 0 ? 0 : v > 255 ? 255 : v; };
function ycbcrToRgb(d: Uint8Array): void {
  for (let i = 0; i < d.length; i += 3) {
    const Y = d[i], Cb = d[i + 1] - 128, Cr = d[i + 2] - 128;
    d[i] = cl(Y + 1.402 * Cr); d[i + 1] = cl(Y - 0.344136 * Cb - 0.714136 * Cr); d[i + 2] = cl(Y + 1.772 * Cb);
  }
}
function cmyk(d: Uint8Array, transform: number, adobe: boolean): void {
  for (let i = 0; i < d.length; i += 4) {
    let c: number, m: number, y: number; let k = d[i + 3];
    if (transform === 2) { const Y = d[i], Cb = d[i + 1] - 128, Cr = d[i + 2] - 128; c = 255 - cl(Y + 1.402 * Cr); m = 255 - cl(Y - 0.344136 * Cb - 0.714136 * Cr); y = 255 - cl(Y + 1.772 * Cb); }
    else { c = d[i]; m = d[i + 1]; y = d[i + 2]; }
    if (adobe) { c = 255 - c; m = 255 - m; y = 255 - y; k = 255 - k; }
    d[i] = c; d[i + 1] = m; d[i + 2] = y; d[i + 3] = k;
  }
}
