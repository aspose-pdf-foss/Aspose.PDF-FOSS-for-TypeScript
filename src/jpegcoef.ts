/**
 * The JPEG encoder's back half: quantized coefficients to bytes.
 *
 * Two producers share it -- `jpegencode.ts`, which arrives here after FDCT and
 * quantization, and `jpegtranscode.ts`, which arrives here with coefficients it
 * took from an existing file and never touched. A second copy of the entropy
 * coder is how the two would come to disagree about a Huffman table or a marker
 * order, which is invisible to any test that asserts decoded pixels.
 *
 * Pure: no PDF objects, no colour, no FDCT. Raw numbers in, bytes out.
 */
import { ZIGZAG } from './jpeg.js';
import {
  BitWriter, HuffTable, buildOptimalHuffTable,
  STD_DC_LUMA, STD_AC_LUMA, STD_DC_CHROMA, STD_AC_CHROMA,
} from './jpeghuffenc.js';

export interface CoefComponent {
  /**
   * One 64-entry block per element, in ZIG-ZAG order, raster over the
   * MCU-PADDED grid: `mcusPerLine * h` wide by `mcusPerColumn * v` tall.
   *
   * Zig-zag rather than the decoder's natural order because JPEG entropy coding
   * is DEFINED over the zig-zag sequence -- a run length counts zeros along it
   * -- so this is the order the module actually speaks, and `quantizeBlock`
   * already writes it. The one transposition in the system therefore lives in
   * `jpegtranscode.ts`, on the new path, rather than in every ordinary encode.
   */
  blocks: Int32Array[];
  /** Sampling factors, relative to the frame. */
  h: number;
  v: number;
  /** Quantization table slot, indexing `CoefFrame.quant`. */
  tq: number;
  /** DC/AC Huffman table slot. Both tables of a slot share its number. */
  td: number;
}

export interface CoefFrame {
  width: number;
  height: number;
  comps: CoefComponent[];
  /**
   * Quantization tables in NATURAL order, indexed by `tq`.
   *
   * Natural, where the blocks are zig-zag, and the asymmetry is the easy thing
   * to get backwards: `scaleQuantTable` produces natural and the DQT writer
   * below re-zigzags on the way out, while `parseDQT` stores the WIRE order it
   * read, which is zig-zag. A caller handing wire order straight through emits a
   * doubly-permuted table -- a file that decodes, with the wrong frequencies
   * scaled.
   */
  quant: Int32Array[];
  /** Emit an APP0 JFIF header. False for CMYK, which carries none. */
  jfif: boolean;
  /** Build per-image Huffman tables rather than using the Annex K standard set. */
  optimizeHuffman: boolean;
  /**
   * Write a spectral-selection PROGRESSIVE file (SOF2) rather than a baseline
   * one: an interleaved DC scan, then one AC scan per component. Successive
   * approximation is not written. Always builds per-scan optimal Huffman
   * tables, whatever `optimizeHuffman` says — the Annex K AC tables carry no
   * EOBRUN symbols, and the EOB runs are where progressive saves its bytes.
   */
  progressive?: boolean;
}

const category = (v: number): number => { let a = Math.abs(v), n = 0; while (a) { n++; a >>= 1; } return n; };
const valueBits = (v: number, n: number): number => (v < 0 ? v + (1 << n) - 1 : v);

/** Bytes common to both processes: SOI, APP0, DQT and the frame header. */
function writeHeader(out: number[], frame: CoefFrame, sof: number): void {
  const { width, height, comps, quant } = frame;
  const u16 = (n: number) => out.push((n >> 8) & 0xff, n & 0xff);
  out.push(0xff, 0xd8); // SOI
  if (frame.jfif) { // APP0/JFIF
    out.push(0xff, 0xe0); u16(16);
    out.push(0x4a, 0x46, 0x49, 0x46, 0x00); // "JFIF\0"
    out.push(1, 1, 0); // version 1.1, no density units
    u16(1); u16(1); // X/Y density
    out.push(0, 0); // no thumbnail
  }
  // DQT — written in zig-zag order; parseDQT (jpeg.ts:92) stores wire order and
  // jpeg.ts:299 de-zigzags with qn[ZIGZAG[k]] = q[k].
  for (let t = 0; t < quant.length; t++) {
    out.push(0xff, 0xdb); u16(2 + 1 + 64);
    out.push(t); // 8-bit precision (Pq=0), table id t
    for (let k = 0; k < 64; k++) out.push(quant[t][ZIGZAG[k]]);
  }
  out.push(0xff, sof); u16(8 + comps.length * 3);
  out.push(8); u16(height); u16(width); out.push(comps.length);
  for (let i = 0; i < comps.length; i++)
    out.push(i + 1, (comps[i].h << 4) | comps[i].v, comps[i].tq);
}

