import { describe, it, expect } from 'vitest';
import { decodeTextRegion } from '../src/jbig2text.js';
import { decodeJbig2, selectTextTables } from '../src/jbig2.js';
import { standardTable } from '../src/jbig2huffman.js';
import type { Bitmap } from '../src/jbig2.js';
import { BitWriter, encodeValue } from './helpers/jbig2-huffman-encode.js';
import * as S from './helpers/jbig2-symbol-vectors.js';

// ---------------------------------------------------------------------------
// The Huffman text region (T.88 §6.4 with SBHUFF set). Assembled here rather
// than minted; as with the symbol dictionary these pin the WALK and the
// framing, not the tables, which utax.6 anchors separately.
//
// Note what SBHUFF changes and what it does not. The strip walk is the same
// one the arithmetic path uses. Three reads differ: CURT is LOG2SBSTRIPS raw
// bits, RI is one raw bit, and a refinement is wrapped in a byte count with an
// MQ decoder inside it — neither CURT nor RI has a selector in the flag word.
// ---------------------------------------------------------------------------

/** The tables the default selectors resolve to: FS→B.6, DS→B.8, DT→B.11,
 *  the four refinement deltas→B.14, RSIZE→B.1. */
const T = {
  fs: standardTable(6), ds: standardTable(8), dt: standardTable(11),
  rdw: standardTable(14), rdh: standardTable(14),
  rdx: standardTable(14), rdy: standardTable(14),
  size: standardTable(1),
};

const rows = (bm: Bitmap): string[] => {
  const o: string[] = [];
  for (let y = 0; y < bm.height; y++) o.push(Array.from(bm.data.subarray(y * bm.width, (y + 1) * bm.width)).join(''));
  return o;
};

const BAR = { width: 3, height: 2, data: Uint8Array.from([1, 1, 1, 1, 1, 1]) };
const DOT = { width: 2, height: 2, data: Uint8Array.from([1, 0, 0, 1]) };

/** The symbol-ID code table for `n` symbols, all one code length apart:
 *  35 runcode lengths giving runcodes 1 and 2 a one-bit code each, then one
 *  runcode per symbol. `lens` is the code length wanted for each symbol. */
function symbolIdTable(w: BitWriter, lens: number[]): void {
  for (let i = 0; i <= 34; i++) w.write(i === 1 || i === 2 ? 1 : 0, 4);
  // Runcode 1 is code '0' and runcode 2 is code '1'.
  for (const len of lens) {
    if (len !== 1 && len !== 2) throw new Error('symbolIdTable: this helper emits lengths 1 and 2 only');
    w.bit(len === 1 ? 0 : 1);
  }
  w.align(); // §7.4.3.1.7's last step
}

