// Arithmetic (QM-coder) entropy decoding for JPEG SOF9/SOF10, per ITU-T T.81
// Annex D (decoder) and F.1.4 / G.2 (DC/AC scan procedures). Ported from
// libjpeg's jdarith.c + jaricom.c. Statistics bins pack (index<<1)|mps per byte,
// exactly as libjpeg: bit 0x80 is the MPS sense, bits 0x7F the state index.
//
// Coefficients are written raw (un-dequantized) in natural order into the shared
// `Comp.blocks` store, so jpeg.ts's assemble()/IDCT/color path is reused as-is.
import { PdfParseError } from './errors.js';
import { ZIGZAG, forEachBlockInScan } from './jpeg.js';
import type { Frame, Comp } from './jpeg.js';

// Probability estimation state machine (ITU-T T.81 Table D.2), transcribed
// verbatim from libjpeg jaricom.c jpeg_aritab as [Qe, NLPS, NMPS, Switch] per
// index (0..113). Entry 113 is the fixed 0.5 estimate (T.851 §10.3).
const QE: readonly [number, number, number, number][] = [
  [0x5a1d, 1, 1, 1], [0x2586, 14, 2, 0], [0x1114, 16, 3, 0], [0x080b, 18, 4, 0],
  [0x03d8, 20, 5, 0], [0x01da, 23, 6, 0], [0x00e5, 25, 7, 0], [0x006f, 28, 8, 0],
  [0x0036, 30, 9, 0], [0x001a, 33, 10, 0], [0x000d, 35, 11, 0], [0x0006, 9, 12, 0],
  [0x0003, 10, 13, 0], [0x0001, 12, 13, 0], [0x5a7f, 15, 15, 1], [0x3f25, 36, 16, 0],
  [0x2cf2, 38, 17, 0], [0x207c, 39, 18, 0], [0x17b9, 40, 19, 0], [0x1182, 42, 20, 0],
  [0x0cef, 43, 21, 0], [0x09a1, 45, 22, 0], [0x072f, 46, 23, 0], [0x055c, 48, 24, 0],
  [0x0406, 49, 25, 0], [0x0303, 51, 26, 0], [0x0240, 52, 27, 0], [0x01b1, 54, 28, 0],
  [0x0144, 56, 29, 0], [0x00f5, 57, 30, 0], [0x00b7, 59, 31, 0], [0x008a, 60, 32, 0],
  [0x0068, 62, 33, 0], [0x004e, 63, 34, 0], [0x003b, 32, 35, 0], [0x002c, 33, 9, 0],
  [0x5ae1, 37, 37, 1], [0x484c, 64, 38, 0], [0x3a0d, 65, 39, 0], [0x2ef1, 67, 40, 0],
  [0x261f, 68, 41, 0], [0x1f33, 69, 42, 0], [0x19a8, 70, 43, 0], [0x1518, 72, 44, 0],
  [0x1177, 73, 45, 0], [0x0e74, 74, 46, 0], [0x0bfb, 75, 47, 0], [0x09f8, 77, 48, 0],
  [0x0861, 78, 49, 0], [0x0706, 79, 50, 0], [0x05cd, 48, 51, 0], [0x04de, 50, 52, 0],
  [0x040f, 50, 53, 0], [0x0363, 51, 54, 0], [0x02d4, 52, 55, 0], [0x025c, 53, 56, 0],
  [0x01f8, 54, 57, 0], [0x01a4, 55, 58, 0], [0x0160, 56, 59, 0], [0x0125, 57, 60, 0],
  [0x00f6, 58, 61, 0], [0x00cb, 59, 62, 0], [0x00ab, 61, 63, 0], [0x008f, 61, 32, 0],
  [0x5b12, 65, 65, 1], [0x4d04, 80, 66, 0], [0x412c, 81, 67, 0], [0x37d8, 82, 68, 0],
  [0x2fe8, 83, 69, 0], [0x293c, 84, 70, 0], [0x2379, 86, 71, 0], [0x1edf, 87, 72, 0],
  [0x1aa9, 87, 73, 0], [0x174e, 72, 74, 0], [0x1424, 72, 75, 0], [0x119c, 74, 76, 0],
  [0x0f6b, 74, 77, 0], [0x0d51, 75, 78, 0], [0x0bb6, 77, 79, 0], [0x0a40, 77, 48, 0],
  [0x5832, 80, 81, 1], [0x4d1c, 88, 82, 0], [0x438e, 89, 83, 0], [0x3bdd, 90, 84, 0],
  [0x34ee, 91, 85, 0], [0x2eae, 92, 86, 0], [0x299a, 93, 87, 0], [0x2516, 86, 71, 0],
  [0x5570, 88, 89, 1], [0x4ca9, 95, 90, 0], [0x44d9, 96, 91, 0], [0x3e22, 97, 92, 0],
  [0x3824, 99, 93, 0], [0x32b4, 99, 94, 0], [0x2e17, 93, 86, 0], [0x56a8, 95, 96, 1],
  [0x4f46, 101, 97, 0], [0x47e5, 102, 98, 0], [0x41cf, 103, 99, 0], [0x3c3d, 104, 100, 0],
  [0x375e, 99, 93, 0], [0x5231, 105, 102, 0], [0x4c0f, 106, 103, 0], [0x4639, 107, 104, 0],
  [0x415e, 103, 99, 0], [0x5627, 105, 106, 1], [0x50e7, 108, 107, 0], [0x4b85, 109, 103, 0],
  [0x5597, 110, 109, 0], [0x504f, 111, 107, 0], [0x5a10, 110, 111, 1], [0x5522, 112, 109, 0],
  [0x59eb, 112, 111, 1], [0x5a1d, 113, 113, 0],
];

