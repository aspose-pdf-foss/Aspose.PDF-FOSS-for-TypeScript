import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { parseContentStream, type ContentOp } from '../src/content.js';
import { isDict, name, type PdfObject } from '../src/types.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import type { UndrawableText } from '../src/replacefont.js';
import { buildSimpleTextPdf, buildFormTextPdf, buildSharedFormPagesPdf } from './helpers/build-text-pdf.js';
import { buildSimpleTtfPdf } from './helpers/build-optimize-pdf.js';

const DIR = fileURLToPath(new URL('./fixtures/fonts/', import.meta.url));
const NIMBUS = new Uint8Array(readFileSync(new URL('./fixtures/fonts/NimbusSans-Regular.otf', import.meta.url)));
const LIB = new Uint8Array(readFileSync(new URL('./fixtures/fonts/LiberationSans-Regular.woff2', import.meta.url)));
const OMEGA = 'Ω';

const plain = (stream: string) => Document.Open(buildSimpleTextPdf(stream));
/** Text after a Save/Open round trip. An embedded font's Type0 dict is filled
 *  by the finalize pass at Save, so text drawn in one decodes only after it. */
const savedText = (doc: Document, page = 0): string => Document.Open(doc.Save()).Pages[page].GetText();
const ops = (doc: Document): ContentOp[] => parseContentStream(doc.Pages[0].Contents);
const shape = (doc: Document): string[] => ops(doc)
  .filter((op) => ['Tj', 'TJ', 'Tf', "'", '"'].includes(op.operator))
  .map((op) => op.operator === 'Tf' ? `Tf ${(op.operands[0] as { name: string }).name}` : op.operator);
/** A page drawn in a Nimbus Sans SUBSET (Type0 Identity-H), reopened from bytes. */
const nimbusDoc = (text: string): Document => {
  const d = Document.New(PageFormat.A4);
  d.Pages[0].AddText(text, 50, 700, { font: d.AddFont(NIMBUS) });
  return Document.Open(d.Save());
};

describe('ReplaceText tier A: the original font, verified', () => {
  it('refuses a glyph a subset blanked instead of drawing nothing', () => {
    const d = Document.Open(buildSimpleTtfPdf({ encoding: name('WinAnsiEncoding'), content: '(A)' }));
    d.Optimize();
    const doc = Document.Open(d.Save());
    const before = doc.Save();
    expect(() => doc.Pages[0].ReplaceText('A', 'B')).toThrow(UnsupportedFeatureError);
    expect(doc.Save()).toEqual(before);
  });

  it('refuses a character the embedded program does not map', () => {
    const doc = Document.Open(buildSimpleTtfPdf({ encoding: name('WinAnsiEncoding'), content: '(A)' }));
    expect(() => doc.Pages[0].ReplaceText('A', 'C')).toThrow(/page 1/);
  });

  it('re-encodes Type0 subset text from glyphs the subset holds', () => {
    const doc = nimbusDoc('Draft');
    expect(doc.Pages[0].ReplaceText('Draft', 'tfarD')).toBe(1);
    expect(doc.Pages[0].GetText()).toBe('tfarD');
  });
});

