// JBIG2 symbol dictionary decode — ITU-T T.88 §6.5 (arithmetic path). Produces
// the ordered array of exported symbol bitmaps. Each new symbol's bitmap is a
// generic region decoded over the dictionary's shared MQ stream/context.
import { MqDecoder } from './jpxmq.js';
import { ArithIntSource, HuffmanIntSource, type HuffmanTables, type IntSource, type SymbolProducer } from './jbig2ints.js';
import { HuffmanReader, standardTable } from './jbig2huffman.js';
import { decodeGeneric, decodeMmrBitmap } from './jbig2generic.js';
import { decodeRefinement } from './jbig2refine.js';
import { decodeTextRegion, huffmanRefinement } from './jbig2text.js';
import { newBitmap, type Bitmap } from './jbig2.js';
import { PdfParseError } from './errors.js';

export interface SymbolDictParams {
  huffman: boolean; refAgg: boolean; template: number; at: Array<{ x: number; y: number }>;
  numExSyms: number; numNewSyms: number; inputSymbols: Bitmap[];
  /** SDRTEMPLATE and SDRAT, read only when `refAgg` is set. */
  rTemplate: number; rAt: Array<{ x: number; y: number }>;
  /** The Huffman tables this dictionary's four selectors resolved to, plus the
   *  two T.88 fixes outright (export runs are always B.1, refinement deltas
   *  always B.15). Selection is header work and lives in jbig2.ts. */
  tables?: HuffmanTables;
}

/** One driver: the entropy source and the bitmap production for one dictionary.
 *  The walk below is the same either way. */
interface Driver { int: IntSource; producer: SymbolProducer }

export function decodeSymbolDict(data: Uint8Array, start: number, end: number, p: SymbolDictParams): Bitmap[] {
  // T.88 §6.5.8.2.3: the symbol-ID width comes from the dictionary's DECLARED
  // total, not from how many symbols have been decoded so far — which grows as
  // the dictionary is built and would read IDs at the wrong width.
  const symCodeLen = Math.max(1, Math.ceil(Math.log2(Math.max(1, p.inputSymbols.length + p.numNewSyms))));
  const newSyms: Bitmap[] = [];
  const { int, producer } = p.huffman
    ? huffmanDriver(data, start, end, p, symCodeLen, newSyms)
    : arithDriver(data, start, end, p, symCodeLen, newSyms);
  heightClassWalk(int, p.numNewSyms, producer, newSyms);
  return exportSymbols(int, [...p.inputSymbols, ...newSyms]);
}

function arithDriver(
  data: Uint8Array, start: number, end: number, p: SymbolDictParams,
  symCodeLen: number, newSyms: Bitmap[],
): Driver {
  const mq = new MqDecoder(data, start, end);
  const cxGB = new Int8Array(1 << 16);
  // ONE source for the dictionary and for any aggregate text region it decodes.
  // T.88 §6.5.8.2.1 has the aggregate use the DICTIONARY's arithmetic
  // statistics, so IAID/IARDX/IARDY are shared rather than duplicated.
  const int = new ArithIntSource(mq, symCodeLen);
  const cxGR = p.refAgg ? new Int8Array(1 << 13) : undefined;

  const producer: SymbolProducer = {
    kind: 'perSymbol',
    produce(symWidth, hcHeight, index) {
      if (!p.refAgg) {
        return decodeGeneric(data, start, end,
          { width: symWidth, height: hcHeight, template: p.template, at: p.at, tpgdon: false, mmr: false }, mq, cxGB);
      }
      const nInst = int.ai();
      if (nInst === null) throw new PdfParseError('JBIG2: symbol dictionary REFAGGNINST OOB');
      if (nInst === 1) {
        // §6.5.8.2.2. The offsets are RDX/RDY PLAIN — no half-delta, unlike the
        // text region's §6.4.11.1, because the refined symbol's size comes from
        // the height class rather than from a decoded delta. Using one rule in
        // both places is a small uniform misplacement that reads as bad
        // rendering rather than as a decode fault.
        const id = int.id();
        const rdx = int.rdx() ?? 0;
        const rdy = int.rdy() ?? 0;
        const ref = id < p.inputSymbols.length ? p.inputSymbols[id] : newSyms[id - p.inputSymbols.length];
        if (!ref) throw new PdfParseError('JBIG2: symbol dictionary REFAGG reference out of range');
        return decodeRefinement(data, start, end, {
          width: symWidth, height: hcHeight, reference: ref, dx: rdx, dy: rdy,
          template: p.rTemplate, at: p.rAt, tpgron: false,
        }, mq, cxGR);
      }
      // §6.5.8.2.1: more than one instance is decoded as a TEXT REGION over the
      // dictionary's current symbols, sharing this stream and this source. Its
      // parameters are fixed by the spec, not read from anywhere: one strip,
      // TOPLEFT, OR, no transpose, no offset. The symCodeLen is the
      // DICTIONARY's, not the region's own derivation.
      void index;
      return decodeTextRegion(data, start, end, {
        width: symWidth, height: hcHeight, numInstances: nInst,
        symbols: [...p.inputSymbols, ...newSyms],
        logStrips: 0, refCorner: 1 /* TOPLEFT */, transposed: false, combOp: 0,
        defPixel: 0, dsOffset: 0,
        refine: true, rTemplate: p.rTemplate, rAt: p.rAt, symCodeLen,
      }, mq, int, cxGR);
    },
  };
  return { int, producer };
}

