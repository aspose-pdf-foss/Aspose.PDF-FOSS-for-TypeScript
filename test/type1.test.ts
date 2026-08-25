import { describe, it, expect } from 'vitest';
import { Type1Font } from '../src/type1.js';
import { Document } from '../src/document.js';
import { PdfParseError } from '../src/errors.js';
import { buildType1, eexecStart, t1num, t1cs, Type1Spec } from './helpers/build-type1.js';
import { buildType1Pdf } from './helpers/build-type1-pdf.js';
import { decodePng } from './helpers/decode-png.js';

/** Fraction of pixels substantially darker than the white page. */
function inkFraction(png: Uint8Array): number {
  const img = decodePng(png);
  let ink = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const [r, g, b] = img.at(x, y);
      if (r < 128 && g < 128 && b < 128) ink++;
    }
  }
  return ink / (img.width * img.height);
}

/** A square from (0,0) to (`side`,`side`), left sidebearing 0, width 600. */
const square = (side: number): Uint8Array => t1cs(
  t1num(0), t1num(600), 13,
  t1num(0), t1num(0), 21,
  t1num(side), 6, t1num(side), 7, t1num(-side), 6,
  9, 14,
);

const base: Type1Spec = {
  charstrings: { '.notdef': t1cs(t1num(0), t1num(600), 13, 14), A: square(700), B: square(400) },
};

describe('Type1Font — container', () => {
  it('reads the charstrings, their names, and the glyph order', () => {
    const f = new Type1Font(buildType1(base));
    expect(f.numGlyphs).toBe(3);
    expect(f.glyphName(0)).toBe('.notdef');
    expect(f.gidForName('A')).toBe(1);
    expect(f.gidForName('B')).toBe(2);
    expect(f.gidForName('C')).toBeUndefined();
  });

  it('interprets a charstring through the eexec and charstring decryption', () => {
    const f = new Type1Font(buildType1(base));
    expect(f.glyphPath(f.gidForName('A')!)).toEqual([
      { op: 'M', x: 0, y: 0 }, { op: 'L', x: 700, y: 0 },
      { op: 'L', x: 700, y: 700 }, { op: 'L', x: 0, y: 700 }, { op: 'Z' },
    ]);
    expect(f.glyphWidth(f.gidForName('A')!)).toBe(600);
  });

  it('reads unitsPerEm from /FontMatrix', () => {
    expect(new Type1Font(buildType1(base)).unitsPerEm).toBe(1000);
    const half = buildType1({ ...base, fontMatrix: [0.0005, 0, 0, 0.0005, 0, 0] });
    expect(new Type1Font(half).unitsPerEm).toBe(2000);
  });

  it('honours a non-default /lenIV', () => {
    // Asserted on coordinates, not segment count: skipping the wrong number of
    // bytes leaves the tail of the random pad on the stack, where hsbw reads it
    // as the sidebearing and width. The square still has five segments — it is
    // just in the wrong place, with the wrong advance.
    const f = new Type1Font(buildType1({ ...base, lenIV: 7 }));
    const gid = f.gidForName('B')!;
    expect(f.glyphPath(gid)).toEqual([
      { op: 'M', x: 0, y: 0 }, { op: 'L', x: 400, y: 0 },
      { op: 'L', x: 400, y: 400 }, { op: 'L', x: 0, y: 400 }, { op: 'Z' },
    ]);
    expect(f.glyphWidth(gid)).toBe(600);
  });

  it('reads a hex-encoded eexec section', () => {
    const f = new Type1Font(buildType1({ ...base, hexEexec: true }));
    expect(f.glyphPath(f.gidForName('A')!)[1]).toEqual({ op: 'L', x: 700, y: 0 });
  });

  it('strips PFB segment headers', () => {
    const f = new Type1Font(buildType1({ ...base, pfb: true }));
    expect(f.gidForName('A')).toBe(1);
    expect(f.glyphPath(1)).toHaveLength(5);
  });

  it('accepts the -| / |- / | spellings of RD / ND / NP', () => {
    const f = new Type1Font(buildType1({ ...base, rdToken: '-|', subrs: [t1cs(11)] }));
    expect(f.glyphPath(f.gidForName('A')!)).toHaveLength(5);
  });

  it('calls a subr by the index the font gives it', () => {
    const subrs: Uint8Array[] = [];
    for (let i = 0; i < 12; i++) subrs[i] = t1cs(11);
    subrs[9] = t1cs(t1num(250), 6, 11);
    const f = new Type1Font(buildType1({
      subrs,
      charstrings: {
        '.notdef': t1cs(14),
        S: t1cs(t1num(0), t1num(600), 13, t1num(0), t1num(0), 21, t1num(9), 10, 14),
      },
    }));
    expect(f.glyphPath(f.gidForName('S')!)).toEqual([
      { op: 'M', x: 0, y: 0 }, { op: 'L', x: 250, y: 0 }, { op: 'Z' },
    ]);
  });

  it('reports the program’s own /Encoding when it has one', () => {
    const f = new Type1Font(buildType1({ ...base, encoding: { 65: 'A', 66: 'B' } }));
    const enc = f.builtinEncodingNames()!;
    expect(enc.get(65)).toBe('A');
    expect(enc.get(66)).toBe('B');
    expect(enc.get(67)).toBeUndefined();
  });

  it('reports no built-in encoding when the program says StandardEncoding', () => {
    // Not an empty map: "predefined" and "none" are different answers, and only
    // the caller knows that the predefined one is the Annex D table.
    expect(new Type1Font(buildType1(base)).builtinEncodingNames()).toBeUndefined();
  });

  it('resolves seac through StandardEncoding names', () => {
    const f = new Type1Font(buildType1({
      charstrings: {
        '.notdef': t1cs(14),
        A: t1cs(t1num(0), t1num(600), 13, t1num(0), t1num(0), 21, t1num(100), 6, 14),
        acute: t1cs(t1num(0), t1num(300), 13, t1num(0), t1num(0), 21, t1num(50), 7, 14),
        Aacute: t1cs(t1num(0), t1num(600), 13, t1num(0), t1num(20), t1num(400), t1num(65), t1num(194), 12, 6),
      },
    }));
    expect(f.glyphPath(f.gidForName('Aacute')!)).toEqual([
      { op: 'M', x: 0, y: 0 }, { op: 'L', x: 100, y: 0 }, { op: 'Z' },
      { op: 'M', x: 20, y: 400 }, { op: 'L', x: 20, y: 450 }, { op: 'Z' },
    ]);
  });

  it('throws PdfParseError on bytes that are not a Type 1 program', () => {
    expect(() => new Type1Font(Uint8Array.from([1, 2, 3, 4]))).toThrow(PdfParseError);
  });

  it('throws PdfParseError when the encrypted portion yields no /CharStrings', () => {
    const good = buildType1(base);
    const wrecked = good.slice();
    // Corrupt from just inside the encrypted portion onward. eexec is a
    // stream cipher, so damaging one byte scrambles everything after it.
    wrecked.fill(0, eexecStart(good) + 8);
    expect(() => new Type1Font(wrecked)).toThrow(PdfParseError);
  });
});

