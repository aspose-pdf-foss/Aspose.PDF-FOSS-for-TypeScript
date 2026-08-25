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
}

const category = (v: number): number => { let a = Math.abs(v), n = 0; while (a) { n++; a >>= 1; } return n; };
const valueBits = (v: number, n: number): number => (v < 0 ? v + (1 << n) - 1 : v);

/** Encode quantized coefficient blocks as a baseline JPEG. */
export function encodeJpegFromBlocks(frame: CoefFrame): Uint8Array {
  const { width, height, comps, quant } = frame;
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

  out.push(0xff, 0xc0); u16(8 + comps.length * 3); // SOF0
  out.push(8); u16(height); u16(width); out.push(comps.length);
  for (let i = 0; i < comps.length; i++)
    out.push(i + 1, (comps[i].h << 4) | comps[i].v, comps[i].tq);

  const writeDHT = (tc: number, th: number, t: HuffTable) => {
    out.push(0xff, 0xc4); u16(2 + 1 + 16 + t.vals.length);
    out.push((tc << 4) | th);
    for (const b of t.bits) out.push(b);
    for (const v of t.vals) out.push(v);
  };
  for (let t = 0; t < dcTables.length; t++) writeDHT(0, t, dcTables[t]);
  for (let t = 0; t < acTables.length; t++) writeDHT(1, t, acTables[t]);

  out.push(0xff, 0xda); u16(6 + comps.length * 2); // SOS
  out.push(comps.length);
  for (let i = 0; i < comps.length; i++)
    out.push(i + 1, (comps[i].td << 4) | comps[i].td);
  out.push(0, 63, 0); // Ss, Se, Ah/Al

  for (const b of bw.bytes) out.push(b);
  out.push(0xff, 0xd9); // EOI
  return Uint8Array.from(out);
}
