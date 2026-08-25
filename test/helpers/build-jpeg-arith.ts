// Minimal QM arithmetic *encoder* for tests (ITU-T T.81 Annex D). Ported from
// libjpeg jcarith.c (arith_encode + finish_pass). Test-only counterpart to
// src/jpegarith.ts's ArithDecoder; the probability table is duplicated here just
// as the FDCT tables are duplicated in build-jpeg.ts. Higher-level SOF9/SOF10
// stream encoders are added in later tasks.

import { buildComponentBlocks, type JpegEncodeOptions } from './build-jpeg.js';

// [Qe, NLPS, NMPS, Switch] per index (T.81 Table D.2 / jaricom.c). Same as the
// decoder's table.
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
const ARITAB = new Int32Array(QE.map(([qe, nl, nm, sw]) => (qe << 16) | (nm << 8) | (sw << 7) | nl));

/** QM arithmetic encoder (T.81 Annex D / jcarith.c). `encode(stats, s, bit)`
 *  codes one decision; `finish()` flushes and returns the entropy byte stream
 *  (0xFF-stuffed, no markers). */
export class ArithEncoder {
  private c = 0;
  private a = 0x10000;
  private ct = 11;
  private sc = 0;           // count of stacked 0xFF bytes
  private zc = 0;           // count of pending 0x00 bytes
  private buffer = -1;      // pending output byte (-1 = empty)
  private out: number[] = [];

  private emit(v: number): void { this.out.push(v & 0xff); }

  private byteOut(): void {
    const temp = Math.floor(this.c / 0x80000);          // c >> 19
    if (temp > 0xff) {
      if (this.buffer >= 0) {
        while (this.zc) { this.emit(0x00); this.zc--; }
        this.emit(this.buffer + 1);
        if (this.buffer + 1 === 0xff) this.emit(0x00);
      }
      this.zc += this.sc; this.sc = 0;
      this.buffer = temp & 0xff;
    } else if (temp === 0xff) {
      this.sc++;
    } else {
      if (this.buffer === 0) this.zc++;
      else if (this.buffer >= 0) {
        while (this.zc) { this.emit(0x00); this.zc--; }
        this.emit(this.buffer);
      }
      if (this.sc) {
        while (this.zc) { this.emit(0x00); this.zc--; }
        do { this.emit(0xff); this.emit(0x00); } while (--this.sc);
      }
      this.buffer = temp & 0xff;
    }
    this.c = this.c % 0x80000;                           // c &= 0x7FFFF
    this.ct += 8;
  }

  encode(stats: Uint8Array, s: number, val: 0 | 1): void {
    const sv = stats[s];
    let packed = ARITAB[sv & 0x7f];
    const nl = packed & 0xff; packed >>>= 8;
    const nm = packed & 0xff; packed >>>= 8;
    const qe = packed;
    this.a -= qe;
    if (val !== (sv >> 7)) {
      if (this.a >= qe) { this.c += this.a; this.a = qe; }
      stats[s] = (sv & 0x80) ^ nl;
    } else {
      if (this.a >= 0x8000) return;
      if (this.a < qe) { this.c += this.a; this.a = qe; }
      stats[s] = (sv & 0x80) ^ nm;
    }
    do {
      this.a *= 2;                                       // a <<= 1
      this.c *= 2;                                       // c <<= 1
      if (--this.ct === 0) this.byteOut();
    } while (this.a < 0x8000);
  }

  /** Terminate the segment (D.1.8) and return the entropy bytes. */
  finish(): number[] {
    let temp = (this.a - 1 + this.c) & 0xffff0000;
    if (temp < this.c) this.c = temp + 0x8000; else this.c = temp;
    this.c = (this.c * (1 << this.ct)) >>> 0;            // c <<= ct (32-bit)
    if (this.c & 0xf8000000) {
      if (this.buffer >= 0) {
        while (this.zc) { this.emit(0x00); this.zc--; }
        this.emit(this.buffer + 1);
        if (this.buffer + 1 === 0xff) this.emit(0x00);
      }
      this.zc += this.sc; this.sc = 0;
    } else {
      if (this.buffer === 0) this.zc++;
      else if (this.buffer >= 0) {
        while (this.zc) { this.emit(0x00); this.zc--; }
        this.emit(this.buffer);
      }
      if (this.sc) {
        while (this.zc) { this.emit(0x00); this.zc--; }
        do { this.emit(0xff); this.emit(0x00); } while (--this.sc);
      }
    }
    if (this.c & 0x7fff800) {
      if (this.zc) { do { this.emit(0x00); } while (--this.zc); }
      this.emit((this.c >>> 19) & 0xff);
      if (((this.c >>> 19) & 0xff) === 0xff) this.emit(0x00);
      if (this.c & 0x7f800) {
        this.emit((this.c >>> 11) & 0xff);
        if (((this.c >>> 11) & 0xff) === 0xff) this.emit(0x00);
      }
    }
    return this.out;
  }
}

