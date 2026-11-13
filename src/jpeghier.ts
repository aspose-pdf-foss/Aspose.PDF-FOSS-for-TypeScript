// Hierarchical (T.81 Annex J) JPEG decode: DHP frame progression, EXP 2×
// reference expansion, and differential frames (SOF5-7 / SOF13-15) whose residual
// is added onto the upsampled reconstruction of the previous frame. Reuses the
// single-frame entropy/transform paths; only reconstruction (no level shift for
// DCT, Psv=0 for lossless) and composition differ.
import { PdfParseError } from './errors.js';
import { LoadLimits } from './loadlimits.js';
import { idct, ZIGZAG, combinePlanes, parseSof, parseDQT, parseDHT, parseDAC, decodeScan } from './jpeg.js';
import type { Frame, Plane, Huff, JpegImage } from './jpeg.js';
import { decodeArithScan } from './jpegarith.js';
import { decodeLosslessScan } from './jpeglossless.js';

// Retain fractional IDCT samples through expansion and DCT residual addition.
// A lossless residual takes the floor of its reference before adding integers.
const FRACTION_BITS = 4;
const SCALE = 1 << FRACTION_BITS;

// Pre-walk markers to the first scan; hierarchical iff a DHP (0xDE) or a
// differential SOF (0xC5-C7 / 0xCD-CF) appears first.
export function isHierarchical(data: Uint8Array): boolean {
  let pos = 2;
  while (pos + 1 < data.length) {
    if (data[pos] !== 0xff) { pos++; continue; }
    const m = data[pos + 1]; pos += 2;
    if (m === 0xd9 || m === 0xda) return false;                       // EOI / SOS reached
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;             // standalone markers
    if (m === 0xde) return true;                                      // DHP
    if ((m >= 0xc5 && m <= 0xc7) || (m >= 0xcd && m <= 0xcf)) return true; // differential SOF
    if (pos + 1 >= data.length) return false;
    pos += (data[pos] << 8) | data[pos + 1];                          // skip segment by length
  }
  return false;
}

// Expand a component plane ×2 horizontally and/or vertically by bilinear
// interpolation (even = original, odd = floor((a+b)/2), last replicated).
export function upsample2x(plane: Int32Array, pw: number, ph: number, eh: boolean, ev: boolean): { plane: Int32Array; pw: number; ph: number } {
  let cur = plane, cw = pw, ch = ph;
  if (eh) {
    const nw = cw * 2; const out = new Int32Array(nw * ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const a = cur[y * cw + x]; const b = x + 1 < cw ? cur[y * cw + x + 1] : a; out[y * nw + 2 * x] = a; out[y * nw + 2 * x + 1] = (a + b) >> 1; }
    cur = out; cw = nw;
  }
  if (ev) {
    const nh = ch * 2; const out = new Int32Array(cw * nh);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const a = cur[y * cw + x]; const b = y + 1 < ch ? cur[(y + 1) * cw + x] : a; out[(2 * y) * cw + x] = a; out[(2 * y + 1) * cw + x] = (a + b) >> 1; }
    cur = out; ch = nh;
  }
  return { plane: cur, pw: cw, ph: ch };
}

interface Dim { pw: number; ph: number }

// Reconstruct a DCT frame to per-component fixed-point planes at image extent.
// The reference must retain IDCT excursions outside the sample range: later
// residuals were encoded against those values, before final output clamping.
function dctPlanes(frame: Frame): { planes: Int32Array[]; dims: Dim[] } {
  const { precision, differential } = frame;
  const shift = differential ? 0 : (1 << (precision - 1)) * SCALE;
  const maxv = (1 << precision) - 1;
  const planes: Int32Array[] = []; const dims: Dim[] = [];
  for (const c of frame.comps) {
    const q = c.quant; if (!q) throw new PdfParseError('JPEG: missing quant table');
    const qn = new Int32Array(64); for (let k = 0; k < 64; k++) qn[ZIGZAG[k]] = q[k];
    const pw = Math.ceil(frame.width * c.h / frame.maxH), ph = Math.ceil(frame.height * c.v / frame.maxV);
    const plane = new Int32Array(pw * ph);
    const out = new Array(64); const dq = new Int32Array(64);
    for (let br = 0; br < c.bpc; br++) for (let bc = 0; bc < c.bpl; bc++) {
      const off = (br * c.bpl + bc) * 64;
      for (let i = 0; i < 64; i++) dq[i] = c.blocks[off + i] * qn[i];
      idct(dq, 0, out, 0, maxv, true, FRACTION_BITS);
      for (let y = 0; y < 8 && br * 8 + y < ph; y++) for (let x = 0; x < 8 && bc * 8 + x < pw; x++)
        plane[(br * 8 + y) * pw + (bc * 8 + x)] = out[y * 8 + x] + shift;
    }
    planes.push(plane); dims.push({ pw, ph });
  }
  return { planes, dims };
}

// Lossless frame planes scaled to the same fixed-point units: absolute for the
// base frame, raw residual for a differential frame (Psv=0 stores diff&0xffff).
function losslessPlanes(frame: Frame): { planes: Int32Array[]; dims: Dim[] } {
  return { planes: frame.comps.map((c) => c.samples!.map((v) => v * SCALE)), dims: frame.comps.map((c) => ({ pw: c.bpl, ph: c.bpc })) };
}

function reconstruct(frame: Frame): { planes: Int32Array[]; dims: Dim[] } {
  return frame.lossless ? losslessPlanes(frame) : dctPlanes(frame);
}

