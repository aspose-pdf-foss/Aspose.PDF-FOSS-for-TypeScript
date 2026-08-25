import { describe, it, expect } from 'vitest';
import { decodeCcitt, decodeCcittConsumed } from '../src/ccitt.js';
import { encodeG4, encodeG3_1D, encodeG3_2D } from './helpers/ccitt-encode.js';

const g4 = (rows: number) =>
  ({ k: -1, columns: 8, rows, blackIs1: false, byteAlign: false, endOfLine: false, endOfBlock: true });

describe('decodeCcitt (Group 4)', () => {
  it('decodes a uniform all-white 8x1 row (single V0) to 0x00', () => {
    const out = decodeCcitt(new Uint8Array([0x80]), g4(1));
    expect(Array.from(out)).toEqual([0x00]);
  });

  it('honors blackIs1 (inverts output)', () => {
    const out = decodeCcitt(new Uint8Array([0x80]), { ...g4(1), blackIs1: true });
    expect(Array.from(out)).toEqual([0xff]);
  });

  it('decodes an 8x2 horizontal-mode pattern (4 black/4 white, 4 white/4 black)', () => {
    const out = decodeCcitt(new Uint8Array([0x26, 0xae, 0x6d, 0x80]), g4(2));
    expect(Array.from(out)).toEqual([0b11110000, 0b00001111]);
  });

  it('decodes an 8x2 vertical-mode pattern (V0 + VR1)', () => {
    const out = decodeCcitt(new Uint8Array([0x26, 0xaf, 0x70]), g4(2));
    expect(Array.from(out)).toEqual([0b11110000, 0b11111000]);
  });

});

describe('decodeCcitt (Group 4) hardening', () => {
  it('tolerates a trailing EOFB when rows is unknown (rows<=0)', () => {
    const g4bm = [[1, 1, 1, 1, 0, 0, 0, 0], [0, 0, 0, 0, 1, 1, 1, 1]];
    const data = encodeG4(g4bm, { eofb: true });
    const out = decodeCcitt(data, { k: -1, columns: 8, rows: 0, blackIs1: false, byteAlign: false, endOfLine: false, endOfBlock: true });
    expect(Array.from(out)).toEqual([0b11110000, 0b00001111]);
  });
});

const params = (over: Partial<Parameters<typeof decodeCcitt>[1]> & { columns: number; rows: number }) =>
  ({ k: 0, blackIs1: false, byteAlign: false, endOfLine: false, endOfBlock: true, ...over });

// Build a bitmap from row strings of '0'/'1'.
const bm = (...rows: string[]): number[][] =>
  rows.map((r) => r.split('').map((c) => (c === '1' ? 1 : 0)));

// Pack the same bitmap directly to compare against the decoder output.
const packed = (rows: string[]): number[] => {
  const cols = rows[0].length, rb = (cols + 7) >> 3, out: number[] = [];
  for (const r of rows) {
    const bytes = new Array(rb).fill(0);
    for (let x = 0; x < cols; x++) if (r[x] === '1') bytes[x >> 3] |= 0x80 >> (x & 7);
    out.push(...bytes);
  }
  return out;
};

describe('decodeCcitt (Group 3 1D, K=0)', () => {
  it('decodes a mixed 8-wide row', () => {
    const rows = ['11110000'];
    const out = decodeCcitt(encodeG3_1D(bm(...rows)), params({ columns: 8, rows: 1 }));
    expect(Array.from(out)).toEqual(packed(rows));
  });

  it('decodes runs >= 64 (makeup codes) across a 200-wide row', () => {
    const rows = ['0'.repeat(100) + '1'.repeat(100)];
    const out = decodeCcitt(encodeG3_1D(bm(...rows)), params({ columns: 200, rows: 1 }));
    expect(Array.from(out)).toEqual(packed(rows));
  });

  it('decodes extended makeup (runs >= 1792) across a 2000-wide row', () => {
    const rows = ['1'.repeat(2000)];
    const out = decodeCcitt(encodeG3_1D(bm(...rows)), params({ columns: 2000, rows: 1 }));
    expect(Array.from(out)).toEqual(packed(rows));
  });

  it('honors EncodedByteAlign across rows', () => {
    const rows = ['11110000', '10101010', '00001111'];
    const data = encodeG3_1D(bm(...rows), { byteAlign: true });
    const out = decodeCcitt(data, params({ columns: 8, rows: 3, byteAlign: true }));
    expect(Array.from(out)).toEqual(packed(rows));
  });

  it('decodes with EndOfLine codes and a trailing EOFB', () => {
    const rows = ['11110000', '00110011'];
    const data = encodeG3_1D(bm(...rows), { endOfLine: true, eofb: true });
    const out = decodeCcitt(data, params({ columns: 8, rows: 0, endOfLine: true }));
    expect(Array.from(out)).toEqual(packed(rows));
  });

  it('honors blackIs1 (inverts output)', () => {
    const rows = ['11110000'];
    const out = decodeCcitt(encodeG3_1D(bm(...rows)), params({ columns: 8, rows: 1, blackIs1: true }));
    const inv = packed(rows).map((byte) => byte ^ 0xff);
    expect(Array.from(out)).toEqual(inv);
  });
});

