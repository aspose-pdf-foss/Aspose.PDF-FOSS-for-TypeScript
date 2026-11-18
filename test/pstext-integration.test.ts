import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runPsText } from './helpers/ps-text.js';
import { Document } from '../src/document.js';
import { appendPsPages } from '../src/pspdf.js';
import { buildInkTtf } from './helpers/build-sfnt.js';
import { t1cs, t1num } from './helpers/build-type1.js';
const root = (path: string) => new URL(path, import.meta.url);
describe('PostScript text integration', () => {
  it('retains AFM advances for Latin1 minus and StandardEncoding accent glyphs', () => {
    const { vm } = runPsText('/Helvetica findfont dup length dict begin { 1 index /FID ne { def } { pop pop } ifelse } forall /Encoding ISOLatin1Encoding def /Latin currentdict end definefont 10 scalefont setfont (---) stringwidth 0 0 moveto /breve glyphshow currentpoint');
    expect(vm.number(3).value).toBeCloseTo(17.52); expect(vm.number(1).value).toBeCloseTo(3.33);
  });
  it('preserves known Symbol math and Dingbats Unicode', () => {
    const { graphics } = runPsText('0 50 moveto /ZapfDingbats 12 selectfont <33> show /Symbol 12 selectfont <a5> show');
    const doc = Document.New(); appendPsPages(doc, graphics.finish());
    expect(Document.Open(doc.Save()).Pages[0]!.GetText()).toContain('✓∞');
  });
  it('reads real supplied Type1 and TrueType glyph programs by explicit alias', () => {
    const { text } = runPsText('', { fonts: [
      { name: 'RealType1', bytes: readFileSync(root('./fixtures/fonts/NimbusSans-Regular.t1')) },
      { name: 'RealTrueType', bytes: readFileSync(root('../fonts/LiberationSans-Regular.ttf')) },
    ] });
    const t1 = text.fonts.definition(text.fonts.find({ kind: 'name', text: 'RealType1', executable: false })).program!.glyph('A');
    const ttf = text.fonts.definition(text.fonts.find({ kind: 'name', text: 'RealTrueType', executable: false })).program!.glyph('A');
    expect(t1.advance).toEqual([667, 0]); expect(t1.path.segments.length).toBeGreaterThan(10);
    expect(ttf.advance[0]).toBe(1366 / 2048); expect(ttf.path.segments.length).toBeGreaterThan(5);
  });
  it('saves mixed source fonts, re-encoding, composites and nested text resources', () => {
    const bytes = Buffer.from(t1cs(t1num(0), t1num(500), 13, t1num(0), t1num(0), 21, t1num(400), t1num(600), 5, 14)).toString('hex');
    const type1 = `/Source1 << /FontType 1 /FontMatrix [.001 0 0 .001 0 0] /FontBBox [0 0 500 700] /Encoding StandardEncoding /Private << /lenIV -1 >> /CharStrings << /A <${bytes}> >> >> definefont pop`;
    const type42 = `/Source42 << /FontType 42 /FontMatrix [1 0 0 1 0 0] /FontBBox [0 0 1 1] /Encoding StandardEncoding /CharStrings << /B 1 >> /sfnts [<${Buffer.from(buildInkTtf()).toString('hex')}>] >> definefont pop`;
    const source = readFileSync(root('./fixtures/postscript-text/mixed.ps'), 'utf8').replace('%%TYPE1_FONT%%', type1).replace('%%TYPE42_FONT%%', type42);
    const { graphics } = runPsText(source); const doc = Document.New(); appendPsPages(doc, graphics.finish()); const reopened = Document.Open(doc.Save());
    expect(reopened.Pages).toHaveLength(1); expect(reopened.Pages[0]!.GetText()).toContain('ABBA'); expect(reopened.Pages[0]!.GetText()).toContain('F');
    expect(reopened.Pages[0]!.ToImage().length).toBeGreaterThan(100);
  });
});