// Packed like jaricom.c: (Qe<<16) | (NMPS<<8) | (Switch<<7) | NLPS. The decode
// accessor reads: nl = v&0xFF (NLPS + switch bit), nm = (v>>8)&0xFF, qe = v>>16.
const ARITAB = new Int32Array(QE.map(([qe, nl, nm, sw]) => (qe << 16) | (nm << 8) | (sw << 7) | nl));

/** QM arithmetic decoder over a JPEG entropy segment (T.81 Annex D). */
export class ArithDecoder {
  private c = 0;         // C register: coding-interval base + input bit buffer
  private a = 0;         // A register: normalized interval size
  private ct = -16;      // bit-shift counter (init forces 2 initial byte reads)
  private markerHit = false;
  private markerPos = 0; // position of the 0xFF of the marker that stopped input

  constructor(private d: Uint8Array, private p: number) {}

  private getByte(): number { return this.p < this.d.length ? this.d[this.p++] : 0; }

  // Renormalize A and refill C, handling 0xFF stuffing / markers (D.2.6). A
  // marker (0xFF followed by a non-0x00 code) ends the entropy input; zero data
  // is supplied thereafter.
  private renorm(): void {
    while (this.a < 0x8000) {
      if (--this.ct < 0) {
        let data: number;
        if (this.markerHit) data = 0;
        else {
          data = this.getByte();
          if (data === 0xff) {
            do data = this.getByte(); while (data === 0xff);
            if (data === 0) data = 0xff;               // stuffed 0xFF00 → real 0xFF byte
            else { this.markerHit = true; this.markerPos = this.p - 2; data = 0; }
          }
        }
        this.c = this.c * 256 + data;                  // (c << 8) | data  (c*256 clears low byte)
        if ((this.ct += 8) < 0) if (++this.ct === 0) this.a = 0x8000;
      }
      this.a *= 2;                                     // a <<= 1
    }
  }

  /** Decode one binary decision against statistics bin `s` in `stats`. */
  decode(stats: Uint8Array, s: number): 0 | 1 {
    this.renorm();
    let sv = stats[s];
    let packed = ARITAB[sv & 0x7f];
    const nl = packed & 0xff; packed >>>= 8;           // Next_Index_LPS + Switch_MPS
    const nm = packed & 0xff; packed >>>= 8;           // Next_Index_MPS
    const qe = packed;                                 // Qe value
    let temp = this.a - qe;
    this.a = temp;
    temp = temp * (1 << this.ct);                      // temp <<= ct (ct in 0..7 here)
    if (this.c >= temp) {
      this.c -= temp;
      if (this.a < qe) { this.a = qe; stats[s] = (sv & 0x80) ^ nm; }
      else { this.a = qe; stats[s] = (sv & 0x80) ^ nl; sv ^= 0x80; }
    } else if (this.a < 0x8000) {
      if (this.a < qe) { stats[s] = (sv & 0x80) ^ nl; sv ^= 0x80; }
      else { stats[s] = (sv & 0x80) ^ nm; }
    }
    return ((sv >> 7) & 1) as 0 | 1;
  }

