import { describe, it, expect } from 'vitest';
import {
  HuffmanReader, HuffmanTable, assignPrefixCodes, standardTable, STANDARD_TABLE_COUNT,
  parseCustomTable, parseSymbolIdTable,
  type HuffmanLine,
} from '../src/jbig2huffman.js';

/** Bytes from an MSB-first bit string, zero-padded to a byte. */
function bytesOf(bits: string): Uint8Array {
  const padded = bits + '0'.repeat((8 - (bits.length % 8)) % 8);
  const out = new Uint8Array(padded.length / 8);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(padded.slice(i * 8, i * 8 + 8), 2);
  return out;
}
const readerOf = (bits: string): HuffmanReader => {
  const b = bytesOf(bits);
  return new HuffmanReader(b, 0, b.length);
};

describe('jbig2 Huffman bit reader', () => {
  it('reads MSB first across a byte boundary', () => {
    const r = new HuffmanReader(Uint8Array.from([0b10110010, 0b01000000]), 0, 2);
    expect(r.bits(3)).toBe(0b101);
    expect(r.bits(7)).toBe(0b1001001); // spans the boundary
  });

  // align() is explicit and load-bearing further up the epic: a Huffman symbol
  // dictionary reads BMSIZE, aligns, and takes a whole collective bitmap
  // byte-wise (utax.2), and the symbol-ID runcode table aligns after itself
  // (utax.7). A no-op align that skipped a byte would be invisible here and
  // fatal there.
  it('aligns to the next byte boundary, and is a no-op when already there', () => {
    const r = new HuffmanReader(Uint8Array.from([0xff, 0x0f, 0x00]), 0, 3);
    r.bits(3);
    r.align();
    expect(r.bytePos()).toBe(1);
    r.align();
    expect(r.bytePos()).toBe(1); // no-op, NOT a byte skipped
    r.bits(8);
    expect(r.bytePos()).toBe(2);
  });

  // A 32-bit range value does not fit in a signed int, and `(v << 1) | b`
  // silently wraps to negative at bit 32. This is the one arithmetic hazard in
  // the module.
  it('reads a full 32-bit value without sign overflow', () => {
    const r = new HuffmanReader(Uint8Array.from([0xff, 0xff, 0xff, 0xff]), 0, 4);
    expect(r.bits(32)).toBe(0xffffffff);
  });

  // A truncated stream is a damaged file, and deciding that belongs to the
  // caller — the division lexer.ts records for the four grammars sharing it.
  // Reading past the end yields zero bits so a decode terminates instead of
  // throwing from inside the reader.
  it('reads zeros past the end and reports it', () => {
    const r = new HuffmanReader(Uint8Array.from([0x80]), 0, 1);
    expect(r.bits(8)).toBe(0x80);
    expect(r.atEnd()).toBe(true);
    expect(r.bits(4)).toBe(0);
  });

  it('honours the start and end bounds it is given', () => {
    const r = new HuffmanReader(Uint8Array.from([0xaa, 0b11000000, 0xaa]), 1, 2);
    expect(r.bits(2)).toBe(0b11);
    expect(r.bytePos()).toBe(1); // still inside byte 1
  });
});

describe('jbig2 Huffman code assignment (T.88 B.3)', () => {
  const line = (prefixLen: number, rangeLen = 0, rangeLow = 0): HuffmanLine =>
    ({ prefixLen, rangeLen, rangeLow, kind: 0, code: -1 });

  // The textbook canonical assignment: codes ascend within a length, and each
  // length starts at (previous first code + previous count) * 2.
  it('assigns canonical codes in table order within a length', () => {
    const lines = [line(1), line(2), line(3), line(3)];
    assignPrefixCodes(lines);
    expect(lines.map((l) => l.code)).toEqual([0b0, 0b10, 0b110, 0b111]);
  });

  // Order within a length is part of the answer, not an implementation detail:
  // T.88 prints the codes in table order and a consumer matches on the code.
  it('follows table order rather than sorting', () => {
    const lines = [line(3), line(1), line(3), line(2)];
    assignPrefixCodes(lines);
    expect(lines.map((l) => l.code)).toEqual([0b110, 0b0, 0b111, 0b10]);
  });

  // B.2.3 writes a prefix length for every range whether or not the encoder
  // used it, so an unused range arrives as prefixLen 0. It takes NO code, and
  // counting it would shift every later code by one — which decodes a
  // DIFFERENT line rather than failing. No standard table has such a line,
  // which is why this case needs its own test.
  it('gives a zero-length line no code and does not let it shift the others', () => {
    const lines = [line(1), line(0), line(2), line(3), line(3)];
    assignPrefixCodes(lines);
    expect(lines.map((l) => l.code)).toEqual([0b0, -1, 0b10, 0b110, 0b111]);
  });

  it('leaves a gap where a length is unused', () => {
    // No length-2 line: length 3 starts at (0 + 1) * 2 * 2 = 4, not at 2.
    const lines = [line(1), line(3), line(3)];
    assignPrefixCodes(lines);
    expect(lines.map((l) => l.code)).toEqual([0b0, 0b100, 0b101]);
  });
});

