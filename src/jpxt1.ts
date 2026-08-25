// EBCOT Tier-1 code-block decoder — ISO/IEC 15444-1 Annex D.
// Decodes one code-block's MQ-coded byte segment into signed subband coefficients
// via three bit-plane coding passes: significance propagation (SP), magnitude
// refinement (MR), and cleanup (CU). The first coding pass of a code-block is a
// cleanup pass; each subsequent bit-plane runs SP, MR, CU in order.

import { MqDecoder } from './jpxmq.js';

export interface CodeBlockDecode {
  width: number;
  height: number;
  data: Uint8Array;
  /** Total coding passes across all quality layers (concatenated segment). */
  passes: number;
  /** Leading all-zero magnitude bit-planes signalled in Tier-2. */
  zeroBitPlanes: number;
  /** Magnitude bit-planes coded for this code-block: Mb(subband) − zeroBitPlanes. */
  numBitPlanes: number;
  sbType: 'LL' | 'HL' | 'LH' | 'HH';
}

const RUNLENGTH_CTX = 17;
const UNIFORM_CTX = 18;

// Sign-coding context (Table D.2) + XOR bit (Table D.3), indexed by (h+1, v+1),
// h,v ∈ {−1,0,1}.
const SIGN: { ctx: number; xor: number }[][] = [
  // v = -1,        0,             1        (rows: h = -1, 0, 1)
  [{ ctx: 13, xor: 1 }, { ctx: 12, xor: 1 }, { ctx: 11, xor: 1 }], // h = -1
  [{ ctx: 10, xor: 1 }, { ctx: 9, xor: 0 }, { ctx: 10, xor: 0 }],  // h = 0
  [{ ctx: 11, xor: 0 }, { ctx: 12, xor: 0 }, { ctx: 13, xor: 0 }], // h = 1
];

/** Zero-coding context label (Table D.1) from significant-neighbour counts. */
function zcContext(sbType: string, h: number, v: number, d: number): number {
  if (sbType === 'HH') {
    const hv = h + v;
    if (d >= 3) return 8;
    if (d === 2) return hv >= 1 ? 7 : 6;
    if (d === 1) return hv >= 2 ? 5 : hv === 1 ? 4 : 3;
    return hv >= 2 ? 2 : hv === 1 ? 1 : 0;
  }
  // LL and LH use (h, v); HL swaps the horizontal/vertical roles.
  let H = h, V = v;
  if (sbType === 'HL') { H = v; V = h; }
  if (H === 2) return 8;
  if (H === 1) return V >= 1 ? 7 : d >= 1 ? 6 : 5;
  if (V === 2) return 4;
  if (V === 1) return 3;
  if (d >= 2) return 2;
  return d === 1 ? 1 : 0;
}

