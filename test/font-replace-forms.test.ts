import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { isDict, isName, isStream, isString, name, type PdfDict, type PdfObject, type PdfStream } from '../src/types.js';
import { visitFormContent, visitContent } from '../src/text.js';
import { getStd14Sfnt } from '../src/std14fonts.js';
import { buildFontReplacePdf, simpleFont } from './helpers/build-font-replace-pdf.js';

const IDENTITY: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];

/** A page with one filled text field, its appearance drawn in Helvetica. */
function formDoc(): Document {
  const doc = Document.New(PageFormat.custom(300, 200));
  doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'f', value: 'Hello' });
  return Document.Open(doc.Save());
}
function widget(doc: Document): PdfDict {
  const annots = doc.resolve(doc.Pages[0].Dict.get('Annots')) as PdfObject[];
  return doc.resolve(annots[0]) as PdfDict;
}
function normal(doc: Document, w = widget(doc)): PdfStream {
  const ap = doc.resolve(w.get('AP')) as PdfDict;
  const n = doc.resolve(ap.get('N'));
  if (!isStream(n)) throw new Error('no /N stream');
  return n;
}
/** The appearance's glyphs: text, font and pen start. */
function apGlyphs(doc: Document, s = normal(doc), fallback?: PdfDict): { text: string; font: string; x: number }[] {
  const out: { text: string; font: string; x: number }[] = [];
  visitFormContent(doc, s, fallback, IDENTITY, { glyph: (g) => out.push({ text: g.text, font: g.font.name ?? '', x: Math.round(g.quad[0] * 1000) / 1000 }) });
  return out;
}
const daOf = (doc: Document, d: PdfDict): string => {
  const da = doc.resolve(d.get('DA'));
  return isString(da) ? new TextDecoder().decode(da.bytes) : '';
};
function dr(doc: Document): PdfDict {
  const root = doc.resolve(doc.trailer.get('Root')) as PdfDict;
  const acro = doc.resolve(root.get('AcroForm')) as PdfDict;
  return doc.resolve(acro.get('DR')) as PdfDict;
}
function drFontNames(doc: Document): string[] {
  const root = doc.resolve(doc.trailer.get('Root')) as PdfDict;
  const acro = doc.resolve(root.get('AcroForm')) as PdfDict;
  const dr = doc.resolve(acro.get('DR')) as PdfDict;
  const fonts = doc.resolve(dr.get('Font')) as PdfDict;
  return [...fonts.values()].map((v) => (doc.resolve(v) as PdfDict).get('BaseFont') as { name: string }).map((n) => n.name).sort();
}
/** Every font dict in the saved file, by /BaseFont. */
function fileFonts(doc: Document): string[] {
  const saved = Document.Open(doc.Save());
  const out: string[] = [];
  for (const [, o] of saved.objectEntries()) {
    if (isDict(o) && isName(o.get('Type')) && (o.get('Type') as { name: string }).name === 'Font') out.push((o.get('BaseFont') as { name: string }).name);
  }
  return out.sort();
}