  /** Resynchronize past a restart (RSTn) marker and re-init the decoder. */
  restart(): void {
    let p = this.markerHit ? this.markerPos : this.p;
    while (p + 1 < this.d.length) {
      if (this.d[p] === 0xff) {
        const m = this.d[p + 1];
        if (m >= 0xd0 && m <= 0xd7) { this.p = p + 2; break; }   // RSTn
        if (m !== 0xff && m !== 0x00) { this.p = p; break; }     // some other marker
      }
      p++;
    }
    this.markerHit = false; this.markerPos = 0;
    this.c = 0; this.a = 0; this.ct = -16;
  }

  /** Byte position at/just before the marker terminating this scan's entropy. */
  endPos(): number {
    if (this.markerHit) return this.markerPos;
    let p = this.p;
    while (p + 1 < this.d.length) {
      if (this.d[p] === 0xff) { const m = this.d[p + 1]; if (m !== 0x00 && m !== 0xff) return p; }
      p++;
    }
    return this.d.length;
  }
}

/** Decode one DC-difference value (T.81 F.1.4.4.1) against DC statistics `stats`
 *  with conditioning bounds L/U, returning the signed difference and updating the
 *  per-component conditioning context `ctx[si]`. Shared by the DCT DC decoder and
 *  the lossless (SOF11) difference decoder. */
export function decodeArithDiff(dec: ArithDecoder, stats: Uint8Array, ctx: Int32Array, si: number, L: number, U: number): number {
  let st = ctx[si];
  if (dec.decode(stats, st) === 0) { ctx[si] = 0; return 0; }
  const sign = dec.decode(stats, st + 1);
  st += 2 + sign;                                // SP (S0+2) if positive, SN (S0+3) if negative
  let m = dec.decode(stats, st);
  if (m !== 0) { st = 20; while (dec.decode(stats, st)) { if ((m <<= 1) === 0x8000) throw new PdfParseError('JPEG: arithmetic DC magnitude overflow'); st += 1; } }
  ctx[si] = m < ((1 << L) >> 1) ? 0 : m > ((1 << U) >> 1) ? 12 + sign * 4 : 4 + sign * 4;
  let v = m; st += 14; while ((m >>= 1) !== 0) if (dec.decode(stats, st)) v |= m;
  v += 1; return sign ? -v : v;
}

/** Decode an arithmetic (SOF9/SOF10) entropy scan into `frame.comps[].blocks`,
 *  ported from libjpeg jdarith.c (decode_mcu, F.1.4 sequential). Statistics areas
 *  are keyed by DC/AC table number (Td/Ta) so components sharing a table share
 *  their adaptive bins; DC prediction and conditioning context are per scan
 *  component. Returns the byte position of the marker terminating the scan. */