function writeDHT(out: number[], tc: number, th: number, t: HuffTable): void {
  out.push(0xff, 0xc4, ((2 + 1 + 16 + t.vals.length) >> 8) & 0xff, (2 + 1 + 16 + t.vals.length) & 0xff);
  out.push((tc << 4) | th);
  for (const b of t.bits) out.push(b);
  for (const v of t.vals) out.push(v);
}

/** Encode quantized coefficient blocks as a baseline JPEG, or a progressive one
 *  when `frame.progressive` is set. */
export function encodeJpegFromBlocks(frame: CoefFrame): Uint8Array {
  if (frame.progressive) return encodeProgressive(frame);
  const { width, height, comps } = frame;
  const maxH = Math.max(...comps.map((c) => c.h));
  const maxV = Math.max(...comps.map((c) => c.v));
  const mcusPerLine = Math.ceil(width / (8 * maxH));
  const mcusPerCol = Math.ceil(height / (8 * maxV));
  const blocksPerLine = comps.map((c) => mcusPerLine * c.h);

  // Walk MCUs, handing each block to `onBlock` in scan order.
  const traverse = (onBlock: (pi: number, zz: Int32Array) => void): void => {
    for (let my = 0; my < mcusPerCol; my++) for (let mx = 0; mx < mcusPerLine; mx++)
      for (let pi = 0; pi < comps.length; pi++) {
        const c = comps[pi];
        for (let by = 0; by < c.v; by++) for (let bx = 0; bx < c.h; bx++)
          onBlock(pi, c.blocks[(my * c.v + by) * blocksPerLine[pi] + (mx * c.h + bx)]);
      }
  };

  /** Feed one block's symbols to `dc`/`ac` sinks; `emit` also writes the bits. */
  const codeBlock = (
    zz: Int32Array, pred: number,
    dc: (sym: number) => void, ac: (sym: number) => void,
    emit?: { bw: BitWriter; dcT: HuffTable; acT: HuffTable },
  ): number => {
    const diff = zz[0] - pred;
    const dcat = category(diff);
    dc(dcat);
    if (emit) {
      const c = emit.dcT.enc.get(dcat)!;
      emit.bw.put(c.code, c.len);
      if (dcat) emit.bw.put(valueBits(diff, dcat), dcat);
    }
    let k = 1;
    while (k < 64) {
      let run = 0;
      while (k < 64 && zz[k] === 0) { run++; k++; }
      if (k === 64) {
        ac(0x00); // EOB
        if (emit) { const c = emit.acT.enc.get(0x00)!; emit.bw.put(c.code, c.len); }
        break;
      }
      while (run > 15) {
        ac(0xf0); // ZRL
        if (emit) { const c = emit.acT.enc.get(0xf0)!; emit.bw.put(c.code, c.len); }
        run -= 16;
      }
      const acat = category(zz[k]);
      const sym = (run << 4) | acat;
      ac(sym);
      if (emit) {
        const c = emit.acT.enc.get(sym)!;
        emit.bw.put(c.code, c.len);
        emit.bw.put(valueBits(zz[k], acat), acat);
      }
      k++;
    }
    return zz[0];
  };

  // ---- Table selection ----
  // One DC and one AC table per distinct `td`. This is `usesChroma ? 2 : 1` for
  // every shape `encodeJpeg` builds, and generalizes for a caller with its own.
  const nSlots = Math.max(...comps.map((c) => c.td)) + 1;
  let dcTables: HuffTable[], acTables: HuffTable[];
  if (frame.optimizeHuffman) {
    const dcFreq = Array.from({ length: nSlots }, () => new Int32Array(257));
    const acFreq = Array.from({ length: nSlots }, () => new Int32Array(257));
    const pred = new Array(comps.length).fill(0);
    traverse((pi, zz) => {
      const slot = comps[pi].td;
      pred[pi] = codeBlock(zz, pred[pi], (s) => dcFreq[slot][s]++, (s) => acFreq[slot][s]++);
    });
    dcTables = dcFreq.map((f) => buildOptimalHuffTable(f));
    acTables = acFreq.map((f) => buildOptimalHuffTable(f));
  } else {
    dcTables = nSlots > 1 ? [STD_DC_LUMA, STD_DC_CHROMA] : [STD_DC_LUMA];
    acTables = nSlots > 1 ? [STD_AC_LUMA, STD_AC_CHROMA] : [STD_AC_LUMA];
  }

  // ---- Entropy pass ----
  const bw = new BitWriter();
  {
    const pred = new Array(comps.length).fill(0);
    const noop = () => {};
    traverse((pi, zz) => {
      const slot = comps[pi].td;
      pred[pi] = codeBlock(zz, pred[pi], noop, noop, {
        bw, dcT: dcTables[slot], acT: acTables[slot],
      });
    });
    bw.flush();
  }

  // ---- Assemble ----
  const out: number[] = [];
  const u16 = (n: number) => out.push((n >> 8) & 0xff, n & 0xff);
  writeHeader(out, frame, 0xc0); // SOF0
  for (let t = 0; t < dcTables.length; t++) writeDHT(out, 0, t, dcTables[t]);
  for (let t = 0; t < acTables.length; t++) writeDHT(out, 1, t, acTables[t]);

  out.push(0xff, 0xda); u16(6 + comps.length * 2); // SOS
  out.push(comps.length);
  for (let i = 0; i < comps.length; i++)
    out.push(i + 1, (comps[i].td << 4) | comps[i].td);
  out.push(0, 63, 0); // Ss, Se, Ah/Al

  for (const b of bw.bytes) out.push(b);
  out.push(0xff, 0xd9); // EOI
  return Uint8Array.from(out);
}

