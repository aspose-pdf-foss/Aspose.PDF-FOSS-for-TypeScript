// JBIG2 text region decode — ITU-T T.88 §6.4 (arithmetic path). Places
// referenced symbols onto the region bitmap via the strip walk. Placement
// follows the jbig2dec/pdf.js ref-corner convention.
import { MqDecoder } from './jpxmq.js';
import { ArithIntSource, HuffmanIntSource, type HuffmanTables, type IntSource, type RefinementProducer } from './jbig2ints.js';
import { HuffmanReader, parseSymbolIdTable } from './jbig2huffman.js';
import { PdfParseError } from './errors.js';
import { decodeRefinement } from './jbig2refine.js';
import { newBitmap, combine, type Bitmap } from './jbig2.js';

export interface TextRegionParams {
  width: number; height: number; numInstances: number; symbols: Bitmap[];
  logStrips: number; refCorner: number; transposed: boolean; combOp: number;
  defPixel: number; dsOffset: number;
  /** SBREFINE (T.88 §6.4.11): each instance may carry a refinement. */
  refine: boolean;
  /** SBRTEMPLATE and SBRAT, read only when `refine` is set. */
  rTemplate: number; rAt: Array<{ x: number; y: number }>;
  /** Overrides the derivation from `symbols.length`. A symbol dictionary's
   *  aggregate text region (§6.5.8.2.3) sizes IDs by the dictionary's DECLARED
   *  total, which is larger than the number of symbols decoded so far —
   *  deriving it here instead reads every symbol ID at the wrong width. */
  symCodeLen?: number;
  /** Overrides the arithmetic refinement — supplied by the Huffman driver,
   *  where the refinement is a separate MQ stream inside the Huffman one. */
  refineWith?: RefinementProducer;
  /** SBHUFF. Set only for a STANDALONE Huffman region, which builds its own
   *  source and its own symbol-ID table; a symbol dictionary's Huffman
   *  aggregate passes a ready-made source instead, because §6.5.8.2.3 reads its
   *  IDs as raw bits rather than through a runcode table. */
  huffman?: boolean;
  /** The eight tables SBHUFF's flag word selects. */
  tables?: HuffmanTables;
}

/** Build the Huffman driver for a standalone text region: the source, the
 *  symbol-ID table read off the front of the data (§7.4.3.1.7), and the
 *  refinement producer that alternates entropy coders (§6.4.11). */
function huffmanDriver(
  data: Uint8Array, start: number, end: number, p: TextRegionParams, cxGR: Int8Array | undefined,
): { int: IntSource; refine: RefinementProducer } {
  const r = new HuffmanReader(data, start, end);
  const idTable = parseSymbolIdTable(r, Math.max(1, p.symbols.length));
  const int = new HuffmanIntSource(r, { ...(p.tables ?? {}), id: idTable }, 0, p.logStrips);
  return { int, refine: huffmanRefinement(data, end, r, int, p.rTemplate, p.rAt, cxGR) };
}

/** The Huffman spelling of §6.4.11: ONE stream, TWO entropy coders,
 *  alternating. RSIZE says how many bytes the refinement occupies, the reader
 *  aligns, an `MqDecoder` runs over exactly those bytes — GRRD is
 *  arithmetic-only, T.88 defines no MMR refinement — and Huffman reading
 *  resumes after them by the FILE's count, the same rule a collective bitmap
 *  follows.
 *
 *  Exported because a symbol dictionary's Huffman aggregate needs it too, over
 *  its own reader; a second copy is how the two would come to disagree about
 *  where Huffman reading resumes. */
export function huffmanRefinement(
  data: Uint8Array, end: number, r: HuffmanReader, int: IntSource,
  rTemplate: number, rAt: Array<{ x: number; y: number }>, cxGR: Int8Array | undefined,
): RefinementProducer {
  return (sym, rdw, rdh, rdx, rdy) => {
    const rsize = int.size();
    if (rsize === null || rsize <= 0) throw new PdfParseError('JBIG2: Huffman refinement with no length');
    int.align();
    const at = r.bytePos();
    if (at + rsize > end) throw new PdfParseError('JBIG2: Huffman refinement past end of segment');
    const bm = decodeRefinement(data, at, at + rsize, {
      width: sym.width + rdw, height: sym.height + rdh, reference: sym,
      dx: (rdw >> 1) + rdx, dy: (rdh >> 1) + rdy,
      template: rTemplate, at: rAt, tpgron: false,
    }, new MqDecoder(data, at, at + rsize), cxGR);
    r.seekByte(at + rsize);
    return bm;
  };
}

