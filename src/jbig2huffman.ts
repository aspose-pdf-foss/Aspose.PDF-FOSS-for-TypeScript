// JBIG2 Huffman coding — ITU-T T.88 Annex B: the bit reader, the table model
// and B.3's canonical code assignment, the fifteen standard tables B.1-B.15,
// and custom-table segment 53 (§B.2.3).
//
// The most isolated module in the JBIG2 stack: it imports `errors.js` and
// nothing else, because it deals in numbers rather than bitmaps. Its consumers
// reach it through `jbig2ints.ts`'s `IntSource` seam rather than directly, with
// one exception — `parseSymbolIdTable` below, which a Huffman text region calls
// to build the table its own IDs are read through.
import { PdfParseError } from './errors.js';

/** MSB-first bit reader over a byte range, with an explicit `align()`.
 *
 *  Reading past `end` yields zero bits rather than throwing: a truncated
 *  Huffman stream is a damaged file, and deciding that belongs to the caller —
 *  the same division `lexer.ts` records for the four grammars that share it.
 *  `atEnd()` is how a caller finds out. */
export class HuffmanReader {
  private pos: number;
  constructor(private readonly data: Uint8Array, start: number, private readonly end: number) {
    this.pos = start * 8;
  }

  bit(): number {
    const byte = this.pos >> 3;
    if (byte >= this.end) { this.pos++; return 0; }
    const b = (this.data[byte] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return b;
  }

  /** Read `n` bits, MSB first. Accumulated by multiplication, never `<< 1`:
   *  a 32-bit range value does not fit in a signed int and the shift silently
   *  wraps to negative at bit 32. */
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }

  /** Advance to the next byte boundary. A no-op when already on one — skipping
   *  a byte there would lose the first byte of a collective bitmap. */
  align(): void { if (this.pos & 7) this.pos = (this.pos & ~7) + 8; }

  /** The current position as a byte offset into the underlying array. */
  bytePos(): number { return this.pos >> 3; }

  /** Resume reading at an absolute byte offset. This is how a caller steps over
   *  a byte-COUNTED payload the reader did not itself read — a symbol
   *  dictionary's collective bitmap (§6.5.9) or a text region's refinement
   *  (§6.4.11) — where the count in the file, not what the inner decoder
   *  consumed, is what says where Huffman reading resumes. */
  seekByte(byteOffset: number): void { this.pos = byteOffset * 8; }

  atEnd(): boolean { return (this.pos >> 3) >= this.end; }
}

/** T.88 B.1's four line kinds. They are not interchangeable, and the one that
 *  hides is `Lower`: it is spelled exactly like `Upper` but for the sign, so
 *  adding instead of subtracting yields a large positive value where a large
 *  negative one was meant — a text-region symbol far off the page rather than
 *  an error. */
export const enum HuffmanLineKind { Normal = 0, Lower = 1, Upper = 2, OutOfBand = 3 }

export interface HuffmanLine {
  prefixLen: number;
  rangeLen: number;
  rangeLow: number;
  kind: HuffmanLineKind;
  /** Assigned by `assignPrefixCodes`; -1 until then, and permanently for a
   *  line whose `prefixLen` is 0. */
  code: number;
  /** The code T.88 Annex B PRINTS for this line, on the standard tables only.
   *  Unused at runtime — the assignment computes the code — and present solely
   *  so `test/jbig2-huffman.test.ts` can assert the two agree. That equality is
   *  the only outside check available on ~150 rows of hand-copied numbers, so
   *  do not "clean this up". */
  printedCode?: number;
}

/** T.88 B.3, the canonical assignment: codes ascend within a length, and each
 *  length starts at `(previous first code + previous count) * 2`. Within one
 *  length the order is the TABLE's, which is why the standard tables are
 *  transcribed in T.88's own line order.
 *
 *  A line with `prefixLen === 0` is unused and takes no code. No standard table
 *  has one; a custom table routinely does, because §B.2.3 writes a length for
 *  every range whether the encoder used it or not — and counting them shifts
 *  every later code by one, which decodes a different line rather than
 *  failing. */
