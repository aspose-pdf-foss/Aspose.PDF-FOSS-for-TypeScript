import { describe, it, expect } from 'vitest';
import { TextFont } from '../src/font.js';
import { PdfDict, PdfObject, name } from '../src/types.js';
import { buildManyGlyphTtf } from './helpers/build-optimize-pdf.js';

const dict = (o: Record<string, PdfObject>): PdfDict => new Map(Object.entries(o));
const id = (o: PdfObject | undefined) => o as PdfObject;
/** These fixtures carry the font program in `raw`, so "inflating" is identity. */
const inflate = (s: { raw: Uint8Array }) => s.raw;

/**
 * A program whose every glyph advances 700 — deliberately NOT 1000.
 *
 * `/DW` defaults to 1000 and `buildManyGlyphTtf`'s own default advance is 1000
 * too, so a fixture built on that default cannot tell the program's answer from
 * the default: every assertion passes whatever the code does.
 */
const PROGRAM = buildManyGlyphTtf(8, { advance: () => 700 });

/** A Type0/CIDFontType2 over `PROGRAM`, with `/CIDToGIDMap /Identity`. */
function type0(cidFontExtra: Record<string, PdfObject>): TextFont {
  return new TextFont(dict({
    Subtype: name('Type0'),
    BaseFont: name('TestFont'),
    Encoding: name('Identity-H'),
    DescendantFonts: [dict({
      Subtype: name('CIDFontType2'),
      CIDToGIDMap: name('Identity'),
      FontDescriptor: dict({
        Type: name('FontDescriptor'), FontName: name('TestFont'), Flags: 4,
        FontFile2: { kind: 'stream' as const, dict: dict({}), raw: PROGRAM },
      }),
      ...cidFontExtra,
    })],
  }), id, inflate as never);
}

/** The advance of one CID, in em units, through the public glyph decoder. */
const advanceOf = (f: TextFont, cid: number): number =>
  f.decodeGlyphs(Uint8Array.from([(cid >> 8) & 0xff, cid & 0xff]))[0].width;

describe('composite-font widths from the embedded program', () => {
  it('takes a CID stated in /W from /W, whatever the program says', () => {
    // The producer stated it. /W outranks everything, exactly as /Widths does.
    const f = type0({ W: [1, [500, 600]] });
    expect(advanceOf(f, 1)).toBeCloseTo(0.5);
    expect(advanceOf(f, 2)).toBeCloseTo(0.6);
  });

  it('measures a CID absent from /W from the program when /DW is ABSENT', () => {
    // THE CASE THIS ISSUE IS ABOUT. With no /DW the 1000 is a spec default, not
    // something the producer said -- so the font is silent and the program,
    // which is right there and knows, answers. Same rule the simple-font side
    // already holds for an absent /MissingWidth.
    const f = type0({ W: [1, [500, 600]] });
    expect(advanceOf(f, 3)).toBeCloseTo(0.7);      // the program, not 1.0
  });

  it('honours an EXPLICIT /DW over the program', () => {
    // A stated /DW is a statement, like a stated /MissingWidth -- including a
    // deliberate one that happens to equal the spec default.
    expect(advanceOf(type0({ W: [1, [500, 600]], DW: 900 }), 3)).toBeCloseTo(0.9);
    expect(advanceOf(type0({ W: [1, [500, 600]], DW: 1000 }), 3)).toBeCloseTo(1.0);
  });

  it('falls back to 1000 when there is no /DW and no usable program', () => {
    // Nothing to measure from: the spec default is the last resort, not the
    // first answer.
    const f = new TextFont(dict({
      Subtype: name('Type0'), BaseFont: name('TestFont'), Encoding: name('Identity-H'),
      DescendantFonts: [dict({ Subtype: name('CIDFontType2'), W: [1, [500]] })],
    }), id, inflate as never);
    expect(advanceOf(f, 3)).toBeCloseTo(1.0);
  });

  it('resolves the CID through /CIDToGIDMap, not as a raw glyph id', () => {
    // The map reverses gids 1 and 2, so a build that treats the CID as a gid
    // reads the wrong glyph's advance. Both are valid gids, so nothing throws.
    const map = new Uint8Array(8);          // CID 0->0, 1->2, 2->1, 3->3
    map[1 * 2 + 1] = 2; map[2 * 2 + 1] = 1; map[3 * 2 + 1] = 3;
    const prog = buildManyGlyphTtf(8, { advance: (gid) => gid === 2 ? 300 : 700 });
    const f = new TextFont(dict({
      Subtype: name('Type0'), BaseFont: name('TestFont'), Encoding: name('Identity-H'),
      DescendantFonts: [dict({
        Subtype: name('CIDFontType2'),
        CIDToGIDMap: { kind: 'stream' as const, dict: dict({}), raw: map },
        FontDescriptor: dict({
          Type: name('FontDescriptor'), FontName: name('TestFont'), Flags: 4,
          FontFile2: { kind: 'stream' as const, dict: dict({}), raw: prog },
        }),
      })],
    }), id, inflate as never);
    expect(advanceOf(f, 1)).toBeCloseTo(0.3);      // CID 1 -> gid 2 -> 300
    expect(advanceOf(f, 2)).toBeCloseTo(0.7);      // CID 2 -> gid 1 -> 700
  });
});