describe('doc.ReplaceFont in forms and annotations (g0ky.5)', () => {
  it("rewrites a field's appearance and /DA, and the old font leaves the file", () => {
    const doc = formDoc();
    const before = apGlyphs(doc);
    expect(before.map((g) => g.font)).toEqual(['Helvetica', 'Helvetica', 'Helvetica', 'Helvetica', 'Helvetica']);
    const report = doc.ReplaceFont('Helvetica', 'Times-Roman');
    expect(report).toMatchObject({ pages: [1], glyphs: 5, appearances: 1, refused: [] });
    expect(report.defaultAppearances).toBeGreaterThanOrEqual(1);
    const after = Document.Open(doc.Save());
    const g = apGlyphs(after);
    expect(g.map((x) => `${x.text}:${x.font}`).join(' ')).toBe('H:Times-Roman e:Times-Roman l:Times-Roman l:Times-Roman o:Times-Roman');
    expect(g.map((x) => x.x)).toEqual(before.map((x) => x.x));
    expect(daOf(after, widget(after))).not.toContain('/Helv ');
    expect(drFontNames(after)).toEqual(['Times-Roman']);
    expect(fileFonts(doc)).toEqual(['Times-Roman']);
  });

  it('leaves /DA and /DR alone for an embedded font, rewriting only the drawn appearance', () => {
    const doc = formDoc();
    const lib = doc.AddFont(getStd14Sfnt('Times-Roman')!.raw);
    const da = daOf(doc, widget(doc));
    const report = doc.ReplaceFont('Helvetica', lib);
    expect(report).toMatchObject({ appearances: 1, defaultAppearances: 0 });
    const after = Document.Open(doc.Save());
    expect(daOf(after, widget(after))).toBe(da);
    expect(drFontNames(after)).toEqual(['Helvetica']);
    expect(apGlyphs(after).map((g) => g.font.replace(/^[A-Z]{6}\+/, ''))).toEqual(Array(5).fill('LiberationSerif'));
  });

  it('rewrites an appearance two annotations share once', () => {
    const doc = formDoc();
    const w = widget(doc);
    const annots = doc.resolve(doc.Pages[0].Dict.get('Annots')) as PdfObject[];
    const twin: PdfDict = new Map(w);
    twin.delete('Parent'); twin.delete('T');
    annots.push(doc.allocObject(twin));
    const report = doc.ReplaceFont('Helvetica', 'Times-Roman');
    expect(report.appearances).toBe(1);
    expect(report.glyphs).toBe(5);
    const after = Document.Open(doc.Save());
    const annots2 = after.resolve(after.Pages[0].Dict.get('Annots')) as PdfObject[];
    for (const a of annots2) expect(apGlyphs(after, normal(after, after.resolve(a) as PdfDict)).map((g) => g.font)).toEqual(Array(5).fill('Times-Roman'));
  });
});

/** Add an annotation to page 1 whose /N is `content`, with `resources`
 *  (omitted: none of its own). */
function addAppearance(doc: Document, content: string, resources?: PdfDict): PdfStream {
  const raw = new TextEncoder().encode(content);
  const dict: PdfDict = new Map<string, PdfObject>([['Type', name('XObject')], ['Subtype', name('Form')], ['BBox', [0, 0, 300, 200]], ['Length', raw.length]]);
  if (resources) dict.set('Resources', resources);
  const stream: PdfStream = { kind: 'stream', dict, raw };
  const annot: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Annot')], ['Subtype', name('Square')], ['Rect', [0, 0, 300, 200]],
    ['AP', new Map<string, PdfObject>([['N', doc.allocObject(stream)]])],
  ]);
  doc.Pages[0].Dict.set('Annots', [doc.allocObject(annot)]);
  return stream;
}
const pageRes = (doc: Document, cat: string): PdfDict => doc.resolve(doc.Pages[0].Resources!.get(cat)) as PdfDict;
function pageGlyphXs(doc: Document): string[] {
  const out: string[] = [];
  visitContent(doc, doc.Pages[0], { glyph: (g) => out.push(`${g.font.name}@${Math.round(g.quad[0] * 1000) / 1000}`) });
  return out;
}