export function assignPrefixCodes(lines: HuffmanLine[]): void {
  let maxLen = 0;
  for (const l of lines) if (l.prefixLen > maxLen) maxLen = l.prefixLen;
  const lenCount = new Array<number>(maxLen + 1).fill(0);
  for (const l of lines) if (l.prefixLen > 0) lenCount[l.prefixLen]++;
  lenCount[0] = 0;
  let firstCode = 0;
  for (let curLen = 1; curLen <= maxLen; curLen++) {
    firstCode = (firstCode + lenCount[curLen - 1]) * 2;
    let curCode = firstCode;
    for (const l of lines) if (l.prefixLen === curLen) l.code = curCode++;
  }
  for (const l of lines) if (l.prefixLen === 0) l.code = -1;
}

export class HuffmanTable {
  constructor(readonly lines: readonly HuffmanLine[]) {}

  /** Decode one value (T.88 B.4). `null` is OOB, which only a table carrying an
   *  OOB line can return — the same out-of-band `decodeInt` returns, so the two
   *  entropy paths agree about what "no value" looks like. */
  decode(r: HuffmanReader): number | null {
    let len = 0, code = 0;
    // Bounded by the longest code in the table: past that no line can match and
    // the stream is damaged. Without the bound a truncated stream spins on the
    // reader's zero bits.
    let maxLen = 0;
    for (const l of this.lines) if (l.prefixLen > maxLen) maxLen = l.prefixLen;
    while (len < maxLen) {
      code = code * 2 + r.bit();
      len++;
      for (const l of this.lines) {
        if (l.prefixLen !== len || l.code !== code) continue;
        if (l.kind === HuffmanLineKind.OutOfBand) return null;
        if (l.kind === HuffmanLineKind.Lower) return l.rangeLow - r.bits(32);
        if (l.kind === HuffmanLineKind.Upper) return l.rangeLow + r.bits(32);
        return l.rangeLow + r.bits(l.rangeLen);
      }
    }
    throw new PdfParseError(`JBIG2: no Huffman code matches ${len} bits`);
  }
}

// ---------------------------------------------------------------------------
// The fifteen standard tables (T.88 Annex B, Tables B.1-B.15).
//
// Each row is [rangeLow, prefixLen, rangeLen, printedCode] plus a kind. The
// PRINTED CODE is transcribed as its own column, separately from the lengths,
// and is asserted against B.3's assignment in test/jbig2-huffman.test.ts. That
// equality is the only outside check available on ~150 rows of hand-copied
// numbers: a typo in a prefixLen changes the computed code and no longer
// matches the printed one, and a wrong assignment breaks all fifteen at once.
// Two structural properties back it up because they see columns the codes
// cannot — Kraft equality and range contiguity — and the tests prove none of
// the three subsumes another.
//
// The line ORDER is T.88's own, and is part of the answer: B.3 assigns within a
// length in table order.
// ---------------------------------------------------------------------------

type Row = readonly [rangeLow: number, prefixLen: number, rangeLen: number, printedCode: number, kind?: 'lower' | 'upper' | 'oob'];