export function decodeArithScan(
  data: Uint8Array, seg: number, _entropyEnd: number, frame: Frame,
  dcCond: { L: number; U: number }[], acCond: { Kx: number }[], restartInterval: number,
): number {
  // --- Parse the SOS header (component selectors + Td/Ta, then Ss/Se/Ah/Al) ---
  const ns = data[seg]; let p = seg + 1;
  const dcStatsByTbl = new Map<number, Uint8Array>();
  const acStatsByTbl = new Map<number, Uint8Array>();
  const dcTbl = (t: number) => { let s = dcStatsByTbl.get(t); if (!s) dcStatsByTbl.set(t, s = new Uint8Array(64)); return s; };
  const acTbl = (t: number) => { let s = acStatsByTbl.get(t); if (!s) acStatsByTbl.set(t, s = new Uint8Array(256)); return s; };
  const scan: { c: Comp; dcStats: Uint8Array; acStats: Uint8Array; L: number; U: number; Kx: number }[] = [];
  for (let i = 0; i < ns; i++) {
    const cs = data[p], td = data[p + 1] >> 4, ta = data[p + 1] & 15; p += 2;
    const c = frame.comps.find((k) => k.id === cs); if (!c) throw new PdfParseError('JPEG: bad scan component');
    const dccnd = dcCond[td] ?? { L: 0, U: 1 };   // T.81 defaults: L=0, U=1
    const accnd = acCond[ta] ?? { Kx: 5 };         // T.81 default: Kx=5
    scan.push({ c, dcStats: dcTbl(td), acStats: acTbl(ta), L: dccnd.L, U: dccnd.U, Kx: accnd.Kx });
  }
  const Ss = data[p], Se = data[p + 1], Ah = data[p + 2] >> 4, Al = data[p + 2] & 15; p += 3;

  const dec = new ArithDecoder(data, p);
  const fixed = new Uint8Array([113]);             // fixed 0.5 estimation bin (state 113, MPS 0)
  const lastDc = new Int32Array(scan.length);      // running DC predictor per scan component
  const dcContext = new Int32Array(scan.length);   // DC conditioning context (0/4/8/12/16)

  // F.1.4.4.1 — decode one DC coefficient (natural index 0) into blocks[off].
  const decodeDC = (si: number, off: number) => {
    const sc = scan[si];
    lastDc[si] += decodeArithDiff(dec, sc.dcStats, dcContext, si, sc.L, sc.U);
    sc.c.blocks[off] = lastDc[si] << Al;
  };
  // F.1.4.4.2 — decode AC coefficients over the zig-zag band [kStart, kEnd].
  const decodeAC = (si: number, off: number, kStart: number, kEnd: number) => {
    const sc = scan[si], S = sc.acStats, c = sc.c;
    for (let k = kStart; k <= kEnd; k++) {
      let st = 3 * (k - 1);
      if (dec.decode(S, st)) break;                // EOB
      while (dec.decode(S, st + 1) === 0) { st += 3; if (++k > kEnd) throw new PdfParseError('JPEG: arithmetic AC spectral overflow'); }
      const sign = dec.decode(fixed, 0);
      st += 2;
      let m = dec.decode(S, st);
      if (m !== 0 && dec.decode(S, st)) { m <<= 1; st = k <= sc.Kx ? 189 : 217; while (dec.decode(S, st)) { if ((m <<= 1) === 0x8000) throw new PdfParseError('JPEG: arithmetic AC magnitude overflow'); st += 1; } }
      let v = m; st += 14; while ((m >>= 1) !== 0) if (dec.decode(S, st)) v |= m;
      v += 1; if (sign) v = -v;
      c.blocks[off + ZIGZAG[k]] = v << Al;
    }
  };
  // G.2 DC refinement: append the Al'th bit of the DC coefficient (fixed prob).
  const decodeDCRefine = (si: number, off: number) => {
    if (dec.decode(fixed, 0)) scan[si].c.blocks[off] |= 1 << Al;
  };
  // G.2 AC refinement (Encode_AC_Coefficients_SA): correction bits for existing
  // coefficients + newly nonzero ±(1<<Al) coefficients, with an EOB flag past EOBx.
  const decodeACRefine = (si: number, off: number) => {
    const sc = scan[si], S = sc.acStats, c = sc.c;
    const p1 = 1 << Al, m1 = -1 << Al;
    let kex = Se; for (; kex > 0; kex--) if (c.blocks[off + ZIGZAG[kex]]) break;   // previous-stage EOB
    for (let k = Ss; k <= Se; k++) {
      let st = 3 * (k - 1);
      if (k > kex && dec.decode(S, st)) break;     // EOB
      for (;;) {
        const idx = off + ZIGZAG[k]; const cur = c.blocks[idx];
        if (cur !== 0) { if (dec.decode(S, st + 2)) c.blocks[idx] += cur < 0 ? m1 : p1; break; }   // correction bit
        if (dec.decode(S, st + 1)) { c.blocks[idx] = dec.decode(fixed, 0) ? m1 : p1; break; }        // newly nonzero
        st += 3; if (++k > Se) throw new PdfParseError('JPEG: arithmetic AC spectral overflow');
      }
    }
  };

  const scanComps = scan.map((s) => ({ c: s.c }));
  const onRestart = () => {
    dec.restart();
    for (const s of dcStatsByTbl.values()) s.fill(0);
    for (const s of acStatsByTbl.values()) s.fill(0);
    lastDc.fill(0); dcContext.fill(0);
  };

  let decodeBlock: (si: number, off: number) => void;
  if (!frame.progressive) decodeBlock = (si, off) => { decodeDC(si, off); decodeAC(si, off, 1, 63); };
  else if (Ss === 0) decodeBlock = Ah === 0 ? decodeDC : decodeDCRefine;   // decodeDC already shifts << Al
  else decodeBlock = Ah === 0 ? (si, off) => decodeAC(si, off, Ss, Se) : decodeACRefine;

  forEachBlockInScan(frame, scanComps, restartInterval, decodeBlock, onRestart);
  return dec.endPos();
}
