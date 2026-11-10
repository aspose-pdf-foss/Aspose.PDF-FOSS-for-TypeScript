import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isName, name, type PdfDict, type PdfObject } from '../src/types.js';
import { parseSfnt } from '../src/sfnt.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { getStd14Sfnt } from '../src/std14fonts.js';
import { verticalGlyph } from '../src/otlayout.js';
import { buildFontReplacePdf, simpleFont } from './helpers/build-font-replace-pdf.js';
import { buildVertGsub, buildVerticalMetrics, withTables } from './helpers/build-vertical-font.js';

// g0ky.10: vertical text written in the face's vertical forms and metrics.

const LIB = getStd14Sfnt('Helvetica')!;            // Liberation Sans, 2048 units/em
const GID = (c: string): number => LIB.cmapLookup(c.codePointAt(0)!)!;
// 1.0742 em down for every glyph but B, A's vertical form, which states its
// own -- so an advance taken from the glyph before substitution is caught.
const ADV = 2200, ADV_B = 2600, TSB = 100;
/** Liberation Sans whose `vert` (under `kana`) draws A as B, with one vmtx row for all. */
function vertFace(o: { tag?: string; script?: string; metrics?: boolean } = {}): Uint8Array {
  const tables: Record<string, Uint8Array> = { GSUB: buildVertGsub([{ tag: o.tag ?? 'vert', pairs: [[GID('A'), GID('B')]] }], o.script ?? 'kana') };
  if (o.metrics !== false) Object.assign(tables, buildVerticalMetrics(LIB.numGlyphs, ADV, TSB, { [GID('B')]: ADV_B }));
  return withTables(LIB.raw, tables);
}

const str = (s: string): PdfObject => ({ kind: 'string', bytes: new TextEncoder().encode(s) });
const TU = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n'
  + '1 begincodespacerange <0000> <FFFF> endcodespacerange\n'
  + '1 beginbfrange <0020> <02FF> <0020> endbfrange\nendcmap end end';
/** One page drawing `codes` vertically in a non-embedded Identity-V font whose glyphs advance 1.2 em. */
function open(codes: string, extra = ''): Document {
  const doc = Document.Open(buildFontReplacePdf({
    fonts: { times: simpleFont('Times-Roman') },
    pages: [{ content: `BT /V1 20 Tf 100 300 Td <${codes}> Tj ET ${extra}`, fonts: { F1: 'times' } }],
  }));
  const tu = doc.allocObject({ kind: 'stream', dict: new Map<string, PdfObject>([['Length', TU.length]]), raw: new TextEncoder().encode(TU) });
  const v = doc.allocObject(new Map<string, PdfObject>([
    ['Type', name('Font')], ['Subtype', name('Type0')], ['BaseFont', name('VertSerif')], ['Encoding', name('Identity-V')], ['ToUnicode', tu],
    ['DescendantFonts', [new Map<string, PdfObject>([
      ['Type', name('Font')], ['Subtype', name('CIDFontType2')], ['BaseFont', name('VertSerif')], ['DW2', [880, -1200]],
      ['CIDSystemInfo', new Map<string, PdfObject>([['Registry', str('Adobe')], ['Ordering', str('Identity')], ['Supplement', 0]])],
    ])]],
  ]));
  (doc.resolve(doc.Pages[0].Resources!.get('Font')) as PdfDict).set('V1', v);
  return doc;
}
const glyphs = (doc: Document): GlyphEvent[] => { const out: GlyphEvent[] = []; visitContent(doc, doc.Pages[0], { glyph: (g) => { out.push(g); } }); return out; };
const pens = (gs: GlyphEvent[]): number[][] => gs.map((g) => [Math.round(g.tm[4] * 1000) / 1000, Math.round(g.tm[5] * 1000) / 1000]);
const descendant = (doc: Document, g: GlyphEvent): PdfDict => doc.resolve((doc.resolve(g.font.dict.get('DescendantFonts')) as PdfObject[])[0]) as PdfDict;
const em = (v: number): number => Math.round((v * 1000) / LIB.unitsPerEm);