const STANDARD_ROWS: readonly (readonly Row[])[] = [
  // B.1 — 0..inf, no OOB, no lower range.
  [
    [0, 1, 4, 0x0],
    [16, 2, 8, 0x2],
    [272, 3, 16, 0x6],
    [65808, 3, 32, 0x7, 'upper'],
  ],
  // B.2 — 0..inf with OOB.
  [
    [0, 1, 0, 0x0],
    [1, 2, 0, 0x2],
    [2, 3, 0, 0x6],
    [3, 4, 3, 0xe],
    [11, 5, 6, 0x1e],
    [75, 6, 32, 0x3e, 'upper'],
    [0, 6, 0, 0x3f, 'oob'],
  ],
  // B.3 — B.2 extended downward, with OOB.
  [
    [-256, 8, 8, 0xfe],
    [0, 1, 0, 0x0],
    [1, 2, 0, 0x2],
    [2, 3, 0, 0x6],
    [3, 4, 3, 0xe],
    [11, 5, 6, 0x1e],
    [-257, 8, 32, 0xff, 'lower'],
    [75, 7, 32, 0x7e, 'upper'],
    [0, 6, 0, 0x3e, 'oob'],
  ],
  // B.4 — 1..inf, no OOB.
  [
    [1, 1, 0, 0x0],
    [2, 2, 0, 0x2],
    [3, 3, 0, 0x6],
    [4, 4, 3, 0xe],
    [12, 5, 6, 0x1e],
    [76, 5, 32, 0x1f, 'upper'],
  ],
  // B.5 — B.4 extended downward, no OOB.
  [
    [-255, 7, 8, 0x7e],
    [1, 1, 0, 0x0],
    [2, 2, 0, 0x2],
    [3, 3, 0, 0x6],
    [4, 4, 3, 0xe],
    [12, 5, 6, 0x1e],
    [-256, 7, 32, 0x7f, 'lower'],
    [76, 6, 32, 0x3e, 'upper'],
  ],
  // B.6
  [
    [-2048, 5, 10, 0x1c],
    [-1024, 4, 9, 0x8],
    [-512, 4, 8, 0x9],
    [-256, 4, 7, 0xa],
    [-128, 5, 6, 0x1d],
    [-64, 5, 5, 0x1e],
    [-32, 4, 5, 0xb],
    [0, 2, 7, 0x0],
    [128, 3, 7, 0x2],
    [256, 3, 8, 0x3],
    [512, 4, 9, 0xc],
    [1024, 4, 10, 0xd],
    [-2049, 6, 32, 0x3e, 'lower'],
    [2048, 6, 32, 0x3f, 'upper'],
  ],
  // B.7
  [
    [-1024, 4, 9, 0x8],
    [-512, 3, 8, 0x0],
    [-256, 4, 7, 0x9],
    [-128, 5, 6, 0x1a],
    [-64, 5, 5, 0x1b],
    [-32, 4, 5, 0xa],
    [0, 4, 5, 0xb],
    [32, 5, 5, 0x1c],
    [64, 5, 6, 0x1d],
    [128, 4, 7, 0xc],
    [256, 3, 8, 0x1],
    [512, 3, 9, 0x2],
    [1024, 3, 10, 0x3],
    [-1025, 5, 32, 0x1e, 'lower'],
    [2048, 5, 32, 0x1f, 'upper'],
  ],
  // B.8
  [
    [-15, 8, 3, 0xfc],
    [-7, 9, 1, 0x1fc],
    [-5, 8, 1, 0xfd],
    [-3, 9, 0, 0x1fd],
    [-2, 7, 0, 0x7c],
    [-1, 4, 0, 0xa],
    [0, 2, 1, 0x0],
    [2, 5, 0, 0x1a],
    [3, 6, 0, 0x3a],
    [4, 3, 4, 0x4],
    [20, 6, 1, 0x3b],
    [22, 4, 4, 0xb],
    [38, 4, 5, 0xc],
    [70, 5, 6, 0x1b],
    [134, 5, 7, 0x1c],
    [262, 6, 7, 0x3c],
    [390, 7, 8, 0x7d],
    [646, 6, 10, 0x3d],
    [-16, 9, 32, 0x1fe, 'lower'],
    [1670, 9, 32, 0x1ff, 'upper'],
    [0, 2, 0, 0x1, 'oob'],
  ],
  // B.9
  [
    [-31, 8, 4, 0xfc],
    [-15, 9, 2, 0x1fc],
    [-11, 8, 2, 0xfd],
    [-7, 9, 1, 0x1fd],
    [-5, 7, 1, 0x7c],
    [-3, 4, 1, 0xa],
    [-1, 3, 1, 0x2],
    [1, 3, 1, 0x3],
    [3, 5, 1, 0x1a],
    [5, 6, 1, 0x3a],
    [7, 3, 5, 0x4],
    [39, 6, 2, 0x3b],
    [43, 4, 5, 0xb],
    [75, 4, 6, 0xc],
    [139, 5, 7, 0x1b],
    [267, 5, 8, 0x1c],
    [523, 6, 8, 0x3c],
    [779, 7, 9, 0x7d],
    [1291, 6, 11, 0x3d],
    [-32, 9, 32, 0x1fe, 'lower'],
    [3339, 9, 32, 0x1ff, 'upper'],
    [0, 2, 0, 0x0, 'oob'],
  ],
  // B.10
  [
    [-21, 7, 4, 0x7a],
    [-5, 8, 0, 0xfc],
    [-4, 7, 0, 0x7b],
    [-3, 5, 0, 0x18],
    [-2, 2, 2, 0x0],
    [2, 5, 0, 0x19],
    [3, 6, 0, 0x36],
    [4, 7, 0, 0x7c],
    [5, 8, 0, 0xfd],
    [6, 2, 6, 0x1],
    [70, 5, 5, 0x1a],
    [102, 6, 5, 0x37],
    [134, 6, 6, 0x38],
    [198, 6, 7, 0x39],
    [326, 6, 8, 0x3a],
    [582, 6, 9, 0x3b],
    [1094, 6, 10, 0x3c],
    [2118, 7, 11, 0x7d],
    [-22, 8, 32, 0xfe, 'lower'],
    [4166, 8, 32, 0xff, 'upper'],
    [0, 2, 0, 0x2, 'oob'],
  ],
  // B.11
  [
    [1, 1, 0, 0x0],
    [2, 2, 1, 0x2],
    [4, 4, 0, 0xc],
    [5, 4, 1, 0xd],
    [7, 5, 1, 0x1c],
    [9, 5, 2, 0x1d],
    [13, 6, 2, 0x3c],
    [17, 7, 2, 0x7a],
    [21, 7, 3, 0x7b],
    [29, 7, 4, 0x7c],
    [45, 7, 5, 0x7d],
    [77, 7, 6, 0x7e],
    [141, 7, 32, 0x7f, 'upper'],
  ],
  // B.12
  [
    [1, 1, 0, 0x0],
    [2, 2, 0, 0x2],
    [3, 3, 1, 0x6],
    [5, 5, 0, 0x1c],
    [6, 5, 1, 0x1d],
    [8, 6, 1, 0x3c],
    [10, 7, 0, 0x7a],
    [11, 7, 1, 0x7b],
    [13, 7, 2, 0x7c],
    [17, 7, 3, 0x7d],
    [25, 7, 4, 0x7e],
    [41, 8, 5, 0xfe],
    [73, 8, 32, 0xff, 'upper'],
  ],
  // B.13
  [
    [1, 1, 0, 0x0],
    [2, 3, 0, 0x4],
    [3, 4, 0, 0xc],
    [4, 5, 0, 0x1c],
    [5, 4, 1, 0xd],
    [7, 3, 3, 0x5],
    [15, 6, 1, 0x3a],
    [17, 6, 2, 0x3b],
    [21, 6, 3, 0x3c],
    [29, 6, 4, 0x3d],
    [45, 6, 5, 0x3e],
    [77, 7, 6, 0x7e],
    [141, 7, 32, 0x7f, 'upper'],
  ],
  // B.14 — the ONE bounded standard table: -2..2, five lines, and NEITHER a
  // lower nor an upper range line. Adding one out of habit breaks Kraft
  // equality, which is what that check is there to catch.
  [
    [-2, 3, 0, 0x4],
    [-1, 3, 0, 0x5],
    [0, 1, 0, 0x0],
    [1, 3, 0, 0x6],
    [2, 3, 0, 0x7],
  ],
  // B.15
  [
    [-24, 7, 4, 0x7c],
    [-8, 6, 2, 0x3c],
    [-4, 5, 1, 0x1c],
    [-2, 4, 0, 0xc],
    [-1, 3, 0, 0x4],
    [0, 1, 0, 0x0],
    [1, 3, 0, 0x5],
    [2, 4, 0, 0xd],
    [3, 5, 1, 0x1d],
    [5, 6, 2, 0x3d],
    [9, 7, 4, 0x7d],
    [-25, 7, 32, 0x7e, 'lower'],
    [25, 7, 32, 0x7f, 'upper'],
  ],
];