describe('jbig2 Huffman decoding', () => {
  const table = (lines: HuffmanLine[]): HuffmanTable => { assignPrefixCodes(lines); return new HuffmanTable(lines); };

  it('decodes a normal line as rangeLow plus the offset it reads', () => {
    // One line: code '0', 4 range bits, rangeLow 16.
    const t = table([{ prefixLen: 1, rangeLen: 4, rangeLow: 16, kind: 0, code: -1 }]);
    expect(t.decode(readerOf('0' + '0101'))).toBe(16 + 5);
  });

  it('returns null for an OOB line and reads nothing further', () => {
    const t = table([
      { prefixLen: 1, rangeLen: 0, rangeLow: 7, kind: 0, code: -1 },
      { prefixLen: 1, rangeLen: 0, rangeLow: 0, kind: 3 /* OOB */, code: -1 },
    ]);
    const r = readerOf('1' + '0');
    expect(t.decode(r)).toBeNull();
    expect(t.decode(r)).toBe(7); // the next bit was NOT consumed by the OOB line
  });
});

// ---------------------------------------------------------------------------
// The fifteen standard tables. Everything about this feature is mechanical, so
// the risk is not a misread of T.88's prose but a typo in one of ~150 rows —
// and a typo in a table nothing yet consumes would sit undetected until utax.2
// decoded a real file wrongly. Three independent checks, swept over all
// fifteen so a table added later cannot skip them.
// ---------------------------------------------------------------------------

const ALL = Array.from({ length: STANDARD_TABLE_COUNT }, (_, i) => i + 1);