// REFCORNER: 0=BOTTOMLEFT, 1=TOPLEFT, 2=BOTTOMRIGHT, 3=TOPRIGHT.
function place(reg: Bitmap, sym: Bitmap, curS: number, T: number, refCorner: number, transposed: boolean, combOp: number): number {
  const WI = sym.width, HI = sym.height;
  if (!transposed) {
    if (refCorner === 2 || refCorner === 3) curS += WI - 1; // right corners advance before draw
    const x = (refCorner === 2 || refCorner === 3) ? curS - WI + 1 : curS;
    const y = (refCorner === 1 || refCorner === 3) ? T : T - HI + 1;
    combine(reg, sym, x, y, combOp);
    if (refCorner === 0 || refCorner === 1) curS += WI - 1; // left corners advance after
    return curS;
  }
  // transposed: S runs vertically, T horizontally.
  if (refCorner === 0 || refCorner === 2) curS += HI - 1; // bottom corners advance before draw
  const y = (refCorner === 0 || refCorner === 2) ? curS - HI + 1 : curS;
  const x = (refCorner === 1 || refCorner === 0) ? T : T - WI + 1;
  combine(reg, sym, x, y, combOp);
  if (refCorner === 1 || refCorner === 3) curS += HI - 1; // top corners advance after
  return curS;
}

/** The ONE strip walk (T.88 §6.4), with the entropy source injected. `intIn` is
 *  supplied by a symbol dictionary decoding an aggregate, which shares its own
 *  source; a standalone region builds an arithmetic one over `data`. */
export function decodeTextRegion(
  data: Uint8Array, start: number, end: number, p: TextRegionParams,
  mqIn?: MqDecoder, intIn?: IntSource, cxGRIn?: Int8Array,
): Bitmap {
  const reg = newBitmap(p.width, p.height, p.defPixel);
  const strips = 1 << p.logStrips;
  const symCodeLen = p.symCodeLen ?? Math.max(1, Math.ceil(Math.log2(Math.max(1, p.symbols.length))));
  const mq = mqIn ?? new MqDecoder(data, start, end);
  // Allocated only when refinement is actually on: 8 KB per text region on a
  // page of hundreds is not free, and a region with SBREFINE clear never reads it.
  const cxGR = cxGRIn ?? (p.refine ? new Int8Array(1 << 13) : undefined);
  const driver = p.huffman === true && intIn === undefined
    ? huffmanDriver(data, start, end, p, cxGR)
    : undefined;
  const int = driver?.int ?? intIn ?? new ArithIntSource(mq, symCodeLen);
  // The ARITHMETIC refinement: it rides the region's own MQ stream, so there is
  // nothing to arrange. §6.4.11.1's half-deltas re-centre the grown bitmap on
  // the original; `>>` floors toward negative infinity as T.88 requires, where
  // `/ 2 | 0` truncates and differs for every odd NEGATIVE delta — a shrinking
  // refinement. Note the symbol dictionary's single-instance path (§6.5.8.2.2)
  // uses RDX/RDY with NO half-delta.
  const refine: RefinementProducer = p.refineWith ?? driver?.refine ?? ((sym, rdw, rdh, rdx, rdy) =>
    decodeRefinement(data, start, end, {
      width: sym.width + rdw, height: sym.height + rdh, reference: sym,
      dx: (rdw >> 1) + rdx, dy: (rdh >> 1) + rdy,
      template: p.rTemplate, at: p.rAt, tpgron: false,
    }, mq, cxGR));
  let stripT = -(int.dt() ?? 0) * strips;
  let firstS = 0, inst = 0;
  while (inst < p.numInstances) {
    stripT += (int.dt() ?? 0) * strips;
    firstS += int.fs() ?? 0;
    let curS = firstS, first = true;
    for (;;) {
      if (!first) { const ds = int.ds(); if (ds === null) break; curS += ds + p.dsOffset; }
      first = false;
      const curT = stripT + (strips === 1 ? 0 : (int.it() ?? 0));
      const id = int.id();
      let sym = p.symbols[id];
      // T.88 §6.4.11: with SBREFINE set every instance carries an RI flag, and a
      // non-zero one replaces the symbol with a refinement of it.
      if (p.refine) {
        const ri = int.ri() ?? 0;
        if (ri !== 0 && sym) {
          const rdw = int.rdw() ?? 0;
          const rdh = int.rdh() ?? 0;
          const rdx = int.rdx() ?? 0;
          const rdy = int.rdy() ?? 0;
          sym = refine(sym, rdw, rdh, rdx, rdy);
        }
      }
      if (sym) curS = place(reg, sym, curS, curT, p.refCorner, p.transposed, p.combOp);
      inst++;
      if (inst >= p.numInstances) break;
    }
  }
  return reg;
}
