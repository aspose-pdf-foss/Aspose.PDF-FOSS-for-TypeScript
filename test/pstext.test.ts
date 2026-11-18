import { describe, expect, it } from 'vitest';
import { runPsText, psTextBytes } from './helpers/ps-text.js';
import { Document } from '../src/document.js';
import { appendPsPages } from '../src/pspdf.js';
import { installPsText } from '../src/pstext.js';
import { PsInterpreter } from '../src/psvm.js';
import { installPsGraphics } from '../src/psgraphics.js';
describe('PostScript base text', () => {
  it('measures Courier12 without a current point or publishing output', () => {
    const { vm, graphics } = runPsText('(AA) stringwidth');
    expect(vm.number(1).value).toBeCloseTo(14.4); expect(vm.number().value).toBe(0); expect(graphics.finish()).toHaveLength(0);
  });
  it('shows and reopens extractable text at its literal endpoint', () => {
    const { vm, graphics } = runPsText('10 20 moveto (AA) show currentpoint');
    expect(vm.number(1).value).toBeCloseTo(24.4); expect(vm.number().value).toBe(20);
    const doc = Document.New(); appendPsPages(doc, graphics.finish()); expect(Document.Open(doc.Save()).Pages[0]!.GetText()).toContain('AA');
  });
  it('uses full FontMatrix width vectors under rotation', () => {
    const { vm } = runPsText('/Courier findfont [0 10 -20 0 0 0] makefont setfont (AA) stringwidth 10 20 moveto (AA) show currentpoint');
    expect(vm.stack).toMatchObject([{ value: 0 }, { value: 12 }, { value: 10 }, { value: 32 }]);
  });
  it('retains constructed device origin after CTM changes and keeps earlier path segments', () => {
    const { vm, graphics } = runPsText('/Courier 10 selectfont 10 20 moveto 20 30 lineto 2 3 scale (A) show currentpoint');
    expect(vm.number(1).value).toBeCloseTo(16); expect(vm.number().value).toBeCloseTo(10);
    expect(graphics.state.path.segments.slice(0, 2)).toEqual([{ op: 'M', x: 10, y: 20 }, { op: 'L', x: 20, y: 30 }]);
  });
  it('selects an unencoded glyph without changing Encoding and uses .notdef for missing names', () => {
    const { vm } = runPsText('/Courier 10 selectfont 0 0 moveto /fi glyphshow /missingglyph glyphshow currentpoint currentfont /Encoding get 65 get');
    expect(vm.stack[0]).toMatchObject({ value: 6 }); expect(vm.stack[1]).toMatchObject({ value: 0 }); expect(vm.peek()).toMatchObject({ text: 'A' });
  });
  it('runs nested Type3 glyphs with independent metrics', () => {
    const { vm } = runPsText('/Inner << /FontType 3 /FontMatrix [.001 0 0 .001 0 0] /FontBBox [0 0 100 100] /Encoding StandardEncoding /BuildGlyph { pop pop 300 20 setcharwidth 0 0 100 100 rectfill } >> definefont pop /Outer << /FontType 3 /FontMatrix [.001 0 0 .001 0 0] /FontBBox [0 0 100 100] /Encoding StandardEncoding /BuildGlyph { pop pop 600 30 setcharwidth /Inner 1 selectfont 0 0 moveto (A) show } >> definefont 10 scalefont setfont (A) stringwidth');
    expect(vm.number(1).value).toBe(6); expect(vm.number().value).toBeCloseTo(.3);
  });
  it('keeps emitted resources valid after restoring their source font', () => {
    const { vm, graphics } = runPsText('/s save def /Local /Courier findfont dup length dict begin { 1 index /FID ne { def } { pop pop } ifelse } forall currentdict end definefont 10 scalefont setfont 0 0 moveto (A) show s restore');
    const doc = Document.New(); appendPsPages(doc, graphics.finish()); expect(Document.Open(doc.Save()).Pages[0]!.GetText()).toContain('A');
    expect(() => vm.run(psTextBytes('/Local findfont'))).toThrow(/invalidfont/);
  });
  it('rejects duplicate, wrong-VM and late installs without mutations', () => {
    const { vm, graphics } = runPsText(); expect(() => installPsText(vm, graphics)).toThrow(/invalidaccess/);
    const other = new PsInterpreter(); expect(() => installPsText(other, graphics)).toThrow(/invalidaccess/); expect(other.lookup('FontDirectory')).toBeUndefined();
    const fresh = new PsInterpreter(), g = installPsGraphics(fresh); fresh.run(psTextBytes('1 pop'));
    expect(() => installPsText(fresh, g)).toThrow(/invalidaccess/); expect(fresh.lookup('FontDirectory')).toBeUndefined();
  });
});
