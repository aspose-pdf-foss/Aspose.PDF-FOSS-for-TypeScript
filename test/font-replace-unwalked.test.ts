import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isDict, isStream, name, ref, type PdfDict, type PdfObject, type PdfStream } from '../src/types.js';
import { visitFormContent, type GlyphEvent } from '../src/text.js';
import { buildFontReplacePdf, simpleFont } from './helpers/build-font-replace-pdf.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const IDENT: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];

/** One page drawing Helvetica, plus `extra` adding a Helvetica-drawing scope
 *  the page walk does not enter (a tiling pattern or a Type 3 glyph procedure). */
function docWith(extra: (doc: Document, res: PdfDict, helv: PdfObject) => void): Document {
  const doc = Document.Open(buildFontReplacePdf({
    fonts: { helv: simpleFont('Helvetica') },
    pages: [{ content: 'BT /F1 12 Tf 10 10 Td (Hi) Tj ET', fonts: { F1: 'helv' } }],
  }));
  const res = doc.Pages[0].Resources!;
  const fonts = doc.resolve(res.get('Font')) as PdfDict;
  extra(doc, res, fonts.get('F1')!);
  return doc;
}
function tilingPattern(doc: Document, res: PdfDict, helv: PdfObject, content = 'BT /F1 8 Tf 0 0 Td (PW) Tj ET'): void {
  const p = doc.allocObject({
    kind: 'stream',
    dict: new Map<string, PdfObject>([
      ['Type', name('Pattern')], ['PatternType', 1], ['PaintType', 1], ['TilingType', 1],
      ['BBox', [0, 0, 20, 20]], ['XStep', 20], ['YStep', 20], ['Length', content.length],
      ['Resources', new Map<string, PdfObject>([['Font', new Map<string, PdfObject>([['F1', helv]])]])],
    ]),
    raw: enc(content),
  });
  res.set('Pattern', new Map<string, PdfObject>([['P0', p]]));
}
function type3Font(doc: Document, res: PdfDict, helv: PdfObject, withResources = true): void {
  const proc = '1000 0 d0 BT /F1 8 Tf 0 0 Td (GW) Tj ET';
  const procRef = doc.allocObject({ kind: 'stream', dict: new Map<string, PdfObject>([['Length', proc.length]]), raw: enc(proc) });
  const t3 = doc.allocObject(new Map<string, PdfObject>([
    ['Type', name('Font')], ['Subtype', name('Type3')], ['FontBBox', [0, 0, 1000, 1000]],
    ['FontMatrix', [0.001, 0, 0, 0.001, 0, 0]], ['FirstChar', 65], ['LastChar', 65], ['Widths', [1000]],
    ['Encoding', new Map<string, PdfObject>([['Differences', [65, name('g')]]])],
    ['CharProcs', new Map<string, PdfObject>([['g', procRef]])],
    ...(withResources ? [['Resources', new Map<string, PdfObject>([['Font', new Map<string, PdfObject>([['F1', helv]])]])] as [string, PdfObject]] : []),
  ]));
  (doc.resolve(res.get('Font')) as PdfDict).set('T3', t3);
}