describe('ReplaceText tier B: fallback fonts', () => {
  it('writes only the characters the original cannot draw in the fallback', () => {
    const doc = plain('BT /F1 12 Tf 20 250 Td (aXb) Tj ET');
    const lib = doc.AddFont(LIB);
    expect(doc.Pages[0].ReplaceText('X', `c${OMEGA}d`, { fallbackFonts: [lib] })).toBe(1);
    expect(savedText(doc)).toBe(`ac${OMEGA}db`);
    expect(shape(doc)).toEqual(['Tf F1', 'Tj', 'Tf F0', 'Tj', 'Tf F1', 'Tj']);
  });

  it('is byte-identical to before when the original draws everything', () => {
    const a = plain('BT /F1 12 Tf 20 250 Td (aXb) Tj ET');
    const b = plain('BT /F1 12 Tf 20 250 Td (aXb) Tj ET');
    a.Pages[0].ReplaceText('X', 'c');
    b.Pages[0].ReplaceText('X', 'c', { fallbackFonts: [b.AddFont(LIB)] });
    expect(b.Pages[0].Contents).toEqual(a.Pages[0].Contents);
  });

  it('draws text after the replacement in the original font again', () => {
    const doc = plain('BT /F1 12 Tf 20 250 Td (aX) Tj (tail) Tj ET');
    doc.Pages[0].ReplaceText('X', OMEGA, { fallbackFonts: [doc.AddFont(LIB)] });
    const [m] = doc.Pages[0].Search('tail');
    expect(m.hits[0].font.name).toBe('Helvetica');
    expect(m.hits[0].tfKey).toBe('F1');
  });

  it('accepts a Standard-14 fallback for a Type0 subset', () => {
    const doc = nimbusDoc('Draft');
    expect(doc.Pages[0].ReplaceText('Draft', 'Draft!', { fallbackFonts: ['Helvetica'] })).toBe(1);
    expect(doc.Pages[0].GetText()).toBe('Draft!');
  });

  it('splits a TJ, keeping its kerns', () => {
    const doc = plain('BT /F1 12 Tf 20 250 Td [(aX) -50 (b)] TJ ET');
    doc.Pages[0].ReplaceText('X', OMEGA, { fallbackFonts: [doc.AddFont(LIB)] });
    expect(shape(doc)).toEqual(['Tf F1', 'TJ', 'Tf F0', 'Tj', 'Tf F1', 'TJ']);
    const last = ops(doc).filter((op) => op.operator === 'TJ').pop()!.operands[0] as PdfObject[];
    expect(last[0]).toBe(-50);
  });

  it("keeps the line move of ' on its first piece", () => {
    const doc = plain("BT /F1 12 Tf 14 TL 20 250 Td (aXb) ' ET");
    doc.Pages[0].ReplaceText('X', OMEGA, { fallbackFonts: [doc.AddFont(LIB)] });
    expect(shape(doc)).toEqual(['Tf F1', "'", 'Tf F0', 'Tj', 'Tf F1', 'Tj']);
  });

  it('registers the fallback in a Form XObject’s own resources', () => {
    const doc = Document.Open(buildFormTextPdf('q /Fm0 Do Q', 'BT /F1 12 Tf 20 250 Td (aXb) Tj ET'));
    doc.Pages[0].ReplaceText('X', OMEGA, { fallbackFonts: [doc.AddFont(LIB)] });
    expect(savedText(doc)).toBe(`a${OMEGA}b`);
    const pageFonts = doc.resolve(doc.Pages[0].Resources!.get('Font'));
    expect(isDict(pageFonts) && pageFonts.has('F0')).toBe(false);
  });
});

describe('ReplaceText: word spacing on a two-byte fallback run (u3l5.8)', () => {
  // `Tw` applies only to the ONE-BYTE code 32, and an embedded fallback is
  // written as Type0 2-byte codes. The oracle is the same edit under `Tw 0`:
  // with `Tw 6` the replacement's one space must be exactly 6 points wider.
  const run = (tw: number, adjust?: 'shiftRest') => {
    const doc = plain(`BT /F1 12 Tf ${tw} Tw 20 250 Td (aX) Tj 40 0 Td (t) Tj ET`);
    doc.Pages[0].ReplaceText('X', 'c d', { font: doc.AddFont(LIB), adjust });
    return doc;
  };
  const xOf = (doc: Document, s: string): number => Document.Open(doc.Save()).Pages[0].Search(s)[0].quads[0][0];

  it('spaces the run as the text it replaced', () => {
    expect(xOf(run(6), 'd') - xOf(run(0), 'd')).toBeCloseTo(6, 6);
  });

  it('measures the run as drawn, so shiftRest moves the rest by the same', () => {
    expect(xOf(run(6, 'shiftRest'), 't') - xOf(run(0, 'shiftRest'), 't')).toBeCloseTo(6, 6);
  });

  it('writes the kern after the space in a TJ, and nothing new without Tw', () => {
    const tj = ops(run(6)).find((op) => op.operator === 'TJ')!.operands[0] as PdfObject[];
    expect(tj.filter((x) => typeof x === 'number')).toEqual([-500]);
    expect(ops(run(0)).some((op) => op.operator === 'TJ')).toBe(false);
  });
});

describe('ReplaceText on a page outside the page tree (u3l5.8)', () => {
  it('names the page by kind, not as page 0', () => {
    const doc = Document.New(PageFormat.A4);
    const t = doc.NewTemplate(200, 100);
    t.page.AddText('aXb', 10, 50);
    expect(() => t.page.ReplaceText('X', OMEGA)).toThrow(/a page outside the page tree/);
    const seen: UndrawableText[] = [];
    t.page.ReplaceText('X', OMEGA, { onUndrawable: (r) => seen.push(r) });
    expect(seen.map((r) => r.page)).toEqual([0]);
  });
});

