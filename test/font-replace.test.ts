import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isDict, name, type PdfObject } from '../src/types.js';
import { visitContent } from '../src/text.js';
import { getStd14Sfnt } from '../src/std14fonts.js';
import { PageFormat } from '../src/pageformat.js';
import { buildFontReplacePdf, simpleFont, type PageSpec } from './helpers/build-font-replace-pdf.js';

/** Each glyph's text, font name and pen start, in content order. */
function glyphs(doc: Document, page = 0): { text: string; font: string; x: number; y: number }[] {
  const out: { text: string; font: string; x: number; y: number }[] = [];
  visitContent(doc, doc.Pages[page], {
    glyph: (g) => out.push({ text: g.text, font: (g.font.name ?? '').replace(/^[A-Z]{6}\+/, ''), x: g.quad[0], y: g.quad[1] }),
  });
  return out;
}
const xs = (gs: { x: number }[]): number[] => gs.map((g) => Math.round(g.x * 1000) / 1000);
const fontNames = (doc: Document): string[] => doc.Fonts.map((f) => f.name ?? '').sort();

const TIMES = { Times: simpleFont('Times-Roman') };
const page = (content: string, extra: Partial<PageSpec> = {}): PageSpec => ({ content, fonts: { F1: 'Times' }, ...extra });
const open = (o: Parameters<typeof buildFontReplacePdf>[0]): Document => Document.Open(buildFontReplacePdf(o));
const reopen = (doc: Document): Document => Document.Open(doc.Save());