describe('ReplaceFont, annotation appearances that share or lack resources (g0ky.5)', () => {
  it('copies a form an appearance draws, so page content drawing the same form under another font is untouched', () => {
    const doc = Document.Open(buildFontReplacePdf({
      fonts: { Times: simpleFont('Times-Roman'), Courier: simpleFont('Courier') },
      forms: { X: { content: 'BT 20 50 Td (shared) Tj ET', fonts: {} } },
      pages: [{ content: 'BT /F2 24 Tf ET /Fm0 Do', fonts: { F1: 'Times', F2: 'Courier' }, forms: { Fm0: 'X' } }],
    }));
    const page = pageGlyphXs(doc);
    let times: PdfObject | undefined;
    for (const [r, o] of doc.objectEntries()) if (isDict(o) && (o.get('BaseFont') as { name?: string })?.name === 'Times-Roman') times = r;
    addAppearance(doc, 'BT /F1 24 Tf ET /X Do', new Map<string, PdfObject>([
      ['Font', new Map<string, PdfObject>([['F1', times!]])],
      ['XObject', new Map<string, PdfObject>([['X', pageRes(doc, 'XObject').get('Fm0')!]])],
    ]));
    const report = doc.ReplaceFont('Times-Roman', 'Helvetica');
    expect(report).toMatchObject({ appearances: 1, glyphs: 6, refused: [] });
    const after = Document.Open(doc.Save());
    expect(pageGlyphXs(after)).toEqual(page);
    expect(apGlyphs(after, normal(after)).map((g) => g.font)).toEqual(Array(6).fill('Helvetica'));
  });

  it('gives an appearance with no /Resources of its own a copy of /DR, and /DR loses the old font', () => {
    const doc = formDoc();
    // The field's appearance, rebuilt with no /Resources -- it reads
    // /AcroForm /DR -- drawing in the field's /Helv AND a second /DR font.
    (doc.resolve(dr(doc).get('Font')) as PdfDict).set('Co', doc.allocObject(simpleFont('Courier')));
    const body = new TextEncoder().encode('BT /Helv 12 Tf 2 5 Td (Hello) Tj ET BT /Co 12 Tf 2 20 Td (c) Tj ET');
    const ap = doc.resolve(widget(doc).get('AP')) as PdfDict;
    ap.set('N', doc.allocObject({ kind: 'stream', dict: new Map<string, PdfObject>([['Subtype', name('Form')], ['BBox', [0, 0, 200, 30]], ['Length', body.length]]), raw: body }));
    expect(apGlyphs(doc, normal(doc), dr(doc)).map((g) => g.font)).toEqual([...Array(5).fill('Helvetica'), 'Courier']);
    const report = doc.ReplaceFont('Helvetica', 'Times-Roman');
    expect(report.appearances).toBe(1);
    const after = Document.Open(doc.Save());
    // Read with NO fallback: the appearance must now carry every name it uses.
    expect(apGlyphs(after, normal(after)).map((g) => g.font)).toEqual([...Array(5).fill('Times-Roman'), 'Courier']);
    expect(drFontNames(after)).toEqual(['Courier', 'Times-Roman']);
    expect(fileFonts(doc)).toEqual(['Courier', 'Times-Roman']);
  });
});

describe('ReplaceFont fallbackFonts (g0ky.5)', () => {
  const cyr = new Map<string, PdfObject>([['Type', name('Encoding')], ['BaseEncoding', name('WinAnsiEncoding')], ['Differences', [65, name('uni0416')]]]);
  const doc = (): Document => Document.Open(buildFontReplacePdf({
    fonts: { Times: simpleFont('Times-Roman', cyr) },
    pages: [{ content: 'BT /F1 24 Tf 20 100 Td (xAy) Tj ET', fonts: { F1: 'Times' } }],
  }));

  it('writes a glyph `to` cannot draw in the first fallback that can, keeping positions', () => {
    const d = doc();
    const lib = d.AddFont(getStd14Sfnt('Helvetica')!.raw);
    const xsOf = (x: Document): number[] => { const o: number[] = []; visitContent(x, x.Pages[0], { glyph: (g) => o.push(Math.round(g.quad[0] * 1000) / 1000) }); return o; };
    const before = xsOf(d);
    const report = d.ReplaceFont('Times-Roman', 'Helvetica', { fallbackFonts: ['Courier', lib] });
    expect(report.undrawable).toEqual([]);
    expect(report.glyphs).toBe(3);
    const after = Document.Open(d.Save());
    const page = after.Pages[0];
    expect(page.GetText()).toBe('xЖy');
    // Courier has no Cyrillic, so the second fallback draws it.
    expect(page.GetTextFragments().map((f) => (f.fontName ?? '').replace(/^[A-Z]{6}\+/, ''))).toEqual(['Helvetica', 'LiberationSans', 'Helvetica']);
    expect(before).toHaveLength(3);
    expect(xsOf(after)).toEqual(before);
  });

  it('refuses a fallback of the wrong kind', () => {
    expect(() => doc().ReplaceFont('Times-Roman', 'Helvetica', { fallbackFonts: ['Arial' as 'Courier'] })).toThrow(TypeError);
    expect(() => doc().ReplaceFont('Times-Roman', 'Helvetica', { fallbackFonts: 'Courier' as unknown as ['Courier'] })).toThrow(TypeError);
  });
});