describe('ReplaceText: scopes that cannot switch font', () => {
  it('cannot switch in a form whose font is inherited from the page', () => {
    const doc = Document.Open(buildFormTextPdf('BT /F1 12 Tf ET /Fm0 Do', 'BT 20 250 Td (aXb) Tj ET', { formFont: false }));
    expect(doc.Pages[0].GetText()).toBe('aXb');
    expect(() => doc.Pages[0].ReplaceText('X', OMEGA, { fallbackFonts: [doc.AddFont(LIB)] }))
      .toThrow(UnsupportedFeatureError);
  });

  it('cannot switch in a form with no resources of its own', () => {
    const doc = Document.Open(buildFormTextPdf('q /Fm0 Do Q', 'BT /F1 12 Tf 20 250 Td (aXb) Tj ET', { formResources: false }));
    expect(doc.Pages[0].GetText()).toBe('aXb');
    expect(() => doc.Pages[0].ReplaceText('X', OMEGA, { fallbackFonts: [doc.AddFont(LIB)] }))
      .toThrow(UnsupportedFeatureError);
  });
});

describe('ReplaceText tier C: the same face from registered folders', () => {
  it('switches to the registered face the subset was cut from', () => {
    const doc = nimbusDoc('Draft');
    doc.RegisterFontFolder(DIR);
    expect(() => doc.Pages[0].ReplaceText('Draft', 'Fixed')).toThrow(UnsupportedFeatureError);
    expect(doc.Pages[0].ReplaceText('Draft', 'Fixed', { matchRegisteredFonts: true })).toBe(1);
    expect(savedText(doc)).toBe('Fixed');
  });
});

describe('ReplaceText reporting and atomicity', () => {
  it('reports what nothing could draw and leaves it out', () => {
    const doc = plain('BT /F1 12 Tf 20 250 Td (aXb) Tj ET');
    const seen: UndrawableText[] = [];
    expect(doc.Pages[0].ReplaceText('X', `${OMEGA}c`, { onUndrawable: (r) => seen.push(r) })).toBe(1);
    expect(seen).toEqual([{ page: 1, match: 'X', missing: [OMEGA] }]);
    expect(doc.Pages[0].GetText()).toBe('acb');
  });

  it('refuses document-wide when a later page cannot draw', () => {
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddText('Hello', 50, 700);
    d.AddPage(PageFormat.A4).page.AddText('Hello', 50, 700, { font: d.AddFont(NIMBUS) });
    const doc = Document.Open(d.Save());
    expect(() => doc.ReplaceText('Hello', 'Q')).toThrow(/page 2/);
    expect(doc.Pages[0].GetText()).toBe('Hello');
  });

  it('takes the same options on the document', () => {
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddText('Hello', 50, 700);
    d.AddPage(PageFormat.A4).page.AddText('Hello', 50, 700, { font: d.AddFont(NIMBUS) });
    const doc = Document.Open(d.Save());
    expect(doc.ReplaceText('Hello', 'Q', { fallbackFonts: ['Helvetica'] })).toBe(2);
    expect(doc.Pages.map((p) => p.GetText())).toEqual(['Q', 'Q']);
  });

  it('validates options before reading any page', () => {
    const doc = plain('BT /F1 12 Tf 20 250 Td (aXb) Tj ET');
    expect(() => doc.ReplaceText('X', 'c', { fallbackFonts: 'Helvetica' as never })).toThrow(TypeError);
    expect(doc.Pages[0].GetText()).toBe('aXb');
  });
});

describe('doc.ReplaceText over pages that share resources and a form', () => {
  // Both pages reach ONE form through ONE indirect /Resources dict, so applying
  // page 1 repoints the form for page 2 as well. A plan made against the
  // original form must not be applied to the edited one.
  it('replaces each occurrence once, all original font', () => {
    const doc = Document.Open(buildSharedFormPagesPdf('BT /F1 12 Tf 20 250 Td (aXbXc) Tj ET'));
    expect(doc.Pages.map((p) => p.GetText())).toEqual(['aXbXc', 'aXbXc']);
    expect(doc.ReplaceText('X', 'YY')).toBe(2);
    expect(doc.Pages.map((p) => p.GetText())).toEqual(['aYYbYYc', 'aYYbYYc']);
  });

  it('replaces each occurrence once, with a fallback run', () => {
    const doc = Document.Open(buildSharedFormPagesPdf('BT /F1 12 Tf 20 250 Td (aXbXc) Tj ET'));
    doc.ReplaceText('X', OMEGA, { fallbackFonts: [doc.AddFont(LIB)] });
    const saved = Document.Open(doc.Save());
    expect(saved.Pages.map((p) => p.GetText())).toEqual([`a${OMEGA}b${OMEGA}c`, `a${OMEGA}b${OMEGA}c`]);
  });
});
