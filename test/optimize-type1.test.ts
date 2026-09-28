import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';
import { Type1Font, eraseType1Glyphs } from '../src/type1.js';
import { decodeStream } from '../src/filters.js';
import { isDict, isStream, PdfStream } from '../src/types.js';
import { buildType1, t1cs, t1num } from './helpers/build-type1.js';
import { buildType1Pdf } from './helpers/build-type1-pdf.js';

const REAL = new Uint8Array(readFileSync(new URL('./fixtures/fonts/NimbusSans-Regular.t1', import.meta.url)));

/** The /FontFile stream of the saved document's only font. */
function fontFile(pdf: Uint8Array): PdfStream {
  const doc = Document.Open(pdf);
  const font = doc.resolve(doc.Pages[0].Resources!.get('Font'));
  if (!isDict(font)) throw new Error('no /Font');
  const f1 = doc.resolve(font.get('F1'));
  const fd = isDict(f1) ? doc.resolve(f1.get('FontDescriptor')) : undefined;
  const ff = isDict(fd) ? doc.resolve(fd.get('FontFile')) : undefined;
  if (!isStream(ff)) throw new Error('no /FontFile');
  return ff;
}

describe('Optimize — Type 1 /FontFile', () => {
  it('shrinks the real Nimbus program and renders identically', () => {
    const pdf = buildType1Pdf(REAL, { text: 'AVA', size: 40 });
    const before = Document.Open(pdf).Pages[0].ToImage();
    const doc = Document.Open(pdf);
    const report = doc.Optimize();
    expect(report.skipped).toEqual([]);
    expect(report.fonts).toHaveLength(1);
    expect(report.fonts[0].bytesSaved).toBeGreaterThan(10_000);
    expect(report.fonts[0].gidsKept).toBe(3);                 // A, V, .notdef
    const saved = doc.Save();
    expect(saved.length).toBeLessThan(pdf.length);
    expect(Document.Open(saved).Pages[0].ToImage()).toEqual(before);
    expect(Document.Open(saved).Pages[0].GetText()).toBe(Document.Open(pdf).Pages[0].GetText());
  });

  it('keeps every glyph name defined, blanks the unused outlines, and states true lengths', () => {
    const doc = Document.Open(buildType1Pdf(REAL, { text: 'AVA', size: 40 }));
    doc.Optimize();
    const ff = fontFile(doc.Save());
    const bytes = decodeStream(ff);
    const orig = new Type1Font(REAL);
    const out = new Type1Font(bytes);
    expect(out.numGlyphs).toBe(orig.numGlyphs);
    for (let gid = 0; gid < orig.numGlyphs; gid++) expect(out.glyphName(gid)).toBe(orig.glyphName(gid));
    const A = orig.gidForName('A')!, B = orig.gidForName('B')!;
    expect(out.glyphPath(A)).toEqual(orig.glyphPath(A));
    expect(orig.glyphPath(B).length).toBeGreaterThan(0);
    expect(out.glyphPath(B)).toEqual([]);
    const l1 = ff.dict.get('Length1') as number, l2 = ff.dict.get('Length2') as number;
    const l3 = ff.dict.get('Length3') as number;
    expect(l1 + l2 + l3).toBe(bytes.length);
    expect(String.fromCharCode(...bytes.subarray(l1 - 6, l1)).trim()).toBe('eexec');
    expect(String.fromCharCode(...bytes.subarray(l1 + l2)).trim().endsWith('cleartomark')).toBe(true);
  });

  it('keeps the base and accent a used seac glyph composes from', () => {
    const box = (x: number) => t1cs(t1num(0), t1num(500), 13, t1num(x), t1num(0), 21,
      t1num(100), 6, t1num(100), 7, t1num(-100), 6, 9, 14);
    const program = buildType1({
      charstrings: {
        '.notdef': t1cs(t1num(0), t1num(500), 13, 14),
        A: box(50),
        acute: box(300),
        Aacute: t1cs(t1num(0), t1num(500), 13, t1num(0), t1num(0), t1num(0), t1num(65), t1num(194), 12, 6),
        B: box(200),
      },
    });
    const pdf = buildType1Pdf(program, { text: 'A', size: 40, differences: [[65, 'Aacute']] });
    const before = Document.Open(pdf).Pages[0].ToImage();
    const doc = Document.Open(pdf);
    const report = doc.Optimize();
    expect(report.fonts).toHaveLength(1);
    const out = new Type1Font(decodeStream(fontFile(doc.Save())));
    for (const n of ['A', 'acute', 'Aacute']) expect(out.glyphPath(out.gidForName(n)!).length).toBeGreaterThan(0);
    expect(out.glyphPath(out.gidForName('B')!)).toEqual([]);
    expect(Document.Open(doc.Save()).Pages[0].ToImage()).toEqual(before);
  });

  it('leaves the font whole, with the reason, when a code names no defined glyph', () => {
    const pdf = buildType1Pdf(REAL, { text: 'AB', size: 40, differences: [[66, 'nosuchglyph']] });
    const doc = Document.Open(pdf);
    const report = doc.Optimize();
    expect(report.fonts).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].reason).toBe('code 66 names /nosuchglyph, which the Type1 program does not define');
    expect(decodeStream(fontFile(doc.Save()))).toEqual(REAL);
  });

  it('leaves the font whole when a code resolves to no glyph name at all', () => {
    // Code 1 is unassigned in StandardEncoding and nothing else names it.
    const doc = Document.Open(buildType1Pdf(REAL, { text: '\\001', size: 40 }));
    const report = doc.Optimize();
    expect(report.fonts).toEqual([]);
    expect(report.skipped[0].reason).toBe('code 1 resolves to no glyph name');
  });
});