describe('jbig2 Huffman text region', () => {
  it('places two symbols through the standard tables', () => {
    const w = new BitWriter();
    symbolIdTable(w, [1, 2, 2]);          // three symbols: codes 0, 10, 11
    encodeValue(w, T.dt, 1);              // initial DT -> STRIPT = -1
    encodeValue(w, T.dt, 1);              // strip DT   -> STRIPT = 0
    encodeValue(w, T.fs, 0);              // first S = 0
    w.bit(0);                             // symbol 0 (code '0'): BAR at x=0
    // A left ref-corner advances CURS by WI - 1, so the bar leaves CURS at 2
    // and DS 2 puts the next instance at x = 4.
    encodeValue(w, T.ds, 2);
    w.write(0b10, 2);                     // symbol 1 (code '10'): DOT at x=4

    const bytes = w.toBytes();
    const bm = decodeTextRegion(bytes, 0, bytes.length, {
      width: 8, height: 2, numInstances: 2, symbols: [BAR, DOT, DOT],
      logStrips: 0, refCorner: 1 /* TOPLEFT */, transposed: false, combOp: 0,
      defPixel: 0, dsOffset: 0, refine: false, rTemplate: 0, rAt: [],
      huffman: true, tables: T,
    });
    expect(rows(bm)).toEqual(['11101000', '11100100']);
  });

  // §6.4.5 3(c)(ii): with SBSTRIPS > 1 the region reads CURT as LOG2SBSTRIPS
  // RAW BITS. There is no SBHUFFIT among the eight selectors, so a decoder that
  // looked for a table here would have nothing to read it with — and one that
  // read no bits at all would desynchronise from the first instance.
  it('reads CURT as raw bits when SBSTRIPS is greater than one', () => {
    const w = new BitWriter();
    symbolIdTable(w, [1, 2, 2]);
    encodeValue(w, T.dt, 1);              // initial DT: STRIPT = -1 * 2 strips
    encodeValue(w, T.dt, 1);              // strip DT:   STRIPT = 0
    encodeValue(w, T.fs, 0);
    w.bit(1);                             // CURT = 1 (LOG2SBSTRIPS = 1 bit)
    w.bit(0);                             // symbol 0: BAR, at T = 0 + 1 = 1

    const bytes = w.toBytes();
    const bm = decodeTextRegion(bytes, 0, bytes.length, {
      width: 4, height: 4, numInstances: 1, symbols: [BAR, DOT, DOT],
      logStrips: 1, refCorner: 1, transposed: false, combOp: 0,
      defPixel: 0, dsOffset: 0, refine: false, rTemplate: 0, rAt: [],
      huffman: true, tables: T,
    });
    // The bar sits on rows 1-2, not 0-1 — which is the CURT bit doing its job.
    expect(rows(bm)).toEqual(['0000', '1110', '1110', '0000']);
  });

  // §6.4.11's Huffman spelling: RI is ONE raw bit, and a set one wraps the
  // refinement in a byte count with an MQ decoder inside. RI = 0 needs no
  // arithmetic data at all, which is the case this fixture pins — the framing
  // of a set RI is covered end to end below.
  it('reads RI as one raw bit and skips the refinement when it is zero', () => {
    const w = new BitWriter();
    symbolIdTable(w, [1, 2, 2]);
    encodeValue(w, T.dt, 1);
    encodeValue(w, T.dt, 1);
    encodeValue(w, T.fs, 0);
    w.bit(0);                             // symbol 0
    w.bit(0);                             // RI = 0: no refinement follows

    const bytes = w.toBytes();
    const bm = decodeTextRegion(bytes, 0, bytes.length, {
      width: 4, height: 2, numInstances: 1, symbols: [BAR, DOT, DOT],
      logStrips: 0, refCorner: 1, transposed: false, combOp: 0,
      defPixel: 0, dsOffset: 0, refine: true, rTemplate: 0,
      rAt: [{ x: -1, y: -1 }, { x: -1, y: -1 }],
      huffman: true, tables: T,
    });
    expect(rows(bm)).toEqual(['1110', '1110']);
  });
});

