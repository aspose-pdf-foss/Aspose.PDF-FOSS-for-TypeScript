import { describe, it, expect } from 'vitest';
import { TextFont } from '../src/font.js';
import { PdfDict, PdfObject, name } from '../src/types.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dict = (o: Record<string, PdfObject>): PdfDict => new Map(Object.entries(o));
const bytes = (...b: number[]) => Uint8Array.from(b);

const id = (o: PdfObject | undefined) => o as PdfObject;
/** These fixtures carry their CMap text in `raw`, so "inflating" is identity. */
const inflate = (s: { raw: Uint8Array }) => s.raw;
const cmapStream = (text: string, extra: Record<string, PdfObject> = {}) =>
  ({ kind: 'stream' as const, dict: dict(extra), raw: enc(text) });

/** A Type0 font over one descendant CIDFont, with `/W` keyed by CID. */
function type0(encoding: PdfObject, w?: PdfObject[], extra: Record<string, PdfObject> = {}): TextFont {
  return new TextFont(dict({
    Subtype: name('Type0'),
    BaseFont: name('KozMinPr6N-Regular'),
    Encoding: encoding,
    DescendantFonts: [dict({
      Subtype: name('CIDFontType0'),
      DW: 1000,
      ...(w ? { W: w } : {}),
    })],
    ...extra,
  }), id, inflate as never);
}

describe('a predefined /Encoding name', () => {
  it('decodes through the bundled CMap', () => {
    // UniJIS-UCS2-H: <3041> <3093> 842, so U+3042 is CID 843.
    const f = type0(name('UniJIS-UCS2-H'));
    const glyphs = f.decodeGlyphs(bytes(0x30, 0x42));
    expect(glyphs.length).toBe(1);
    expect(glyphs[0].byteLen).toBe(2);
    expect(glyphs[0].cid).toBe(843);
  });

  it('takes one byte or two, as the CMap codespace requires', () => {
    // 90ms-RKSJ-H is Shift-JIS: 1 byte for ASCII and half-width katakana.
    const f = type0(name('90ms-RKSJ-H'));
    const glyphs = f.decodeGlyphs(bytes(0x41, 0x82, 0xa0, 0xb1));
    expect(glyphs.map((g) => g.byteLen)).toEqual([1, 2, 1]);
    expect(glyphs.map((g) => g.byteStart)).toEqual([0, 1, 3]);
    expect(glyphs.map((g) => g.cid)).toEqual([
      231 + (0x41 - 0x20),   // <20> <7d> 231
      843,                    // <829f> <82f1> 842
      326 + (0xb1 - 0xa0),   // <a0> <df> 326
    ]);
  });

  it('reports codeWidth as the narrowest code the encoding admits', () => {
    expect(type0(name('UniJIS-UCS2-H')).codeWidth).toBe(2);
    expect(type0(name('90ms-RKSJ-H')).codeWidth).toBe(1);
    expect(type0(name('Identity-H')).codeWidth).toBe(2);
  });

  it('decodes each collection from the acceptance criteria', () => {
    const cid = (cmap: string, ...b: number[]) => type0(name(cmap)).decodeGlyphs(bytes(...b))[0].cid;
    expect(cid('UniJIS-UCS2-H', 0x30, 0x42)).toBe(843);   // Adobe-Japan1
    expect(cid('UniGB-UCS2-H', 0x4e, 0x00)).toBe(4162);   // Adobe-GB1
    expect(cid('UniCNS-UCS2-H', 0x4e, 0x00)).toBe(595);   // Adobe-CNS1
    expect(cid('UniKS-UCS2-H', 0xac, 0x00)).toBe(1086);   // Adobe-Korea1
  });
});

describe('/W is keyed by CID, not by code', () => {
  it('measures a glyph by the CID its CMap produced', () => {
    // Code <3042> maps to CID 843. A /W naming CID 843 must be what applies —
    // looking the width up by the code instead finds nothing and silently
    // returns /DW, so the text measures at the default width throughout.
    const f = type0(name('UniJIS-UCS2-H'), [843, [500]]);
    expect(f.decodeGlyphs(bytes(0x30, 0x42))[0].width).toBeCloseTo(0.5);
    expect(f.decodeRun(bytes(0x30, 0x42)).width).toBeCloseTo(0.5);
  });

  it('does not apply a width keyed by the raw code', () => {
    // 0x3042 is the code, not the CID; nothing should match it.
    const f = type0(name('UniJIS-UCS2-H'), [0x3042, [500]]);
    expect(f.decodeGlyphs(bytes(0x30, 0x42))[0].width).toBeCloseTo(1); // /DW 1000
  });

  it('still measures an Identity font by code, since there CID = code', () => {
    const f = type0(name('Identity-H'), [3, [500]]);
    expect(f.decodeGlyphs(bytes(0x00, 0x03))[0].width).toBeCloseTo(0.5);
  });
});