describe('decodeCcitt (Group 3 2D, K>0)', () => {
  it('decodes mixed 1D/2D lines (first row 1D, rest 2D)', () => {
    const rows = ['11110000', '11100000', '00011111'];
    const data = encodeG3_2D(bm(...rows));
    const out = decodeCcitt(data, params({ k: 1, columns: 8, rows: 3 }));
    expect(Array.from(out)).toEqual(packed(rows));
  });

  it('round-trips a pattern that forces pass mode (region vanishes between rows)', () => {
    // row0 has an isolated black block; row1 is all white -> b2 < a1 => pass.
    const rows = ['00111100', '00000000'];
    const data = encodeG3_2D(bm(...rows));
    const out = decodeCcitt(data, params({ k: 1, columns: 8, rows: 2 }));
    expect(Array.from(out)).toEqual(packed(rows));
  });

  it('round-trips edges shifted by 2 and 3 px (VR2/VR3/VL2/VL3) over a 16-wide image', () => {
    const rows = [
      '0000111111110000',
      '0000001111000000', // both edges pulled in by 2 -> VR2 / VL2
      '0000000110000000', // pulled in by 3 more -> VR3 / VL3 region
    ];
    const data = encodeG3_2D(bm(...rows));
    const out = decodeCcitt(data, params({ k: 1, columns: 16, rows: 3 }));
    expect(Array.from(out)).toEqual(packed(rows));
  });

  it('honors byteAlign, EndOfLine and EOFB together for K>0', () => {
    const rows = ['1100110011001100', '0011001100110011'];
    const data = encodeG3_2D(bm(...rows), { byteAlign: true, endOfLine: true, eofb: true });
    const out = decodeCcitt(data, params({ k: 2, columns: 16, rows: 0, byteAlign: true, endOfLine: true }));
    expect(Array.from(out)).toEqual(packed(rows));
  });
});

describe('decodeCcitt termination guard', () => {
  it('throws PdfParseError on a truncated 1D row rather than looping forever', () => {
    // A single white-8 code then EOF, but we ask for a 64-wide row: run cannot complete.
    const data = encodeG3_1D(bm('00000000')); // only 8 px of a claimed 64-wide row
    expect(() => decodeCcitt(data, params({ columns: 64, rows: 1 })))
      .toThrow(/CCITT/);
  });
});

// T.88 Annex C.5 packs every grayscale bitplane into ONE MMR datastream with an
// EOFB between them, so a JBIG2 halftone region has to know where each plane
// stopped. decodeCcitt takes a byte range and returns an image with no way to
// say. This is the entry that says; per utax.1 it earns its own test here rather
// than being validated solely through a halftone fixture.
describe('decodeCcittConsumed', () => {
  const P = { k: -1, columns: 8, rows: 2, blackIs1: false, byteAlign: false, endOfLine: false, endOfBlock: false };
  const A = [[1, 1, 1, 1, 0, 0, 0, 0], [0, 0, 0, 0, 1, 1, 1, 1]];
  const B = [[1, 0, 1, 0, 1, 0, 1, 0], [0, 1, 0, 1, 0, 1, 0, 1]];

  it('decodes two EOFB-terminated images from one buffer', () => {
    const ea = encodeG4(A, { eofb: true }), eb = encodeG4(B, { eofb: true });
    const both = new Uint8Array(ea.length + eb.length);
    both.set(ea, 0); both.set(eb, ea.length);

    const first = decodeCcittConsumed(both, P);
    expect(first.consumed).toBe(ea.length);
    // The second image comes back ONLY because the first reported where it
    // stopped, terminator included. A count that omits the EOFB, or that runs to
    // the end of the buffer, leaves this decode reading from the wrong bit.
    const second = decodeCcittConsumed(both.subarray(first.consumed), P);
    expect(Array.from(second.data)).toEqual(Array.from(decodeCcitt(eb, P)));
    expect(Array.from(first.data)).toEqual(Array.from(decodeCcitt(ea, P)));
  });

  it('agrees with decodeCcitt on the pixels', () => {
    const e = encodeG4(A, { eofb: true });
    expect(Array.from(decodeCcittConsumed(e, P).data)).toEqual(Array.from(decodeCcitt(e, P)));
  });

  it('never reports more bytes than it was given', () => {
    const e = encodeG4(A, {}); // no EOFB at all
    expect(decodeCcittConsumed(e, P).consumed).toBeLessThanOrEqual(e.length);
  });
});
