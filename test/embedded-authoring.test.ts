import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { EmbeddedFont } from '../src/embeddedfont.js';
import { PdfDict, isName, isDict, isStream } from '../src/types.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';
import { buildUnicodeTtf } from './helpers/build-sfnt.js';

/** The Type0 font dict registered on page 0, resolved from its /Resources. */
function pageFont(doc: Document) {
  const page = doc.Pages[0];
  const res = doc.resolve(page.Dict.get('Resources'));
  const fonts = isDict(res) ? doc.resolve(res.get('Font')) : undefined;
  if (!isDict(fonts)) return undefined;
  for (const v of fonts.values()) {
    const d = doc.resolve(v);
    if (isDict(d) && isName(d.get('Subtype')) && (d.get('Subtype') as any).name === 'Type0') return d;
  }
  return undefined;
}

describe('Document.AddFont / embedded text authoring', () => {
  it('returns an EmbeddedFont handle', () => {
    const doc = Document.Open(buildStampTarget());
    const font = doc.AddFont(buildUnicodeTtf());
    expect(font).toBeInstanceOf(EmbeddedFont);
  });

  it('AddText round-trips arbitrary Unicode through Save/Open/GetText', () => {
    const doc = Document.Open(buildStampTarget());
    const font = doc.AddFont(buildUnicodeTtf());
    doc.Pages[0].AddText('A中', 20, 50, { font }); // 中 is NOT WinAnsi-encodable
    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages[0].GetText()).toContain('A中');
  });

  it('embeds a Type0/Identity-H font subset on Save', () => {
    const doc = Document.Open(buildStampTarget());
    const font = doc.AddFont(buildUnicodeTtf());
    doc.Pages[0].AddText('A中', 20, 50, { font });
    const reopened = Document.Open(doc.Save());
    const f = pageFont(reopened)!;
    expect(f).toBeDefined();
    expect((f.get('Encoding') as any).name).toBe('Identity-H');
    const cid = reopened.resolve((reopened.resolve(f.get('DescendantFonts')) as any[])[0]) as PdfDict;
    expect((cid.get('Subtype') as any).name).toBe('CIDFontType2');
    const fd = reopened.resolve(cid.get('FontDescriptor')) as PdfDict;
    expect(isStream(reopened.resolve(fd.get('FontFile2')))).toBe(true);
  });

  it('records only the glyphs actually drawn (subset scales with distinct glyphs)', () => {
    const doc = Document.Open(buildStampTarget());
    const font = doc.AddFont(buildUnicodeTtf());
    doc.Pages[0].AddText('A', 20, 50, { font });   // only gid 1
    expect([...font.usedGids].sort()).toEqual([1]);
    doc.Pages[0].AddText('中', 20, 80, { font });  // adds gid 2
    expect([...font.usedGids].sort()).toEqual([1, 2]);
  });

  it('drops characters absent from the font cmap; an all-uncmapped draw is a no-op', () => {
    const doc = Document.Open(buildStampTarget());
    const font = doc.AddFont(buildUnicodeTtf());
    // 'Z' and 'x' are not in the fixture cmap (only A and 中 are).
    doc.Pages[0].AddText('Zx', 20, 50, { font });
    expect(font.usedGids.size).toBe(0);    // nothing recorded -> nothing to embed
    expect(font.objNum).toBeUndefined();   // no resource reserved
    const reopened = Document.Open(doc.Save());
    expect(pageFont(reopened)).toBeUndefined(); // no Type0 font emitted
  });

  it('AddTextBlock wraps and round-trips embedded text', () => {
    const doc = Document.Open(buildStampTarget());
    const font = doc.AddFont(buildUnicodeTtf());
    const rem = doc.Pages[0].AddTextBlock('A中 A中 A中', [20, 20, 200, 100], { font, fontSize: 12 });
    expect(rem).toBeNull();
    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages[0].GetText().replace(/\s/g, '')).toContain('A中');
  });

  it('MeasureText uses embedded hmtx widths at unitsPerEm scale', () => {
    const doc = Document.Open(buildStampTarget());
    const font = doc.AddFont(buildUnicodeTtf());
    // advances: gid1('A')=600, gid2('中')=700; (600+700)/1000 * 12 = 15.6
    expect(doc.Pages[0].MeasureText('A中', 12, font)).toBeCloseTo(15.6, 6);
  });

  it('produces byte-identical output across repeated Save calls', () => {
    const doc = Document.Open(buildStampTarget());
    const font = doc.AddFont(buildUnicodeTtf());
    doc.Pages[0].AddText('A中', 20, 50, { font });
    const a = doc.Save();
    const b = doc.Save();
    expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
  });

  it('rejects a font option that is neither a Standard-14 name nor a handle', () => {
    const doc = Document.Open(buildStampTarget());
    expect(() => doc.Pages[0].AddText('x', 0, 0, { font: 'NotAFont' as any })).toThrow(TypeError);
  });
});
