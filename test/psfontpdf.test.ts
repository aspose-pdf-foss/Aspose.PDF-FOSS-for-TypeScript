import { describe, expect, it } from 'vitest';
import { runPsFonts, psTextBytes } from './helpers/ps-text.js';
import { PsFontPdfBank } from '../src/psfontpdf.js';
import { appendPsPages, PsPdfWriter } from '../src/pspdf.js';
import { Document } from '../src/document.js';
import { parseContentStream } from '../src/content.js';
import { name, isDict, isStream, type PdfDict } from '../src/types.js';
import { PsBudget } from '../src/psbudget.js';
import { LoadLimits } from '../src/loadlimits.js';
import type { PsProgramGlyph } from '../src/psfonttypes.js';
import { decodePng } from './helpers/decode-png.js';
const emptyGlyph = (n: string): PsProgramGlyph => ({ name: n, advance: [500, 30], sidebearing: [0, 0], path: { segments: [] }, box: [0, 0, 10, 20] });
describe('PostScript PDF font banks', () => {
  it('saves native Standard14 text with explicit affine placement and Unicode', () => {
    const { vm, graphics, fonts } = runPsFonts('/Courier 10 selectfont 0.1 0.2 0.3 0.4 setcmykcolor true setoverprint');
    const font = fonts.current(), bank = new PsFontPdfBank(vm, graphics), glyph = bank.glyph(font, font.program!.glyph('A'));
    graphics.writer.drawText(glyph, [.01, 0, .002, .02, 10, 20], graphics.state);
    const output = graphics.finish()[0]!;
    const tm = parseContentStream(output.content).find(op => op.operator === 'Tm')!;
    [10, 0, 2, 20, 10, 20].forEach((n, i) => expect(tm.operands[i]).toBeCloseTo(n, 10));
    expect(parseContentStream(output.content)).toContainEqual({ operator: 'k', operands: [.1, .2, .3, .4] });
    expect(glyph.font.get('Subtype')).toEqual(name('Type1'));
    const doc = Document.New(); appendPsPages(doc, graphics.finish());
    expect(Document.Open(doc.Save()).Pages[0]!.GetText()).toContain('A');
  });
  it('writes Type3 d0/d1 charprocs, widths and only known Unicode mappings', () => {
    const { vm, graphics, fonts } = runPsFonts(); const bank = new PsFontPdfBank(vm, graphics), font = { ...fonts.current(), standard: undefined };
    const a = emptyGlyph('A'); a.unicode = 'A'; a.path.segments = [{ op: 'M', x: 1, y: 2 }, { op: 'L', x: 3, y: 4 }, { op: 'Z' }];
    const first = bank.glyph(font, a), unknown = bank.glyph(font, emptyGlyph('privateglyph'));
    expect(first.font).toBe(unknown.font); expect(first.code).not.toBe(unknown.code);
    const chars = first.font.get('CharProcs') as PdfDict, proc = chars.get('g0'); expect(isStream(proc)).toBe(true);
    expect(parseContentStream((proc as { raw: Uint8Array }).raw)[0]).toEqual({ operator: 'd1', operands: [500, 0, 0, 0, 10, 20] });
    expect(first.font.get('Widths')).toEqual([500, 500]);
    const cmap = first.font.get('ToUnicode'); expect(isStream(cmap) && new TextDecoder().decode(cmap.raw)).toContain('<00> <0041>');
    expect(isStream(cmap) && new TextDecoder().decode(cmap.raw)).not.toContain('<01> <');
  });
  it('spans 257 unencoded names without overwriting earlier code meanings', () => {
    const { vm, graphics, fonts } = runPsFonts(), bank = new PsFontPdfBank(vm, graphics), font = { ...fonts.current(), standard: undefined };
    const first = bank.glyph(font, emptyGlyph('n0')); let last = first;
    for (let i = 1; i <= 256; i++) last = bank.glyph(font, emptyGlyph('n' + i));
    expect(last.font).not.toBe(first.font); expect(last.code).toBe(0); expect(bank.glyph(font, emptyGlyph('n0'))).toBe(first);
    expect((first.font.get('CharProcs') as PdfDict).size).toBe(256);
  });
  it('deduplicates completed dynamic paint including nested resource meaning', () => {
    const { vm, graphics, fonts } = runPsFonts(), bank = new PsFontPdfBank(vm, graphics), font = { ...fonts.current(), standard: undefined };
    const paint = { content: psTextBytes('0 0 1 1 re f'), resources: new Map() as PdfDict, colored: true };
    const a = bank.glyph(font, emptyGlyph('A'), paint), b = bank.glyph(font, emptyGlyph('A'), { ...paint, content: paint.content.slice() });
    expect(a).toBe(b);
    const changed = bank.glyph(font, emptyGlyph('A'), { ...paint, content: psTextBytes('0 0 2 2 re f') }); expect(changed.code).not.toBe(a.code);
    const chars = a.font.get('CharProcs') as PdfDict;
    expect(parseContentStream((chars.get('g0') as { raw: Uint8Array }).raw)[0]?.operator).toBe('d0');
  });
  it('reuses completed glyph streams over page changes and transformed owners', () => {
    const { vm, graphics, fonts } = runPsFonts(), bank = new PsFontPdfBank(vm, graphics), font = fonts.current();
    const a = bank.glyph(font, font.program!.glyph('A')); graphics.writer.drawText(a, [.012, 0, 0, .012, 10, 20], graphics.state); graphics.showPage();
    graphics.writer.drawText(bank.glyph(font, font.program!.glyph('A')), [.012, 0, 0, .012, 30, 40], graphics.state);
    const capture = graphics.beginCapture([0, 0, 100, 100], [2, 0, 0, 3, 10, 20], false);
    graphics.writer.drawText(a, [.024, 0, 0, .036, 10, 20], graphics.state);
    const tm = parseContentStream(capture.complete().content).find(op => op.operator === 'Tm')!;
    [12, 0, 0, 12, 0, 0].forEach((n, i) => expect(tm.operands[i]).toBeCloseTo(n, 10));
    const pages = graphics.finish(); expect(pages[0]!.resources.get('Font')).toEqual(pages[1]!.resources.get('Font'));
  });
  it('rolls back an interrupted text block and its resource registration', () => {
    const { vm, graphics, fonts } = runPsFonts(), glyph = new PsFontPdfBank(vm, graphics).glyph(fonts.current(), fonts.current().program!.glyph('A'));
    const writer = new PsPdfWriter(new PsBudget(LoadLimits.defaults.with({ maxContentTokens: 21 })), [0, 0, 20, 20]);
    expect(() => writer.drawText(glyph, [.01, 0, 0, .01, 1, 2], graphics.state)).toThrowError(expect.objectContaining({ limit: 'maxContentTokens' }));
    const output = writer.finish(); expect(output.content).toHaveLength(0); expect(output.resources.has('Font')).toBe(false);
  });
  it('resolves completed glyph paint resources through the Type3 font', () => {
    const { vm, graphics, fonts } = runPsFonts('<< /PageSize [40 40] >> setpagedevice');
    const form = { kind: 'stream' as const, raw: psTextBytes('1 0 0 rg 0 0 10 20 re f'), dict: new Map<string, import('../src/types.js').PdfObject>([['Subtype', name('Form')], ['BBox', [0, 0, 10, 20]], ['Resources', new Map()]]) };
    const resources: PdfDict = new Map([['XObject', new Map([['X', form]])]]);
    const font = { ...fonts.current(), standard: undefined }, g = new PsFontPdfBank(vm, graphics).glyph(font, emptyGlyph('A'), { content: psTextBytes('/X Do'), resources, colored: true });
    graphics.writer.drawText(g, [1, 0, 0, 1, 10, 10], graphics.state);
    const doc = Document.New(); appendPsPages(doc, graphics.finish()); const reopened = Document.Open(doc.Save());
    expect(decodePng(reopened.Pages[0]!.ToImage()).at(15, 20)).toEqual([255, 0, 0, 255]);
  });
});
