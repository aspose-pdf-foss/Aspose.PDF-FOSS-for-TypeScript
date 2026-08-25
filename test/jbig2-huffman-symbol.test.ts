import { describe, it, expect } from 'vitest';
import { decodeSymbolDict } from '../src/jbig2symbol.js';
import { decodeJbig2, selectSymbolTables } from '../src/jbig2.js';
import { standardTable } from '../src/jbig2huffman.js';
import type { Bitmap } from '../src/jbig2.js';
import { BitWriter, encodeValue } from './helpers/jbig2-huffman-encode.js';
import { encodeG4 } from './helpers/ccitt-encode.js';

// ---------------------------------------------------------------------------
// The Huffman symbol dictionary (T.88 §6.5 with SDHUFF set).
//
// These fixtures are assembled here rather than minted, and what they pin is
// the WALK — the height-class loop, BMSIZE, the byte alignment, the collective
// bitmap and its slicing. They cannot see a typo in one of T.88's tables,
// because the encoder reads the same table data the decoder does; the tables
// are anchored separately by utax.6's three checks.
// ---------------------------------------------------------------------------

/** The tables a dictionary with the default selectors resolves to: SDHUFFDH is
 *  B.4, SDHUFFDW is B.2, BMSIZE and AGGINST are B.1, and the export run is
 *  always B.1 whatever the flags say. */
const DEFAULT_TABLES = {
  dh: standardTable(4), dw: standardTable(2),
  size: standardTable(1), ai: standardTable(1), ex: standardTable(1),
  rdx: standardTable(15), rdy: standardTable(15),
};

const rows = (bm: Bitmap): string[] => {
  const o: string[] = [];
  for (let y = 0; y < bm.height; y++) o.push(Array.from(bm.data.subarray(y * bm.width, (y + 1) * bm.width)).join(''));
  return o;
};

/** Pack a bitmap the way §6.5.9's uncompressed collective bitmap is stored:
 *  MSB-first with each ROW padded to a byte — not the bitmap as a whole. */