describe('doc.ReplaceFont (g0ky.3)', () => {
  it('draws every glyph in the new font, at the same position, and drops the old font', () => {
    const doc = open({ fonts: TIMES, pages: [page('BT /F1 24 Tf 5 Tw 20 100 Td (Hello World) Tj ET')] });
    const before = glyphs(doc);
    const report = doc.ReplaceFont('Times-Roman', 'Helvetica');
    expect(report).toEqual({ fonts: 1, pages: [1], glyphs: 11, appearances: 0, patterns: 0, glyphProcedures: 0, defaultAppearances: 0, undrawable: [], refused: [] });
    const after = reopen(doc);
    const g = glyphs(after);
    expect(g.map((x) => x.text).join('')).toBe('Hello World');
    expect(new Set(g.map((x) => x.font))).toEqual(new Set(['Helvetica']));
    expect(xs(g)).toEqual(xs(before));
    expect(fontNames(after)).toEqual(['Helvetica']);
  });

  it("with positions: 'natural' lets the new advances stand", () => {
    const doc = open({ fonts: TIMES, pages: [page('BT /F1 24 Tf 20 100 Td (Hello World) Tj ET')] });
    const before = glyphs(doc);
    doc.ReplaceFont('Times-Roman', 'Helvetica', { positions: 'natural' });
    const g = glyphs(reopen(doc));
    expect(g[0].x).toBeCloseTo(before[0].x, 6);
    expect(g[10].x).not.toBeCloseTo(before[10].x, 1);
  });

  it('keeps positions in a TJ with kerns, under Tc, Tw and Tz, into an embedded (two-byte) font', () => {
    const doc = open({ fonts: TIMES, pages: [page('BT /F1 18 Tf 1.5 Tc 6 Tw 80 Tz 20 100 Td [(Wide) -250 (word spacing) 120 (x)] TJ ET')] });
    const before = glyphs(doc);
    const lib = doc.AddFont(getStd14Sfnt('Helvetica')!.raw);
    doc.ReplaceFont('Times-Roman', lib);
    const g = glyphs(reopen(doc));
    expect(g.map((x) => x.text).join('')).toBe('Wideword spacingx');
    expect(xs(g)).toEqual(xs(before));
    expect(fontNames(reopen(doc))).toEqual(['LiberationSans']);
  });

  it("keeps 'natural' spacing justified: a space moving to a two-byte font keeps its Tw", () => {
    const doc = open({ fonts: TIMES, pages: [page('BT /F1 18 Tf 10 Tw 20 100 Td (a b) Tj ET')] });
    const lib = doc.AddFont(getStd14Sfnt('Times-Roman')!.raw);
    const before = glyphs(doc);
    doc.ReplaceFont('Times-Roman', lib, { positions: 'natural' });
    const g = glyphs(reopen(doc));
    // Liberation Serif has Times's advances, so only a lost Tw could move 'b'.
    expect(g[2].x).toBeCloseTo(before[2].x, 3);
  });

  it('keeps a glyph the new font cannot draw in the old font, and reports it', () => {
    const cyr = new Map<string, PdfObject>([['Type', name('Encoding')], ['BaseEncoding', name('WinAnsiEncoding')], ['Differences', [65, name('uni0416')]]]);
    const doc = open({ fonts: { Times: simpleFont('Times-Roman', cyr) }, pages: [page('BT /F1 24 Tf 20 100 Td (xAyA) Tj ET')] });
    const before = glyphs(doc);
    const report = doc.ReplaceFont('Times-Roman', 'Helvetica');
    expect(report.glyphs).toBe(2);
    expect(report.undrawable).toEqual([{ page: 1, code: 65, text: 'Ж', count: 2 }]);
    const g = glyphs(reopen(doc));
    expect(g.map((x) => `${x.text}:${x.font}`)).toEqual(['x:Helvetica', 'Ж:Times-Roman', 'y:Helvetica', 'Ж:Times-Roman']);
    expect(xs(g)).toEqual(xs(before));
    expect(fontNames(reopen(doc))).toEqual(['Helvetica', 'Times-Roman']);
  });

  it('renames the font in a form, and in a form that inherits it from the page', () => {
    const doc = open({
      fonts: TIMES,
      forms: {
        Own: { content: 'BT /F1 24 Tf 20 150 Td (own) Tj ET', fonts: { F1: 'Times' } },
        Inherits: { content: 'BT 20 50 Td (inherited) Tj ET', fonts: {} },
        Bare: { content: 'BT 20 20 Td (bare) Tj ET', resources: false },
      },
      pages: [page('/Fm0 Do BT /F1 24 Tf ET /Fm1 Do /Fm2 Do', { forms: { Fm0: 'Own', Fm1: 'Inherits', Fm2: 'Bare' } })],
    });
    const before = glyphs(doc);
    const report = doc.ReplaceFont('Times-Roman', 'Courier');
    expect(report.refused).toEqual([]);
    const after = reopen(doc);
    const g = glyphs(after);
    expect(g.map((x) => x.text).join('')).toBe('owninheritedbare');
    expect(new Set(g.map((x) => x.font))).toEqual(new Set(['Courier']));
    expect(xs(g)).toEqual(xs(before));
    expect(fontNames(after)).toEqual(['Courier']);
  });

  it('renames a form nested in a form, both drawing text', () => {
    const doc = open({
      fonts: TIMES,
      forms: {
        Outer: { content: 'BT /F1 24 Tf 20 150 Td (outer) Tj ET /Inner Do', fonts: { F1: 'Times' }, forms: { Inner: 'In' } },
        In: { content: 'BT /F1 24 Tf 20 50 Td (inner) Tj ET', fonts: { F1: 'Times' } },
      },
      pages: [page('/Fm0 Do', { forms: { Fm0: 'Outer' } })],
    });
    doc.ReplaceFont('Times-Roman', 'Helvetica');
    const g = glyphs(reopen(doc));
    expect(g.map((x) => `${x.text}:${x.font}`).join(' ')).toBe(
      'o:Helvetica u:Helvetica t:Helvetica e:Helvetica r:Helvetica i:Helvetica n:Helvetica n:Helvetica e:Helvetica r:Helvetica');
  });

  it('replaces every page, through resources several pages share, and takes an entry of doc.Fonts', () => {
    const doc = open({
      fonts: { ...TIMES, Courier: simpleFont('Courier') },
      pages: [
        page('BT /F1 24 Tf 20 100 Td (one) Tj /F2 24 Tf (keep) Tj ET', { fonts: { F1: 'Times', F2: 'Courier' } }),
        { content: 'BT /F1 24 Tf 20 100 Td (two) Tj ET', shareResourcesWith: 0 },
      ],
    });
    const times = doc.Fonts.find((f) => f.name === 'Times-Roman')!;
    const report = doc.ReplaceFont(times, 'Helvetica');
    expect(report.pages).toEqual([1, 2]);
    const after = reopen(doc);
    expect(glyphs(after, 0).map((g) => g.font)).toEqual(['Helvetica', 'Helvetica', 'Helvetica', 'Courier', 'Courier', 'Courier', 'Courier']);
    expect(glyphs(after, 1).map((g) => g.font)).toEqual(['Helvetica', 'Helvetica', 'Helvetica']);
    expect(fontNames(after)).toEqual(['Courier', 'Helvetica']);
  });

  it('replaces text in a form two pages share, on both pages', () => {
    const doc = open({
      fonts: TIMES,
      forms: { Head: { content: 'BT /F1 24 Tf 20 150 Td (head) Tj ET', fonts: { F1: 'Times' } } },
      pages: [page('/Fm0 Do', { forms: { Fm0: 'Head' } }), page('/Fm0 Do', { forms: { Fm0: 'Head' } })],
    });
    expect(doc.ReplaceFont('Times-Roman', 'Helvetica').pages).toEqual([1, 2]);
    const after = reopen(doc);
    for (const p of [0, 1]) expect(glyphs(after, p).map((g) => g.font)).toEqual(['Helvetica', 'Helvetica', 'Helvetica', 'Helvetica']);
    expect(fontNames(after)).toEqual(['Helvetica']);
  });

  it('replaces a composite font, re-encoding its two-byte codes from their Unicode', () => {
    const doc = Document.New(PageFormat.custom(400, 200));
    const lib = doc.AddFont(getStd14Sfnt('Times-Roman')!.raw);
    doc.Pages[0].AddText('Composite', 20, 100, { font: lib, fontSize: 24 });
    const saved = reopen(doc);
    const before = glyphs(saved);
    const name0 = saved.Fonts[0].name!;
    const report = saved.ReplaceFont(name0, 'Helvetica');
    expect(report.glyphs).toBe(9);
    const g = glyphs(reopen(saved));
    expect(g.map((x) => x.text).join('')).toBe('Composite');
    expect(xs(g)).toEqual(xs(before));
    expect(fontNames(reopen(saved))).toEqual(['Helvetica']);
  });

  it('matches a name with or without its subset tag', () => {
    const doc = open({ fonts: { T: simpleFont('ABCDEF+Times-Roman') }, pages: [page('BT /F1 24 Tf 20 100 Td (x) Tj ET', { fonts: { F1: 'T' } })] });
    expect(doc.ReplaceFont('Times-Roman', 'Helvetica').glyphs).toBe(1);
    const again = open({ fonts: { T: simpleFont('ABCDEF+Times-Roman') }, pages: [page('BT /F1 24 Tf 20 100 Td (x) Tj ET', { fonts: { F1: 'T' } })] });
    expect(again.ReplaceFont('ABCDEF+Times-Roman', 'Helvetica').glyphs).toBe(1);
  });

  it('gives a form drawn under the old font and another a copy for the old-font drawing', () => {
    const doc = open({
      fonts: { ...TIMES, Courier: simpleFont('Courier') },
      forms: { Shared: { content: 'BT 20 50 Td (twice) Tj ET', fonts: {} } },
      pages: [page('BT /F1 24 Tf ET /Fm0 Do 1 0 0 1 0 60 cm BT /F2 24 Tf ET /Fm0 Do', { fonts: { F1: 'Times', F2: 'Courier' }, forms: { Fm0: 'Shared' } })],
    });
    const before = glyphs(doc);
    expect(doc.ReplaceFont('Times-Roman', 'Helvetica')).toMatchObject({ pages: [1], glyphs: 5, refused: [] });
    const g = glyphs(reopen(doc));
    expect(g.map((x) => x.font)).toEqual([...Array(5).fill('Helvetica'), ...Array(5).fill('Courier')]);
    expect(xs(g)).toEqual(xs(before));
    expect(fontNames(reopen(doc))).toEqual(['Courier', 'Helvetica']);
  });

  it('splits at the form drawn twice, when the shared stream is nested below it', () => {
    const doc = open({
      fonts: { ...TIMES, Courier: simpleFont('Courier') },
      forms: { Outer: { content: '/In Do', fonts: {}, forms: { In: 'Inner' } }, Inner: { content: 'BT 20 50 Td (deep) Tj ET', fonts: {} } },
      pages: [page('BT /F1 24 Tf ET /Fm0 Do 1 0 0 1 0 60 cm BT /F2 24 Tf ET /Fm0 Do', { fonts: { F1: 'Times', F2: 'Courier' }, forms: { Fm0: 'Outer' } })],
    });
    expect(doc.ReplaceFont('Times-Roman', 'Helvetica').refused).toEqual([]);
    expect(glyphs(reopen(doc)).map((x) => x.font)).toEqual([...Array(4).fill('Helvetica'), ...Array(4).fill('Courier')]);
  });

  it('gives each drawing its own copy when they need different kerns', () => {
    // Only Tw at a space can make two drawings need different kerns, and only
    // into a two-byte font, which Tw does not reach: Tc and the size cancel.
    const doc = open({
      fonts: TIMES,
      forms: { Shared: { content: 'BT 20 50 Td (a b) Tj ET', fonts: {} } },
      pages: [page('BT /F1 24 Tf ET /Fm0 Do 1 0 0 1 0 60 cm BT 6 Tw ET /Fm0 Do', { forms: { Fm0: 'Shared' } })],
    });
    const before = glyphs(doc);
    expect(before).toHaveLength(6);
    const lib = doc.AddFont(getStd14Sfnt('Times-Roman')!.raw);
    expect(doc.ReplaceFont('Times-Roman', lib)).toMatchObject({ glyphs: 6, refused: [] });
    expect(xs(glyphs(reopen(doc)))).toEqual(xs(before));
  });

  it('keeps a glyph in the old font inside a form that reads its parent\'s resources, and keeps the old font there', () => {
    const cyr = new Map<string, PdfObject>([['Type', name('Encoding')], ['BaseEncoding', name('WinAnsiEncoding')], ['Differences', [65, name('uni0416')]]]);
    const doc = open({
      fonts: { Times: simpleFont('Times-Roman', cyr) },
      forms: { Bare: { content: 'BT /F1 24 Tf 20 50 Td (xA) Tj ET', resources: false } },
      pages: [page('/Fm0 Do', { forms: { Fm0: 'Bare' } })],
    });
    doc.ReplaceFont('Times-Roman', 'Helvetica');
    expect(glyphs(reopen(doc)).map((g) => `${g.text}:${g.font}`)).toEqual(['x:Helvetica', 'Ж:Times-Roman']);
  });

  it('registers the new font once per resource dictionary, however many Tf select the old one', () => {
    const doc = open({ fonts: TIMES, pages: [page('BT /F1 24 Tf 20 100 Td (a) Tj ET BT /F1 12 Tf 20 50 Td (b) Tj ET')] });
    doc.ReplaceFont('Times-Roman', 'Helvetica');
    const res = doc.resolve(doc.Pages[0].Dict.get('Resources'));
    const fonts = isDict(res) ? doc.resolve(res.get('Font')) : undefined;
    expect(isDict(fonts) ? [...fonts.keys()].length : -1).toBe(1);
  });

  it('finds a font dict written directly in the resources', () => {
    const doc = open({ fonts: TIMES, pages: [page('BT /F1 24 Tf 20 100 Td (x) Tj ET')] });
    const res = doc.resolve(doc.Pages[0].Dict.get('Resources'));
    const fonts = isDict(res) ? doc.resolve(res.get('Font')) : undefined;
    if (!isDict(fonts)) throw new Error('no fonts');
    fonts.set('F1', new Map(doc.resolve(fonts.get('F1')) as Map<string, PdfObject>));
    expect(doc.ReplaceFont('Times-Roman', 'Helvetica').glyphs).toBe(1);
  });

  it('refuses a vertical font', () => {
    const vert = new Map<string, PdfObject>([
      ['Type', name('Font')], ['Subtype', name('Type0')], ['BaseFont', name('MSMincho')], ['Encoding', name('Identity-V')],
      ['DescendantFonts', [new Map<string, PdfObject>([['Type', name('Font')], ['Subtype', name('CIDFontType2')], ['BaseFont', name('MSMincho')],
        ['CIDSystemInfo', new Map<string, PdfObject>([['Registry', { kind: 'string', bytes: new TextEncoder().encode('Adobe') }], ['Ordering', { kind: 'string', bytes: new TextEncoder().encode('Identity') }], ['Supplement', 0]])]])]],
    ]);
    const doc = open({ fonts: { V: vert }, pages: [page('BT /F1 24 Tf 200 150 Td <00410042> Tj ET', { fonts: { F1: 'V' } })] });
    expect(doc.ReplaceFont('MSMincho', 'Helvetica').refused).toEqual([{ page: 1, reason: 'vertical' }]);
    expect(doc.isModifiedInternal()).toBe(false);
  });

  it('replaces a font set through an ExtGState, repointing its /Font', () => {
    const doc = open({ fonts: TIMES, pages: [page('BT /GS0 gs 20 100 Td (Hello) Tj ET', { fonts: {}, gsFonts: { GS0: 'Times' } })] });
    const before = glyphs(doc);
    const report = doc.ReplaceFont('Times-Roman', 'Helvetica');
    expect(report).toMatchObject({ pages: [1], glyphs: 5, refused: [] });
    const after = reopen(doc);
    const g = glyphs(after);
    expect(g.map((x) => `${x.text}:${x.font}`).join(' ')).toBe('H:Helvetica e:Helvetica l:Helvetica l:Helvetica o:Helvetica');
    expect(xs(g)).toEqual(xs(before));
    expect(fontNames(after)).toEqual(['Helvetica']);
  });

  it('keeps a glyph the new font cannot draw in an ExtGState-set font', () => {
    const cyr = new Map<string, PdfObject>([['Type', name('Encoding')], ['BaseEncoding', name('WinAnsiEncoding')], ['Differences', [65, name('uni0416')]]]);
    const doc = open({ fonts: { Times: simpleFont('Times-Roman', cyr) }, pages: [page('BT /GS0 gs 20 100 Td (xA) Tj ET', { fonts: {}, gsFonts: { GS0: 'Times' } })] });
    doc.ReplaceFont('Times-Roman', 'Helvetica');
    expect(glyphs(reopen(doc)).map((g) => `${g.text}:${g.font}`)).toEqual(['x:Helvetica', 'Ж:Times-Roman']);
  });

  it('keeps an undrawable glyph in the old font inside a form that inherits it, registering it there', () => {
    const cyr = new Map<string, PdfObject>([['Type', name('Encoding')], ['BaseEncoding', name('WinAnsiEncoding')], ['Differences', [65, name('uni0416')]]]);
    const doc = open({
      fonts: { Times: simpleFont('Times-Roman', cyr) },
      forms: { F: { content: 'BT 20 50 Td (xA) Tj ET', fonts: {} } },
      pages: [page('BT /F1 24 Tf ET /Fm0 Do', { forms: { Fm0: 'F' } })],
    });
    const before = glyphs(doc);
    expect(doc.ReplaceFont('Times-Roman', 'Helvetica').refused).toEqual([]);
    const g = glyphs(reopen(doc));
    expect(g.map((x) => `${x.text}:${x.font}`)).toEqual(['x:Helvetica', 'Ж:Times-Roman']);
    expect(xs(g)).toEqual(xs(before));
  });

  it('reports nothing matched for an unknown name, and touches nothing', () => {
    const doc = open({ fonts: TIMES, pages: [page('BT /F1 24 Tf 20 100 Td (x) Tj ET')] });
    expect(doc.ReplaceFont('Garamond', 'Helvetica')).toEqual({ fonts: 0, pages: [], glyphs: 0, appearances: 0, patterns: 0, glyphProcedures: 0, defaultAppearances: 0, undrawable: [], refused: [] });
    expect(doc.isModifiedInternal()).toBe(false);
  });

  it('refuses arguments of the wrong kind before touching anything', () => {
    const doc = open({ fonts: TIMES, pages: [page('BT /F1 24 Tf 20 100 Td (x) Tj ET')] });
    expect(() => doc.ReplaceFont(3 as unknown as string, 'Helvetica')).toThrow(TypeError);
    expect(() => doc.ReplaceFont('Times-Roman', 'Arial' as unknown as 'Helvetica')).toThrow(TypeError);
    expect(() => doc.ReplaceFont('Times-Roman', 'Helvetica', { positions: 'loose' as 'keep' })).toThrow(RangeError);
    expect(doc.isModifiedInternal()).toBe(false);
  });

  it('leaves the font dict of the page resources as a fresh copy, never editing a shared one in place', () => {
    const doc = open({ fonts: TIMES, pages: [page('BT /F1 24 Tf 20 100 Td (x) Tj ET')] });
    const res = doc.resolve(doc.Pages[0].Dict.get('Resources'));
    const fonts = isDict(res) ? doc.resolve(res.get('Font')) : undefined;
    doc.ReplaceFont('Times-Roman', 'Helvetica');
    expect(isDict(fonts) && fonts.has('F1')).toBe(true);
  });
});

