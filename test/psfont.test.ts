import { describe, expect, it } from 'vitest';
import { runPsFonts, psTextBytes } from './helpers/ps-text.js';
import { installPsFonts } from '../src/psfont.js';
import { name, type PsDictionary } from '../src/psvalue.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { buildType1, t1cs, t1num } from './helpers/build-type1.js';
import { PsInterpreter } from '../src/psvm.js';
import { installPsGraphics } from '../src/psgraphics.js';

const type3 = '10 dict begin /FontType 3 def /FontMatrix [.001 0 0 .001 0 0] def /FontBBox [0 0 500 700] def /Encoding StandardEncoding def /BuildGlyph { pop pop 500 0 setcharwidth } def currentdict end';
const recode = '/Courier findfont dup length dict begin { 1 index /FID ne { def } { pop pop } ifelse } forall /Encoding StandardEncoding dup length array copy def Encoding 65 /B put currentdict end /Recode exch definefont';
describe('VM-owned PostScript fonts', () => {
  it('starts at Courier12 and installs protected font/encoding values', () => {
    const { vm, fonts } = runPsFonts('currentfont /FontName get currentfont /FontMatrix get 0 get currentfont /FID get type');
    expect(vm.stack).toMatchObject([{ text: 'Courier' }, { value: 0.012 }, { text: 'fonttype' }]);
    expect(fonts.current().program!.glyph('A').advance).toEqual([600, 0]);
    expect(() => vm.run(psTextBytes('StandardEncoding 65 /B put'))).toThrow(/invalidaccess/);
  });
  it('derives full matrices without modifying its source font', () => {
    const { fonts, vm } = runPsFonts('/Helvetica findfont dup [0 20 -10 0 3 4] makefont setfont /FontMatrix get');
    expect(fonts.current().matrix).toEqual([0, 0.02, -0.01, 0, 3, 4]);
    expect((vm.stack[0] as { kind: string }).kind).toBe('array');
    expect(fonts.definition(fonts.find(name('Helvetica'))).matrix).toEqual([.001, 0, 0, .001, 0, 0]);
  });
  it('re-encodes a copied builtin font through trusted program identity', () => {
    const { fonts } = runPsFonts(recode + ' setfont');
    expect(fonts.current().standard).toBe('Courier'); expect(fonts.current().encoding[65]).toBe('B');
  });
  it('rejects a copied FID and leaves the candidate writable on failure', () => {
    const { vm } = runPsFonts('/Courier findfont dup length dict copy /fake exch def');
    expect(() => vm.run(psTextBytes('/Fake fake definefont'))).toThrow(/invalidfont/);
    vm.run(psTextBytes('clear fake /probe 1 put fake /probe get')); expect(vm.number().value).toBe(1);
  });
  it('defines source Type3 dictionaries, prefers BuildGlyph and returns readonly fonts', () => {
    const { fonts, vm } = runPsFonts('/Local ' + type3 + ' definefont dup setfont /FID get type');
    expect(fonts.current().type).toBe(3); expect(fonts.current().builder?.byName).toBe(true);
    expect(vm.peek()).toMatchObject({ text: 'fonttype' });
    expect(() => vm.run(psTextBytes('currentfont /FontType 1 put'))).toThrow(/invalidaccess/);
  });
  it('restores local definitions and retains global definitions and global directory views', () => {
    const { vm } = runPsFonts('/s save def /Local ' + type3 + ' definefont pop true setglobal /Global ' + type3 + ' definefont pop false setglobal s restore FontDirectory /Local known FontDirectory /Global known true setglobal FontDirectory GlobalFontDirectory eq');
    expect(vm.stack).toMatchObject([{ value: false }, { value: true }, { value: true }]);
  });
  it('undefines registry entries without invalidating an already selected font', () => {
    const { fonts, vm } = runPsFonts('/Local ' + type3 + ' definefont setfont /Local undefinefont currentfont /FontType get');
    expect(fonts.current().type).toBe(3); expect(vm.peek()).toMatchObject({ value: 3 });
    expect(() => vm.run(psTextBytes('/Local findfont'))).toThrow(/invalidfont/);
  });
  it.each(['initgraphics', 'showpage', 'nulldevice', '<< /PageSize [100 200] >> setpagedevice'])('preserves font selection over %s', command => {
    const { fonts } = runPsFonts('/Times-Bold 15 selectfont ' + command); expect(fonts.current().standard).toBe('Times-Bold'); expect(fonts.current().matrix[0]).toBe(.015);
  });
  it('restores selection through gsave and VM restore', () => {
    const { fonts } = runPsFonts('/Times-Italic 10 selectfont gsave /Helvetica 20 selectfont grestore /s save def /Courier 30 selectfont s restore');
    expect(fonts.current().standard).toBe('Times-Italic'); expect(fonts.current().matrix[0]).toBe(.01);
  });
  it('supports Font and Encoding resource status/lookup/definition/removal', () => {
    const { vm } = runPsFonts('/Courier /Font findresource /Courier findfont eq /StandardEncoding /Encoding findresource StandardEncoding eq /Courier /Font resourcestatus /New StandardEncoding /Encoding defineresource pop /New findencoding StandardEncoding eq /New /Encoding undefineresource /New /Encoding resourcestatus');
    expect(vm.stack).toMatchObject([{ value: true }, { value: true }, { value: 0 }, { value: 0 }, { value: true }, { value: true }, { value: false }]);
  });
  it('enumerates resource keys with bounded callbacks and ordinary exit', () => {
    const { vm } = runPsFonts('(*) { pop /found true def exit } 80 string /Font resourceforall found'); expect(vm.peek()).toMatchObject({ value: true });
  });
  it('rejects missing names and unsupported fonts/categories explicitly', () => {
    const { vm } = runPsFonts();
    expect(() => vm.run(psTextBytes('/Arial findfont'))).toThrow(/invalidfont/);
    expect(() => vm.run(psTextBytes('/Unknown findencoding'))).toThrow(/undefinedresource/);
    expect(() => vm.run(psTextBytes('clear /X << /FontType 9 >> definefont'))).toThrow(UnsupportedFeatureError);
    expect(() => vm.run(psTextBytes('clear /X /CMap findresource'))).toThrow(UnsupportedFeatureError);
  });
  it('accepts an explicitly supplied Type1 alias without host font discovery', () => {
    const bytes = buildType1({ charstrings: { A: t1cs(t1num(0), t1num(550), 13, 14) } });
    const { fonts } = runPsFonts('/MyFace 10 selectfont', { fonts: [{ name: 'MyFace', bytes }] });
    expect(fonts.current().program!.glyph('A').advance).toEqual([550, 0]);
  });
  it('preserves complete supplied Type1 FontMatrix including skew and translation', () => {
    const bytes = buildType1({ charstrings: { A: t1cs(t1num(0), t1num(550), 13, 14) }, fontMatrix: [.001, .002, .003, .004, 5, 6] });
    const { fonts } = runPsFonts('/MyFace findfont setfont', { fonts: [{ name: 'MyFace', bytes }] });
    expect(fonts.current().matrix).toEqual([.001, .002, .003, .004, 5, 6]);
  });
  it('installs Adobe ISOLatin1Encoding including its punctuation and accent slots', () => {
    const { vm } = runPsFonts('ISOLatin1Encoding 39 get ISOLatin1Encoding 45 get ISOLatin1Encoding 128 get ISOLatin1Encoding 144 get');
    expect(vm.stack).toMatchObject([{ text: 'quoteright' }, { text: 'minus' }, { text: '.notdef' }, { text: 'dotlessi' }]);
  });
  it('honors Metrics on a copied builtin font', () => {
    const { fonts } = runPsFonts('/Courier findfont dup length dict begin { 1 index /FID ne { def } { pop pop } ifelse } forall /Metrics << /A [10 20 650 30] >> def /M currentdict end definefont setfont');
    expect(fonts.current().program!.glyph('A').advance).toEqual([650, 30]);
    expect(fonts.current().program!.glyph('A').sidebearing).toEqual([10, 20]);
  });
  it('matches bracketed classes and escaped wildcard literals in resourceforall', () => {
    const { vm } = runPsFonts('/n 0 def (Courie[r]) { pop /n n 1 add def } 80 string /Font resourceforall n');
    expect(vm.number().value).toBe(1);
  });
  it('rejects duplicate/mismatched/late installation before publishing dictionaries', () => {
    const { vm, graphics } = runPsFonts(); expect(() => installPsFonts(vm, graphics)).toThrow(/invalidaccess/);
    const other = new PsInterpreter(); expect(() => installPsFonts(other, graphics)).toThrow(/invalidaccess/); expect(other.lookup('FontDirectory')).toBeUndefined();
    const fresh = new PsInterpreter(), g = installPsGraphics(fresh); const saved = fresh.save();
    expect(() => installPsFonts(fresh, g)).toThrow(/invalidaccess/); expect(fresh.lookup('FontDirectory')).toBeUndefined(); fresh.restore(saved);
  });
});
