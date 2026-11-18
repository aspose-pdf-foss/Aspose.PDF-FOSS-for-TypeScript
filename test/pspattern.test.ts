import { describe, expect, it } from 'vitest';
import { runGraphics } from './helpers/ps-graphics.js';
import { Document } from '../src/document.js';
import { appendPsPages } from '../src/pspdf.js';
import { parseContentStream } from '../src/content.js';
import { isDict, isStream, type PdfStream } from '../src/types.js';
import { decodePng } from './helpers/decode-png.js';
export const colored = '<< /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 5 5] '
  + '/XStep 10 /YStep 10 /PaintProc { pop 1 0 0 setrgbcolor 0 0 5 5 rectfill } >>';
const uncolored = colored.replace('/PaintType 1', '/PaintType 2').replace('1 0 0 setrgbcolor ', '');
function patterns(doc: Document, page = 0): PdfStream[] {
  const res = doc.resolve(doc.Pages[page]!.Dict.get('Resources'));
  const dict = isDict(res) ? doc.resolve(res.get('Pattern')) : undefined;
  return isDict(dict) ? [...dict.values()].map(value => doc.resolve(value)).filter(isStream) : [];
}
describe('PostScript tiling patterns', () => {
  it('shares a captured pattern stream across separately painted pages', () => {
    const { graphics } = runGraphics(colored + ' matrix makepattern /p exch def '
      + 'p setpattern 0 0 30 30 rectfill showpage p setpattern 0 0 30 30 rectfill showpage');
    const doc = Document.New(); appendPsPages(doc, graphics.finish());
    const reopened = Document.Open(doc.Save());
    expect(patterns(reopened)[0]).toBe(patterns(reopened, 1)[0]);
  });
  it('binds placement when created and owns resources on every page', () => {
    const { graphics } = runGraphics('2 3 translate ' + colored + ' matrix makepattern /p exch def '
      + 'initmatrix p setpattern 0 0 30 30 rectfill showpage p setpattern 0 0 30 30 rectfill showpage');
    const doc = Document.New(); appendPsPages(doc, graphics.finish()); const reopened = Document.Open(doc.Save());
    expect(patterns(reopened)).toHaveLength(1); expect(patterns(reopened, 1)).toHaveLength(1);
    expect(patterns(reopened)[0]!.dict.get('Matrix')).toEqual([1, 0, 0, 1, 2, 3]);
    const png = decodePng(reopened.Pages[0]!.ToImage());
    expect(png.at(3, 837)).toEqual([255, 0, 0, 255]);
    expect(png.at(8, 837)).toEqual([255, 255, 255, 255]);
  });
  it.each([1, 2, 3])('supports TilingType %i and signed steps', tiling => {
    const { graphics } = runGraphics(colored.replace('/TilingType 1', `/TilingType ${tiling}`)
      .replace('/XStep 10', '/XStep -10') + ' matrix makepattern setpattern 0 0 20 20 rectfill showpage');
    expect(graphics.finish()).toHaveLength(1);
  });
  it('emits an uncolored cell with base components supplied at setcolor', () => {
    const { graphics } = runGraphics(uncolored + ' matrix makepattern /p exch def '
      + '[/Pattern /DeviceRGB] setcolorspace 0 1 0 p setcolor 0 0 20 20 rectfill showpage');
    const doc = Document.New(); appendPsPages(doc, graphics.finish()); const reopened = Document.Open(doc.Save());
    const pattern = patterns(reopened)[0]!;
    expect(pattern.dict.get('PaintType')).toBe(2);
    expect(parseContentStream(pattern.raw).some(op => ['g', 'rg', 'k', 'cs', 'scn'].includes(op.operator))).toBe(false);
    expect(parseContentStream(reopened.Pages[0]!.Contents).find(op => op.operator === 'scn')?.operands.slice(0, 3)).toEqual([0, 1, 0]);
  });
  it.each(['0 setgray', '/DeviceRGB setcolorspace', '0 0 0 setrgbcolor', 'initgraphics', 'gstate setgstate',
    '1 1 8 [1 0 0 1 0 0] <00> image'])('refuses %s inside uncolored cells', operation => {
    expect(() => runGraphics(uncolored.replace('0 0 5 5 rectfill', operation)
      + ' matrix makepattern /p exch def [/Pattern /DeviceRGB] setcolorspace 0 1 0 p setcolor')).toThrow(/undefined/);
  });
  it('rejects a forged pattern and invalidated bound dictionaries', () => {
    expect(() => runGraphics(colored + ' setpattern')).toThrow(/typecheck|invalidaccess/);
    expect(() => runGraphics('/s save def ' + colored + ' matrix makepattern s restore')).toThrow(/invalidrestore/);
  });
  it('abandons a stopped pattern callback and retains the parent color', () => {
    const { vm, graphics } = runGraphics('0.5 setgray { ' + colored.replace('0 0 5 5 rectfill', 'stop')
      + ' matrix makepattern setpattern } stopped currentgray showpage');
    expect(vm.stack).toMatchObject([{ value: true }, { value: 0.5 }]);
    expect(graphics.finish()[0]!.resources.has('Pattern')).toBe(false);
  });
  it('uses the current device space for uncolored setpattern shorthand', () => {
    const { vm } = runGraphics('0 0 0 setrgbcolor ' + uncolored
      + ' matrix makepattern 0 1 0 4 -1 roll setpattern currentcolor pop');
    expect(vm.stack).toMatchObject([{ value: 0 }, { value: 1 }, { value: 0 }]);
  });
  it('rebases a reusable pattern into a transformed form resource owner', () => {
    const { graphics } = runGraphics(colored + ' matrix makepattern /p exch def '
      + '<< /FormType 1 /BBox [0 0 20 20] /Matrix [1 0 0 1 20 30] '
      + '/PaintProc { pop p setpattern 0 0 20 20 rectfill } >> execform showpage');
    const doc = Document.New(); appendPsPages(doc, graphics.finish()); const reopened = Document.Open(doc.Save());
    const resources = reopened.resolve(reopened.Pages[0]!.Dict.get('Resources'));
    const objects = isDict(resources) ? reopened.resolve(resources.get('XObject')) : undefined;
    const form = isDict(objects) ? reopened.resolve([...objects.values()][0]) : undefined;
    expect(isStream(form)).toBe(true);
    const res = isStream(form) ? reopened.resolve(form.dict.get('Resources')) : undefined;
    const pats = isDict(res) ? reopened.resolve(res.get('Pattern')) : undefined;
    const pat = isDict(pats) ? reopened.resolve([...pats.values()][0]) : undefined;
    expect(isStream(pat) ? pat.dict.get('Matrix') : undefined).toEqual([1, 0, 0, 1, -20, -30]);
  });
  it('retries a stopped cell without publishing its abandoned resource', () => {
    const { vm, graphics } = runGraphics('/first true def ' + colored.replace('0 0 5 5 rectfill',
      'first { /first false def stop } if 0 0 5 5 rectfill')
      + ' matrix makepattern /p exch def { p setpattern } stopped pop p setpattern 0 0 20 20 rectfill showpage');
    expect(vm.lookup('first')).toMatchObject({ value: false });
    expect(graphics.finish()[0]!.resources.has('Pattern')).toBe(true);
  });
});