const KIND_OF = { lower: HuffmanLineKind.Lower, upper: HuffmanLineKind.Upper, oob: HuffmanLineKind.OutOfBand } as const;

const standardCache = new Array<HuffmanTable | undefined>(STANDARD_ROWS.length);

/** One of the fifteen standard tables, numbered as T.88 numbers them: `1` is
 *  Table B.1. Built once and shared — the lines are immutable after their codes
 *  are assigned. */
export function standardTable(n: number): HuffmanTable {
  const rows = STANDARD_ROWS[n - 1];
  if (rows === undefined) throw new PdfParseError(`JBIG2: no standard Huffman table B.${n}`);
  const cached = standardCache[n - 1];
  if (cached !== undefined) return cached;
  const lines: HuffmanLine[] = rows.map(([rangeLow, prefixLen, rangeLen, printedCode, kind]) => ({
    rangeLow, prefixLen, rangeLen, code: -1, printedCode,
    kind: kind === undefined ? HuffmanLineKind.Normal : KIND_OF[kind],
  }));
  assignPrefixCodes(lines);
  const table = new HuffmanTable(lines);
  standardCache[n - 1] = table;
  return table;
}

/** How many standard tables there are, so the tests can sweep all of them
 *  rather than naming each — a table added later cannot skip the checks. */
