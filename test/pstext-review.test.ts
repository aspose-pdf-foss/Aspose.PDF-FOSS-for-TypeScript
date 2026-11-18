import { describe, expect, it } from 'vitest';
import { runPsText, pairFontSource, psTextBytes } from './helpers/ps-text.js';
import { parseContentStream } from '../src/content.js';
import { Document } from '../src/document.js';
import { appendPsPages } from '../src/pspdf.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { buildType1, t1cs, t1num, eexecStart } from './helpers/build-type1.js';
import { buildInkTtf, buildMinimalTtf, buildPostV2 } from './helpers/build-sfnt.js';
import { encryptedPs } from './helpers/ps-font-program.js';
import { PsBudget } from '../src/psbudget.js';
import { LoadLimits } from '../src/loadlimits.js';
import { DecodeBudget } from '../src/decodebudget.js';
import { suppliedPsProgram } from '../src/psfontprogram.js';
import { parseSfnt } from '../src/sfnt.js';
import { namesFromTables } from '../src/fontnames.js';
import { glyphToUnicode } from '../src/encoding.js';
const base = '/G << /FontType 3 /FontMatrix [.001 0 0 .001 0 0] /FontBBox [0 0 600 700] /Encoding StandardEncoding ';
describe('PostScript text whole-branch review regressions', () => {
  it('counts translated CTM origin exactly once in PDF text and character paths', () => {
    const native = runPsText('/Courier 10 selectfont 100 200 translate 10 20 moveto (A) show');
    const tm = parseContentStream(native.graphics.finish()[0]!.content).find(op => op.operator === 'Tm')!;
    expect(tm.operands[4]).toBe(110); expect(tm.operands[5]).toBe(220);
    const procedure = runPsText(base + '/BuildGlyph { pop pop 600 0 setcharwidth 0 0 100 100 rectfill } >> definefont setfont 100 200 translate 10 20 moveto (A) false charpath');
    expect(procedure.graphics.state.path.segments[0]).toEqual({ op: 'M', x: 110, y: 220 });
  });
  it('maps glyphshow names to actual BuildChar encoding codes and falls back to .notdef', () => {
    const { vm } = runPsText(base + '/BuildChar { /seen exch def pop seen 0 setcharwidth } >> definefont setfont 0 0 moveto /A glyphshow seen /privateglyph glyphshow seen');
    expect(vm.stack).toMatchObject([{ value: 65 }, { value: 0 }]);
  });
  it('rejects BuildChar glyphshow when neither the name nor .notdef is encoded', () => {
    expect(() => runPsText('/G << /FontType 3 /FontMatrix [.001 0 0 .001 0 0] /FontBBox [0 0 1 1] /Encoding [/A] /BuildChar { pop pop 0 0 setcharwidth } >> definefont setfont 0 0 moveto /privateglyph glyphshow')).toThrow(/invalidfont/);
  });
  it('saves a terminating same-font nested glyph without a cyclic bank resource', () => {
    const { graphics } = runPsText(base + '/BuildGlyph { exch pop /A eq { 600 0 setcharwidth 0 0 moveto /B glyphshow } { 300 0 setcharwidth 0 0 100 100 rectfill } ifelse } >> definefont setfont 0 0 moveto /A glyphshow');
    const doc = Document.New(); expect(() => appendPsPages(doc, graphics.finish())).not.toThrow();
    expect(Document.Open(doc.Save()).Pages[0]!.GetText()).toContain('A');
  });
  it('rejects Type1 procedure overrides even through builtin CharStrings lineage', () => {
    expect(() => runPsText('/Courier findfont dup length dict begin { 1 index /FID ne { def } { pop pop } ifelse } forall /BuildGlyph {} def /Bad currentdict end definefont')).toThrow(UnsupportedFeatureError);
  });
  it('matches composite width adjustments against immediate font number and byte', () => {
    const { vm } = runPsText(pairFontSource() + '/Pair 10 selectfont 0 0 moveto 10 0 321 <00410141> widthshow currentpoint 0 0 moveto 10 0 65 1 2 <00410141> awidthshow currentpoint');
    expect(vm.number(3).value).toBe(22); expect(vm.number(1).value).toBe(24); expect(vm.number().value).toBe(4);
  });
  it('uses the effective composite leaf in the glyph restore boundary', () => {
    const { vm } = runPsText('/Leaf << /FontName /Leaf /FontType 3 /FontMatrix [.001 0 0 .001 0 0] /FontBBox [0 0 1 1] /Encoding StandardEncoding /BuildGlyph { pop pop 1 0 setcharwidth currentfont /FontName get grestoreall currentfont /FontName get } >> definefont pop /Root << /FontName /Root /FontType 0 /FontMatrix [1 0 0 1 0 0] /FMapType 2 /Encoding [0] /FDepVector [/Leaf findfont] >> definefont setfont <0041> stringwidth');
    expect(vm.stack.slice(0, 2)).toMatchObject([{ text: 'Leaf' }, { text: 'Leaf' }]);
  });
  it('keeps private invocation frames out of kshow exit and reports a missing point as a language fault', () => {
    expect(() => runPsText('0 0 moveto { pop pop newpath } (AB) kshow')).toThrow(/nocurrentpoint/);
  });
  it('retains a supplied Type1 program encoding', () => {
    const bytes = buildType1({ encoding: { 65: 'B' }, charstrings: { A: t1cs(t1num(0), t1num(300), 13, 14), B: t1cs(t1num(0), t1num(800), 13, 14) } });
    const { vm } = runPsText('/Host 10 selectfont (A) stringwidth currentfont /Encoding get 65 get', { fonts: [{ name: 'Host', bytes }] });
    expect(vm.stack).toMatchObject([{ value: 8 }, { value: 0 }, { text: 'B' }]);
  });
  it('owns supplied Buffer storage after registration', () => {
    const bytes = Buffer.from(buildInkTtf()), { text } = runPsText('', { fonts: [{ name: 'Host', bytes }] });
    const font = text.fonts.definition(text.fonts.find({ kind: 'name', text: 'Host', executable: false }));
    expect(font.program!.glyph('A').path.segments).toHaveLength(5); bytes.fill(0);
    expect(font.program!.glyph('A').path.segments).toHaveLength(5);
  });
  it('routes stroke-designed builtin copies through stroke-capable glyph resources', () => {
    const { graphics } = runPsText('/Courier findfont dup length dict begin { 1 index /FID ne { def } { pop pop } ifelse } forall /PaintType 2 def /StrokeWidth 30 def /Stroke currentdict end definefont 12 scalefont setfont 0 0 moveto (A) show');
    const fonts = graphics.finish()[0]!.resources.get('Font') as import('../src/types.js').PdfDict, font = [...fonts.values()][0] as import('../src/types.js').PdfDict;
    expect(font.get('Subtype')).toEqual({ kind: 'name', name: 'Type3' });
    const proc = [...(font.get('CharProcs') as import('../src/types.js').PdfDict).values()][0] as import('../src/types.js').PdfStream;
    expect(parseContentStream(proc.raw).some(op => op.operator === 'S')).toBe(true);
  });
  it('reuses identical completed procedure glyphs at different positions', () => {
    const { graphics } = runPsText(base + '/BuildGlyph { pop pop 600 0 setcharwidth 0 0 1 1 rectfill } >> definefont setfont 0 0 moveto (AA) show');
    const fonts = graphics.finish()[0]!.resources.get('Font') as import('../src/types.js').PdfDict, font = [...fonts.values()][0] as import('../src/types.js').PdfDict;
    expect((font.get('CharProcs') as import('../src/types.js').PdfDict).size).toBe(1);
  });
  it('retains caller graphics roots until the glyph capture unwinds', () => {
    const { vm, graphics } = runPsText(base + '/BuildGlyph { pop pop 1 0 setcharwidth s restore } >> definefont setfont /letters (A) def 0 0 moveto /s save def [1 2] 0 setdash');
    expect(() => vm.run(psTextBytes('letters show'))).toThrow(/invalidrestore/);
    expect(graphics.state.sourceDash!.body.valid).toBe(true);
  });
  it.each(['\r', '\r\n'])('allows encrypted closefile ending with %j before a clear suffix', newline => {
    const { vm, text } = runPsText(); vm.run(text.fontSource(encryptedPs('mark currentfile closefile', { hex: true, newline, suffix: 'cleartomark 7 8 add' })));
    expect(vm.stack).toMatchObject([{ value: 15 }]);
  });
  it('meters shared name-record spans before decoding and post-name arrays before growing', () => {
    const data = new Uint8Array(298), view = new DataView(data.buffer); view.setUint16(2, 3); view.setUint16(4, 42);
    for (let i = 0; i < 3; i++) { const p = 6 + i * 12; view.setUint16(p, 3); view.setUint16(p + 6, i + 1); view.setUint16(p + 8, 256); }
    const work = new PsBudget(LoadLimits.defaults.with({ maxPostScriptVmBytes: 1024 }));
    expect(() => namesFromTables({ name: data }, work)).toThrowError(expect.objectContaining({ limit: 'maxPostScriptVmBytes' }));
    const font = parseSfnt(buildMinimalTtf({ post: buildPostV2(['A', 'B', 'C']) })); font.work = new PsBudget(LoadLimits.defaults.with({ maxPostScriptVmBytes: 100 }));
    expect(() => font.postNames()).toThrowError(expect.objectContaining({ limit: 'maxPostScriptVmBytes' }));
  });
  it('charges every supplied Type1 decryption layer to the shared decode total', () => {
    const plain = t1cs(t1num(0), t1num(500), 13, 14), bytes = buildType1({ charstrings: { A: plain }, subrs: [Uint8Array.of(11)] });
    const { vm } = runPsText(), decode = new DecodeBudget(LoadLimits.defaults);
    suppliedPsProgram(vm, bytes, decode);
    expect(decode.decoded).toBe(bytes.length - eexecStart(bytes) - 4 + plain.length + 1);
  });
  it.each(['constructor', 'toString', '__proto__'])('treats private prototype-property name %s as unknown Unicode', n => {
    expect(glyphToUnicode(n)).toBeUndefined();
  });
});