/** The glyphs one standalone stream draws, read with `res` as its resources. */
function glyphsIn(doc: Document, s: PdfStream, res?: PdfDict): GlyphEvent[] {
  const out: GlyphEvent[] = [];
  visitFormContent(doc, s, res, IDENT, { glyph: (e) => { out.push(e); } });
  return out;
}
const baseFont = (doc: Document, g: GlyphEvent): string => (doc.resolve(g.font.dict.get('BaseFont')) as { name: string }).name;
const patternOf = (doc: Document): PdfStream => {
  const pats = doc.resolve(doc.Pages[0].Resources!.get('Pattern')) as PdfDict;
  const p = doc.resolve(pats.get('P0'));
  if (!isStream(p)) throw new Error('no pattern');
  return p;
};
const type3Of = (doc: Document): { font: PdfDict; proc: PdfStream } => {
  const fonts = doc.resolve(doc.Pages[0].Resources!.get('Font')) as PdfDict;
  const font = doc.resolve(fonts.get('T3')) as PdfDict;
  const proc = doc.resolve((doc.resolve(font.get('CharProcs')) as PdfDict).get('g'));
  if (!isStream(proc)) throw new Error('no charproc');
  return { font, proc };
};
/** Every BaseFont a saved file's objects name. */
const baseFonts = (doc: Document): string[] => {
  const out: string[] = [];
  for (const [, o] of doc.objectEntries()) {
    const bf = isDict(o) && (o.get('Type') as { name?: string })?.name === 'Font' ? doc.resolve(o.get('BaseFont')) : undefined;
    if (bf && typeof bf === 'object' && 'name' in bf) out.push((bf as { name: string }).name);
  }
  return out.sort();
};