describe('Type 1 /FontFile in the render path', () => {
  // A glyph nothing in Helvetica resembles: a solid full-em block. Rendered
  // from the embedded program it floods its em square; rendered from the
  // Standard-14 substitute, 'A' is a thin outline triangle covering a fraction
  // of it. The two are separated by an order of magnitude, not by a threshold
  // that needs tuning.
  const block = t1cs(
    t1num(0), t1num(1000), 13,
    t1num(0), t1num(0), 21,
    t1num(1000), 6, t1num(1000), 7, t1num(-1000), 6,
    9, 14,
  );
  const notdef = t1cs(t1num(0), t1num(1000), 13, 14);
  const program = buildType1({
    charstrings: { '.notdef': notdef, A: block },
    encoding: { 0x41: 'A' },
  });

  it('renders outlines from the embedded program, not the substitute face', () => {
    const doc = Document.Open(buildType1Pdf(program, { text: 'AAAA', size: 48 }));
    // Four 48pt solid blocks on a 240x100 page: ~4 * 48*48 / 24000 ~= 0.38.
    expect(inkFraction(doc.Pages[0].ToImage())).toBeGreaterThan(0.25);
  });

  it('reaches the program through /Differences when the font dict names a glyph', () => {
    const named = buildType1({ charstrings: { '.notdef': notdef, blockglyph: block } });
    const doc = Document.Open(buildType1Pdf(named, {
      text: 'AAAA', size: 48, differences: [[0x41, 'blockglyph']],
    }));
    expect(inkFraction(doc.Pages[0].ToImage())).toBeGreaterThan(0.25);
  });

  it('falls back to the substitute face when the program is unreadable', () => {
    const wrecked = program.slice();
    wrecked.fill(0, eexecStart(program) + 8);
    const doc = Document.Open(buildType1Pdf(wrecked, { text: 'AAAA', size: 48 }));
    const ink = inkFraction(doc.Pages[0].ToImage());
    expect(ink).toBeGreaterThan(0);        // still draws: the substitute took over
    expect(ink).toBeLessThan(0.25);        // but not solid blocks
  });
});