// Arithmetic-encoder options: JPEG options plus optional non-default DAC
// conditioning (L/U for DC, Kx for AC). When omitted the T.81 defaults apply.
export interface ArithEncodeOptions extends JpegEncodeOptions { dac?: { L: number; U: number; Kx: number } }

// ---------------------------------------------------------------------------
// Arithmetic sequential (SOF9) encoder — mirrors libjpeg jcarith.c encode_mcu
// (F.1.4). Reuses buildComponentBlocks for the FDCT'd (zig-zag, all-ones-quant)
// coefficient blocks; only the entropy stage differs from the baseline encoder.
// All components share DC/AC table 0. Honors restartInterval (DRI + RSTn with a
// fresh segment + statistics reset per boundary) and an optional `dac` override.
// ---------------------------------------------------------------------------
export function encodeSequentialArithJpeg(o: ArithEncodeOptions): Uint8Array {
  const { width, height } = o;
  const { cinfo, blocks, mcusPerLine, mcusPerColumn, adobe } = buildComponentBlocks(o);
  const nc = cinfo.length;
  const ri = o.restartInterval ?? 0;

  const L = o.dac?.L ?? 0, U = o.dac?.U ?? 1, Kx = o.dac?.Kx ?? 5; // arithmetic conditioning
  const dcS = new Uint8Array(64), acS = new Uint8Array(256);
  const fixed = new Uint8Array([113]);            // fixed 0.5 estimation bin
  const lastDc = new Int32Array(nc);
  const dcContext = new Int32Array(nc);
  let enc = new ArithEncoder();

  // F.1.4.4.1 — encode the DC difference for component `ci`.
  const encodeDC = (ci: number, zz: Int32Array) => {
    let st = dcContext[ci];
    let v = zz[0] - lastDc[ci];
    if (v === 0) { enc.encode(dcS, st, 0); dcContext[ci] = 0; return; }
    lastDc[ci] = zz[0];
    enc.encode(dcS, st, 1);
    if (v > 0) { enc.encode(dcS, st + 1, 0); st += 2; dcContext[ci] = 4; }
    else { v = -v; enc.encode(dcS, st + 1, 1); st += 3; dcContext[ci] = 8; }
    let m = 0;
    if (--v) { enc.encode(dcS, st, 1); m = 1; let v2 = v; st = 20; while (v2 >>= 1) { enc.encode(dcS, st, 1); m <<= 1; st += 1; } }
    enc.encode(dcS, st, 0);
    if (m < ((1 << L) >> 1)) dcContext[ci] = 0; else if (m > ((1 << U) >> 1)) dcContext[ci] += 8;
    st += 14; while (m >>= 1) enc.encode(dcS, st, (m & v) ? 1 : 0);
  };
  // F.1.4.4.2 — encode the AC coefficients (zig-zag order) of one block.
  const encodeAC = (zz: Int32Array) => {
    let ke; for (ke = 63; ke > 0; ke--) if (zz[ke]) break;
    let k = 1;
    for (; k <= ke; k++) {
      let st = 3 * (k - 1);
      enc.encode(acS, st, 0);                     // not EOB
      let v = zz[k];
      while (v === 0) { enc.encode(acS, st + 1, 0); st += 3; k++; v = zz[k]; }
      enc.encode(acS, st + 1, 1);                 // nonzero coefficient here
      if (v > 0) enc.encode(fixed, 0, 0); else { v = -v; enc.encode(fixed, 0, 1); }
      st += 2;
      let m = 0;
      if (--v) {
        enc.encode(acS, st, 1); m = 1; let v2 = v;
        if (v2 >>= 1) { enc.encode(acS, st, 1); m <<= 1; st = k <= Kx ? 189 : 217; while (v2 >>= 1) { enc.encode(acS, st, 1); m <<= 1; st += 1; } }
      }
      enc.encode(acS, st, 0);
      st += 14; while (m >>= 1) enc.encode(acS, st, (m & v) ? 1 : 0);
    }
    if (k <= 63) enc.encode(acS, 3 * (k - 1), 1); // EOB
  };

  // Entropy pass over MCUs, matching the decoder's forEachBlockInScan order.
  // At each restart boundary: flush the segment, emit RSTn, and reset the encoder
  // + statistics + DC predictors — the mirror of the decoder's onRestart.
  const entropy: number[] = [];
  const total = mcusPerLine * mcusPerColumn;
  let mcu = 0, rstIdx = 0;
  for (let my = 0; my < mcusPerColumn; my++) for (let mx = 0; mx < mcusPerLine; mx++) {
    for (let ci = 0; ci < nc; ci++) {
      const B = blocks[ci], c = cinfo[ci];
      for (let by = 0; by < c.v; by++) for (let bx = 0; bx < c.h; bx++) {
        const zz = B.arr[(my * c.v + by) * B.bpl + (mx * c.h + bx)];
        encodeDC(ci, zz); encodeAC(zz);
      }
    }
    mcu++;
    if (ri && mcu % ri === 0 && mcu < total) {
      for (const b of enc.finish()) entropy.push(b);
      entropy.push(0xff, 0xd0 + (rstIdx++ & 7));
      enc = new ArithEncoder();
      dcS.fill(0); acS.fill(0); lastDc.fill(0); dcContext.fill(0);
    }
  }
  for (const b of enc.finish()) entropy.push(b);

  // ---- Assemble the file (SOF9; DAC only when non-default; DRI when restarting) ----
  const out: number[] = [];
  const u16 = (n: number) => { out.push((n >> 8) & 0xff, n & 0xff); };
  out.push(0xff, 0xd8); // SOI
  if (adobe !== undefined) { out.push(0xff, 0xee); u16(14); for (const ch of 'Adobe') out.push(ch.charCodeAt(0)); out.push(0, 0x64, 0, 0, 0, 0, adobe); }
  out.push(0xff, 0xdb); u16(2 + 65); out.push(0x00); for (let i = 0; i < 64; i++) out.push(1); // DQT all ones
  if (o.dac) { out.push(0xff, 0xcc); u16(2 + 4); out.push(0x00, (U << 4) | L, 0x10, Kx); } // DAC: DC table 0 (U high, L low per T.81 B.2.4.3), AC table 0
  out.push(0xff, 0xc9); u16(8 + nc * 3); out.push(8); u16(height); u16(width); out.push(nc); // SOF9
  for (let i = 0; i < nc; i++) out.push(i + 1, (cinfo[i].h << 4) | cinfo[i].v, 0);
  if (ri) { out.push(0xff, 0xdd); u16(4); u16(ri); } // DRI
  out.push(0xff, 0xda); u16(6 + nc * 2); out.push(nc);
  for (let i = 0; i < nc; i++) out.push(i + 1, 0x00); // comp selector, Td=0 Ta=0
  out.push(0, 63, 0); // Ss, Se, Ah/Al
  for (const b of entropy) out.push(b);
  out.push(0xff, 0xd9); // EOI
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// Arithmetic progressive (SOF10) encoder — mirrors libjpeg jcarith.c
// encode_mcu_{DC_first,DC_refine,AC_first,AC_refine} (G.2). Each scan is its own
// arithmetic segment with fresh statistics, exactly as the decoder allocates per
// SOS. Coefficient blocks (zig-zag order) come from buildComponentBlocks.
// ---------------------------------------------------------------------------

const AR_L = 0, AR_U = 1, AR_KX = 5; // default arithmetic conditioning

// G.2 DC first: encode point-transformed (>> Al) DC difference for component ci.
function encDCFirst(enc: ArithEncoder, dcS: Uint8Array, lastDc: Int32Array, dcContext: Int32Array, ci: number, zz: Int32Array, Al: number): void {
  const m0 = zz[0] >> Al; // IRIGHT_SHIFT (arithmetic)
  let st = dcContext[ci];
  let v = m0 - lastDc[ci];
  if (v === 0) { enc.encode(dcS, st, 0); dcContext[ci] = 0; return; }
  lastDc[ci] = m0;
  enc.encode(dcS, st, 1);
  if (v > 0) { enc.encode(dcS, st + 1, 0); st += 2; dcContext[ci] = 4; }
  else { v = -v; enc.encode(dcS, st + 1, 1); st += 3; dcContext[ci] = 8; }
  let m = 0;
  if (--v) { enc.encode(dcS, st, 1); m = 1; let v2 = v; st = 20; while (v2 >>= 1) { enc.encode(dcS, st, 1); m <<= 1; st += 1; } }
  enc.encode(dcS, st, 0);
  if (m < ((1 << AR_L) >> 1)) dcContext[ci] = 0; else if (m > ((1 << AR_U) >> 1)) dcContext[ci] += 8;
  st += 14; while (m >>= 1) enc.encode(dcS, st, (m & v) ? 1 : 0);
}

// G.2 AC first: encode one non-interleaved block's band (Ss=1..Se=63) at Al.
function encACFirst(enc: ArithEncoder, acS: Uint8Array, fixed: Uint8Array, zz: Int32Array, Al: number): void {
  let ke; for (ke = 63; ke > 0; ke--) { const a = zz[ke] < 0 ? -zz[ke] : zz[ke]; if (a >> Al) break; }
  let k = 1;
  for (; k <= ke; k++) {
    let st = 3 * (k - 1);
    enc.encode(acS, st, 0);                        // not EOB
    let v: number;
    for (;;) {
      const c = zz[k]; v = (c < 0 ? -c : c) >> Al;
      if (v) { enc.encode(acS, st + 1, 1); enc.encode(fixed, 0, c < 0 ? 1 : 0); break; }
      enc.encode(acS, st + 1, 0); st += 3; k++;
    }
    st += 2;
    let m = 0;
    if (--v) {
      enc.encode(acS, st, 1); m = 1; let v2 = v;
      if (v2 >>= 1) { enc.encode(acS, st, 1); m <<= 1; st = k <= AR_KX ? 189 : 217; while (v2 >>= 1) { enc.encode(acS, st, 1); m <<= 1; st += 1; } }
    }
    enc.encode(acS, st, 0);
    st += 14; while (m >>= 1) enc.encode(acS, st, (m & v) ? 1 : 0);
  }
  if (k <= 63) enc.encode(acS, 3 * (k - 1), 1);    // EOB
}

// G.2 AC refine: correction bits (Al) for existing coeffs + newly nonzero coeffs.
function encACRefine(enc: ArithEncoder, acS: Uint8Array, fixed: Uint8Array, zz: Int32Array, Ah: number, Al: number): void {
  let ke; for (ke = 63; ke > 0; ke--) { const a = zz[ke] < 0 ? -zz[ke] : zz[ke]; if (a >> Al) break; }
  let kex; for (kex = ke; kex > 0; kex--) { const a = zz[kex] < 0 ? -zz[kex] : zz[kex]; if (a >> Ah) break; }
  let k = 1;
  for (; k <= ke; k++) {
    let st = 3 * (k - 1);
    if (k > kex) enc.encode(acS, st, 0);           // EOB decision
    for (;;) {
      const c = zz[k]; const v = (c < 0 ? -c : c) >> Al;
      if (v) {
        if (v >> 1) enc.encode(acS, st + 2, (v & 1) as 0 | 1);            // previously nonzero → correction bit
        else { enc.encode(acS, st + 1, 1); enc.encode(fixed, 0, c < 0 ? 1 : 0); } // newly nonzero + sign
        break;
      }
      enc.encode(acS, st + 1, 0); st += 3; k++;
    }
  }
  if (k <= 63) enc.encode(acS, 3 * (k - 1), 1);    // EOB
}

export function encodeProgressiveArithJpeg(o: JpegEncodeOptions): Uint8Array {
  const { width, height } = o;
  const { cinfo, blocks, mcusPerLine, mcusPerColumn, adobe } = buildComponentBlocks(o);
  const nc = cinfo.length;
  const maxH = Math.max(...cinfo.map((c) => c.h)), maxV = Math.max(...cinfo.map((c) => c.v));
  const dcAl = o.successive ? 1 : 0, acAl = o.successive ? 1 : 0;
  const fixed = new Uint8Array([113]);
  const actual = (h: number, v: number) => ({ bpl: Math.ceil(Math.ceil((width * h) / maxH) / 8), bpc: Math.ceil(Math.ceil((height * v) / maxV) / 8) });

  interface Scan { comps: number[]; Ss: number; Se: number; Ah: number; Al: number; bytes: number[] }
  const scans: Scan[] = [];

  // ---- DC first (interleaved, Ss=Se=0) ----
  {
    const enc = new ArithEncoder(); const dcS = new Uint8Array(64);
    const lastDc = new Int32Array(nc), dcContext = new Int32Array(nc);
    for (let my = 0; my < mcusPerColumn; my++) for (let mx = 0; mx < mcusPerLine; mx++)
      for (let ci = 0; ci < nc; ci++) { const B = blocks[ci], c = cinfo[ci];
        for (let by = 0; by < c.v; by++) for (let bx = 0; bx < c.h; bx++)
          encDCFirst(enc, dcS, lastDc, dcContext, ci, B.arr[(my * c.v + by) * B.bpl + (mx * c.h + bx)], dcAl); }
    scans.push({ comps: cinfo.map((_, i) => i + 1), Ss: 0, Se: 0, Ah: 0, Al: dcAl, bytes: enc.finish() });
  }
  // ---- DC refine (interleaved), only in successive mode ----
  if (o.successive) {
    const enc = new ArithEncoder();
    for (let my = 0; my < mcusPerColumn; my++) for (let mx = 0; mx < mcusPerLine; mx++)
      for (let ci = 0; ci < nc; ci++) { const B = blocks[ci], c = cinfo[ci];
        for (let by = 0; by < c.v; by++) for (let bx = 0; bx < c.h; bx++)
          enc.encode(fixed, 0, ((B.arr[(my * c.v + by) * B.bpl + (mx * c.h + bx)][0] >> 0) & 1) as 0 | 1); }
    scans.push({ comps: cinfo.map((_, i) => i + 1), Ss: 0, Se: 0, Ah: 1, Al: 0, bytes: enc.finish() });
  }
  // ---- AC first (per component, non-interleaved, Ss=1 Se=63) ----
  for (let ci = 0; ci < nc; ci++) {
    const enc = new ArithEncoder(); const acS = new Uint8Array(256);
    const { bpl, bpc } = actual(cinfo[ci].h, cinfo[ci].v); const B = blocks[ci];
    for (let by = 0; by < bpc; by++) for (let bx = 0; bx < bpl; bx++) encACFirst(enc, acS, fixed, B.arr[by * B.bpl + bx], acAl);
    scans.push({ comps: [ci + 1], Ss: 1, Se: 63, Ah: 0, Al: acAl, bytes: enc.finish() });
  }
  // ---- AC refine (per component), only in successive mode ----
  if (o.successive) for (let ci = 0; ci < nc; ci++) {
    const enc = new ArithEncoder(); const acS = new Uint8Array(256);
    const { bpl, bpc } = actual(cinfo[ci].h, cinfo[ci].v); const B = blocks[ci];
    for (let by = 0; by < bpc; by++) for (let bx = 0; bx < bpl; bx++) encACRefine(enc, acS, fixed, B.arr[by * B.bpl + bx], 1, 0);
    scans.push({ comps: [ci + 1], Ss: 1, Se: 63, Ah: 1, Al: 0, bytes: enc.finish() });
  }

  // ---- Assemble (SOF10) ----
  const out: number[] = [];
  const u16 = (n: number) => { out.push((n >> 8) & 0xff, n & 0xff); };
  out.push(0xff, 0xd8); // SOI
  if (adobe !== undefined) { out.push(0xff, 0xee); u16(14); for (const ch of 'Adobe') out.push(ch.charCodeAt(0)); out.push(0, 0x64, 0, 0, 0, 0, adobe); }
  out.push(0xff, 0xdb); u16(2 + 65); out.push(0x00); for (let i = 0; i < 64; i++) out.push(1); // DQT all ones
  out.push(0xff, 0xca); u16(8 + nc * 3); out.push(8); u16(height); u16(width); out.push(nc); // SOF10
  for (let i = 0; i < nc; i++) out.push(i + 1, (cinfo[i].h << 4) | cinfo[i].v, 0);
  for (const s of scans) {
    out.push(0xff, 0xda); u16(6 + s.comps.length * 2); out.push(s.comps.length);
    for (const id of s.comps) out.push(id, 0x00); // Td=0 Ta=0
    out.push(s.Ss, s.Se, (s.Ah << 4) | s.Al);
    for (const b of s.bytes) out.push(b);
  }
  out.push(0xff, 0xd9); // EOI
  return Uint8Array.from(out);
}