describe('ReplaceFont: tiling patterns and Type 3 glyph procedures (g0ky.8)', () => {
  it('rewrites the text a tiling pattern draws, keeping glyph positions', () => {
    const doc = docWith(tilingPattern);
    const before = glyphsIn(doc, patternOf(doc)).map((g) => g.quad[0]);
    const r = doc.ReplaceFont('Helvetica', 'Times-Roman');
    expect(r.refused).toEqual([]);
    expect(r).toMatchObject({ pages: [1], glyphs: 4, patterns: 1, glyphProcedures: 0 });
    const saved = Document.Open(doc.Save());
    const g = glyphsIn(saved, patternOf(saved));
    expect(g.map((x) => `${x.text}:${baseFont(saved, x)}`)).toEqual(['P:Times-Roman', 'W:Times-Roman']);
    g.forEach((x, i) => expect(x.quad[0]).toBeCloseTo(before[i], 3));
    expect(baseFonts(saved)).toEqual(['Times-Roman']);
  });

  it('rewrites the text a Type 3 glyph procedure draws, in the font\'s own resources', () => {
    const doc = docWith(type3Font);
    const { font } = type3Of(doc);
    const before = glyphsIn(doc, type3Of(doc).proc, doc.resolve(font.get('Resources')) as PdfDict).map((g) => g.quad[0]);
    const r = doc.ReplaceFont('Helvetica', 'Times-Roman');
    expect(r.refused).toEqual([]);
    expect(r).toMatchObject({ glyphs: 4, patterns: 0, glyphProcedures: 1 });
    const saved = Document.Open(doc.Save());
    const t = type3Of(saved);
    expect(t.proc.dict.has('Resources')).toBe(false);
    const g = glyphsIn(saved, t.proc, saved.resolve(t.font.get('Resources')) as PdfDict);
    expect(g.map((x) => `${x.text}:${baseFont(saved, x)}`)).toEqual(['G:Times-Roman', 'W:Times-Roman']);
    g.forEach((x, i) => expect(x.quad[0]).toBeCloseTo(before[i], 3));
    expect(baseFonts(saved)).not.toContain('Helvetica');
  });

  it('rewrites every glyph procedure of a Type 3 font, which share the font\'s resources', () => {
    // One target for the whole font: pruning the old font after the first
    // procedure would cut the name the second still draws with.
    const doc = docWith((d, res, helv) => {
      type3Font(d, res, helv);
      const { font } = type3Of(d);
      const proc = '1000 0 d0 BT /F1 8 Tf 0 0 Td (HX) Tj ET';
      const p2 = d.allocObject({ kind: 'stream', dict: new Map<string, PdfObject>([['Length', proc.length]]), raw: enc(proc) });
      (d.resolve(font.get('CharProcs')) as PdfDict).set('h', p2);
    });
    const r = doc.ReplaceFont('Helvetica', 'Times-Roman');
    expect(r).toMatchObject({ refused: [], glyphProcedures: 2, glyphs: 6 });
    const saved = Document.Open(doc.Save());
    const { font } = type3Of(saved);
    const fres = saved.resolve(font.get('Resources')) as PdfDict;
    const procs = saved.resolve(font.get('CharProcs')) as PdfDict;
    const texts = ['g', 'h'].map((k) => glyphsIn(saved, saved.resolve(procs.get(k)) as PdfStream, fres).map((x) => `${x.text}:${baseFont(saved, x)}`).join(' '));
    expect(texts).toEqual(['G:Times-Roman W:Times-Roman', 'H:Times-Roman X:Times-Roman']);
    expect(baseFonts(saved)).not.toContain('Helvetica');
  });

  it('reports a Type 3 font whose glyph procedures draw in the old font with no /Resources of their own', () => {
    const doc = docWith((d, res, helv) => type3Font(d, res, helv, false));
    const r = doc.ReplaceFont('Helvetica', 'Times-Roman');
    expect(r.refused).toEqual([{ page: 1, reason: 'type3-glyph', part: 'type3-glyph' }]);
    expect(r.glyphProcedures).toBe(0);
  });

  it('rewrites a pattern reached through a form the page draws', () => {
    const doc = docWith((d, res, helv) => {
      const inner = new Map<string, PdfObject>();
      tilingPattern(d, inner, helv);
      const form = d.allocObject({
        kind: 'stream',
        dict: new Map<string, PdfObject>([
          ['Type', name('XObject')], ['Subtype', name('Form')], ['BBox', [0, 0, 10, 10]], ['Length', 0], ['Resources', inner],
        ]),
        raw: new Uint8Array(0),
      });
      res.set('XObject', new Map<string, PdfObject>([['Fx', form]]));
    });
    const r = doc.ReplaceFont('Helvetica', 'Times-Roman');
    expect(r).toMatchObject({ refused: [], patterns: 1, glyphs: 4 });
    expect(baseFonts(Document.Open(doc.Save()))).toEqual(['Times-Roman']);
  });

  it('rewrites a pattern that shares the page resources dict, once', () => {
    const doc = docWith((d, res) => {
      const content = 'BT /F1 8 Tf 0 0 Td (P) Tj ET';
      const p = d.allocObject({
        kind: 'stream',
        dict: new Map<string, PdfObject>([
          ['Type', name('Pattern')], ['PatternType', 1], ['PaintType', 1], ['TilingType', 1],
          ['BBox', [0, 0, 20, 20]], ['XStep', 20], ['YStep', 20], ['Length', content.length], ['Resources', res],
        ]),
        raw: enc(content),
      });
      res.set('Pattern', new Map<string, PdfObject>([['P0', p]]));
    });
    const r = doc.ReplaceFont('Helvetica', 'Times-Roman');
    expect(r).toMatchObject({ refused: [], patterns: 1, glyphs: 3 });
    expect(baseFonts(Document.Open(doc.Save()))).toEqual(['Times-Roman']);
  });

  it('rewrites a pattern shared by two pages once', () => {
    const doc = Document.Open(buildFontReplacePdf({
      fonts: { helv: simpleFont('Helvetica') },
      pages: [
        { content: 'BT /F1 12 Tf 10 10 Td (Hi) Tj ET', fonts: { F1: 'helv' } },
        { content: 'BT /F1 12 Tf 10 10 Td (Yo) Tj ET', fonts: { F1: 'helv' } },
      ],
    }));
    const r0 = doc.Pages[0].Resources!;
    tilingPattern(doc, r0, (doc.resolve(r0.get('Font')) as PdfDict).get('F1')!);
    doc.Pages[1].Resources!.set('Pattern', r0.get('Pattern')!);
    const r = doc.ReplaceFont('Helvetica', 'Times-Roman');
    expect(r).toMatchObject({ refused: [], patterns: 1, glyphs: 6, pages: [1, 2] });
  });

  it('leaves a pattern drawing in another font alone', () => {
    const doc = docWith((d, res) => {
      const courier = d.allocObject(simpleFont('Courier'));
      tilingPattern(d, res, courier);
    });
    const before = patternOf(doc).raw;
    const r = doc.ReplaceFont('Helvetica', 'Times-Roman');
    expect(r).toMatchObject({ refused: [], patterns: 0 });
    expect(Buffer.compare(patternOf(doc).raw, before)).toBe(0);
  });

  it('rewrites a Type 3 font used inside a pattern', () => {
    const doc = docWith((d, res, helv) => {
      const inner = new Map<string, PdfObject>([['Font', new Map<string, PdfObject>()]]);
      type3Font(d, inner, helv);
      const content = 'BT /T3 8 Tf 0 0 Td (A) Tj ET';
      const p = d.allocObject({
        kind: 'stream',
        dict: new Map<string, PdfObject>([
          ['Type', name('Pattern')], ['PatternType', 1], ['PaintType', 1], ['TilingType', 1],
          ['BBox', [0, 0, 20, 20]], ['XStep', 20], ['YStep', 20], ['Length', content.length], ['Resources', inner],
        ]),
        raw: enc(content),
      });
      res.set('Pattern', new Map<string, PdfObject>([['P0', p]]));
    });
    const r = doc.ReplaceFont('Helvetica', 'Times-Roman');
    expect(r).toMatchObject({ refused: [], glyphProcedures: 1 });
    expect(baseFonts(Document.Open(doc.Save())).filter((b) => b === 'Helvetica')).toEqual([]);
  });

  it('rewrites a pattern stating no /Resources, which reads the page\'s', () => {
    const doc = docWith((d, res) => {
      const content = 'BT /F1 8 Tf 0 0 Td (P) Tj ET';
      const p = d.allocObject({
        kind: 'stream',
        dict: new Map<string, PdfObject>([
          ['Type', name('Pattern')], ['PatternType', 1], ['PaintType', 1], ['TilingType', 1],
          ['BBox', [0, 0, 20, 20]], ['XStep', 20], ['YStep', 20], ['Length', content.length],
        ]),
        raw: enc(content),
      });
      res.set('Pattern', new Map<string, PdfObject>([['P0', p]]));
    });
    const r = doc.ReplaceFont('Helvetica', 'Times-Roman');
    expect(r).toMatchObject({ refused: [], patterns: 1, glyphs: 3 });
    expect(baseFonts(Document.Open(doc.Save()))).toEqual(['Times-Roman']);
  });

  it('rewrites a pattern a Type 3 glyph procedure paints with', () => {
    const doc = docWith((d, res, helv) => {
      type3Font(d, res, helv);
      const { font } = type3Of(d);
      tilingPattern(d, d.resolve(font.get('Resources')) as PdfDict, helv);
    });
    const r = doc.ReplaceFont('Helvetica', 'Times-Roman');
    expect(r).toMatchObject({ refused: [], patterns: 1, glyphProcedures: 1, glyphs: 6 });
    expect(baseFonts(Document.Open(doc.Save()))).not.toContain('Helvetica');
  });

  it('checks a borrowed Type 3 font on every page, and keeps the names its procedures draw with', () => {
    // Page 1 lends it Courier as /F1, page 2 Helvetica: only page 2 draws the
    // old font through it, and page 2's prune must not cut /F1 (review).
    const doc = Document.Open(buildFontReplacePdf({
      fonts: { courier: simpleFont('Courier'), helv: simpleFont('Helvetica') },
      pages: [
        { content: 'BT /F1 12 Tf 10 10 Td (Hi) Tj /T3 12 Tf (A) Tj ET', fonts: { F1: 'courier' } },
        { content: 'BT /F1 12 Tf 10 10 Td (Yo) Tj /T3 12 Tf (A) Tj ET', fonts: { F1: 'helv' } },
      ],
    }));
    const p1 = doc.Pages[0].Resources!;
    type3Font(doc, p1, (doc.resolve(p1.get('Font')) as PdfDict).get('F1')!, false);
    const t3 = (doc.resolve(p1.get('Font')) as PdfDict).get('T3')!;
    (doc.resolve(doc.Pages[1].Resources!.get('Font')) as PdfDict).set('T3', t3);
    const r = doc.ReplaceFont('Helvetica', 'Times-Roman');
    expect(r.refused).toEqual([{ page: 2, reason: 'type3-glyph', part: 'type3-glyph' }]);
    const saved = Document.Open(doc.Save());
    const f2 = saved.resolve(saved.Pages[1].Resources!.get('Font')) as PdfDict;
    expect((saved.resolve((saved.resolve(f2.get('F1')) as PdfDict).get('BaseFont')) as { name: string }).name).toBe('Helvetica');
  });

  it('rewrites a pattern shared by two pages once, though a glyph stays in the old font', () => {
    // The commit replaces the pattern stream, so a dedupe keyed on the stream
    // object rewrote it again on page 2 (review).
    // Code 0x81 is undefined in WinAnsi: no text, so it stays in the old font.
    const doc = Document.Open(buildFontReplacePdf({
      fonts: { helv: simpleFont('Helvetica') },
      pages: [
        { content: 'BT /F1 12 Tf 10 10 Td (Hi) Tj ET', fonts: { F1: 'helv' } },
        { content: 'BT /F1 12 Tf 10 10 Td (Yo) Tj ET', fonts: { F1: 'helv' } },
      ],
    }));
    const r0 = doc.Pages[0].Resources!;
    tilingPattern(doc, r0, (doc.resolve(r0.get('Font')) as PdfDict).get('F1')!, 'BT /F1 8 Tf 0 0 Td (P\\201W) Tj ET');
    doc.Pages[1].Resources!.set('Pattern', r0.get('Pattern')!);
    const r = doc.ReplaceFont('Helvetica', 'Times-Roman');
    expect(r.patterns).toBe(1);
    expect(r.undrawable.map((u) => u.page)).toEqual([1]);
    const tfs = new TextDecoder('latin1').decode(patternOf(doc).raw).match(/Tf/g)!.length;
    expect(tfs).toBe(3);
  });

  it('terminates on a pattern whose resources reach itself', () => {
    const doc = docWith((d, res, helv) => {
      tilingPattern(d, res, ref(9999, 0));
      const pats = d.resolve(res.get('Pattern')) as PdfDict;
      const p = d.resolve(pats.get('P0')) as { dict: PdfDict };
      const pres = p.dict.get('Resources') as PdfDict;
      pres.set('Pattern', new Map<string, PdfObject>([['Self', pats.get('P0')!]]));
      (pres.get('Font') as PdfDict).set('F1', helv);
    });
    const r = doc.ReplaceFont('Helvetica', 'Times-Roman');
    expect(r).toMatchObject({ refused: [], patterns: 1 });
  });
});