describe('eraseType1Glyphs', () => {
  const charstrings = {
    '.notdef': t1cs(t1num(0), t1num(500), 13, 14),
    A: t1cs(t1num(0), t1num(500), 13, t1num(10), t1num(0), 21, t1num(100), 6, t1num(100), 7, 9, 14),
    B: t1cs(t1num(0), t1num(500), 13, t1num(20), t1num(0), 21, t1num(200), 6, t1num(200), 7, 9, 14),
  };

  for (const [label, spec] of [
    ['a PFA with binary eexec', {}],
    ['a hex eexec section', { hexEexec: true }],
    ['a PFB', { pfb: true }],
    ['a -| RD token', { rdToken: '-|' as const }],
    ['a nonstandard lenIV', { lenIV: 1 }],
  ] as const) {
    it(`round-trips ${label}`, () => {
      const input = buildType1({ charstrings, ...spec });
      const orig = new Type1Font(input);
      const out = eraseType1Glyphs(input, new Set(['.notdef', 'A']));
      expect(out.length1 + out.length2 + out.length3).toBe(out.bytes.length);
      const t = new Type1Font(out.bytes);
      expect(t.numGlyphs).toBe(3);
      expect(t.glyphPath(t.gidForName('A')!)).toEqual(orig.glyphPath(orig.gidForName('A')!));
      expect(t.glyphPath(t.gidForName('B')!)).toEqual([]);
      expect(t.glyphWidth(t.gidForName('B')!)).toBe(0);
    });
  }

  it('keeps /Subrs, which a kept glyph may call', () => {
    const input = buildType1({
      charstrings: { '.notdef': charstrings['.notdef'], A: t1cs(t1num(0), t1num(500), 13, t1num(0), 10, 14) },
      subrs: [t1cs(t1num(10), t1num(0), 21, t1num(100), 6, t1num(100), 7, 9, 11)],
    });
    const out = new Type1Font(eraseType1Glyphs(input, new Set(['.notdef', 'A'])).bytes);
    expect(out.glyphPath(out.gidForName('A')!).length).toBeGreaterThan(0);
  });
});
