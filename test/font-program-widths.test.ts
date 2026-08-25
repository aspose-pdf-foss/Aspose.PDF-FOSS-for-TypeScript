import { describe, it, expect } from 'vitest';
import { TextFont } from '../src/font.js';
import { PdfDict, PdfObject, PdfStream, name } from '../src/types.js';
import { buildMinimalTtf } from './helpers/build-sfnt.js';
import { buildType1, t1num, t1cs } from './helpers/build-type1.js';

const id = (o: PdfObject | undefined): PdfObject => (o ?? null) as PdfObject;
const inflate = (s: { raw: Uint8Array }) => s.raw;
const dict = (entries: Record<string, PdfObject>): PdfDict => new Map(Object.entries(entries));
const stream = (raw: Uint8Array): PdfStream => ({ kind: 'stream', dict: new Map(), raw });

/** A Type 1 program where /A advances 742 and /B advances 333. */
const t1Program = buildType1({
  charstrings: {
    '.notdef': t1cs(t1num(0), t1num(300), 13, 14),
    A: t1cs(t1num(0), t1num(742), 13, 14),
    B: t1cs(t1num(0), t1num(333), 13, 14),
  },
  encoding: { 0x41: 'A', 0x42: 'B' },
});

/** Em-width of one code, via the public decode path. */
function widthOf(font: TextFont, code: number): number {
  return font.decodeGlyphs(Uint8Array.from([code]))[0].width;
}

describe('advance resolution order', () => {
  it('prefers /Widths over the program, even when they disagree', () => {
    // /Widths says 900 where the program says 742. A producer that states a
    // width has said what it means, so the program must not win.
    const f = new TextFont(dict({
      Subtype: name('Type1'), BaseFont: name('TestFont'),
      FirstChar: 0x41, LastChar: 0x41, Widths: [900],
      FontDescriptor: dict({ FontFile: stream(t1Program) }),
    }), id, inflate);
    expect(widthOf(f, 0x41)).toBeCloseTo(0.9, 6);
  });

  it('takes the program width for a code past LastChar with no /MissingWidth', () => {
    // Without this the code gets /MissingWidth's default of 0 and every such
    // glyph piles up on the previous one.
    const f = new TextFont(dict({
      Subtype: name('Type1'), BaseFont: name('TestFont'),
      FirstChar: 0x41, LastChar: 0x41, Widths: [900],
      FontDescriptor: dict({ FontFile: stream(t1Program) }),
    }), id, inflate);
    expect(widthOf(f, 0x42)).toBeCloseTo(0.333, 6);
  });

  it('honours an explicit /MissingWidth over the program, including zero', () => {
    const f = new TextFont(dict({
      Subtype: name('Type1'), BaseFont: name('TestFont'),
      FirstChar: 0x41, LastChar: 0x41, Widths: [900],
      FontDescriptor: dict({ FontFile: stream(t1Program), MissingWidth: 0 }),
    }), id, inflate);
    expect(widthOf(f, 0x42)).toBe(0);
  });

  it('uses the program throughout when the font carries no /Widths', () => {
    // Today this measures as Helvetica, because normalizeFont maps an unknown
    // /BaseFont onto it: 'A' would be 0.667.
    const f = new TextFont(dict({
      Subtype: name('Type1'), BaseFont: name('AAAAAB+TestFont'),
      FontDescriptor: dict({ FontFile: stream(t1Program) }),
    }), id, inflate);
    expect(widthOf(f, 0x41)).toBeCloseTo(0.742, 6);
    expect(widthOf(f, 0x42)).toBeCloseTo(0.333, 6);
  });

  it('measures an embedded TrueType through its own hmtx', () => {
    const f = new TextFont(dict({
      Subtype: name('TrueType'), BaseFont: name('AAAAAB+TestTtf'),
      FontDescriptor: dict({ FontFile2: stream(buildMinimalTtf()) }),
    }), id, inflate);
    // buildMinimalTtf is 1000/em and gives 'A' (gid 1) an advance of 600.
    expect(widthOf(f, 0x41)).toBeCloseTo(0.6, 6);
  });

  it('degrades to the Standard-14 guess when the program is unreadable', () => {
    const f = new TextFont(dict({
      Subtype: name('Type1'), BaseFont: name('Helvetica'),
      FontDescriptor: dict({ FontFile: stream(Uint8Array.from([1, 2, 3, 4])) }),
    }), id, inflate);
    expect(widthOf(f, 0x41)).toBeCloseTo(0.667, 3);   // Helvetica 'A'
  });

  it('leaves a Type 3 font measuring through its /FontMatrix', () => {
    // Regression guard for imxw.1: a Type 3 font has no /FontFile* and must not
    // reach the program path at all.
    const f = new TextFont(dict({
      Subtype: name('Type3'),
      FontMatrix: [0.01, 0, 0, 0.01, 0, 0],
      CharProcs: dict({}), Encoding: dict({}),
      FirstChar: 0x41, LastChar: 0x41, Widths: [50],
    }), id, inflate);
    expect(widthOf(f, 0x41)).toBeCloseTo(0.5, 6);     // 50 * 0.01
  });
});