/** A symbol-and-bits sink: one pass counts symbols, the next writes them. */
interface Sink { sym(s: number): void; bits(v: number, n: number): void }

/**
 * A spectral-selection progressive JPEG (ITU-T T.81 G.1.1): one interleaved DC
 * scan (Ss 0, Se 0), then one NON-interleaved AC scan per component (Ss 1,
 * Se 63), all with Ah = Al = 0. Every coefficient is sent once, at full
 * precision, so the decoded image is the baseline encoding's exactly.
 *
 * **Invariant:** a non-interleaved scan walks the component's OWN block grid,
 * `ceil(ceil(width * h / maxH) / 8)` blocks wide, never the MCU-padded grid the
 * interleaved scans use. For a subsampled luma plane the two differ by the
 * padding blocks, and walking the padded grid shifts every later block of the
 * scan — a file that decodes, with its luma sheared.
 *
 * **Invariant:** trailing zeros are coded as EOB RUNS (G.1.2.2): a block with
 * no nonzero AC coefficient adds to a run that is emitted as one `EOBn`
 * symbol, flushed before the next block that carries data, at 0x7FFF, and at
 * the scan's end.
 *
 * **Note, measured, and the savings are NOT all from the runs:** on the libjpeg
 * `testorig` photograph an EOB per block instead of runs is still smaller than
 * baseline at 4:2:0, so that file cannot see the runs at all. A flat image
 * can: 4,451 bytes with runs, 8,720 without, 8,710 baseline. At 4:4:4 on the
 * photograph progressive is 0.8-1.6% LARGER than baseline — a scan per
 * full-resolution chroma plane does not repay itself on a small image.
 */
