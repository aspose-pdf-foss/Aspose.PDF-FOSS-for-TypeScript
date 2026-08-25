import { describe, it, expect } from 'vitest';
import { MqDecoder } from '../src/jpxmq.js';
import { PdfParseError } from '../src/errors.js';
import { ArithIntSource, HuffmanIntSource, type IntSource } from '../src/jbig2ints.js';
import { HuffmanReader, standardTable } from '../src/jbig2huffman.js';
import { BitWriter, encodeValue } from './helpers/jbig2-huffman-encode.js';
import * as A from './helpers/jbig2-arith-vectors.js';

// ---------------------------------------------------------------------------
// The seam itself. T.88 writes the symbol dictionary and the text region as one
// procedure each with the entropy source swapped — every step reads "decode DT
// using SBHUFFDT or IADT". The point of IntSource is that ONE walk serves both,
// so what is tested here is that claim, not each implementation separately.
// ---------------------------------------------------------------------------

/** Read `n` values through whichever source, using the same call each time. */
function readAll(int: IntSource, n: number): Array<number | null> {
  return Array.from({ length: n }, () => int.dt());
}

describe('jbig2 IntSource', () => {
  it('reads the same values through either entropy source', () => {
    const values = A.ints_small.values as Array<number | null>;

    // Arithmetic: a vector minted by scripts/mqenc.mjs through ONE integer
    // context, which is exactly what ArithIntSource.dt() reads.
    const arith = new ArithIntSource(new MqDecoder(A.ints_small.bytes, 0, A.ints_small.bytes.length), 1);
    expect(readAll(arith, values.length)).toEqual(values);

    // Huffman: the same values through Table B.3, which spans negatives and
    // carries lower- and upper-range lines, so the sequence exercises all three
    // normal kinds rather than only the middle of the table.
    const w = new BitWriter();
    for (const v of values) encodeValue(w, standardTable(3), v);
    const bytes = w.toBytes();
    const huff = new HuffmanIntSource(
      new HuffmanReader(bytes, 0, bytes.length), { dt: standardTable(3) }, 1,
    );
    expect(readAll(huff, values.length)).toEqual(values);
  });

  it('carries OOB through both sources alike', () => {
    // OOB is what ends a height class and a strip, so a source that lost it
    // would run a walk forever rather than produce a wrong picture.
    const oob = A.ints_oob.values as Array<number | null>;
    expect(oob).toContain(null);

    const arith = new ArithIntSource(new MqDecoder(A.ints_oob.bytes, 0, A.ints_oob.bytes.length), 1);
    expect(readAll(arith, oob.length)).toEqual(oob);

    const w = new BitWriter();
    for (const v of oob) encodeValue(w, standardTable(3), v);
    const bytes = w.toBytes();
    const huff = new HuffmanIntSource(new HuffmanReader(bytes, 0, bytes.length), { dt: standardTable(3) }, 1);
    expect(readAll(huff, oob.length)).toEqual(oob);
  });

  // align() exists so the two shared walks never branch on which source they
  // hold. On the arithmetic path it must do NOTHING — the MQ decoder is not
  // bit-addressed, and skipping a byte there would desynchronise it.
  it('makes align() a no-op on the arithmetic path and real on the Huffman one', () => {
    const arith = new ArithIntSource(new MqDecoder(A.ints_small.bytes, 0, A.ints_small.bytes.length), 1);
    const first = arith.dt();
    arith.align();
    const arithRest = readAll(arith, 3);

    const unaligned = new ArithIntSource(new MqDecoder(A.ints_small.bytes, 0, A.ints_small.bytes.length), 1);
    unaligned.dt();
    expect(arithRest).toEqual(readAll(unaligned, 3));
    expect(first).toBe(A.ints_small.values[0]);

    const r = new HuffmanReader(Uint8Array.from([0xff, 0x00]), 0, 2);
    const huff = new HuffmanIntSource(r, {}, 4);
    huff.id();       // four raw bits
    huff.align();    // now on byte 1
    expect(r.bytePos()).toBe(1);
  });

  // §6.5.8.2.3: a symbol dictionary reads an ID as symCodeLen RAW bits — there
  // is no table for it. A Huffman text region builds a runcode table and
  // supplies one, which is the hook utax.7 uses; that this falls back rather
  // than throwing is what lets the dictionary land first.
  it('reads a symbol ID as raw bits when no symbol-ID table is supplied', () => {
    const r = new HuffmanReader(Uint8Array.from([0b10110000]), 0, 1);
    expect(new HuffmanIntSource(r, {}, 4).id()).toBe(0b1011);
  });

  // A field with no table must throw rather than return a plausible zero: a
  // dictionary reading a field it was given no table for is a header we
  // mis-parsed, and a zero there decodes silently into a wrong picture.
  it('refuses to read a field it has no table for', () => {
    const r = new HuffmanReader(Uint8Array.from([0xff]), 0, 1);
    expect(() => new HuffmanIntSource(r, {}, 1).dh()).toThrow(PdfParseError);
    expect(() => new HuffmanIntSource(r, {}, 1).dh()).toThrow(/no Huffman table for dh/);
  });

  // BMSIZE/RSIZE is never read on the arithmetic path — a refinement's extent
  // comes from the height class or the decoded deltas, never from a byte count.
  // Returning null rather than throwing is what keeps the shared walks
  // branch-free.
  it('reports no size on the arithmetic path', () => {
    const arith = new ArithIntSource(new MqDecoder(Uint8Array.from([0]), 0, 1), 1);
    expect(arith.size()).toBeNull();
  });
});

// §6.4.5 3(c)(ii): a Huffman text region reads CURT as LOG2SBSTRIPS RAW BITS,
// not through a table — the flag word's eight selectors are FS, DS, DT, RDW,
// RDH, RDX, RDY and RSIZE, and IT is not among them. `HuffmanTables` therefore
// has no `it` field at all, so this cannot be got wrong by omission.
describe('jbig2 HuffmanIntSource CURT', () => {
  it('reads exactly LOG2SBSTRIPS bits', () => {
    const r = new HuffmanReader(Uint8Array.from([0b10100000]), 0, 1);
    const int = new HuffmanIntSource(r, {}, 1, 3);
    expect(int.it()).toBe(0b101);
    expect(r.bytePos()).toBe(0);
  });

  // At SBSTRIPS == 1 the walk never asks for CURT, but a source that consumed a
  // bit anyway would desynchronise every single-strip region — the common case.
  it('consumes nothing at LOG2SBSTRIPS 0', () => {
    const r = new HuffmanReader(Uint8Array.from([0xff]), 0, 1);
    const int = new HuffmanIntSource(r, {}, 1, 0);
    expect(int.it()).toBe(0);
    expect(r.bits(8)).toBe(0xff); // the whole byte is still there
  });
});
