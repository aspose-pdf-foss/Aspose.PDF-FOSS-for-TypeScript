// Minimal hierarchical (T.81 Annex J) JPEG frame-splitter encoder for tests.
// Frame 1 is a lossless low-res base (so its reconstruction equals the input
// exactly — no self-decode needed). Frame 2 is a differential frame encoding
// residual = full − upsample(base), reusing the single-frame encoders in their
// `differential` mode with the SOF marker rewritten to the differential variant.
import { encodeLosslessJpeg } from './build-jpeg-lossless.js';
import { encodeBaselineJpeg, encodeProgressiveJpeg } from './build-jpeg.js';
import { encodeSequentialArithJpeg, encodeProgressiveArithJpeg } from './build-jpeg-arith.js';
import { upsample2x } from '../../src/jpeghier.js';

export interface HierEncodeOptions {
  width: number; height: number;
  comps: 1 | 3;
  pixels: ArrayLike<number>;             // 0..255, comps-interleaved
  residual: 'seq-dct' | 'prog-dct' | 'lossless';
  mode?: 'huffman' | 'arithmetic';       // default 'huffman'
  expand?: 'h' | 'v' | 'hv';             // default 'hv'
}

// Non-differential → differential SOF marker rewrite.
const DIFF_MARKER: Record<number, number> = { 0xc0: 0xc5, 0xc1: 0xc5, 0xc2: 0xc6, 0xc3: 0xc7, 0xc9: 0xcd, 0xca: 0xce, 0xcb: 0xcf };

// Split a standalone JPEG into (marker, payload-with-length) segments between SOI
// and EOI. The SOS segment carries its entropy data (up to the trailing EOI).
function splitSegments(jpg: Uint8Array): { marker: number; bytes: number[] }[] {
  const segs: { marker: number; bytes: number[] }[] = [];
  let p = 2; // skip SOI
  while (p < jpg.length) {
    if (jpg[p] !== 0xff) { p++; continue; }
    const m = jpg[p + 1]; p += 2;
    if (m === 0xd9) break; // EOI
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;
    const len = (jpg[p] << 8) | jpg[p + 1];
    if (m === 0xda) { // SOS: header + entropy up to EOI
      const bytes: number[] = []; let q = p; const end = jpg.length - 2; // strip trailing EOI
      while (q < end) bytes.push(jpg[q++]);
      segs.push({ marker: m, bytes }); break;
    }
    const bytes: number[] = []; for (let i = 0; i < len; i++) bytes.push(jpg[p + i]);
    segs.push({ marker: m, bytes }); p += len;
  }
  return segs;
}

export function encodeHierarchicalJpeg(o: HierEncodeOptions): Uint8Array {
  const { width: w, height: h, comps, pixels } = o;
  const eh = o.expand !== 'v', ev = o.expand !== 'h'; // default 'hv'
  const bw = eh ? w >> 1 : w, bh = ev ? h >> 1 : h;   // base (low-res) dims

  // --- Base frame: decimate full image by 2 in expanded axes. ---
  const base = new Uint8Array(bw * bh * comps);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) for (let ci = 0; ci < comps; ci++) {
    const sx = eh ? x * 2 : x, sy = ev ? y * 2 : y;
    base[(y * bw + x) * comps + ci] = pixels[(sy * w + sx) * comps + ci];
  }
  const baseJpg = encodeLosslessJpeg({ width: bw, height: bh, comps, pixels: base });

  // --- Reference = upsample(base) per component (matches the decoder). ---
  const up: Int32Array[] = [];
  for (let ci = 0; ci < comps; ci++) {
    const plane = new Int32Array(bw * bh); for (let i = 0; i < bw * bh; i++) plane[i] = base[i * comps + ci];
    up.push(upsample2x(plane, bw, bh, eh, ev).plane);
  }
  const uw = eh ? bw * 2 : bw; // == w

  // --- Residual = full − reference, comps-interleaved (signed). ---
  const res: number[] = new Array(w * h * comps);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let ci = 0; ci < comps; ci++)
    res[(y * w + x) * comps + ci] = pixels[(y * w + x) * comps + ci] - up[ci][y * uw + x];

  // --- Differential frame: encode the residual, then rewrite its SOF marker. ---
  const arith = o.mode === 'arithmetic';
  let diffJpg: Uint8Array;
  if (o.residual === 'lossless') diffJpg = encodeLosslessJpeg({ width: w, height: h, comps, pixels: res, differential: true, mode: arith ? 'arithmetic' : 'huffman' });
  else if (o.residual === 'seq-dct') diffJpg = arith ? encodeSequentialArithJpeg({ width: w, height: h, comps, pixels: res, differential: true }) : encodeBaselineJpeg({ width: w, height: h, comps, pixels: res, differential: true });
  else diffJpg = arith ? encodeProgressiveArithJpeg({ width: w, height: h, comps, pixels: res, differential: true }) : encodeProgressiveJpeg({ width: w, height: h, comps, pixels: res, differential: true });

  const baseSegs = splitSegments(baseJpg);
  const diffSegs = splitSegments(diffJpg);
  for (const s of diffSegs) if (DIFF_MARKER[s.marker] !== undefined) s.marker = DIFF_MARKER[s.marker]; // SOF → differential SOF

  // --- Assemble: SOI · [APP14 from base] · DHP · base(minus APP14) · EXP · diff · EOI. ---
  const out: number[] = []; const u16 = (n: number) => out.push((n >> 8) & 0xff, n & 0xff);
  out.push(0xff, 0xd8); // SOI
  const app14 = baseSegs.find((s) => s.marker === 0xee);
  if (app14) { out.push(0xff, 0xee); for (const b of app14.bytes) out.push(b); }
  // DHP (0xDE): SOF-syntax header, full image dims, 1×1 comps, Tq=0.
  out.push(0xff, 0xde); u16(8 + comps * 3); out.push(8); u16(h); u16(w); out.push(comps); for (let i = 0; i < comps; i++) out.push(i + 1, 0x11, 0);
  for (const s of baseSegs) { if (s.marker === 0xee) continue; out.push(0xff, s.marker); for (const b of s.bytes) out.push(b); }
  out.push(0xff, 0xdf, 0x00, 0x03, ((eh ? 1 : 0) << 4) | (ev ? 1 : 0)); // EXP
  for (const s of diffSegs) { if (s.marker === 0xee) continue; out.push(0xff, s.marker); for (const b of s.bytes) out.push(b); }
  out.push(0xff, 0xd9); // EOI
  return Uint8Array.from(out);
}
