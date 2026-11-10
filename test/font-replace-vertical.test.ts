import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';
import { isDict, isName, name, type PdfDict, type PdfObject } from '../src/types.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { getStd14Sfnt } from '../src/std14fonts.js';
import { buildFontReplacePdf, simpleFont } from './helpers/build-font-replace-pdf.js';

const str = (s: string): PdfObject => ({ kind: 'string', bytes: new TextEncoder().encode(s) });
const TU = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n'
  + '1 begincodespacerange <0000> <FFFF> endcodespacerange\n'
  + '1 beginbfrange <0020> <02FF> <0020> endbfrange\nendcmap end end';

/** A non-embedded composite font writing vertically, whose glyphs advance
 *  1.2 em down -- not the 1 em `to`'s vertical twin states, so keeping
 *  positions needs a kern. */
function verticalFont(doc: Document, baseFont = 'VertSerif'): PdfObject {
  const tu = doc.allocObject({ kind: 'stream', dict: new Map<string, PdfObject>([['Length', TU.length]]), raw: new TextEncoder().encode(TU) });
  return doc.allocObject(new Map<string, PdfObject>([
    ['Type', name('Font')], ['Subtype', name('Type0')], ['BaseFont', name(baseFont)], ['Encoding', name('Identity-V')],
    ['ToUnicode', tu],
    ['DescendantFonts', [new Map<string, PdfObject>([
      ['Type', name('Font')], ['Subtype', name('CIDFontType2')], ['BaseFont', name(baseFont)], ['DW2', [880, -1200]],
      ['CIDSystemInfo', new Map<string, PdfObject>([['Registry', str('Adobe')], ['Ordering', str('Identity')], ['Supplement', 0]])],
    ])]],
  ]));
}

/** One page: `content`, with F1 a Times-Roman simple font and V1 the vertical font. */
function open(content: string, baseFont?: string): Document {
  const doc = Document.Open(buildFontReplacePdf({
    fonts: { times: simpleFont('Times-Roman') },
    pages: [{ content, fonts: { F1: 'times' } }],
  }));
  (doc.resolve(doc.Pages[0].Resources!.get('Font')) as PdfDict).set('V1', verticalFont(doc, baseFont));
  return doc;
}
const glyphs = (doc: Document): GlyphEvent[] => { const out: GlyphEvent[] = []; visitContent(doc, doc.Pages[0], { glyph: (g) => { out.push(g); } }); return out; };
const pens = (gs: GlyphEvent[]): number[][] => gs.map((g) => [Math.round(g.tm[4] * 1000) / 1000, Math.round(g.tm[5] * 1000) / 1000]);
const fontName = (g: GlyphEvent): string => (g.font.name ?? '').replace(/^[A-Z]{6}\+/, '');
const encodingOf = (doc: Document, g: GlyphEvent): string | undefined => {
  const e = doc.resolve(g.font.dict.get('Encoding'));
  return isName(e) ? e.name : undefined;
};
const nimbus = (doc: Document) => doc.AddFont(new Uint8Array(readFileSync('test/fixtures/fonts/NimbusSans-Regular.otf')));
const VERT = 'BT /V1 20 Tf 100 300 Td <004100420043> Tj ET';

