import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { buildDocx, type DocxParts } from './helpers/build-docx.js';
import { p, r } from './helpers/wml.js';

const frags = (body: string, parts: DocxParts = {}) => {
  const doc = Document.New();
  const res = doc.AddDocx(buildDocx(body, parts));
  return { f: doc.Pages[0].GetTextFragments(), skipped: res.skipped, doc };
};

describe('AddDocx: runs', () => {
  it('draws bold and italic in the family\'s bold and italic faces', () => {
    const { f } = frags(p(r('plain ') + r('bold ', '<w:b/>') + r('ital', '<w:i/>')));
    expect(f.find((x) => x.text.includes('bold'))?.bold).toBe(true);
    expect(f.find((x) => x.text.includes('ital'))?.italic).toBe(true);
    expect(f.find((x) => x.text.includes('plain'))?.bold).toBeUndefined();
  });

  it('draws each run at its own size and colour', () => {
    const { f, doc } = frags(p(r('big', '<w:sz w:val="40"/><w:color w:val="FF0000"/>') + r(' small', '<w:sz w:val="16"/>')));
    expect(f.find((x) => x.text.includes('big'))!.fontSize).toBeCloseTo(20, 3);
    expect(f.find((x) => x.text.includes('small'))!.fontSize).toBeCloseTo(8, 3);
    // Colour stops at the glyph: a TextFragment deliberately carries none.
    const glyphs: GlyphEvent[] = [];
    visitContent(doc, doc.Pages[0], { glyph: (e) => glyphs.push(e) });
    expect(glyphs.find((g) => g.text === 'b')!.color).toEqual([1, 0, 0]);
    expect(glyphs.find((g) => g.text === 'm')!.color).toBeUndefined();
  });

  it('falls back by the font table\'s class and reports the unresolved name once per run', () => {
    const { f, skipped } = frags(p(r('serif', '<w:rFonts w:ascii="Cambria" w:hAnsi="Cambria"/>')),
      { fontTable: '<w:font w:name="Cambria"><w:family w:val="roman"/></w:font>' });
    expect(f[0].fontName).toMatch(/Times/);
    expect(skipped).toContainEqual({ name: 'font:Cambria', count: 1, kind: 'degraded' });
  });

  it('renders text with no w:rFonts anywhere in a serif face and reports nothing about fonts (Review Focus 2)', () => {
    const { f, skipped } = frags(p(r('default')));
    expect(f[0].fontName).toMatch(/Times/);
    expect(skipped.filter((s) => s.name.startsWith('font:'))).toEqual([]);
  });

  it('links an external hyperlink and reports an internal anchor as degraded', () => {
    const { doc, skipped } = frags(p('<w:hyperlink r:id="rL">' + r('site') + '</w:hyperlink> '
      + '<w:hyperlink w:anchor="bm">' + r('there') + '</w:hyperlink>'),
      { rels: [{ id: 'rL', type: 'hyperlink', target: 'https://x.test/', external: true }] });
    const links = doc.Pages[0].Annotations.filter((a) => a.Subtype === 'Link');
    expect(links).toHaveLength(1);
    expect(skipped).toContainEqual({ name: 'w:hyperlink (anchor)', count: 1, kind: 'degraded' });
  });

  it('draws underline and strike, and reports a property it does not model', () => {
    const plain = frags(p(r('u') + r('s')));
    const { skipped, doc } = frags(p(r('u', '<w:u w:val="single"/>') + r('s', '<w:strike/>') + r('sup', '<w:vertAlign w:val="superscript"/>')));
    expect(skipped).toContainEqual({ name: 'w:vertAlign', count: 1, kind: 'degraded' });
    // Two decoration rules: two filled paths a plain paragraph does not have.
    expect(doc.Pages[0].GetPaths().length).toBe(plain.doc.Pages[0].GetPaths().length + 2);
  });

  it('reports text the resolved face cannot draw', () => {
    const { skipped } = frags(p(r('Привет')));
    expect(skipped.some((s) => s.name === 'text' || s.name === 'text:partial')).toBe(true);
  });
});