function huffmanDriver(
  data: Uint8Array, start: number, end: number, p: SymbolDictParams,
  symCodeLen: number, newSyms: Bitmap[],
): Driver {
  const r = new HuffmanReader(data, start, end);
  const int = new HuffmanIntSource(r, p.tables ?? {}, symCodeLen);

  if (!p.refAgg) {
    // The main Huffman shape: ONE bitmap per height class (§6.5.9), sliced by
    // the widths already read. This is where the IntSource abstraction stops.
    return {
      int,
      producer: {
        kind: 'perClass',
        produce: (widths, hcHeight) => collectiveBitmap(data, end, r, int, widths, hcHeight),
      },
    };
  }

  const cxGR = new Int8Array(1 << 13);
  return {
    int,
    producer: {
      kind: 'perSymbol',
      produce(symWidth, hcHeight) {
        const nInst = int.ai();
        if (nInst === null) throw new PdfParseError('JBIG2: symbol dictionary REFAGGNINST OOB');
        if (nInst !== 1) {
          // §6.5.8.2.1: a Huffman-coded TEXT region over the dictionary's
          // current symbols, whose parameters T.88 Table 17 fixes outright —
          // there is no flag word to read them from. Its symbol IDs are
          // symCodeLen RAW BITS (§6.5.8.2.3), not a runcode table, which is
          // why it gets a source of its own rather than going through
          // decodeTextRegion's `huffman` path.
          //
          // UNVERIFIED, tracked as `qfgw`: this reads INLINE from the
          // dictionary's bit stream with no BMSIZE wrapper, unlike the
          // NINST == 1 path below. The reading is that the wrapper exists
          // because GRRD is arithmetic-only and an MqDecoder needs a byte
          // range, which an aggregate reading Huffman bits does not — its own
          // refinements carry their RSIZE wrappers where RI is set. Our
          // encoder shares that reading, so no fixture here can settle it.
          const aggInt = new HuffmanIntSource(r, {
            fs: standardTable(6), ds: standardTable(8), dt: standardTable(11),
            rdw: standardTable(15), rdh: standardTable(15),
            rdx: standardTable(15), rdy: standardTable(15),
            size: standardTable(1),
          }, symCodeLen, 0);
          return decodeTextRegion(data, start, end, {
            width: symWidth, height: hcHeight, numInstances: nInst,
            symbols: [...p.inputSymbols, ...newSyms],
            logStrips: 0, refCorner: 1 /* TOPLEFT */, transposed: false, combOp: 0,
            defPixel: 0, dsOffset: 0,
            refine: true, rTemplate: p.rTemplate, rAt: p.rAt, symCodeLen,
            refineWith: huffmanRefinement(data, end, r, aggInt, p.rTemplate, p.rAt, cxGR),
          }, undefined, aggInt, cxGR);
        }
        // §6.5.8.2.2, the Huffman spelling: the ID is symCodeLen raw bits, the
        // deltas come through Table B.15, and BMSIZE says how many bytes the
        // refinement occupies. GRRD is ARITHMETIC-ONLY — T.88 defines no MMR
        // refinement — so an MqDecoder runs over exactly those bytes and
        // Huffman reading resumes after them.
        const id = int.id();
        const rdx = int.rdx() ?? 0;
        const rdy = int.rdy() ?? 0;
        const bmSize = int.size();
        if (bmSize === null || bmSize <= 0) {
          throw new PdfParseError('JBIG2: Huffman REFAGG symbol with no refinement length');
        }
        int.align();
        const at = r.bytePos();
        if (at + bmSize > end) throw new PdfParseError('JBIG2: Huffman REFAGG refinement past end of segment');
        const ref = id < p.inputSymbols.length ? p.inputSymbols[id] : newSyms[id - p.inputSymbols.length];
        if (!ref) throw new PdfParseError('JBIG2: symbol dictionary REFAGG reference out of range');
        const bm = decodeRefinement(data, at, at + bmSize, {
          width: symWidth, height: hcHeight, reference: ref, dx: rdx, dy: rdy,
          template: p.rTemplate, at: p.rAt, tpgron: false,
        }, new MqDecoder(data, at, at + bmSize), cxGR);
        // Advance by the file's OWN claim, not by what the MQ decoder read.
        r.seekByte(at + bmSize);
        return bm;
      },
    },
  };
}

/** A height class's collective bitmap (T.88 §6.5.9). A Huffman dictionary with
 *  SDREFAGG clear does not decode a bitmap per symbol: it reads BMSIZE, aligns,
 *  takes ONE bitmap for the whole class — MMR-coded, or stored uncompressed
 *  with each row padded to a byte when BMSIZE is 0 — and slices it by the
 *  widths already decoded. */