// Compose at the differential frame's actual extent, discarding an extra EXP
// edge sample. Lossless samples carry signed residuals modulo 2^16; wrapping
// the composed image to its precision instead would turn a one-LSB IDCT
// difference at white into black. Clamp only when emitting the final image.
function addResidual(ref: Int32Array, rd: Dim, res: Int32Array, sd: Dim, lossless: boolean): Int32Array {
  const out = new Int32Array(sd.pw * sd.ph);
  for (let y = 0; y < sd.ph; y++) for (let x = 0; x < sd.pw; x++) {
    const prediction = ref[Math.min(y, rd.ph - 1) * rd.pw + Math.min(x, rd.pw - 1)];
    const residual = res[y * sd.pw + x];
    out[y * sd.pw + x] = lossless
      ? ((prediction >> FRACTION_BITS) + ((residual >> FRACTION_BITS) << 16 >> 16)) * SCALE
      : prediction + residual;
  }
  return out;
}

// Downshift composed Int32 planes to 8-bit and interleave/colour via combinePlanes.
function combineFinal(frame: Frame, planes: Int32Array[], dims: Dim[], adobe: number | undefined): JpegImage {
  const down = frame.precision - 8;
  const out: Plane[] = planes.map((p, ci) => {
    const u8 = new Uint8Array(p.length); for (let i = 0; i < p.length; i++) { const v = ((p[i] + SCALE / 2) >> FRACTION_BITS) >> down; u8[i] = v < 0 ? 0 : v > 255 ? 255 : v; }
    return { plane: u8, pw: dims[ci].pw, ph: dims[ci].ph, h: frame.comps[ci].h, v: frame.comps[ci].v };
  });
  return combinePlanes(frame, out, adobe);
}

export function decodeHierarchical(data: Uint8Array, limits: LoadLimits = LoadLimits.defaults): JpegImage {
  const u16 = (p: number) => (data[p] << 8) | data[p + 1];
  const qt: (Int32Array | undefined)[] = [];
  const huffDC: (Huff | undefined)[] = []; const huffAC: (Huff | undefined)[] = [];
  const dcCond: { L: number; U: number }[] = []; const acCond: { Kx: number }[] = [];
  let adobe: number | undefined; let restartInterval = 0;
  let refPlanes: Int32Array[] | undefined; let refDims: Dim[] | undefined; let refFrame: Frame | undefined;
  let pending: Frame | undefined; let pendingExpH = false, pendingExpV = false; // EXP that preceded `pending`'s SOF
  let expH = false, expV = false;                                               // EXP accumulating for the NEXT frame
  let pos = 2;

  // Finalize the pending frame: reconstruct it, then either seed the reference
  // (first frame) or upsample the reference by the pending frame's own EXP and add
  // its residual. EXP is captured per-frame (pendingExpH/V) at SOF time, because a
  // later frame's EXP marker arrives before this frame is finalized.
  const finalize = () => {
    if (!pending) return;
    const { planes, dims } = reconstruct(pending);
    if (!refPlanes) { refPlanes = planes; refDims = dims; refFrame = pending; }
    else {
      if (pendingExpH || pendingExpV) for (let i = 0; i < refPlanes.length; i++) { const u = upsample2x(refPlanes[i], refDims![i].pw, refDims![i].ph, pendingExpH, pendingExpV); refPlanes[i] = u.plane; refDims![i] = { pw: u.pw, ph: u.ph }; }
      for (let i = 0; i < refPlanes.length; i++) {
        refPlanes[i] = addResidual(refPlanes[i], refDims![i], planes[i], dims[i], pending.lossless);
        refDims![i] = dims[i];
      }
      refFrame = pending;
    }
    pending = undefined;
  };

  while (pos < data.length) {
    if (data[pos] !== 0xff) { pos++; continue; }
    const marker = data[pos + 1]; pos += 2;
    if (marker === 0xd9) break;                                       // EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const len = u16(pos); const seg = pos + 2; const segEnd = pos + len; pos += len;

    if (marker === 0xdb) parseDQT(data, seg, segEnd, qt);
    else if (marker === 0xc4) parseDHT(data, seg, segEnd, huffDC, huffAC);
    else if (marker === 0xcc) parseDAC(data, seg, segEnd, dcCond, acCond);
    else if (marker === 0xdd) restartInterval = u16(seg);
    else if (marker === 0xde) { /* DHP: geometry defined per-frame; presence already noted */ }
    else if (marker === 0xdf) { const b = data[seg]; expH = (b >> 4 & 1) === 1; expV = (b & 1) === 1; } // EXP (for the next frame)
    else if (marker === 0xee) { if (len >= 14 && data[seg] === 0x41 && data[seg + 1] === 0x64 && data[seg + 2] === 0x6f && data[seg + 3] === 0x62 && data[seg + 4] === 0x65) adobe = data[seg + 11]; }
    else if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) { finalize(); pending = parseSof(data, seg, marker, qt, limits); pendingExpH = expH; pendingExpV = expV; expH = expV = false; }
    else if (marker === 0xda) {
      if (!pending) throw new PdfParseError('JPEG: SOS before SOF');
      pos = pending.lossless
        ? decodeLosslessScan(data, seg, pending, huffDC, dcCond, restartInterval)
        : pending.arithmetic
        ? decodeArithScan(data, seg, segEnd, pending, dcCond, acCond, restartInterval)
        : decodeScan(data, seg, segEnd, pending, huffDC, huffAC, restartInterval);
    }
  }
  finalize();
  if (!refPlanes || !refFrame || !refDims) throw new PdfParseError('JPEG: no frame data');
  return combineFinal(refFrame, refPlanes, refDims, adobe);
}