export const STANDARD_TABLE_COUNT = STANDARD_ROWS.length;

// A damage guard, not a format limit. The line loop advances by 2^rangeLen and
// so always terminates, but a corrupt HTLOW/HTHIGH pair with rangeLen 0
// throughout would produce four billion one-value lines before it did.
const MAX_CUSTOM_LINES = 1 << 16;

/** Parse a custom Huffman table segment (T.88 §B.2.3, segment type 53).
 *
 *  Note HTPS and HTRS are stored one LESS than their value — a three-bit field
 *  cannot hold 8 — so reading them raw leaves every prefix length one bit short
 *  and the table decodes plausible nonsense rather than failing. */
export function parseCustomTable(data: Uint8Array, start: number, end: number): HuffmanTable {
  if (end - start < 9) throw new PdfParseError('JBIG2: truncated custom Huffman table segment', start);
  const flags = data[start];
  const oob = (flags & 1) !== 0;
  const prefixSize = ((flags >> 1) & 7) + 1;
  const rangeSize = ((flags >> 4) & 7) + 1;
  const s32 = (o: number) => ((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) | 0;
  const low = s32(start + 1), high = s32(start + 5);
  if (low > high) throw new PdfParseError(`JBIG2: custom Huffman table with HTLOW ${low} above HTHIGH ${high}`, start);

  const r = new HuffmanReader(data, start + 9, end);
  const lines: HuffmanLine[] = [];
  let cur = low;
  while (cur < high) {
    if (lines.length >= MAX_CUSTOM_LINES) {
      throw new PdfParseError('JBIG2: custom Huffman table with implausibly many lines', start);
    }
    const prefixLen = r.bits(prefixSize);
    const rangeLen = r.bits(rangeSize);
    lines.push({ prefixLen, rangeLen, rangeLow: cur, kind: HuffmanLineKind.Normal, code: -1 });
    cur += 2 ** rangeLen;
  }
  // The lower-range line continues DOWNWARD from HTLOW and subtracts what it
  // reads; the upper-range line continues upward from HTHIGH and adds.
  lines.push({ prefixLen: r.bits(prefixSize), rangeLen: 32, rangeLow: low - 1, kind: HuffmanLineKind.Lower, code: -1 });
  lines.push({ prefixLen: r.bits(prefixSize), rangeLen: 32, rangeLow: high, kind: HuffmanLineKind.Upper, code: -1 });
  if (oob) {
    lines.push({ prefixLen: r.bits(prefixSize), rangeLen: 0, rangeLow: 0, kind: HuffmanLineKind.OutOfBand, code: -1 });
  }
  assignPrefixCodes(lines);
  return new HuffmanTable(lines);
}

/** The symbol-ID code table of a Huffman text region (T.88 §7.4.3.1.7).
 *
 *  There is no simpler fallback: this runs for EVERY Huffman text region. The
 *  region does not read symbol IDs at a fixed width — it reads 35 four-bit
 *  runcode lengths, builds a runcode table from them, decodes one code length
 *  per symbol through that, builds the symbol-ID table from those, and then
 *  aligns.
 *
 *  Both tables are "value tables": line `i` has `rangeLow` i and no range bits,
 *  so decoding one yields the index directly.
 *
 *  The three repeat codes differ only in what they repeat and by how much, and
 *  confusing them shifts every later symbol ID by a code:
 *    32 — repeat the PREVIOUS symbol's length, 3 + (2 bits) times
 *    33 — repeat ZERO, 3 + (3 bits) times
 *    34 — repeat ZERO, 11 + (7 bits) times */
export function parseSymbolIdTable(r: HuffmanReader, numSyms: number): HuffmanTable {
  const runLines: HuffmanLine[] = [];
  for (let i = 0; i <= 34; i++) {
    runLines.push({ prefixLen: r.bits(4), rangeLen: 0, rangeLow: i, kind: HuffmanLineKind.Normal, code: -1 });
  }
  assignPrefixCodes(runLines);
  const runTable = new HuffmanTable(runLines);

  const lines: HuffmanLine[] = [];
  while (lines.length < numSyms) {
    const code = runTable.decode(r);
    if (code === null || code < 0 || code > 34) {
      throw new PdfParseError(`JBIG2: bad runcode ${code} in the symbol-ID table`);
    }
    if (code < 32) {
      lines.push({ prefixLen: code, rangeLen: 0, rangeLow: lines.length, kind: HuffmanLineKind.Normal, code: -1 });
      continue;
    }
    let repeatLen: number, count: number;
    if (code === 32) {
      // The PREVIOUS symbol's length — the one thing 33 and 34 do not do.
      const prev = lines[lines.length - 1];
      if (prev === undefined) throw new PdfParseError('JBIG2: symbol-ID runcode 32 with no previous length to repeat');
      repeatLen = prev.prefixLen;
      count = r.bits(2) + 3;
    } else if (code === 33) {
      repeatLen = 0;
      count = r.bits(3) + 3;
    } else {
      repeatLen = 0;
      count = r.bits(7) + 11;
    }
    if (lines.length + count > numSyms) {
      throw new PdfParseError('JBIG2: symbol-ID repeat run overshoots the symbol count');
    }
    for (let k = 0; k < count; k++) {
      lines.push({ prefixLen: repeatLen, rangeLen: 0, rangeLow: lines.length, kind: HuffmanLineKind.Normal, code: -1 });
    }
  }
  assignPrefixCodes(lines);
  // §7.4.3.1.7's last step: the strip data begins at the next byte.
  r.align();
  return new HuffmanTable(lines);
}
