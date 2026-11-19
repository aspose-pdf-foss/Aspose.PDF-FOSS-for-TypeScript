import { describe, expect, it } from 'vitest';
import { Document, PageFormat, LoadLimits, PdfParseError, UnsupportedFeatureError,
  type PostScriptOptions, type PostScriptFont, type PostScriptResult } from '../src/index.js';
import { psBytes, joinPs } from './helpers/ps-font-program.js';
import { epsSource, dosEps } from './helpers/build-eps.js';
import { buildType1, t1cs, t1num } from './helpers/build-type1.js';
import { buildInkTtf } from './helpers/build-sfnt.js';

describe('public PostScript import', () => {
  it('reports an invalid supplied font program using the public parse error type', () => {
    const doc = Document.New(), before = doc.Save();
    expect(() => doc.AddPostScript(new Uint8Array(), { fonts: [{ name: 'Bad', bytes: new Uint8Array(3) }] })).toThrow(PdfParseError);
    expect(doc.Save()).toEqual(before);
  });
  it('uses supplied TrueType Buffer glyph metrics with a job-local alias', () => {
    const font = Buffer.from(buildInkTtf()), doc = Document.New();
    doc.AddPostScript(psBytes('/Ink 10 selectfont (A) stringwidth pop 10 ne { missing } if 0 0 moveto (A) show'), { fonts: [{ name: 'Ink', bytes: font }] });
    const before = doc.Save(); font.fill(0);
    expect(doc.Save()).toEqual(before); expect(Document.Open(before).Pages[0]!.GetText()).toContain('A');
  });
  it('appends live pages, preserving existing handles and metadata across independent jobs', () => {
    const doc = Document.New(PageFormat.Letter), first = doc.Pages[0]!;
    doc.SetMetadata({ title: 'Keep' });
    const result: PostScriptResult = doc.AddPostScript(psBytes('/private 3 def 0 0 10 10 rectfill showpage showpage'));
    expect(doc.Pages[0]).toBe(first); expect(result.pages).toEqual(doc.Pages.slice(1));
    expect(result.pages.map(p => p.Number)).toEqual([2, 3]);
    expect(doc.GetMetadata().title).toBe('Keep');
    const before = doc.Save();
    expect(() => doc.AddPostScript(psBytes('private'))).toThrow(PdfParseError);
    expect(doc.Save()).toEqual(before);
    expect(doc.AddPostScript(psBytes('0 0 2 2 rectfill')).pages).toHaveLength(1);
  });
  it('omits empty PS while explicit blank showpages remain pages', () => {
    const doc = Document.New(), before = doc.Save();
    expect(doc.AddPostScript(new Uint8Array()).pages).toEqual([]); expect(doc.Save()).toEqual(before);
    expect(doc.AddPostScript(psBytes('showpage showpage')).pages).toHaveLength(2);
  });
  it.each(['tiff', 'wmf'] as const)('imports a binary %s preview envelope without executing its preview or outside bytes', kind => {
    const source = epsSource('-10 20 1 1 rectfill showpage showpage');
    const bytes = joinPs(dosEps(source, psBytes('quit undefinedName'), kind), psBytes('undefinedOutside'));
    const doc = Document.New(), pages = doc.AddPostScript(bytes).pages;
    expect(pages).toHaveLength(1); expect(pages[0]!.MediaBox).toEqual([0, 0, 100, 50]);
  });
  it('uses the PS initial pageSize and allows source device changes', () => {
    const doc = Document.New();
    expect(doc.AddPostScript(psBytes('showpage << /PageSize [20 30] >> setpagedevice showpage'), { pageSize: PageFormat.Letter }).pages.map(p => p.MediaBox))
      .toEqual([[0, 0, 612, 792], [0, 0, 20, 30]]);
  });
  it.each(['missing', '<< /Duplex true >> setpagedevice'])('publishes no earlier pages when later execution fails at %s', tail => {
    const doc = Document.New(PageFormat.A4), before = doc.Save(), objects = [...doc.objectEntries()];
    expect(() => doc.AddPostScript(psBytes(`showpage showpage ${tail}`))).toThrow();
    expect(doc.Save()).toEqual(before); expect([...doc.objectEntries()]).toEqual(objects);
  });
  it.each([
    { format: 'other' }, { format: null }, { pageSize: {} }, { pageSize: { width: 10, height: 10 } }, { fonts: {} },
    { fonts: [{ name: '', bytes: new Uint8Array() }] }, { fonts: [{ name: 'x', bytes: 'no' }] },
    { fonts: [{ name: 'x', bytes: new Uint8Array() }, { name: 'x', bytes: new Uint8Array() }] },
  ])('validates caller options before executing source: %j', options => {
    expect(() => Document.New().AddPostScript(psBytes('missing'), options as PostScriptOptions)).toThrow(TypeError);
  });
  it('rejects wrong bytes, null options, invalid limits and mutated nominal PageFormats', () => {
    const doc = Document.New();
    expect(() => doc.AddPostScript('showpage' as any)).toThrow(TypeError);
    expect(() => doc.AddPostScript(psBytes('missing'), null as any)).toThrow(TypeError);
    const pageSize = PageFormat.custom(10, 10); (pageSize as any).width = Infinity;
    expect(() => doc.AddPostScript(psBytes('missing'), { pageSize })).toThrow(TypeError);
    (doc as any).loadLimits = {};
    expect(() => doc.AddPostScript(psBytes('missing'))).toThrow(TypeError);
  });
  it('refuses incompatible EPS options and explicit format contradictions', () => {
    const doc = Document.New();
    expect(() => doc.AddPostScript(epsSource(), { pageSize: PageFormat.A4 })).toThrow(TypeError);
    expect(() => doc.AddPostScript(epsSource(), { format: 'ps' })).toThrow(PdfParseError);
    expect(() => doc.AddPostScript(psBytes('showpage'), { format: 'eps' })).toThrow(PdfParseError);
    expect(() => doc.AddPostScript(epsSource('<< >> setpagedevice'))).toThrow(UnsupportedFeatureError);
  });
  it('owns supplied Type1 Buffer programs and emitted source data after return', () => {
    const bytes = Buffer.from(buildType1({ charstrings: { A: t1cs(t1num(0), t1num(550), 13, 14) } }));
    const font: PostScriptFont = { name: 'MyFace', bytes };
    const source = Buffer.from('/MyFace 10 selectfont (A) stringwidth pop 5.5 ne { missing } if 0 0 moveto (A) show');
    const doc = Document.New(); doc.AddPostScript(source, { fonts: [font] }); const saved = doc.Save();
    bytes.fill(0); source.fill(0); expect(doc.Save()).toEqual(saved);
    expect(Document.Open(saved).Pages[0]!.GetText()).toContain('A');
  });
});