describe('verticalGlyph (g0ky.10)', () => {
  it('substitutes through vert, from any script', () => {
    const f = parseSfnt(vertFace());
    expect(verticalGlyph(f, GID('A'))).toBe(GID('B'));
    expect(verticalGlyph(f, GID('C'))).toBe(GID('C'));
  });

  it('prefers vrt2 to vert', () => {
    const both = withTables(LIB.raw, {
      GSUB: buildVertGsub([{ tag: 'vert', pairs: [[GID('A'), GID('B')]] }, { tag: 'vrt2', pairs: [[GID('A'), GID('D')]] }]),
    });
    expect(verticalGlyph(parseSfnt(both), GID('A'))).toBe(GID('D'));
  });

  it('answers the glyph itself for a face with no vertical feature', () => {
    expect(verticalGlyph(LIB, GID('A'))).toBe(GID('A'));
  });
});

describe('ReplaceFont: vertical forms and metrics (g0ky.10)', () => {
  it('draws the vertical form, keeping the text and every pen position', () => {
    const doc = open('00410043');
    const before = pens(glyphs(doc));
    const to = doc.AddFont(vertFace());
    expect(doc.ReplaceFont('VertSerif', to)).toMatchObject({ refused: [], glyphs: 2 });
    const saved = Document.Open(doc.Save());
    const g = glyphs(saved);
    expect(g.map((x) => x.text).join('')).toBe('AC');
    expect(g.map((x) => x.cid)).toEqual([GID('B'), GID('C')]);
    expect(pens(g)).toEqual(before);
    expect(saved.Pages[0].GetText()).toContain('AC');
  });

  it('states /W2 from the face\'s vmtx, so natural advances follow the face', () => {
    const doc = open('00410043');
    const to = doc.AddFont(vertFace());
    doc.ReplaceFont('VertSerif', to, { positions: 'natural' });
    const saved = Document.Open(doc.Save());
    const g = glyphs(saved);
    const w2 = descendant(saved, g[0]).get('W2') as PdfObject[];
    const idx = w2.indexOf(GID('B'));
    expect(w2[idx + 1]).toEqual([-em(ADV_B), em(LIB.advanceWidth(GID('B')) / 2), em((LIB.glyphYMax(GID('B')) ?? 0) + TSB)]);
    const ys = pens(g).map((p) => p[1]);
    expect(ys[1]).toBeCloseTo(300 - (20 * em(ADV_B)) / 1000, 3);
  });

  it('keeps the /DW2 default for a face with no vmtx', () => {
    const doc = open('00410043');
    const to = doc.AddFont(vertFace({ metrics: false }));
    doc.ReplaceFont('VertSerif', to, { positions: 'natural' });
    const saved = Document.Open(doc.Save());
    const g = glyphs(saved);
    expect(descendant(saved, g[0]).has('W2')).toBe(false);
    expect(pens(g).map((p) => p[1])).toEqual([300, 280]);
    expect(g.map((x) => x.cid)).toEqual([GID('B'), GID('C')]);
  });

  it('leaves horizontal text in the same face in its horizontal forms', () => {
    const doc = open('0041', 'BT /F1 20 Tf 20 100 Td (A) Tj ET');
    const to = doc.AddFont(vertFace());
    doc.ReplaceFont('VertSerif', to);
    doc.ReplaceFont('Times-Roman', to);
    const g = glyphs(Document.Open(doc.Save()));
    const enc = (x: GlyphEvent): string | undefined => { const e = x.font.dict.get('Encoding'); return isName(e) ? e.name : undefined; };
    expect(g.map((x) => `${x.text}:${x.cid}:${enc(x)}`)).toEqual([`A:${GID('B')}:Identity-V`, `A:${GID('A')}:Identity-H`]);
  });
});
