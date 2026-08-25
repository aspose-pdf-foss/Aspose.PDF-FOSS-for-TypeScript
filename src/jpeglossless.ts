// Lossless (Annex H) JPEG decode: SOF3 (Huffman) and SOF11 (arithmetic). A
// predictive spatial pipeline — no DCT/quant/IDCT. Reuses jpeg.ts's Huffman
// primitives and combinePlanes, and jpegarith.ts's QM decoder; emits per-
// component sample planes consumed by combinePlanes.
import { PdfParseError } from './errors.js';
import { BitReader, decodeHuff, extend, combinePlanes } from './jpeg.js';
import type { Frame, Comp, Huff, Plane, JpegImage } from './jpeg.js';
import { ArithDecoder, decodeArithDiff } from './jpegarith.js';

// Allocate per-component full-resolution sample planes (T.81 A.2: a lossless data
// unit is one sample). bpl/bpc are the padded plane stride/height;
// blocksPerLine/blocksPerColumn hold the actual (unpadded) sample extent.
export function setupLosslessGeometry(frame: Frame): void {
  frame.mcusPerLine = Math.ceil(frame.width / frame.maxH);
  frame.mcusPerColumn = Math.ceil(frame.height / frame.maxV);
  for (const c of frame.comps) {
    c.bpl = frame.mcusPerLine * c.h;
    c.bpc = frame.mcusPerColumn * c.v;
    c.blocksPerLine = Math.ceil((frame.width * c.h) / frame.maxH);
    c.blocksPerColumn = Math.ceil((frame.height * c.v) / frame.maxV);
    c.samples = new Int32Array(c.bpl * c.bpc);
  }
}

// H.1.2.1 predictor selection (psv 1..7) from neighbours Ra (left), Rb (above),
// Rc (above-left).
export function losslessPredict(psv: number, ra: number, rb: number, rc: number): number {
  switch (psv) {
    case 1: return ra; case 2: return rb; case 3: return rc;
    case 4: return ra + rb - rc;
    case 5: return ra + ((rb - rc) >> 1);
    case 6: return rb + ((ra - rc) >> 1);
    case 7: return (ra + rb) >> 1;
    default: throw new PdfParseError(`JPEG: unsupported lossless predictor ${psv}`);
  }
}

interface LScan { c: Comp; td: number }

export function decodeLosslessScan(
  data: Uint8Array, seg: number, frame: Frame,
  huffDC: (Huff | undefined)[], dcCond: { L: number; U: number }[], restartInterval: number,
): number {
  const ns = data[seg]; let p = seg + 1;
  const scan: LScan[] = [];
  for (let i = 0; i < ns; i++) {
    const cs = data[p], td = data[p + 1] >> 4; p += 2;
    const c = frame.comps.find((k) => k.id === cs); if (!c) throw new PdfParseError('JPEG: bad scan component');
    scan.push({ c, td });
  }
  const psv = data[p], Pt = data[p + 2] & 15; p += 3;
  const P = frame.precision;
  const def = 1 << (P - Pt - 1);
  const reset = new Array(ns).fill(true); // start-of-scan default for first sample

  // Per-component difference readers (Huffman table or arithmetic stats+context).
  let readDiff: (si: number) => number;
  let onRestart: () => void;
  let endPos: () => number;
  if (!frame.arithmetic) {
    const r = new BitReader(data, p);
    const tables = scan.map((s) => { const t = huffDC[s.td]; if (!t) throw new PdfParseError('JPEG: missing lossless Huffman table'); return t; });
    readDiff = (si) => { const s = decodeHuff(r, tables[si]); return s === 0 ? 0 : s === 16 ? 32768 : extend(r.receive(s), s); };
    onRestart = () => { r.restart(); reset.fill(true); };
    endPos = () => r.pos;
  } else {
    const dec = new ArithDecoder(data, p);
    const statsByTd = new Map<number, Uint8Array>();
    const dcStats = (td: number) => { let s = statsByTd.get(td); if (!s) statsByTd.set(td, s = new Uint8Array(64)); return s; };
    const ctx = new Int32Array(ns);
    const stats = scan.map((s) => dcStats(s.td));
    const bounds = scan.map((s) => dcCond[s.td] ?? { L: 0, U: 1 });
    readDiff = (si) => decodeArithDiff(dec, stats[si], ctx, si, bounds[si].L, bounds[si].U);
    onRestart = () => { dec.restart(); for (const s of statsByTd.values()) s.fill(0); ctx.fill(0); reset.fill(true); };
    endPos = () => dec.endPos();
  }

  // Decode one sample of component si at plane coordinate (x,y).
  const decodeSample = (si: number, x: number, y: number) => {
    const c = scan[si].c; const S = c.samples!; const bpl = c.bpl;
    let px: number;
    if (psv === 0) px = 0;                       // differential frame: reference supplies prediction
    else if (reset[si]) { px = def; reset[si] = false; }
    else if (y === 0) px = S[x - 1];
    else if (x === 0) px = S[(y - 1) * bpl];
    else px = losslessPredict(psv, S[y * bpl + x - 1], S[(y - 1) * bpl + x], S[(y - 1) * bpl + x - 1]);
    S[y * bpl + x] = (px + readDiff(si)) & 0xffff;
  };

  // Traversal: interleaved MCUs for ns>1, else per-sample raster.
  let mcu = 0;
  if (ns > 1) {
    const total = frame.mcusPerLine * frame.mcusPerColumn;
    for (let my = 0; my < frame.mcusPerColumn; my++) for (let mx = 0; mx < frame.mcusPerLine; mx++) {
      for (let si = 0; si < ns; si++) { const c = scan[si].c; for (let by = 0; by < c.v; by++) for (let bx = 0; bx < c.h; bx++) decodeSample(si, mx * c.h + bx, my * c.v + by); }
      mcu++; if (restartInterval && mcu % restartInterval === 0 && mcu < total) onRestart();
    }
  } else {
    const c = scan[0].c; const total = c.blocksPerLine * c.blocksPerColumn;
    for (let y = 0; y < c.blocksPerColumn; y++) for (let x = 0; x < c.blocksPerLine; x++) {
      decodeSample(0, x, y);
      mcu++; if (restartInterval && mcu % restartInterval === 0 && mcu < total) onRestart();
    }
  }

  // Apply point transform (samples were coded point-transformed; scale back up).
  if (Pt) for (const s of scan) { const S = s.c.samples!; for (let i = 0; i < S.length; i++) S[i] <<= Pt; }
  return endPos();
}

// Emit per-component planes (precision-downshifted to 8-bit) and interleave/colour
// via the shared combinePlanes.
export function assembleLossless(frame: Frame, adobeTransform: number | undefined): JpegImage {
  const down = frame.precision - 8;
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
  const planes: Plane[] = frame.comps.map((c) => {
    const S = c.samples!; const plane = new Uint8Array(S.length);
    for (let i = 0; i < S.length; i++) plane[i] = clamp(S[i] >> down);
    return { plane, pw: c.bpl, ph: c.bpc, h: c.h, v: c.v };
  });
  return combinePlanes(frame, planes, adobeTransform);
}