function packRows(pixels: string[]): Uint8Array {
  const width = pixels[0].length, rowBytes = (width + 7) >> 3;
  const out = new Uint8Array(rowBytes * pixels.length);
  for (let y = 0; y < pixels.length; y++) {
    for (let x = 0; x < width; x++) if (pixels[y][x] === '1') out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return out;
}

/** Write one height class: its DH delta, its symbol widths, the OOB that ends
 *  it, then BMSIZE and the collective bitmap. `bmSize` of 0 stores the bitmap
 *  uncompressed. */
function heightClass(w: BitWriter, dh: number, widths: number[], collective: string[], mmr: boolean): void {
  encodeValue(w, DEFAULT_TABLES.dh, dh);
  let prev = 0;
  for (const width of widths) { encodeValue(w, DEFAULT_TABLES.dw, width - prev); prev = width; }
  encodeValue(w, DEFAULT_TABLES.dw, null); // OOB ends the height class
  const data = mmr
    ? encodeG4(collective.map((r) => r.split('').map((c) => (c === '1' ? 1 : 0))), { eofb: true })
    : packRows(collective);
  encodeValue(w, DEFAULT_TABLES.size, mmr ? data.length : 0);
  w.align();
  w.bytes(data);
}

/** The export run that keeps every new symbol: skip 0, then export all. */
function exportAll(w: BitWriter, count: number): void {
  encodeValue(w, DEFAULT_TABLES.ex, 0);
  encodeValue(w, DEFAULT_TABLES.ex, count);
}

const decode = (bytes: Uint8Array, numNewSyms: number): Bitmap[] =>
  decodeSymbolDict(bytes, 0, bytes.length, {
    huffman: true, refAgg: false, template: 0, at: [],
    numExSyms: numNewSyms, numNewSyms, inputSymbols: [], rTemplate: 0, rAt: [],
    tables: DEFAULT_TABLES,
  });

describe('jbig2 Huffman symbol dictionary', () => {
  // FIXTURE 1: BMSIZE == 0, the uncompressed collective bitmap. No compression
  // anywhere, so this pins the height-class walk, the align and the slicing
  // with nothing else in the way.
  it('slices an uncompressed collective bitmap into its symbols', () => {
    // One class of height 3, two symbols 2 and 3 wide: a 5-wide collective.
    const w = new BitWriter();
    heightClass(w, 3, [2, 3], ['11010', '10111', '11010'], false);
    exportAll(w, 2);
    const syms = decode(w.toBytes(), 2);

    expect(syms.map((s) => [s.width, s.height])).toEqual([[2, 3], [3, 3]]);
    expect(rows(syms[0])).toEqual(['11', '10', '11']);
    expect(rows(syms[1])).toEqual(['010', '111', '010']);
  });

  // FIXTURE 2: an MMR collective bitmap, assembled with the G4 encoder that
  // test/ccitt-encode.test.ts already pins against golden bit strings — so no
  // second reading of T.6 for this.
  it('decodes an MMR collective bitmap', () => {
    const w = new BitWriter();
    heightClass(w, 4, [3, 3], ['111000', '100100', '100100', '111000'], true);
    exportAll(w, 2);
    const syms = decode(w.toBytes(), 2);

    expect(syms.map((s) => [s.width, s.height])).toEqual([[3, 4], [3, 4]]);
    expect(rows(syms[0])).toEqual(['111', '100', '100', '111']);
    expect(rows(syms[1])).toEqual(['000', '100', '100', '000']);
  });

  // FIXTURE 3: two height classes with DIFFERENT symbol counts and widths. A
  // single class of one symbol cannot tell correct slicing from "the whole
  // collective bitmap is the symbol", and equal widths cannot tell correct
  // slicing from equal shares.
  it('walks more than one height class, each with its own bitmap', () => {
    const w = new BitWriter();
    // Class 1: height 2, widths 1 and 4 — a 5-wide collective over 2 rows.
    heightClass(w, 2, [1, 4], ['10110', '11001'], false);
    // Class 2: height 3 (DH delta 1), widths 2, 2 and 3 — 7 wide over 3 rows.
    heightClass(w, 1, [2, 2, 3], ['1100110', '0011001', '1110001'], false);
    exportAll(w, 5);
    const syms = decode(w.toBytes(), 5);

    expect(syms.map((s) => [s.width, s.height])).toEqual([[1, 2], [4, 2], [2, 3], [2, 3], [3, 3]]);
    expect(rows(syms[0])).toEqual(['1', '1']);
    expect(rows(syms[1])).toEqual(['0110', '1001']);
    expect(rows(syms[2])).toEqual(['11', '00', '11']);
    expect(rows(syms[3])).toEqual(['00', '11', '10']);
    expect(rows(syms[4])).toEqual(['110', '001', '001']);
  });

  // BMSIZE is the FILE's claim about how many bytes the collective bitmap
  // occupies, and it is what says where the next height class begins — NOT what
  // the MMR decoder happened to consume. The two agree on everything our own
  // encoder produces, so this fixture pads deliberately: measured, with an
  // unpadded fixture a build that advances by MMR's own count passes, and
  // fixture 2 above therefore cannot fence this rule at all.
  it('advances by BMSIZE rather than by what MMR consumed', () => {
    const collective = ['111000', '100100', '100100', '111000'];
    const mmr = encodeG4(collective.map((r) => r.split('').map((c) => (c === '1' ? 1 : 0))), { eofb: true });
    const padded = new Uint8Array(mmr.length + 2); // two bytes of declared slack
    padded.set(mmr, 0);

    const w = new BitWriter();
    encodeValue(w, DEFAULT_TABLES.dh, 4);
    encodeValue(w, DEFAULT_TABLES.dw, 3);
    encodeValue(w, DEFAULT_TABLES.dw, 0);
    encodeValue(w, DEFAULT_TABLES.dw, null);
    encodeValue(w, DEFAULT_TABLES.size, padded.length);
    w.align();
    w.bytes(padded);
    // The export run sits AFTER the padding, so a decoder that resumed at the
    // end of the MMR data would read it out of the slack bytes.
    exportAll(w, 2);
    const syms = decode(w.toBytes(), 2);

    expect(syms.map((s) => [s.width, s.height])).toEqual([[3, 4], [3, 4]]);
    expect(rows(syms[0])).toEqual(['111', '100', '100', '111']);
  });

  // The export run is ALWAYS Table B.1 (§6.5.10) — it has no selector, unlike
  // the four fields that do, so it is the one easiest to give one by mistake.
  it('exports a subset through the run-length flags', () => {
    const w = new BitWriter();
    heightClass(w, 3, [2, 3], ['11010', '10111', '11010'], false);
    encodeValue(w, standardTable(1), 1); // skip the first
    encodeValue(w, standardTable(1), 1); // export the second
    const syms = decode(w.toBytes(), 2);
    expect(syms.map((s) => [s.width, s.height])).toEqual([[3, 3]]);
  });

  it('refuses a collective bitmap that runs past the end of the segment', () => {
    const w = new BitWriter();
    encodeValue(w, DEFAULT_TABLES.dh, 3);
    encodeValue(w, DEFAULT_TABLES.dw, 40);
    encodeValue(w, DEFAULT_TABLES.dw, null);
    encodeValue(w, DEFAULT_TABLES.size, 0); // uncompressed, 3 rows of 5 bytes
    w.align();
    const bytes = w.toBytes(); // ...and no bitmap data at all follows
    expect(() => decode(bytes, 1)).toThrow(/past end of segment/);
  });
});

// ---------------------------------------------------------------------------
// End to end, through decodeJbig2's segment loop — the only thing that
// exercises table SELECTION, which lives in jbig2.ts and which the unit tests
// above bypass by handing `tables` in directly.
// ---------------------------------------------------------------------------

const u32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

/** A segment header (short form, no referred-to segments). */
function segment(num: number, type: number, referred: number[], body: number[]): number[] {
  return [
    ...u32(num), type & 0x3f, (referred.length << 5) & 0xff, ...referred.map((r) => r & 0xff),
    0x01, ...u32(body.length), ...body,
  ];
}

describe('jbig2 Huffman symbol dictionary end to end', () => {
  /** A type-0 segment whose flags say SDHUFF with the default selectors. */
  function dictSegment(flags: number, payload: Uint8Array): Uint8Array {
    const body = [
      (flags >> 8) & 0xff, flags & 0xff,
      ...u32(2), ...u32(2), // SDNUMEXSYMS, SDNUMNEWSYMS
      ...payload,
    ];
    return Uint8Array.from(segment(0, 0, [], body));
  }

  const payload = (): Uint8Array => {
    const w = new BitWriter();
    heightClass(w, 3, [2, 3], ['11010', '10111', '11010'], false);
    exportAll(w, 2);
    return w.toBytes();
  };

  it('resolves its tables from the flag word and decodes', () => {
    // SDHUFF set, every selector 0: DH -> B.4, DW -> B.2, BMSIZE -> B.1,
    // AGGINST -> B.1 — which is what DEFAULT_TABLES spells out by hand above.
    const stream = dictSegment(0x0001, payload());
    // The dictionary contributes no ink of its own, so a blank page means the
    // segment parsed and decoded rather than threw.
    expect(() => decodeJbig2(stream, undefined, 8, 8)).not.toThrow();
  });

  // A two-bit selector's value 2 is RESERVED. Falling through to whichever
  // table happens to be next would decode plausible nonsense.
  it('refuses a reserved table selector', () => {
    const stream = dictSegment(0x0001 | (2 << 2), payload()); // SDHUFFDH = 2
    expect(() => decodeJbig2(stream, undefined, 8, 8)).toThrow(/reserved Huffman table selector/);
  });

  // A selector saying "custom" with no type-53 segment referred to is a header
  // we cannot honour; naming the shortfall beats reading a field with no table.
  it('refuses a custom selector with no table to take', () => {
    const stream = dictSegment(0x0001 | (3 << 2), payload()); // SDHUFFDH = custom
    expect(() => decodeJbig2(stream, undefined, 8, 8)).toThrow(/more custom Huffman tables than it refers to/);
  });
});

// The selector-to-table mapping is another transcription (T.88 §7.4.3.1.2), so
// it is asserted directly rather than only through a decode: a wrong choice
// still produces AN image, and the end-to-end tests above cannot see it —
// measured, swapping the export table for B.4 leaves every one of them green.
describe('jbig2 symbol dictionary table selection', () => {
  const sel = (dh: number, dw: number, bmsize: number, agg: number): number =>
    1 | (dh << 2) | (dw << 4) | (bmsize << 6) | (agg << 7);

  it('maps each selector value to the table T.88 names', () => {
    const a = selectSymbolTables(sel(0, 0, 0, 0), []);
    expect(a.dh).toBe(standardTable(4));
    expect(a.dw).toBe(standardTable(2));
    expect(a.size).toBe(standardTable(1));
    expect(a.ai).toBe(standardTable(1));

    const b = selectSymbolTables(sel(1, 1, 0, 0), []);
    expect(b.dh).toBe(standardTable(5));
    expect(b.dw).toBe(standardTable(3));
  });

  // Neither has a selector, so neither can be got right by reading the flags —
  // they are simply what §6.5.10 and §6.5.8.2.2 fix them to be.
  it('always uses B.1 for the export run and B.15 for the refinement deltas', () => {
    for (const flags of [sel(0, 0, 0, 0), sel(1, 1, 1, 1)]) {
      const t = selectSymbolTables(flags, [standardTable(9), standardTable(9)]);
      expect(t.ex).toBe(standardTable(1));
      expect(t.rdx).toBe(standardTable(15));
      expect(t.rdy).toBe(standardTable(15));
    }
  });

  // Custom tables are consumed in REFERRED-TO order, one per selector that says
  // "custom", walked in field order DH -> DW -> BMSIZE -> AGGINST.
  it('takes custom tables in referred-to order', () => {
    const first = standardTable(9), second = standardTable(10);
    const t = selectSymbolTables(sel(3, 0, 1, 0), [first, second]);
    expect(t.dh).toBe(first);   // SDHUFFDH is custom, so it takes the first
    expect(t.dw).toBe(standardTable(2));
    expect(t.size).toBe(second); // SDHUFFBMSIZE is custom, so it takes the next
  });
});

// ---------------------------------------------------------------------------
// A Huffman dictionary with SDREFAGG, at REFAGGNINST > 1 (T.88 §6.5.8.2.1):
// the symbol is a Huffman-coded TEXT region over the dictionary's current
// symbols, whose parameters Table 17 fixes outright — FS through B.6, DS
// through B.8, DT through B.11, symbol IDs as symCodeLen RAW BITS.
//
// It needs no arithmetic data at all, which is what makes it buildable here:
// every instance carries an RI flag and RI == 0 means no refinement, so a
// fixture whose instances are all unrefined is pure Huffman end to end.
// ---------------------------------------------------------------------------

describe('jbig2 Huffman symbol dictionary with an aggregate symbol', () => {
  const BOX = { width: 4, height: 4, data: Uint8Array.from([1,1,1,1, 1,0,0,1, 1,0,0,1, 1,1,1,1]) };
  const SOLID = { width: 4, height: 4, data: new Uint8Array(16).fill(1) };

  it('decodes an aggregate of two existing symbols', () => {
    const w = new BitWriter();
    encodeValue(w, standardTable(4), 4);  // SDHUFFDH: height class 4
    encodeValue(w, standardTable(2), 8);  // SDHUFFDW: the new symbol is 8 wide
    encodeValue(w, standardTable(1), 2);  // SDHUFFAGGINST: two instances

    // The aggregate text region, read from this same bit stream.
    encodeValue(w, standardTable(11), 1); // initial DT -> STRIPT = -1
    encodeValue(w, standardTable(11), 1); // strip DT   -> STRIPT = 0
    encodeValue(w, standardTable(6), 0);  // FS -> first S = 0
    w.write(0, 2); w.bit(0);              // ID 0 (2 raw bits), RI 0 (1 raw bit)
    encodeValue(w, standardTable(8), 1);  // DS: CURS 3 -> 4, so the next lands at x=4
    w.write(1, 2); w.bit(0);              // ID 1, RI 0

    encodeValue(w, standardTable(2), null); // OOB ends the height class
    // The export runs walk input + new, so skipping the two inputs is what
    // leaves only the aggregate — `exportAll` is for a dictionary with none.
    encodeValue(w, DEFAULT_TABLES.ex, 2);
    encodeValue(w, DEFAULT_TABLES.ex, 1);

    const bytes = w.toBytes();
    const syms = decodeSymbolDict(bytes, 0, bytes.length, {
      huffman: true, refAgg: true, template: 0, at: [],
      numExSyms: 1, numNewSyms: 1, inputSymbols: [BOX, SOLID],
      rTemplate: 0, rAt: [{ x: -1, y: -1 }, { x: -1, y: -1 }],
      tables: DEFAULT_TABLES,
    });

    expect(syms.map((s) => [s.width, s.height])).toEqual([[8, 4]]);
    // The box on the left, the solid block on the right — so the aggregate is
    // visibly TWO placements rather than one symbol drawn twice.
    expect(rows(syms[0])).toEqual(['11111111', '10011111', '10011111', '11111111']);
  });
});