describe('ReplaceFont: a pattern with no /Resources of its own (g0ky.11)', () => {
  /** Two pages, each painting one pattern that states no /Resources, with F1
   *  `p1` on page 1 and `p2` on page 2. */
  function twoPages(p1: string, p2: string, sameResources = false): Document {
    const doc = Document.Open(buildFontReplacePdf({
      fonts: { helv: simpleFont('Helvetica'), courier: simpleFont('Courier') },
      pages: [
        { content: 'BT /F1 12 Tf 10 10 Td (Hi) Tj ET', fonts: { F1: p1 } },
        { content: 'BT /F1 12 Tf 10 10 Td (Yo) Tj ET', fonts: { F1: p2 } },
      ],
    }));
    const content = 'BT /F1 8 Tf 0 0 Td (P) Tj ET';
    const pat = doc.allocObject({
      kind: 'stream',
      dict: new Map<string, PdfObject>([
        ['Type', name('Pattern')], ['PatternType', 1], ['PaintType', 1], ['TilingType', 1],
        ['BBox', [0, 0, 20, 20]], ['XStep', 20], ['YStep', 20], ['Length', content.length],
      ]),
      raw: enc(content),
    });
    const pats = new Map<string, PdfObject>([['P0', pat]]);
    if (sameResources) doc.Pages[1].Dict.set('Resources', doc.Pages[0].Dict.get('Resources')!);
    for (const p of doc.Pages) p.Resources!.set('Pattern', pats);
    return doc;
  }

  it('refuses one painted under resources that name its fonts differently', () => {
    const doc = twoPages('helv', 'courier');
    const before = patternOf(doc).raw;
    const r = doc.ReplaceFont('Helvetica', 'Times-Roman');
    expect(r.refused).toEqual([{ page: 1, reason: 'pattern', part: 'pattern' }]);
    expect(r.patterns).toBe(0);
    expect(Buffer.compare(patternOf(doc).raw, before)).toBe(0);
    // The page drawing Helvetica keeps it, for the pattern still names /F1.
    const saved = Document.Open(doc.Save());
    expect(baseFonts(saved)).toContain('Helvetica');
  });

  it('rewrites one painted under a single resources dict however many pages use it', () => {
    const doc = twoPages('helv', 'helv', true);
    const r = doc.ReplaceFont('Helvetica', 'Times-Roman');
    expect(r).toMatchObject({ refused: [], patterns: 1 });
  });
});