/** Decode one code-block to signed reconstructed magnitudes (row-major). */
export function decodeCodeBlock(cb: CodeBlockDecode): Int32Array {
  const { width: w, height: h, data, passes, numBitPlanes, sbType } = cb;
  const out = new Int32Array(w * h);
  if (passes === 0 || data.length === 0) return out;

  const mag = new Uint32Array(w * h);      // magnitude (0 ⇒ insignificant)
  const sign = new Uint8Array(w * h);      // 0 = +, 1 = −
  const processed = new Uint8Array(w * h); // visited in SP/MR this bit-plane
  const firstRef = new Uint8Array(w * h);  // pending first magnitude refinement
  const bitsDecoded = new Uint8Array(w * h);
  const cx = new Int8Array(19);
  cx[0] = (4 << 1) | 0;             // ZC context 0 initial state (Table D.7)
  cx[RUNLENGTH_CTX] = (3 << 1) | 0; // run-length context
  cx[UNIFORM_CTX] = (46 << 1) | 0;  // uniform context
  const mq = new MqDecoder(data, 0, data.length);
  const idx = (i: number, j: number) => i * w + j;

  // Significant-neighbour counts (h, v, d) around (i, j).
  const counts = (i: number, j: number) => {
    const L = j > 0 && mag[idx(i, j - 1)] ? 1 : 0;
    const R = j + 1 < w && mag[idx(i, j + 1)] ? 1 : 0;
    const U = i > 0 && mag[idx(i - 1, j)] ? 1 : 0;
    const D = i + 1 < h && mag[idx(i + 1, j)] ? 1 : 0;
    let dg = 0;
    if (i > 0 && j > 0 && mag[idx(i - 1, j - 1)]) dg++;
    if (i > 0 && j + 1 < w && mag[idx(i - 1, j + 1)]) dg++;
    if (i + 1 < h && j > 0 && mag[idx(i + 1, j - 1)]) dg++;
    if (i + 1 < h && j + 1 < w && mag[idx(i + 1, j + 1)]) dg++;
    return { hc: L + R, vc: U + D, dc: dg };
  };
  const anyNeighbor = (i: number, j: number) => { const c = counts(i, j); return c.hc || c.vc || c.dc; };

  const decodeSign = (i: number, j: number, index: number): number => {
    let sh = 0, sv = 0;
    if (j > 0 && mag[idx(i, j - 1)]) sh += sign[idx(i, j - 1)] ? -1 : 1;
    if (j + 1 < w && mag[idx(i, j + 1)]) sh += sign[idx(i, j + 1)] ? -1 : 1;
    if (i > 0 && mag[idx(i - 1, j)]) sv += sign[idx(i - 1, j)] ? -1 : 1;
    if (i + 1 < h && mag[idx(i + 1, j)]) sv += sign[idx(i + 1, j)] ? -1 : 1;
    sh = sh < -1 ? -1 : sh > 1 ? 1 : sh;
    sv = sv < -1 ? -1 : sv > 1 ? 1 : sv;
    const s = SIGN[sh + 1][sv + 1];
    void index;
    return mq.decode(cx, s.ctx) ^ s.xor;
  };

  const sigPropOrCleanupBit = (i: number, j: number, index: number) => {
    const c = counts(i, j);
    const ctx = zcContext(sbType, c.hc, c.vc, c.dc);
    if (mq.decode(cx, ctx)) {
      sign[index] = decodeSign(i, j, index);
      mag[index] = 1;
      firstRef[index] = 1;
    }
  };

  const runSigProp = () => {
    for (let i0 = 0; i0 < h; i0 += 4) for (let j = 0; j < w; j++) {
      for (let i = i0; i < Math.min(i0 + 4, h); i++) {
        const index = idx(i, j);
        processed[index] = 0;
        if (mag[index]) continue;
        if (!anyNeighbor(i, j)) continue;
        sigPropOrCleanupBit(i, j, index);
        bitsDecoded[index]++;
        processed[index] = 1;
      }
    }
  };

  const runMagRef = () => {
    for (let i0 = 0; i0 < h; i0 += 4) for (let j = 0; j < w; j++) {
      for (let i = i0; i < Math.min(i0 + 4, h); i++) {
        const index = idx(i, j);
        if (!mag[index] || processed[index]) continue;
        let ctx = 16;
        if (firstRef[index]) { firstRef[index] = 0; ctx = anyNeighbor(i, j) ? 15 : 14; }
        mag[index] = (mag[index] << 1) | mq.decode(cx, ctx);
        bitsDecoded[index]++;
        processed[index] = 1;
      }
    }
  };

  const runCleanup = () => {
    for (let i0 = 0; i0 < h; i0 += 4) for (let j = 0; j < w; j++) {
      let k = 0;
      const stripe = Math.min(4, h - i0);
      if (stripe === 4) {
        let allZero = true;
        for (let m = 0; m < 4; m++) { const ix = idx(i0 + m, j); if (mag[ix] || processed[ix] || anyNeighbor(i0 + m, j)) { allZero = false; break; } }
        if (allZero) {
          if (mq.decode(cx, RUNLENGTH_CTX) === 0) {
            for (let m = 0; m < 4; m++) bitsDecoded[idx(i0 + m, j)]++;
            continue;
          }
          k = (mq.decode(cx, UNIFORM_CTX) << 1) | mq.decode(cx, UNIFORM_CTX);
          const i = i0 + k, index = idx(i, j);
          sign[index] = decodeSign(i, j, index);
          mag[index] = 1;
          firstRef[index] = 1;
          for (let m = 0; m <= k; m++) bitsDecoded[idx(i0 + m, j)]++;
          k++;
        }
      }
      for (; k < stripe; k++) {
        const i = i0 + k, index = idx(i, j);
        if (mag[index] || processed[index]) continue;
        sigPropOrCleanupBit(i, j, index);
        bitsDecoded[index]++;
      }
    }
  };

  for (let p = 0; p < passes; p++) {
    const kind = p === 0 ? 2 : (p - 1) % 3; // 0=SP, 1=MR, 2=CU
    if (kind === 0) runSigProp();
    else if (kind === 1) runMagRef();
    else runCleanup();
  }

  // Reconstruct signed magnitudes: shift decoded prefix to the LSB, add a
  // mid-point offset for truncated (partially decoded) coefficients.
  for (let i = 0; i < w * h; i++) {
    if (!mag[i]) { out[i] = 0; continue; }
    const shift = numBitPlanes - bitsDecoded[i];
    let m = mag[i];
    if (shift > 0) m = (m << shift) | (1 << (shift - 1));
    out[i] = sign[i] ? -m : m;
  }
  return out;
}