describe('jbig2 standard Huffman tables', () => {
  // CHECK 1, THE ANCHOR. T.88 Annex B prints the assigned prefix CODES, not
  // merely their lengths, and those codes are what B.3's assignment produces
  // from the lengths in table order. The lengths and the codes are transcribed
  // as separate columns, so a typo in either breaks this equality — and a wrong
  // assignment algorithm breaks all fifteen tables at once. No encoder of ours
  // is involved, unlike most of this stack.
  it.each(ALL)('assigns table B.%i the prefix codes T.88 prints', (n) => {
    const t = standardTable(n);
    expect(t.lines.map((l) => l.code)).toEqual(t.lines.map((l) => l.printedCode));
  });

  // CHECK 2. Every standard table is a COMPLETE prefix code: a dropped line, a
  // duplicated line or a wrong prefixLen breaks Kraft equality. A property of
  // what the table IS rather than of what we wrote down.
  it.each(ALL)('table B.%i is a complete prefix code (Kraft equality)', (n) => {
    const sum = standardTable(n).lines
      .filter((l) => l.prefixLen > 0)
      .reduce((acc, l) => acc + 2 ** -l.prefixLen, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  // CHECK 3, on the two columns the prefix codes cannot see. Sorted by
  // rangeLow the normal lines tile the integers with no gap and no overlap; the
  // lower-range line continues downward from the first and the upper-range line
  // upward from the last. A mistyped rangeLow or rangeLen shows up here and
  // nowhere else.
  it.each(ALL)('table B.%i tiles its range contiguously', (n) => {
    const lines = standardTable(n).lines;
    const normal = lines.filter((l) => l.kind === 0 /* Normal */).slice().sort((a, b) => a.rangeLow - b.rangeLow);
    expect(normal.length).toBeGreaterThan(0);
    for (let i = 0; i + 1 < normal.length; i++) {
      expect(normal[i].rangeLow + 2 ** normal[i].rangeLen).toBe(normal[i + 1].rangeLow);
    }
    const lower = lines.find((l) => l.kind === 1 /* Lower */);
    if (lower) expect(lower.rangeLow).toBe(normal[0].rangeLow - 1);
    const upper = lines.find((l) => l.kind === 2 /* Upper */);
    const last = normal[normal.length - 1];
    if (upper) expect(upper.rangeLow).toBe(last.rangeLow + 2 ** last.rangeLen);
  });

  // B.14 is the only bounded standard table: five lines covering -2..2 with
  // NEITHER a lower nor an upper range line. Stated directly because "add an
  // upper range line out of habit" is the transcription slip it invites, and
  // because a sweep cannot say which tables were meant to be open-ended.
  it('gives table B.14 no lower or upper range line', () => {
    const kinds = standardTable(14).lines.map((l) => l.kind);
    expect(kinds).toEqual([0, 0, 0, 0, 0]);
    expect(standardTable(14).lines.map((l) => l.rangeLow)).toEqual([-2, -1, 0, 1, 2]);
  });

  it('reports which tables carry an OOB line', () => {
    const withOob = ALL.filter((n) => standardTable(n).lines.some((l) => l.kind === 3));
    expect(withOob).toEqual([2, 3, 8, 9, 10]);
  });
});

describe('jbig2 decoding through a standard table', () => {
  it('decodes a normal line and an upper range from table B.1', () => {
    // B.1: code '0' + 4 bits -> 0..15;  code '111' + 32 bits -> 65808 + offset.
    expect(standardTable(1).decode(readerOf('0' + '0101'))).toBe(5);
    expect(standardTable(1).decode(readerOf('111' + '0'.repeat(29) + '011'))).toBe(65808 + 3);
  });

  it('returns null on table B.2\'s OOB code', () => {
    expect(standardTable(2).decode(readerOf('111111'))).toBeNull();
  });

  // The lower-range line SUBTRACTS. It is spelled exactly like an upper-range
  // line but for the sign, and adding instead would put a text-region symbol
  // far off the page rather than raise an error — so it gets its own case
  // beside the upper range it is so easily confused with.
  it('subtracts on table B.3\'s lower-range line and adds on its upper', () => {
    // B.3 lower: code 11111111, rangeLow -257.  upper: code 1111110, rangeLow 75.
    expect(standardTable(3).decode(readerOf('11111111' + '0'.repeat(30) + '11'))).toBe(-257 - 3);
    expect(standardTable(3).decode(readerOf('1111110' + '0'.repeat(30) + '11'))).toBe(75 + 3);
  });

  it('decodes table B.14 by prefix alone, with no range bits', () => {
    // Five one-value lines: '0' is 0, and the four length-3 codes are -2,-1,1,2.
    expect(standardTable(14).decode(readerOf('0'))).toBe(0);
    expect(standardTable(14).decode(readerOf('100'))).toBe(-2);
    expect(standardTable(14).decode(readerOf('111'))).toBe(2);
  });

  // Only an INCOMPLETE table can fail to match — a standard table is complete
  // by Kraft equality, so every bit pattern hits a line and the refusal below
  // is unreachable through one. A custom table (§B.2.3) may be incomplete, and
  // there the alternative to refusing is spinning on the reader's zero bits
  // past the end of the data.
  it('refuses a bit pattern no line matches rather than looping', () => {
    const lines: HuffmanLine[] = [{ prefixLen: 2, rangeLen: 0, rangeLow: 5, kind: 0, code: -1 }];
    assignPrefixCodes(lines); // the single length-2 line takes code 00
    const t = new HuffmanTable(lines);
    expect(() => t.decode(readerOf('11'))).toThrow(/no Huffman code matches/);
  });
});

// ---------------------------------------------------------------------------
// Custom table segment 53 (T.88 §B.2.3). Hand-built bits rather than a minted
// vector: there is no encoder for this, and writing one would be a second
// reading of B.2.3 — the trap utax.1 avoided by assembling its MMR fixture
// from the already-pinned G4 encoder. A bit string is also readable, which a
// base64 blob is not.
// ---------------------------------------------------------------------------

const i32 = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

/** A type-53 segment body: the 9-byte header then the bit-packed lines. */
function customTableBytes(flags: number, low: number, high: number, bits: string): Uint8Array {
  return Uint8Array.from([flags, ...i32(low), ...i32(high), ...bytesOf(bits)]);
}
/** HTPS and HTRS are stored one LESS than their value (§B.2.3) — a three-bit
 *  field cannot hold 8 — so the fixture encodes them the way a file does. */
const tableFlags = (oob: boolean, prefixSize: number, rangeSize: number): number =>
  (oob ? 1 : 0) | ((prefixSize - 1) << 1) | ((rangeSize - 1) << 4);

describe('jbig2 custom Huffman table (segment 53)', () => {
  // HTLOW 0, HTHIGH 8, HTPS 3, HTRS 3, HTOOB set. Two normal lines of four
  // values each, then the lower, upper and OOB prefix lengths.
  const SIMPLE = customTableBytes(tableFlags(true, 3, 3), 0, 8, [
    '010', '010', // line at 0: prefixLen 2, rangeLen 2  -> covers 0..3
    '010', '010', // line at 4: prefixLen 2, rangeLen 2  -> covers 4..7
    '011',        // lower range: prefixLen 3
    '011',        // upper range: prefixLen 3
    '010',        // OOB:         prefixLen 2
  ].join(''));

  it('parses the lines B.2.3 describes, in order', () => {
    const t = parseCustomTable(SIMPLE, 0, SIMPLE.length);
    expect(t.lines.map((l) => [l.rangeLow, l.prefixLen, l.rangeLen, l.kind])).toEqual([
      [0, 2, 2, 0],   // normal
      [4, 2, 2, 0],   // normal
      [-1, 3, 32, 1], // lower: HTLOW - 1, continuing DOWNWARD
      [8, 3, 32, 2],  // upper: HTHIGH
      [0, 2, 0, 3],   // OOB
    ]);
  });

  it('assigns its codes by B.3 like any other table', () => {
    // Lengths in table order are 2,2,3,3,2 — the OOB line comes LAST and is a
    // length-2 line, so it takes the third length-2 code rather than a trailing
    // one. Length 2 starts at 0 (three of them), length 3 at (0 + 3) * 2 = 6.
    expect(parseCustomTable(SIMPLE, 0, SIMPLE.length).lines.map((l) => l.code)).toEqual([0, 1, 6, 7, 2]);
  });

  it('decodes every line kind through the parsed table', () => {
    const t = parseCustomTable(SIMPLE, 0, SIMPLE.length);
    expect(t.decode(readerOf('00' + '11'))).toBe(3);       // normal, 0 + 3
    expect(t.decode(readerOf('01' + '10'))).toBe(6);       // normal, 4 + 2
    expect(t.decode(readerOf('10'))).toBeNull();           // OOB
    expect(t.decode(readerOf('110' + '0'.repeat(30) + '11'))).toBe(-4); // lower: -1 - 3
    expect(t.decode(readerOf('111' + '0'.repeat(30) + '11'))).toBe(11); // upper: 8 + 3
  });

  // §B.2.3 writes a prefix length for every range whether or not the encoder
  // used it, so an unused range arrives as prefixLen 0. It takes NO code, and
  // counting it shifts every later code by one — which decodes a different
  // line rather than failing. This is the case no standard table has.
  it('gives an unused range no code and does not let it shift the others', () => {
    const bytes = customTableBytes(tableFlags(false, 3, 3), 0, 12, [
      '001', '010', // line at 0: prefixLen 1
      '000', '010', // line at 4: prefixLen 0 — UNUSED
      '010', '010', // line at 8: prefixLen 2
      '011',        // lower
      '011',        // upper
    ].join(''));
    const t = parseCustomTable(bytes, 0, bytes.length);
    expect(t.lines.map((l) => l.prefixLen)).toEqual([1, 0, 2, 3, 3]);
    expect(t.lines.map((l) => l.code)).toEqual([0, -1, 2, 6, 7]);
  });

  it('refuses a segment too short to hold its own header', () => {
    expect(() => parseCustomTable(new Uint8Array(8), 0, 8)).toThrow(/truncated custom Huffman table/);
  });

  it('refuses bounds that run backwards', () => {
    const bytes = customTableBytes(tableFlags(false, 3, 3), 8, 0, '011011');
    expect(() => parseCustomTable(bytes, 0, bytes.length)).toThrow(/HTLOW/);
  });

  // The loop advances by 2**rangeLen and so always terminates, but a corrupt
  // pair of bounds with rangeLen 0 throughout would produce four billion
  // one-value lines before it did. A damaged file must be refused, not
  // survived slowly.
  it('refuses a table with implausibly many lines', () => {
    const bytes = customTableBytes(tableFlags(false, 3, 3), 0, 1 << 20, '');
    expect(() => parseCustomTable(bytes, 0, bytes.length)).toThrow(/implausibly many lines/);
  });
});

// ---------------------------------------------------------------------------
// The symbol-ID code table (T.88 §7.4.3.1.7). It runs for EVERY Huffman text
// region — there is no simpler fallback — and its three repeat codes differ
// only in what they repeat and by how much, so each gets its own case
// asserting the resulting length array rather than merely that a decode
// succeeded.
// ---------------------------------------------------------------------------

/** 35 four-bit runcode lengths, as a bit string. `lens` maps runcode -> length;
 *  everything unnamed is 0 and so takes no code. */
function runcodeLengths(lens: Record<number, number>): string {
  let out = '';
  for (let i = 0; i <= 34; i++) out += (lens[i] ?? 0).toString(2).padStart(4, '0');
  return out;
}

describe('jbig2 symbol-ID code table', () => {
  // Runcodes 1 and 2 both get length 1, so they are the complete code {0, 1}
  // and emitting one is a single bit.
  const RUN12 = runcodeLengths({ 1: 1, 2: 1 });
  const lengthsOf = (t: { lines: readonly { prefixLen: number }[] }) => t.lines.map((l) => l.prefixLen);

  it('reads one length per symbol through the runcode table', () => {
    // runcode 1 ('0'), runcode 2 ('1'), runcode 2 ('1') -> lengths 1, 2, 2.
    const r = readerOf(RUN12 + '011');
    expect(lengthsOf(parseSymbolIdTable(r, 3))).toEqual([1, 2, 2]);
  });

  it('assigns the symbol-ID codes by B.3, so a decode yields the index', () => {
    const r = readerOf(RUN12 + '011');
    const t = parseSymbolIdTable(r, 3);
    // Lengths 1, 2, 2 -> codes 0, 10, 11.
    expect(t.decode(readerOf('0'))).toBe(0);
    expect(t.decode(readerOf('10'))).toBe(1);
    expect(t.decode(readerOf('11'))).toBe(2);
  });

  // 32 repeats the PREVIOUS symbol's length. This is the one that must not be
  // confused with 33 and 34, which repeat ZERO.
  it('repeats the previous length on runcode 32', () => {
    // runcode 2 (length 2), then 32 with a 2-bit count of 0 -> 3 more 2s.
    const r = readerOf(runcodeLengths({ 2: 1, 32: 1 }) + '0' + '1' + '00');
    expect(lengthsOf(parseSymbolIdTable(r, 4))).toEqual([2, 2, 2, 2]);
  });

  it('repeats zero on runcode 33, not the previous length', () => {
    // runcode 2 (length 2), then 33 with a 3-bit count of 0 -> 3 ZEROS.
    const r = readerOf(runcodeLengths({ 2: 1, 33: 1 }) + '0' + '1' + '000');
    expect(lengthsOf(parseSymbolIdTable(r, 4))).toEqual([2, 0, 0, 0]);
  });

  // 34 also repeats zero, but its count starts at 11 rather than 3 and reads
  // seven bits rather than three — so it cannot be folded into 33.
  it('repeats zero eleven or more times on runcode 34', () => {
    const r = readerOf(runcodeLengths({ 1: 1, 34: 1 }) + '0' + '1' + '0000000');
    expect(lengthsOf(parseSymbolIdTable(r, 12))).toEqual([1, ...new Array<number>(11).fill(0)]);
  });

  // §7.4.3.1.7's last step. The strip data begins at the next byte, so a
  // missing align leaves every later read a few bits out.
  it('aligns after the table', () => {
    const bits = RUN12 + '011'; // 140 + 3 bits, so mid-byte
    const b = bytesOf(bits);
    const r = new HuffmanReader(b, 0, b.length);
    parseSymbolIdTable(r, 3);
    expect(r.bytePos()).toBe(Math.ceil((35 * 4 + 3) / 8));
  });

  it('refuses runcode 32 with no previous length to repeat', () => {
    const r = readerOf(runcodeLengths({ 32: 1 }) + '0' + '00');
    expect(() => parseSymbolIdTable(r, 3)).toThrow(/no previous length/);
  });

  it('refuses a repeat run that overshoots the symbol count', () => {
    const r = readerOf(runcodeLengths({ 1: 1, 34: 1 }) + '0' + '1' + '0000000');
    expect(() => parseSymbolIdTable(r, 3)).toThrow(/overshoots/);
  });
});