function collectiveBitmap(
  data: Uint8Array, end: number, r: HuffmanReader, int: IntSource,
  widths: number[], hcHeight: number,
): Bitmap[] {
  const totWidth = widths.reduce((a, b) => a + b, 0);
  if (totWidth <= 0) throw new PdfParseError('JBIG2: height class with no width');
  // A damage guard, not a format limit — the same argument decodePatternDict's
  // bound rests on. A height class's collective bitmap is sized by a SUM of
  // decoded widths times a decoded height, so a stream read at the wrong offset
  // produces an enormous one; measured, a desynchronised fixture spent 58
  // seconds here before the walk noticed.
  if (totWidth * hcHeight > 1 << 26) {
    throw new PdfParseError(`JBIG2: collective bitmap implausibly large (${totWidth}x${hcHeight})`);
  }
  const bmSize = int.size();
  if (bmSize === null) throw new PdfParseError('JBIG2: collective bitmap BMSIZE OOB');
  int.align();
  const at = r.bytePos();

  let collective: Bitmap;
  let consumed: number;
  if (bmSize === 0) {
    // Stored uncompressed, each ROW padded to a byte — not the bitmap as a
    // whole, so the row stride is what matters.
    const rowBytes = (totWidth + 7) >> 3;
    consumed = rowBytes * hcHeight;
    if (at + consumed > end) throw new PdfParseError('JBIG2: uncompressed collective bitmap past end of segment');
    collective = newBitmap(totWidth, hcHeight);
    for (let y = 0; y < hcHeight; y++) {
      for (let x = 0; x < totWidth; x++) {
        collective.data[y * totWidth + x] = (data[at + y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
      }
    }
  } else {
    if (at + bmSize > end) throw new PdfParseError('JBIG2: collective bitmap past end of segment');
    collective = decodeMmrBitmap(data, at, at + bmSize, totWidth, hcHeight).bitmap;
    consumed = bmSize;
  }
  // Advance by BMSIZE, NOT by what MMR reported consuming. The two normally
  // agree; where they do not, the file's own claim is what says where the next
  // height class begins, and one short bitmap would desynchronise all of them.
  r.seekByte(at + consumed);

  const out: Bitmap[] = [];
  let x0 = 0;
  for (const w of widths) {
    const bm = newBitmap(w, hcHeight);
    for (let y = 0; y < hcHeight; y++) {
      for (let x = 0; x < w; x++) bm.data[y * w + x] = collective.data[y * totWidth + x0 + x];
    }
    out.push(bm);
    x0 += w;
  }
  return out;
}

/** The ONE height-class walk (T.88 §6.5.5), with the entropy source and the
 *  bitmap production both injected.
 *
 *  `newSyms` is passed IN rather than returned because a REFAGG producer refines
 *  symbols this same dictionary has already produced, so it must see the array
 *  grow — a returned array would still be in its temporal dead zone at the
 *  moment the producer closure runs. */
function heightClassWalk(int: IntSource, numNewSyms: number, producer: SymbolProducer, newSyms: Bitmap[]): void {
  let hcHeight = 0;
  while (newSyms.length < numNewSyms) {
    const dh = int.dh();
    if (dh === null) throw new PdfParseError('JBIG2: symbol dictionary height-class OOB');
    hcHeight += dh;
    let symWidth = 0;
    const widths: number[] = [];
    const before = newSyms.length;
    for (;;) {
      const dw = int.dw();
      if (dw === null) break; // OOB ends the height class
      symWidth += dw;
      if (hcHeight <= 0 || symWidth <= 0) throw new PdfParseError('JBIG2: bad symbol dimensions');
      if (newSyms.length + widths.length >= numNewSyms) throw new PdfParseError('JBIG2: too many symbols in dictionary');
      if (producer.kind === 'perSymbol') newSyms.push(producer.produce(symWidth, hcHeight, newSyms.length));
      else widths.push(symWidth);
    }
    // A Huffman dictionary with SDREFAGG clear decodes ONE bitmap for the whole
    // class (§6.5.9) and slices it by the widths already read — which is where
    // the IntSource abstraction stops and the producer takes over.
    if (producer.kind === 'perClass') newSyms.push(...producer.produce(widths, hcHeight));
    // A height class that produced nothing cannot make progress, so the outer
    // loop would spin on a damaged file. The arithmetic path has the same
    // exposure and the guard covers both.
    if (newSyms.length === before) throw new PdfParseError('JBIG2: symbol dictionary height class with no symbols');
  }
}

/** Export flags (T.88 §6.5.10): alternating skip/export runs over input+new. */
function exportSymbols(int: IntSource, all: Bitmap[]): Bitmap[] {
  const exported: Bitmap[] = [];
  let exFlag = false, i = 0;
  while (i < all.length) {
    const run = int.ex();
    if (run === null) throw new PdfParseError('JBIG2: symbol dictionary export-run OOB');
    if (exFlag) for (let k = 0; k < run && i + k < all.length; k++) exported.push(all[i + k]);
    i += run; exFlag = !exFlag;
  }
  return exported;
}
