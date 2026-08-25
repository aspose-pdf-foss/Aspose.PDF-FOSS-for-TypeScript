// Inverse (and, for testing, forward) discrete wavelet transform —
// ISO/IEC 15444-1 Annex F. 1D lifting on interleaved arrays: even indices carry
// the low-pass band, odd indices the high-pass band. Boundaries use whole-sample
// symmetric (periodic-reflective) extension.

/** Whole-sample symmetric index reflection into [0, len). */
function reflect(i: number, len: number): number {
  if (len === 1) return 0;
  const period = 2 * (len - 1);
  let k = ((i % period) + period) % period;
  if (k < 0) k += period;
  return k < len ? k : period - k;
}

// ---- 5/3 reversible (integer) ----

/** Inverse 5/3 lifting over `a[off + k*stride]`, k in [0, len). */
export function idwt1d53(a: Float32Array, off: number, len: number, stride: number): void {
  if (len < 2) return;
  const at = (i: number) => a[off + reflect(i, len) * stride];
  // Even (low) update: s(2n) -= floor((d(2n-1) + d(2n+1) + 2) / 4)
  for (let i = 0; i < len; i += 2) a[off + i * stride] = at(i) - Math.floor((at(i - 1) + at(i + 1) + 2) / 4);
  // Odd (high) update: d(2n+1) += floor((s(2n) + s(2n+2)) / 2)
  for (let i = 1; i < len; i += 2) a[off + i * stride] = at(i) + Math.floor((at(i - 1) + at(i + 1)) / 2);
}

/** Forward 5/3 lifting (exact inverse of {@link idwt1d53}). For tests. */
export function fdwt1d53(a: Float32Array, off: number, len: number, stride: number): void {
  if (len < 2) return;
  const at = (i: number) => a[off + reflect(i, len) * stride];
  // Odd (high): d(2n+1) -= floor((s(2n) + s(2n+2)) / 2)
  for (let i = 1; i < len; i += 2) a[off + i * stride] = at(i) - Math.floor((at(i - 1) + at(i + 1)) / 2);
  // Even (low): s(2n) += floor((d(2n-1) + d(2n+1) + 2) / 4)
  for (let i = 0; i < len; i += 2) a[off + i * stride] = at(i) + Math.floor((at(i - 1) + at(i + 1) + 2) / 4);
}

// ---- 9/7 irreversible (float) ----
// Lifting constants (Annex F, Table F.4).
const A97 = -1.586134342059924, B97 = -0.052980118572961,
      G97 = 0.882911075530934, D97 = 0.443506852043971,
      K97 = 1.230174104914001;

/** Inverse 9/7 lifting over `a[off + k*stride]`, k in [0, len). */
export function idwt1d97(a: Float32Array, off: number, len: number, stride: number): void {
  if (len < 2) return;
  const at = (i: number) => a[off + reflect(i, len) * stride];
  const set = (i: number, v: number) => { a[off + i * stride] = v; };
  // Undo scaling: even *= K, odd *= 1/K.
  for (let i = 0; i < len; i += 2) set(i, at(i) * K97);
  for (let i = 1; i < len; i += 2) set(i, at(i) / K97);
  // Undo delta (even), gamma (odd), beta (even), alpha (odd).
  for (let i = 0; i < len; i += 2) set(i, at(i) - D97 * (at(i - 1) + at(i + 1)));
  for (let i = 1; i < len; i += 2) set(i, at(i) - G97 * (at(i - 1) + at(i + 1)));
  for (let i = 0; i < len; i += 2) set(i, at(i) - B97 * (at(i - 1) + at(i + 1)));
  for (let i = 1; i < len; i += 2) set(i, at(i) - A97 * (at(i - 1) + at(i + 1)));
}

/** Forward 9/7 lifting (exact inverse of {@link idwt1d97}). For tests. */
export function fdwt1d97(a: Float32Array, off: number, len: number, stride: number): void {
  if (len < 2) return;
  const at = (i: number) => a[off + reflect(i, len) * stride];
  const set = (i: number, v: number) => { a[off + i * stride] = v; };
  for (let i = 1; i < len; i += 2) set(i, at(i) + A97 * (at(i - 1) + at(i + 1)));
  for (let i = 0; i < len; i += 2) set(i, at(i) + B97 * (at(i - 1) + at(i + 1)));
  for (let i = 1; i < len; i += 2) set(i, at(i) + G97 * (at(i - 1) + at(i + 1)));
  for (let i = 0; i < len; i += 2) set(i, at(i) + D97 * (at(i - 1) + at(i + 1)));
  for (let i = 0; i < len; i += 2) set(i, at(i) / K97);
  for (let i = 1; i < len; i += 2) set(i, at(i) * K97);
}

// ---- 2D driver ----

export interface Subband { type: 'LL' | 'HL' | 'LH' | 'HH'; x0: number; y0: number; x1: number; y1: number; coeffs: Float32Array }
export interface ResolutionSpec { level: number; x0: number; y0: number; x1: number; y1: number; subbands: Subband[] }

/** Reconstruct a component tile from its resolution pyramid: start at the LL band,
 *  and for each higher resolution interleave the four subbands into the even/odd
 *  lattice and apply a 2D inverse lift (rows then columns). Returns the full-res
 *  tile row-major. */
export function inverseDwt(resolutions: ResolutionSpec[], reversible: boolean): Float32Array {
  const idwt1d = reversible ? idwt1d53 : idwt1d97;
  const r0 = resolutions[0];
  let cur = resolutions[0].subbands[0].coeffs.slice();
  let curW = r0.x1 - r0.x0, curH = r0.y1 - r0.y0;

  for (let r = 1; r < resolutions.length; r++) {
    const res = resolutions[r];
    const w = res.x1 - res.x0, h = res.y1 - res.y0;
    const buf = new Float32Array(w * h);
    const byType = (t: Subband['type']) => res.subbands.find((s) => s.type === t)!;
    // LL (previous resolution) → even/even lattice.
    for (let y = 0; y < curH; y++) for (let x = 0; x < curW; x++) buf[(2 * y) * w + 2 * x] = cur[y * curW + x];
    const place = (sb: Subband, ox: number, oy: number) => {
      const sw = sb.x1 - sb.x0, sh = sb.y1 - sb.y0;
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) buf[(2 * y + oy) * w + (2 * x + ox)] = sb.coeffs[y * sw + x];
    };
    place(byType('HL'), 1, 0);
    place(byType('LH'), 0, 1);
    place(byType('HH'), 1, 1);
    for (let y = 0; y < h; y++) idwt1d(buf, y * w, w, 1);
    for (let x = 0; x < w; x++) idwt1d(buf, x, h, w);
    cur = buf; curW = w; curH = h;
  }
  return cur;
}