describe('ReplaceFont: an embedded `to` that would draw nothing (g0ky.11)', () => {
  const cyr = (): Map<string, PdfObject> => new Map<string, PdfObject>([['Type', name('Encoding')], ['BaseEncoding', name('WinAnsiEncoding')], ['Differences', [65, name('uni0416')]]]);

  it('leaves a page untouched when no glyph can be written in `to` or a fallback', async () => {
    const { buildUnicodeTtf } = await import('./helpers/build-sfnt.js');
    const doc = open({ fonts: { Times: simpleFont('Times-Roman', cyr()) }, pages: [page('BT /F1 24 Tf 20 100 Td (AA) Tj ET')] });
    const to = doc.AddFont(buildUnicodeTtf());
    const before = doc.Save();
    const r = doc.ReplaceFont('Times-Roman', to);
    expect(r).toMatchObject({ pages: [], glyphs: 0, undrawable: [{ page: 1, code: 65, text: 'Ж', count: 2 }] });
    expect(Buffer.compare(before, doc.Save())).toBe(0);
  });

  it('writes a valid font for a `to` only fallback runs surround', async () => {
    const { buildUnicodeTtf } = await import('./helpers/build-sfnt.js');
    const doc = open({ fonts: { Times: simpleFont('Times-Roman', cyr()) }, pages: [page('BT /F1 24 Tf 20 100 Td (A) Tj ET')] });
    const to = doc.AddFont(buildUnicodeTtf());
    const lib = doc.AddFont(getStd14Sfnt('Helvetica')!.raw);
    expect(doc.ReplaceFont('Times-Roman', to, { fallbackFonts: [lib] })).toMatchObject({ glyphs: 1, undrawable: [] });
    const saved = reopen(doc);
    const fonts = saved.resolve(saved.Pages[0].Resources!.get('Font')) as Map<string, PdfObject>;
    for (const v of fonts.values()) {
      const f = saved.resolve(v) as Map<string, PdfObject>;
      expect(isDict(f) && f.has('Subtype') && f.has('BaseFont')).toBe(true);
    }
    expect(glyphs(saved).map((x) => `${x.text}:${x.font}`)).toEqual(['Ж:LiberationSans']);
  });
});