describe('usecmap chains', () => {
  it('inherits the parent codespace and mappings from a predefined name', () => {
    // UniJIS-UCS2-V declares no codespace and restates ~100 codes.
    const f = type0(name('UniJIS-UCS2-V'));
    expect(f.decodeGlyphs(bytes(0x20, 0x10))[0].cid).toBe(7893); // its own
    expect(f.decodeGlyphs(bytes(0x30, 0x42))[0].cid).toBe(843);  // inherited
  });

  it('follows a chain two links long', () => {
    const f = type0(name('ETenms-B5-V'));
    expect(f.decodeGlyphs(bytes(0xa1, 0x5d))[0].cid).toBe(130);  // its own
    expect(f.decodeGlyphs(bytes(0x20))[0].cid).toBe(1);           // ETenms-B5-H
    expect(f.decodeGlyphs(bytes(0xa4, 0x40))[0].cid).toBe(595);  // ETen-B5-H
  });

  it('resolves an embedded CMap that names a predefined parent', () => {
    const stream = cmapStream(
      '/UniJIS-UCS2-H usecmap\n' +
      '/CMapName /Custom-H def\n' +
      '1 begincidrange\n<3042> <3042> 9999\nendcidrange\n'
    );
    const f = type0(stream as never);
    // Its own restatement wins...
    expect(f.decodeGlyphs(bytes(0x30, 0x42))[0].cid).toBe(9999);
    // ...and everything else, codespace included, comes from the parent.
    expect(f.decodeGlyphs(bytes(0x30, 0x43))[0].cid).toBe(844);
  });

  it('follows a /UseCMap entry in the stream dict', () => {
    // The other of the two parent mechanisms: a PDF object, not a name inside
    // the CMap text.
    const stream = cmapStream(
      '/CMapName /Custom-H def\n1 begincidrange\n<3042> <3042> 9999\nendcidrange\n',
      { UseCMap: name('UniJIS-UCS2-H') },
    );
    const f = type0(stream as never);
    expect(f.decodeGlyphs(bytes(0x30, 0x42))[0].cid).toBe(9999);
    expect(f.decodeGlyphs(bytes(0x30, 0x43))[0].cid).toBe(844);
  });

  it('prefers the stream dict /UseCMap over the name inside the text', () => {
    const stream = cmapStream(
      '/UniGB-UCS2-H usecmap\n1 begincidrange\n<0041> <0041> 7\nendcidrange\n',
      { UseCMap: name('UniJIS-UCS2-H') },
    );
    // U+4E00 is CID 1200 in Japan1 and 4162 in GB1; the dict entry must win.
    expect(type0(stream as never).decodeGlyphs(bytes(0x4e, 0x00))[0].cid).toBe(1200);
  });

  it('does not hang on a /UseCMap that points at itself', () => {
    const self: Record<string, PdfObject> = {};
    const stream = cmapStream(
      '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
      '1 begincidrange\n<0041> <0041> 7\nendcidrange\n', self);
    self.UseCMap = stream as never;
    const f = type0(stream as never);
    expect(f.decodeGlyphs(bytes(0x00, 0x41))[0].cid).toBe(7);
  });
});

describe('an /Encoding the font cannot resolve', () => {
  it('degrades an unknown name to Identity rather than throwing', () => {
    const f = type0(name('NoSuchCMap-H'));
    expect(f.codeWidth).toBe(2);
    expect(f.wmode).toBe(0);
    expect(f.decodeGlyphs(bytes(0x00, 0x03))[0].cid).toBe(3);
  });

  it('keeps a vertical unknown name vertical', () => {
    // Identity-V rather than Identity-H, so /WMode survives a CMap we do not
    // have. Decoding is identical either way — the writing mode is the only
    // thing that distinguishes the two fallbacks, and dropping it turns a
    // vertical run horizontal.
    const f = type0(name('NoSuchCMap-V'));
    expect(f.wmode).toBe(1);
    expect(f.decodeGlyphs(bytes(0x00, 0x03))[0].cid).toBe(3);
  });

  it('reports the writing mode of a CMap it does resolve', () => {
    expect(type0(name('UniJIS-UCS2-H')).wmode).toBe(0);
    expect(type0(name('UniJIS-UCS2-V')).wmode).toBe(1);
    expect(type0(name('Identity-V')).wmode).toBe(1);
  });

  it('falls back to fixed-width codes when there is no /Encoding at all', () => {
    const f = new TextFont(dict({
      Subtype: name('Type0'),
      DescendantFonts: [dict({ Subtype: name('CIDFontType0'), DW: 1000 })],
    }), id, inflate as never);
    expect(f.codeWidth).toBe(2);
    expect(f.decodeGlyphs(bytes(0x00, 0x03)).length).toBe(1);
  });

  it('does not throw on a CMap stream that will not parse', () => {
    const stream = { kind: 'stream' as const, dict: dict({}), raw: bytes(0x29, 0x7b, 0xff) };
    expect(() => type0(stream as never).decodeGlyphs(bytes(0x00, 0x41))).not.toThrow();
  });
});

describe('word spacing under a composite font', () => {
  it('applies to a single-byte code 32 only', () => {
    // 32000-1 9.3.3: Tw applies to the one-byte code 32, including in a
    // composite font that defines it as one byte — which the RKSJ CMaps do.
    const f = type0(name('90ms-RKSJ-H'));
    expect(f.decodeRun(bytes(0x20)).nWordSpaces).toBe(1);
    // Two-byte code 0x2020 is not a word space, even though its high byte is 32.
    const g = type0(name('UniJIS-UCS2-H'));
    expect(g.decodeRun(bytes(0x20, 0x20)).nWordSpaces).toBe(0);
  });

  it('reads the width of the code itself, not the font\'s narrowest', () => {
    // A CMap whose narrowest code is one byte but which also has a two-byte
    // code of value 32. Testing `codeWidth === 1` instead of this code's own
    // length calls that a word space and applies Tw to it — and no real CMap
    // separates the two, so only a synthetic one can hold the rule in place.
    const stream = cmapStream(
      '2 begincodespacerange\n<30> <30>\n<0000> <00FF>\nendcodespacerange\n' +
      '1 begincidrange\n<0020> <0020> 5\nendcidrange\n'
    );
    const f = type0(stream as never);
    expect(f.codeWidth).toBe(1);
    const run = f.decodeRun(bytes(0x00, 0x20));
    expect(run.ncodes).toBe(1);              // one two-byte code
    expect(run.nWordSpaces).toBe(0);
  });
});