function encodeProgressive(frame: CoefFrame): Uint8Array {
  const { width, height, comps } = frame;
  const maxH = Math.max(...comps.map((c) => c.h));
  const maxV = Math.max(...comps.map((c) => c.v));
  const mcusPerLine = Math.ceil(width / (8 * maxH));
  const mcusPerCol = Math.ceil(height / (8 * maxV));
  const blocksPerLine = comps.map((c) => mcusPerLine * c.h);

  // ---- DC scan: interleaved, in MCU order, exactly baseline's DC coding ----
  const dcScan = (sinkOf: (pi: number) => Sink): void => {
    const pred = new Array(comps.length).fill(0);
    for (let my = 0; my < mcusPerCol; my++) for (let mx = 0; mx < mcusPerLine; mx++)
      for (let pi = 0; pi < comps.length; pi++) {
        const c = comps[pi];
        for (let by = 0; by < c.v; by++) for (let bx = 0; bx < c.h; bx++) {
          const zz = c.blocks[(my * c.v + by) * blocksPerLine[pi] + (mx * c.h + bx)];
          const diff = zz[0] - pred[pi];
          pred[pi] = zz[0];
          const n = category(diff);
          const s = sinkOf(pi);
          s.sym(n);
          if (n) s.bits(valueBits(diff, n), n);
        }
      }
  };

  // ---- AC scan: one component, its own block grid, EOB runs ----
  const acScan = (pi: number, s: Sink): void => {
    const c = comps[pi];
    const cols = Math.ceil(Math.ceil((width * c.h) / maxH) / 8);
    const rows = Math.ceil(Math.ceil((height * c.v) / maxV) / 8);
    let eobrun = 0;
    const flushEob = (): void => {
      if (eobrun === 0) return;
      const n = 31 - Math.clz32(eobrun);
      s.sym(n << 4);
      if (n) s.bits(eobrun - (1 << n), n);
      eobrun = 0;
    };
    for (let r = 0; r < rows; r++) for (let col = 0; col < cols; col++) {
      const zz = c.blocks[r * blocksPerLine[pi] + col];
      let last = 63;
      while (last > 0 && zz[last] === 0) last--;
      if (last === 0) { if (++eobrun === 0x7fff) flushEob(); continue; }
      flushEob();
      let run = 0;
      for (let k = 1; k <= last; k++) {
        if (zz[k] === 0) { run++; continue; }
        while (run > 15) { s.sym(0xf0); run -= 16; }
        const n = category(zz[k]);
        s.sym((run << 4) | n);
        s.bits(valueBits(zz[k], n), n);
        run = 0;
      }
      if (last < 63 && ++eobrun === 0x7fff) flushEob();
    }
    flushEob();
  };

  const counter = (f: Int32Array): Sink => ({ sym: (v) => { f[v]++; }, bits: () => {} });
  const writer = (bw: BitWriter, t: HuffTable): Sink => ({
    sym: (v) => { const c = t.enc.get(v)!; bw.put(c.code, c.len); },
    bits: (v, n) => bw.put(v, n),
  });

  // DC tables per `td` slot, AC tables per scan: each built from what it codes.
  const nSlots = Math.max(...comps.map((c) => c.td)) + 1;
  const dcFreq = Array.from({ length: nSlots }, () => new Int32Array(257));
  dcScan((pi) => counter(dcFreq[comps[pi].td]));
  const dcTables = dcFreq.map((f) => buildOptimalHuffTable(f));
  // One AC table per `td` SLOT, pooled over every scan that uses the slot —
  // the sharing baseline gets for Cb and Cr. A table per scan fits each scan a
  // little better and costs a DHT segment more; measured on testorig at 4:4:4,
  // per-scan tables made progressive LARGER than baseline, pooled ones smaller.
  const acFreq = Array.from({ length: nSlots }, () => new Int32Array(257));
  comps.forEach((c, pi) => acScan(pi, counter(acFreq[c.td])));
  const acBySlot = acFreq.map((f) => buildOptimalHuffTable(f));
  const acTables = comps.map((c) => acBySlot[c.td]);

  const out: number[] = [];
  const u16 = (n: number) => out.push((n >> 8) & 0xff, n & 0xff);
  const emitScan = (bw: BitWriter): void => { bw.flush(); for (const b of bw.bytes) out.push(b); };

  writeHeader(out, frame, 0xc2); // SOF2
  for (let t = 0; t < nSlots; t++) writeDHT(out, 0, t, dcTables[t]);

  // DC scan header: every component, DC table only (Ta is unused and 0).
  out.push(0xff, 0xda); u16(6 + comps.length * 2);
  out.push(comps.length);
  for (let i = 0; i < comps.length; i++) out.push(i + 1, comps[i].td << 4);
  out.push(0, 0, 0); // Ss 0, Se 0, Ah/Al 0
  { const bw = new BitWriter(); dcScan((pi) => writer(bw, dcTables[comps[pi].td])); emitScan(bw); }

  // One AC scan per component. A slot's AC table is written once, before the
  // first scan that codes with it; later scans of the slot reuse it.
  const written = new Set<number>();
  for (let pi = 0; pi < comps.length; pi++) {
    const slot = comps[pi].td;
    if (!written.has(slot)) { writeDHT(out, 1, slot, acTables[pi]); written.add(slot); }
    out.push(0xff, 0xda); u16(6 + 2);
    out.push(1, pi + 1, slot);
    out.push(1, 63, 0); // Ss 1, Se 63, Ah/Al 0
    const bw = new BitWriter();
    acScan(pi, writer(bw, acTables[pi]));
    emitScan(bw);
  }

  out.push(0xff, 0xd9); // EOI
  return Uint8Array.from(out);
}
