// JBIG2 image decode — ITU-T T.88, embedded (PDF) organization only.
// Orchestrates segment parsing and page assembly; the entropy-coded region and
// symbol-dictionary bodies live in jbig2generic.ts / jbig2symbol.ts / jbig2text.ts.
import { PdfParseError, UnsupportedFeatureError } from './errors.js';
import { decodeGeneric } from './jbig2generic.js';
import { decodeSymbolDict } from './jbig2symbol.js';
import { decodeTextRegion } from './jbig2text.js';
import { decodeRefinement } from './jbig2refine.js';
import { decodePatternDict, decodeHalftoneRegion } from './jbig2halftone.js';
import { parseCustomTable, standardTable, type HuffmanTable } from './jbig2huffman.js';
import type { HuffmanTables } from './jbig2ints.js';

/** A decoded region/symbol: one byte per pixel, `1 = black`, row-major. */
export interface Bitmap { width: number; height: number; data: Uint8Array }

export function newBitmap(width: number, height: number, fill = 0): Bitmap {
  const data = new Uint8Array(width * height);
  if (fill) data.fill(1);
  return { width, height, data };
}

/** Composite `src` onto `dst` at (x,y) with a JBIG2 combination operator
 *  (0=OR, 1=AND, 2=XOR, 3=XNOR, 4=REPLACE). Pixels outside `dst` are clipped. */
export function combine(dst: Bitmap, src: Bitmap, x: number, y: number, op: number): void {
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy; if (dy < 0 || dy >= dst.height) continue;
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx; if (dx < 0 || dx >= dst.width) continue;
      const s = src.data[sy * src.width + sx];
      const di = dy * dst.width + dx; const d = dst.data[di];
      dst.data[di] = op === 0 ? (d | s) : op === 1 ? (d & s) : op === 2 ? (d ^ s) : op === 3 ? (d ^ s ^ 1) : s;
    }
  }
}

export interface SegmentHeader {
  number: number; type: number; referredTo: number[]; pageAssociation: number;
  dataStart: number; dataLength: number;
}

/** Parse the embedded-organization segment headers (T.88 §7.2). */
export function parseSegments(data: Uint8Array): SegmentHeader[] {
  const segs: SegmentHeader[] = []; let p = 0;
  const u8 = () => { if (p >= data.length) throw new PdfParseError('JBIG2: truncated segment header', p); return data[p++]; };
  const u32 = () => ((u8() << 24) | (u8() << 16) | (u8() << 8) | u8()) >>> 0;
  while (p < data.length) {
    const number = u32();
    const flags = u8();
    const type = flags & 0x3f;
    const pageAssocLarge = (flags & 0x40) !== 0;
    const rtByte = u8();
    let count = rtByte >> 5;
    if (count === 7) { // long form: 29-bit count + retention-flag bytes
      p -= 1; count = u32() & 0x1fffffff;
      const retainBytes = Math.ceil((count + 1) / 8);
      for (let i = 0; i < retainBytes; i++) u8();
    } // else short form: retain bits are in the low 5 of rtByte
    const refSize = number <= 256 ? 1 : number <= 65536 ? 2 : 4;
    const referredTo: number[] = [];
    for (let i = 0; i < count; i++) {
      let v = 0; for (let b = 0; b < refSize; b++) v = (v << 8) | u8(); referredTo.push(v >>> 0);
    }
    const pageAssociation = pageAssocLarge ? u32() : u8();
    const dataLength = u32();
    if (dataLength === 0xffffffff) throw new PdfParseError('JBIG2: unknown segment data length (0xffffffff) unsupported', p);
    segs.push({ number, type, referredTo, pageAssociation, dataStart: p, dataLength });
    p += dataLength;
  }
  return segs;
}

/** Pack a page bitmap into PDF 1-bpp samples (MSB-first, each row padded to a
 *  byte), bit-inverted so JBIG2 black(1) becomes PDF sample 0 under the default
 *  DeviceGray [0 1] decode (matches pdf.js Jbig2Stream). */