describe('ReplaceFont: a pattern with no /Resources painted by an annotation too (g0ky.11)', () => {
  it('refuses it when the appearance lends it other names than the page', () => {
    const doc = Document.Open(buildFontReplacePdf({
      fonts: { helv: simpleFont('Helvetica'), courier: simpleFont('Courier') },
      pages: [{ content: 'BT /F1 12 Tf 10 10 Td (Hi) Tj ET', fonts: { F1: 'helv' } }],
    }));
    const content = 'BT /F1 8 Tf 0 0 Td (P) Tj ET';
    const pat = doc.allocObject({
      kind: 'stream',
      dict: new Map<string, PdfObject>([
        ['Type', name('Pattern')], ['PatternType', 1], ['PaintType', 1], ['TilingType', 1],
        ['BBox', [0, 0, 20, 20]], ['XStep', 20], ['YStep', 20], ['Length', content.length],
      ]),
      raw: enc(content),
    });
    const res = doc.Pages[0].Resources!;
    res.set('Pattern', new Map<string, PdfObject>([['P0', pat]]));
    const courier = doc.allocObject(simpleFont('Courier'));
    const ap = doc.allocObject({
      kind: 'stream',
      dict: new Map<string, PdfObject>([
        ['Type', name('XObject')], ['Subtype', name('Form')], ['BBox', [0, 0, 20, 20]], ['Length', 0],
        ['Resources', new Map<string, PdfObject>([
          ['Font', new Map<string, PdfObject>([['F1', courier]])], ['Pattern', new Map<string, PdfObject>([['P0', pat]])],
        ])],
      ]),
      raw: new Uint8Array(0),
    });
    const annot = doc.allocObject(new Map<string, PdfObject>([
      ['Type', name('Annot')], ['Subtype', name('Square')], ['Rect', [0, 0, 20, 20]], ['AP', new Map<string, PdfObject>([['N', ap]])],
    ]));
    doc.Pages[0].Dict.set('Annots', [annot]);
    const before = patternOf(doc).raw;
    const r = doc.ReplaceFont('Helvetica', 'Times-Roman');
    expect(r.refused).toEqual([{ page: 1, reason: 'pattern', part: 'pattern' }]);
    expect(Buffer.compare(patternOf(doc).raw, before)).toBe(0);
  });
});