describe('ReplaceFont: vertical fonts (g0ky.8)', () => {
  it('writes vertical text in the vertical twin of an embedded font, keeping every pen position', () => {
    const doc = open(VERT);
    const before = pens(glyphs(doc));
    const r = doc.ReplaceFont('VertSerif', nimbus(doc));
    expect(r).toMatchObject({ refused: [], glyphs: 3, pages: [1] });
    const saved = Document.Open(doc.Save());
    const g = glyphs(saved);
    expect(g.map((x) => x.text).join('')).toBe('ABC');
    expect(g.every((x) => x.vertical)).toBe(true);
    expect(new Set(g.map(fontName))).toEqual(new Set(['NimbusSans-Regular']));
    expect(encodingOf(saved, g[0])).toBe('Identity-V');
    expect(pens(g)).toEqual(before);
    expect(saved.Fonts.map((f) => f.name)).not.toContain('VertSerif');
  });

  it("with positions: 'natural' advances each glyph by the twin's 1 em", () => {
    const doc = open(VERT);
    doc.ReplaceFont('VertSerif', nimbus(doc), { positions: 'natural' });
    const ys = pens(glyphs(Document.Open(doc.Save()))).map((p) => p[1]);
    expect(ys).toEqual([300, 280, 260]);
  });

  it('keeps horizontal and vertical uses of one font name apart: Identity-H and Identity-V over one descendant', () => {
    const doc = open(`BT /F1 20 Tf 20 100 Td (Hi) Tj ET ${VERT}`, 'Times-Roman');
    const r = doc.ReplaceFont('Times-Roman', nimbus(doc));
    expect(r).toMatchObject({ refused: [], glyphs: 5, fonts: 2 });
    const saved = Document.Open(doc.Save());
    const g = glyphs(saved);
    expect(g.map((x) => `${x.text}:${x.vertical ? 'V' : 'H'}:${encodingOf(saved, x)}`)).toEqual([
      'H:H:Identity-H', 'i:H:Identity-H', 'A:V:Identity-V', 'B:V:Identity-V', 'C:V:Identity-V',
    ]);
    const d = (x: GlyphEvent): PdfObject | undefined => saved.resolve((saved.resolve(x.font.dict.get('DescendantFonts')) as PdfObject[])[0]);
    expect(d(g[0])).toBe(d(g[2]));
    const dw2 = (d(g[2]) as PdfDict).get('DW2');
    expect(dw2).toEqual([880, -1000]);
  });

  it('writes a vertical glyph `to` cannot draw in the vertical twin of a fallback font', () => {
    const doc = open('BT /V1 20 Tf 100 300 Td <004101800042> Tj ET');
    const before = pens(glyphs(doc));
    const lib = doc.AddFont(getStd14Sfnt('Helvetica')!.raw);
    const r = doc.ReplaceFont('VertSerif', nimbus(doc), { fallbackFonts: ['Times-Roman', lib] });
    expect(r).toMatchObject({ refused: [], glyphs: 3, undrawable: [] });
    const saved = Document.Open(doc.Save());
    const g = glyphs(saved);
    expect(g.map((x) => `${x.text}:${fontName(x)}:${encodingOf(saved, x)}`)).toEqual([
      'A:NimbusSans-Regular:Identity-V', 'ƀ:LiberationSans:Identity-V', 'B:NimbusSans-Regular:Identity-V',
    ]);
    expect(pens(g)).toEqual(before);
  });

  it('still refuses vertical text for a Standard-14 font, which cannot write vertically', () => {
    const doc = open(VERT);
    const before = doc.Save();
    expect(doc.ReplaceFont('VertSerif', 'Helvetica').refused).toEqual([{ page: 1, reason: 'vertical' }]);
    expect(Buffer.compare(before, doc.Save())).toBe(0);
  });

  it('repoints an ExtGState /Font selecting a vertical font at the vertical twin', () => {
    const doc = open('BT /GS0 gs 100 300 Td <00410042> Tj ET');
    const res = doc.Pages[0].Resources!;
    const v = (doc.resolve(res.get('Font')) as PdfDict).get('V1')!;
    res.set('ExtGState', new Map<string, PdfObject>([['GS0', new Map<string, PdfObject>([['Font', [v, 20]]])]]));
    const before = pens(glyphs(doc));
    expect(doc.ReplaceFont('VertSerif', nimbus(doc))).toMatchObject({ refused: [], glyphs: 2 });
    const saved = Document.Open(doc.Save());
    const g = glyphs(saved);
    expect(g.every((x) => x.vertical && encodingOf(saved, x) === 'Identity-V')).toBe(true);
    expect(pens(g)).toEqual(before);
    expect(isDict(saved.resolve(saved.Pages[0].Resources!.get('ExtGState')))).toBe(true);
  });
});

describe('ReplaceFont: a vertical font that draws nothing, with a Standard-14 to (g0ky.8 review)', () => {
  it('leaves a Tf selecting it alone rather than failing', () => {
    const doc = open('BT /V1 10 Tf /F1 10 Tf 20 100 Td (AB) Tj ET', 'Times-Roman');
    const r = doc.ReplaceFont('Times-Roman', 'Helvetica');
    expect(r).toMatchObject({ refused: [], glyphs: 2 });
    const g = glyphs(Document.Open(doc.Save()));
    expect(g.map((x) => `${x.text}:${fontName(x)}`)).toEqual(['A:Helvetica', 'B:Helvetica']);
  });

  it('leaves an unused ExtGState selecting it alone rather than failing', () => {
    const doc = open('BT /F1 10 Tf 20 100 Td (AB) Tj ET', 'Times-Roman');
    const res = doc.Pages[0].Resources!;
    const v = (doc.resolve(res.get('Font')) as PdfDict).get('V1')!;
    res.set('ExtGState', new Map<string, PdfObject>([['GV', new Map<string, PdfObject>([['Font', [v, 10]]])]]));
    expect(doc.ReplaceFont('Times-Roman', 'Helvetica')).toMatchObject({ refused: [], glyphs: 2 });
  });
});

describe('glyph usage reads a vertical twin (g0ky.8 review)', () => {
  it('scans an Identity-V font completely, so Optimize can still subset its program', async () => {
    const { collectGlyphUsage } = await import('../src/glyphusage.js');
    const doc = open(VERT);
    doc.ReplaceFont('VertSerif', nimbus(doc));
    const saved = Document.Open(doc.Save());
    const twin = glyphs(saved)[0].font.dict;
    const u = collectGlyphUsage(saved).get(twin);
    expect(u?.complete).toBe(true);
    expect(u?.gids.size).toBe(3);
  });
});