export function packBitmap(bm: Bitmap): Uint8Array {
  const rowBytes = (bm.width + 7) >> 3;
  const out = new Uint8Array(rowBytes * bm.height);
  for (let y = 0; y < bm.height; y++) {
    for (let x = 0; x < bm.width; x++) {
      if (bm.data[y * bm.width + x]) out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = ~out[i] & 0xff;
  return out;
}

/** Region segment information field (T.88 §7.4.1): the 17-byte header shared by
 *  every region segment. `bodyStart` is the offset just past it. */
export interface RegionInfo { width: number; height: number; x: number; y: number; combOp: number; bodyStart: number }
export function parseRegionInfo(data: Uint8Array, start: number): RegionInfo {
  const u32 = (o: number) => ((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) >>> 0;
  return { width: u32(start), height: u32(start + 4), x: u32(start + 8), y: u32(start + 12), combOp: data[start + 16] & 7, bodyStart: start + 17 };
}

/** An intermediate region segment's decoded result (T.88 §7.4): the bitmap plus
 *  the region rectangle it was decoded for, held under its segment number for a
 *  later segment to consume. A refinement region needs both — the pixels as its
 *  reference, and the rectangle to align that reference against its own. */
export interface Buffered { bitmap: Bitmap; info: RegionInfo }

/** Read a signed 8-bit AT-pixel coordinate. */
function s8(v: number): number { return (v << 24) >> 24; }

/** Read a signed 32-bit big-endian value. A halftone region's HGX/HGY are
 *  signed (T.88 §7.4.5.1.2) — a grid may legitimately start off the left or top
 *  edge of its region, which is exactly the case that makes the placement
 *  formula's floor-versus-truncate difference observable. */
function s32(data: Uint8Array, o: number): number {
  return ((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) | 0;
}

interface Located { h: SegmentHeader; src: Uint8Array }

/** The custom Huffman tables a segment refers to, in REFERRED-TO order — which
 *  is the order its selectors consume them in (T.88 §7.4.3.1.6). */
function customTables(h: SegmentHeader, tablesBySeg: Map<number, HuffmanTable>): HuffmanTable[] {
  const out: HuffmanTable[] = [];
  for (const r of h.referredTo) { const got = tablesBySeg.get(r); if (got) out.push(got); }
  return out;
}

/** A table selector: `choices` is indexed by the selector value, a gap in it is
 *  a RESERVED value that must be refused rather than falling through to
 *  whichever table happens to be next, and the slot past the standard ones is
 *  "custom", taken from the referred-to tables in order. */
function pickTable(
  sel: number, choices: Array<number | undefined>, field: string,
  take: () => HuffmanTable, at: number,
): HuffmanTable {
  if (sel === choices.length) return take();
  const std = choices[sel];
  if (std === undefined) throw new PdfParseError(`JBIG2: reserved Huffman table selector ${sel} for ${field}`, at);
  return standardTable(std);
}

/** Resolve a TEXT region's eight table selectors (T.88 §7.4.3.1.2). Note there
 *  is no selector for IT or RI: a Huffman region reads CURT as LOG2SBSTRIPS raw
 *  bits and RI as one raw bit, so neither is a table at all. */
export function selectTextTables(flags: number, custom: HuffmanTable[], at = 0): HuffmanTables {
  let next = 0;
  const take = (): HuffmanTable => {
    const t = custom[next++];
    if (t === undefined) throw new PdfParseError('JBIG2: text region names more custom Huffman tables than it refers to', at);
    return t;
  };
  const pick = (sel: number, choices: Array<number | undefined>, field: string): HuffmanTable =>
    pickTable(sel, choices, field, take, at);
  // Field order matters: it is the order the custom tables are consumed in.
  return {
    fs: pick(flags & 3, [6, 7, undefined], 'SBHUFFFS'),
    ds: pick((flags >> 2) & 3, [8, 9, 10], 'SBHUFFDS'),
    dt: pick((flags >> 4) & 3, [11, 12, 13], 'SBHUFFDT'),
    rdw: pick((flags >> 6) & 3, [14, 15, undefined], 'SBHUFFRDW'),
    rdh: pick((flags >> 8) & 3, [14, 15, undefined], 'SBHUFFRDH'),
    rdx: pick((flags >> 10) & 3, [14, 15, undefined], 'SBHUFFRDX'),
    rdy: pick((flags >> 12) & 3, [14, 15, undefined], 'SBHUFFRDY'),
    size: pick((flags >> 14) & 1, [1], 'SBHUFFRSIZE'),
  };
}

/** Resolve a symbol dictionary's four table selectors (T.88 §7.4.3.1.2).
 *
 *  Two of the fields it also needs have NO selector and are easy to give one by
 *  mistake: the export run is always Table B.1 (§6.5.10) and the refinement
 *  deltas are always Table B.15 (§6.5.8.2.2). */
export function selectSymbolTables(flags: number, custom: HuffmanTable[], at = 0): HuffmanTables {
  let next = 0;
  const take = (): HuffmanTable => {
    const t = custom[next++];
    if (t === undefined) throw new PdfParseError('JBIG2: symbol dictionary names more custom Huffman tables than it refers to', at);
    return t;
  };
  /** `choices` is indexed by the selector value; a gap in it is a RESERVED
   *  value, which must be refused rather than falling through to whichever
   *  table happens to be next. */
  const pick = (sel: number, choices: Array<number | undefined>, field: string): HuffmanTable => {
    if (sel === choices.length) return take(); // the "custom" slot sits past the standard ones
    const std = choices[sel];
    if (std === undefined) throw new PdfParseError(`JBIG2: reserved Huffman table selector ${sel} for ${field}`, at);
    return standardTable(std);
  };
  return {
    dh: pick((flags >> 2) & 3, [4, 5, undefined], 'SDHUFFDH'),
    dw: pick((flags >> 4) & 3, [2, 3, undefined], 'SDHUFFDW'),
    size: pick((flags >> 6) & 1, [1], 'SDHUFFBMSIZE'),
    ai: pick((flags >> 7) & 1, [1], 'SDHUFFAGGINST'),
    // No selector: T.88 fixes both outright.
    ex: standardTable(1),
    rdx: standardTable(15),
    rdy: standardTable(15),
  };
}

/** Decode an embedded JBIG2 image stream to packed 1-bpp samples. `globals` is
 *  the decoded `/JBIG2Globals` stream (shared segments), if any. */
export function decodeJbig2(data: Uint8Array, globals: Uint8Array | undefined, width: number, height: number): Uint8Array {
  const page = newBitmap(width, height);
  const located: Located[] = [
    ...(globals ? parseSegments(globals).map((h) => ({ h, src: globals })) : []),
    ...parseSegments(data).map((h) => ({ h, src: data })),
  ];
  const symbolsBySeg = new Map<number, Bitmap[]>();
  // Intermediate regions (types 4, 20, 36, 40), keyed by segment number. A
  // referred-to segment resolves by KIND — a refinement region wants a buffer,
  // a text region wants symbol dictionaries — so a wrong-kind reference is a
  // lookup miss rather than a runtime type test.
  const buffersBySeg = new Map<number, Buffered>();
  // Pattern dictionaries (type 16), keyed by segment number. Same rule: a
  // halftone region resolves its patterns by KIND, so a reference to a symbol
  // dictionary is a lookup miss rather than a runtime type test.
  const patternsBySeg = new Map<number, Bitmap[]>();
  // Custom Huffman tables (type 53), the fourth and last of the design's lookup
  // maps. A table is stored the moment it is met, because a symbol dictionary
  // or a text region refers to it by segment number and may come later in the
  // stream. Nothing READS this yet — the two Huffman consumers are separate
  // children — but parsing and discarding would make the segment arm a no-op
  // that looks like support.
  const tablesBySeg = new Map<number, HuffmanTable>();
  for (const { h, src } of located) {
    switch (h.type) {
      // page info / end-of-* / profiles / extension: carry no bitmap and
      // contribute nothing to the page.
      case 48: case 49: case 50: case 51: case 52: case 62: break;
      case 0: { // symbol dictionary
        const b = h.dataStart;
        const u32 = (o: number) => ((src[o] << 24) | (src[o + 1] << 16) | (src[o + 2] << 8) | src[o + 3]) >>> 0;
        const flags = (src[b] << 8) | src[b + 1];
        const huffman = (flags & 1) !== 0, refAgg = (flags & 2) !== 0, template = (flags >> 10) & 3;
        let o = b + 2;
        const at: Array<{ x: number; y: number }> = [];
        if (!huffman) { const n = template === 0 ? 4 : 1; for (let i = 0; i < n; i++) { at.push({ x: s8(src[o]), y: s8(src[o + 1]) }); o += 2; } }
        const rTemplate = (flags >> 12) & 1;
        // T.88 §7.4.4.1: SDRAT sits between SDAT and SDNUMEXSYMS.
        const rAt: Array<{ x: number; y: number }> = [];
        if (refAgg && rTemplate === 0) {
          for (let i = 0; i < 2; i++) { rAt.push({ x: s8(src[o]), y: s8(src[o + 1]) }); o += 2; }
        }
        const numExSyms = u32(o); const numNewSyms = u32(o + 4); o += 8;
        const inputSymbols: Bitmap[] = [];
        for (const r of h.referredTo) { const got = symbolsBySeg.get(r); if (got) inputSymbols.push(...got); }
        // T.88 §7.4.3.1.2: four selectors in the flag word pick this
        // dictionary's tables. Selection is header work and stays here;
        // jbig2ints.ts receives concrete tables and never sees a flag word.
        const tables = huffman
          ? selectSymbolTables(flags, customTables(h, tablesBySeg), h.dataStart)
          : undefined;
        const syms = decodeSymbolDict(src, o, h.dataStart + h.dataLength, { huffman, refAgg, template, at, numExSyms, numNewSyms, inputSymbols, rTemplate, rAt, tables });
        symbolsBySeg.set(h.number, syms);
        break;
      }
      case 36: case 38: case 39: { // generic region: 36 intermediate, 38/39 immediate (lossless)
        const ri = parseRegionInfo(src, h.dataStart);
        const flags = src[ri.bodyStart];
        const mmr = (flags & 1) !== 0;
        const template = (flags >> 1) & 3;
        const tpgdon = ((flags >> 3) & 1) !== 0;
        let o = ri.bodyStart + 1;
        const at: Array<{ x: number; y: number }> = [];
        if (!mmr) {
          const n = template === 0 ? 4 : 1;
          for (let i = 0; i < n; i++) { at.push({ x: s8(src[o]), y: s8(src[o + 1]) }); o += 2; }
        }
        const bm = decodeGeneric(src, o, h.dataStart + h.dataLength, { width: ri.width, height: ri.height, template, at, tpgdon, mmr });
        // 36 is the intermediate form: stored, not drawn. Only 38/39 composite.
        if (h.type === 36) buffersBySeg.set(h.number, { bitmap: bm, info: ri });
        else combine(page, bm, ri.x, ri.y, ri.combOp);
        break;
      }
      case 4: case 6: case 7: { // text region: 4 intermediate, 6/7 immediate (lossless)
        const ri = parseRegionInfo(src, h.dataStart);
        const f = (src[ri.bodyStart] << 8) | src[ri.bodyStart + 1];
        const huffman = (f & 1) !== 0;
        const refine = (f & 2) !== 0;
        const logStrips = (f >> 2) & 3, refCorner = (f >> 4) & 3, transposed = ((f >> 6) & 1) !== 0;
        const combOp = (f >> 7) & 3, defPixel = (f >> 9) & 1;
        let dsOffset = (f >> 10) & 0x1f; if (dsOffset > 15) dsOffset -= 32;
        const rTemplate = (f >> 15) & 1;
        let o = ri.bodyStart + 2;
        // T.88 §7.4.3.1.2: the Huffman flags are a 2-byte field sitting between
        // the text-region flags and SBRAT, and present only when SBHUFF is set.
        // Reading it in the wrong order shifts SBRAT and SBNUMINSTANCES — the
        // same class of mistake the SBRAT ordering below already invites.
        let tables: HuffmanTables | undefined;
        if (huffman) {
          const hf = (src[o] << 8) | src[o + 1]; o += 2;
          tables = selectTextTables(hf, customTables(h, tablesBySeg), h.dataStart);
        }
        // T.88 §7.4.3.1: SBRAT sits between the flags and SBNUMINSTANCES, and
        // only when refinement is on with template 0. Reading it in the wrong
        // order shifts SBNUMINSTANCES by four bytes.
        const rAt: Array<{ x: number; y: number }> = [];
        if (refine && rTemplate === 0) {
          for (let i = 0; i < 2; i++) { rAt.push({ x: s8(src[o]), y: s8(src[o + 1]) }); o += 2; }
        }
        const numInstances = ((src[o] << 24) | (src[o + 1] << 16) | (src[o + 2] << 8) | src[o + 3]) >>> 0; o += 4;
        const symbols: Bitmap[] = [];
        for (const r of h.referredTo) { const got = symbolsBySeg.get(r); if (got) symbols.push(...got); }
        const bm = decodeTextRegion(src, o, h.dataStart + h.dataLength, { width: ri.width, height: ri.height, numInstances, symbols, logStrips, refCorner, transposed, combOp, defPixel, dsOffset, refine, rTemplate, rAt , huffman, tables });
        // 4 is the intermediate form: stored, not drawn. Only 6/7 composite.
        if (h.type === 4) buffersBySeg.set(h.number, { bitmap: bm, info: ri });
        else combine(page, bm, ri.x, ri.y, ri.combOp);
        break;
      }
      case 16: { // pattern dictionary (T.88 §7.4.4)
        // 1 flags + 1 HDPW + 1 HDPH + 4 GRAYMAX is the minimum; anything shorter
        // is a damaged file, and parsing on would size a bitmap from undefined.
        if (h.dataLength < 7) throw new PdfParseError('JBIG2: truncated pattern dictionary segment', h.dataStart);
        const b = h.dataStart;
        const flags = src[b];
        const mmr = (flags & 1) !== 0;
        const template = (flags >> 1) & 3;
        const grayMax = ((src[b + 3] << 24) | (src[b + 4] << 16) | (src[b + 5] << 8) | src[b + 6]) >>> 0;
        const pats = decodePatternDict(src, b + 7, h.dataStart + h.dataLength, {
          mmr, template, patternWidth: src[b + 1], patternHeight: src[b + 2], grayMax,
        });
        patternsBySeg.set(h.number, pats);
        break;
      }
      case 20: case 22: case 23: { // halftone region: 20 intermediate, 22/23 immediate (lossless)
        // 17-byte region info + 1 flags byte + HGW/HGH/HGX/HGY (4 each) +
        // HRX/HRY (2 each) is 38 bytes before any coded data.
        if (h.dataLength < 38) throw new PdfParseError('JBIG2: truncated halftone region segment', h.dataStart);
        const ri = parseRegionInfo(src, h.dataStart);
        const u32 = (o: number) => ((src[o] << 24) | (src[o + 1] << 16) | (src[o + 2] << 8) | src[o + 3]) >>> 0;
        const flags = src[ri.bodyStart];
        const mmr = (flags & 1) !== 0;
        const template = (flags >> 1) & 3;
        const enableSkip = ((flags >> 3) & 1) !== 0;
        const combOp = (flags >> 4) & 7;
        const defPixel = (flags >> 7) & 1;
        const o = ri.bodyStart + 1;
        const gridWidth = u32(o), gridHeight = u32(o + 4);
        // HGX/HGY are SIGNED and in 1/256 pel; HRX/HRY are 8.8 fixed point.
        const gridX = s32(src, o + 8), gridY = s32(src, o + 12);
        const vectorX = (src[o + 16] << 8) | src[o + 17];
        const vectorY = (src[o + 18] << 8) | src[o + 19];
        const patterns: Bitmap[] = [];
        for (const r of h.referredTo) { const got = patternsBySeg.get(r); if (got) patterns.push(...got); }
        const bm = decodeHalftoneRegion(src, o + 20, h.dataStart + h.dataLength, {
          width: ri.width, height: ri.height, mmr, template, enableSkip, combOp, defPixel,
          gridWidth, gridHeight, gridX, gridY, vectorX, vectorY, patterns,
        });
        // 20 is the intermediate form: stored, not drawn. Only 22/23 composite.
        if (h.type === 20) buffersBySeg.set(h.number, { bitmap: bm, info: ri });
        else combine(page, bm, ri.x, ri.y, ri.combOp);
        break;
      }
      case 40: case 42: case 43: { // refinement region: 40 intermediate, 42/43 immediate (lossless)
        // 17-byte region info + 1 flags byte is the minimum; anything shorter is
        // a damaged file, and parsing on would build a bitmap out of undefined.
        if (h.dataLength < 18) throw new PdfParseError('JBIG2: truncated refinement region segment', h.dataStart);
        const ri = parseRegionInfo(src, h.dataStart);
        const flags = src[ri.bodyStart];
        const template = flags & 1;
        const tpgron = ((flags >> 1) & 1) !== 0;
        let o = ri.bodyStart + 1;
        const at: Array<{ x: number; y: number }> = [];
        if (template === 0) {
          for (let i = 0; i < 2; i++) { at.push({ x: s8(src[o]), y: s8(src[o + 1]) }); o += 2; }
        }
        // T.88 §7.4.7.2: an intermediate region in the referred-to set is the
        // reference. With none, the reference is the PAGE under the rect and the
        // result REPLACES it — the external combination operator does not apply.
        let reference: Bitmap | undefined;
        for (const r of h.referredTo) { const got = buffersBySeg.get(r); if (got) { reference = got.bitmap; break; } }
        const onPage = reference === undefined;
        // Branch on `reference === undefined`, not on `onPage` — TypeScript
        // narrows through the former and not through the latter.
        if (reference === undefined) {
          const ref = newBitmap(ri.width, ri.height);
          for (let y = 0; y < ri.height; y++) {
            for (let x = 0; x < ri.width; x++) {
              ref.data[y * ri.width + x] = (ri.y + y < page.height && ri.x + x < page.width)
                ? page.data[(ri.y + y) * page.width + (ri.x + x)] : 0;
            }
          }
          reference = ref;
        }
        const bm = decodeRefinement(src, o, h.dataStart + h.dataLength,
          { width: ri.width, height: ri.height, reference, dx: 0, dy: 0, template, at, tpgron });
        if (h.type === 40) buffersBySeg.set(h.number, { bitmap: bm, info: ri });
        else combine(page, bm, ri.x, ri.y, onPage ? 4 /* REPLACE */ : ri.combOp);
        break;
      }
      case 53: { // custom Huffman table (T.88 §B.2.3)
        tablesBySeg.set(h.number, parseCustomTable(src, h.dataStart, h.dataStart + h.dataLength));
        break;
      }
      default: throw new UnsupportedFeatureError(`JBIG2: segment type ${h.type} not supported`);
    }
  }
  return packBitmap(page);
}