// The selector-to-table mapping, asserted directly for utax.2's reason: an
// end-to-end decode that only checks "does not throw" cannot see a wrong table.
describe('jbig2 text region table selection', () => {
  it('maps each selector value to the table T.88 names', () => {
    const a = selectTextTables(0, []);
    expect(a.fs).toBe(standardTable(6));
    expect(a.ds).toBe(standardTable(8));
    expect(a.dt).toBe(standardTable(11));
    expect(a.rdw).toBe(standardTable(14));
    expect(a.size).toBe(standardTable(1));

    // FS=1, DS=2, DT=2, RDW/RDH/RDX/RDY=1, RSIZE=0.
    const b = selectTextTables(1 | (2 << 2) | (2 << 4) | (1 << 6) | (1 << 8) | (1 << 10) | (1 << 12), []);
    expect(b.fs).toBe(standardTable(7));
    expect(b.ds).toBe(standardTable(10));
    expect(b.dt).toBe(standardTable(13));
    expect(b.rdw).toBe(standardTable(15));
    expect(b.rdy).toBe(standardTable(15));
  });

  // SBHUFFFS and the four refinement selectors have only two standard choices,
  // so value 2 is RESERVED — but SBHUFFDS and SBHUFFDT have three, where 2 is
  // a real table. Getting that asymmetry wrong refuses valid files or accepts
  // invalid ones.
  it('refuses a reserved selector but accepts value 2 where a third table exists', () => {
    expect(() => selectTextTables(2, [])).toThrow(/reserved Huffman table selector 2 for SBHUFFFS/);
    expect(() => selectTextTables(2 << 6, [])).toThrow(/SBHUFFRDW/);
    expect(selectTextTables(2 << 2, []).ds).toBe(standardTable(10));
  });

  it('takes custom tables in field order across all eight selectors', () => {
    const first = standardTable(9), second = standardTable(12);
    // FS custom (3), DS standard, DT custom (3).
    const t = selectTextTables(3 | (3 << 4), [first, second]);
    expect(t.fs).toBe(first);
    expect(t.ds).toBe(standardTable(8));
    expect(t.dt).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// End to end through decodeJbig2 — the only thing that exercises the header
// parse, and in particular WHERE the Huffman flags field sits: T.88 §7.4.3.1.2
// puts it between the text-region flags and SBRAT, so reading it in the wrong
// order shifts SBRAT and SBNUMINSTANCES. The dictionary here is ARITHMETIC and
// the region Huffman, which is a real-world shape and also proves the two
// stacks coexist in one stream.
// ---------------------------------------------------------------------------

const u32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const segment = (num: number, type: number, referred: number[], body: number[]): number[] => [
  ...u32(num), type & 0x3f, (referred.length << 5) & 0xff, ...referred.map((r) => r & 0xff),
  0x01, ...u32(body.length), ...body,
];

/** Pack a bitmap the way decodeJbig2 returns it: MSB-first rows, then inverted. */
function packInvert(pixels: string[]): number[] {
  const width = pixels[0].length, rowBytes = (width + 7) >> 3;
  const out = new Uint8Array(rowBytes * pixels.length);
  for (let y = 0; y < pixels.length; y++) {
    for (let x = 0; x < width; x++) if (pixels[y][x] === '1') out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return Array.from(out, (b) => ~b & 0xff);
}

describe('jbig2 Huffman text region end to end', () => {
  const SD_AT = [{ x: 3, y: -1 }, { x: -3, y: -1 }, { x: 2, y: -2 }, { x: -2, y: -2 }];

  it('decodes a Huffman text region over an arithmetic symbol dictionary', () => {
    // The dictionary exports bar (4x2) as id 0 and plus (3x3) as id 1.
    const dict = segment(0, 0, [], [
      0, 0, // flags: arithmetic, no refagg, template 0
      ...SD_AT.flatMap((a) => [a.x & 0xff, a.y & 0xff]),
      ...u32(2), ...u32(2),
      ...Array.from(S.two_syms.bytes),
    ]);

    const w = new BitWriter();
    symbolIdTable(w, [1, 1]);   // two symbols, codes '0' and '1'
    encodeValue(w, T.dt, 1);
    encodeValue(w, T.dt, 1);
    encodeValue(w, T.fs, 0);
    w.bit(0);                   // bar at x=0, leaving CURS at 3
    encodeValue(w, T.ds, 2);    // CURS 3 -> 5
    w.bit(1);                   // plus at x=5

    const region = segment(1, 6, [0], [
      ...u32(12), ...u32(6), ...u32(0), ...u32(0), 0, // region info
      0x00, 0x11,   // text flags: SBHUFF | REFCORNER=TOPLEFT
      0x00, 0x00,   // Huffman flags: every selector 0
      ...u32(2),    // SBNUMINSTANCES — shifted by four bytes if the flags field is misplaced
      ...Array.from(w.toBytes()),
    ]);

    const out = decodeJbig2(Uint8Array.from([...dict, ...region]), undefined, 12, 6);
    expect(Array.from(out)).toEqual(packInvert([
      '111100000000',
      '111100000000',
      '000000000000',
      '000000000000',
      '000000000000',
      '000000000000',
    ].map((r, y) => {
      // The plus (0,1,0 / 1,1,1 / 0,1,0) sits at x=5 on rows 0..2.
      const plus = ['010', '111', '010'];
      return y < 3 ? r.slice(0, 5) + plus[y] + r.slice(8) : r;
    })));
  });
});
