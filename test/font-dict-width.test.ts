import { describe, it, expect } from 'vitest';
import { TextFont } from '../src/font.js';
import { PdfDict, PdfObject, name } from '../src/types.js';
import { buildManyGlyphTtf } from './helpers/build-optimize-pdf.js';

const dict = (o: Record<string, PdfObject>): PdfDict => new Map(Object.entries(o));
const id = (o: PdfObject | undefined) => o as PdfObject;
/** These fixtures carry the font program in `raw`, so "inflating" is identity. */
const inflate = (s: { raw: Uint8Array }) => s.raw;

/**
 * A program whose every glyph advances 700 — deliberately NOT 1000, and
 * deliberately not the 600 the dictionary states below. `buildCmap` maps
 * 'A' (65) to gid 1 and 'B' (66) to gid 2, so both codes resolve.
 */
const PROGRAM = buildManyGlyphTtf(8, { advance: () => 700 });

/** A simple TrueType font. `widths` is the /Widths array starting at 65. */
function simple(opts: {
  widths?: number[];
  missingWidth?: number;
  embed?: boolean;
}): TextFont {
  const descriptor: Record<string, PdfObject> = {
    Type: name('FontDescriptor'), FontName: name('TestFont'), Flags: 32,
  };
  if (opts.missingWidth !== undefined) descriptor.MissingWidth = opts.missingWidth;
  if (opts.embed === true) {
    descriptor.FontFile2 = { kind: 'stream' as const, dict: dict({}), raw: PROGRAM };
  }
  const font: Record<string, PdfObject> = {
    Subtype: name('TrueType'),
    BaseFont: name('TestFont'),
    Encoding: name('WinAnsiEncoding'),
    FontDescriptor: dict(descriptor),
  };
  if (opts.widths !== undefined) {
    font.FirstChar = 65;
    font.LastChar = 65 + opts.widths.length - 1;
    font.Widths = opts.widths;
  }
  return new TextFont(dict(font), id, inflate as never);
}

describe('TextFont.dictWidth', () => {
  it('returns the width the /Widths array states', () => {
    expect(simple({ widths: [600] }).dictWidth(65)).toBeCloseTo(0.6, 6);
  });

  it('returns /MissingWidth for a code the array does not cover', () => {
    expect(simple({ widths: [600], missingWidth: 250 }).dictWidth(66)).toBeCloseTo(0.25, 6);
  });

  it('is UNDEFINED where the dictionary states nothing', () => {
    // The whole point. `Glyph.width` falls through to the embedded program
    // here, so comparing THAT against the program would compare a value with
    // itself and 8.4.5.6-1 could never fire.
    expect(simple({ widths: [600] }).dictWidth(66)).toBeUndefined();
  });

  it('is UNDEFINED for a font with no /Widths at all', () => {
    expect(simple({}).dictWidth(65)).toBeUndefined();
  });

  it('differs from Glyph.width exactly where the program takes over', () => {
    // Belt and braces on the rule above: for a code the dictionary does not
    // cover, `advance` answers from the program and this answers nothing.
    const font = simple({ widths: [600], embed: true });
    expect(font.dictWidth(66)).toBeUndefined();
    const [g] = font.decodeGlyphs(new Uint8Array([66]));
    expect(g.width).toBeCloseTo(0.7, 6);
    // ...and where the dictionary DOES state one, the two disagree, which is
    // the disagreement 8.4.5.6-1 exists to report.
    expect(font.dictWidth(65)).toBeCloseTo(0.6, 6);
    const [a] = font.decodeGlyphs(new Uint8Array([65]));
    expect(a.width).toBeCloseTo(0.6, 6);
  });
});
