import { describe, expect, it } from 'vitest';
import { pairFontSource, runPsText, psTextBytes } from './helpers/ps-text.js';
import { UnsupportedFeatureError } from '../src/errors.js';
const modal = '/Modal << /FontType 0 /FontMatrix [1 0 0 1 0 0] /FMapType 3 /Encoding [0 1] /FDepVector [ /Base0 findfont /Base1 findfont ] >> definefont pop ';
describe('PostScript composite text mapping', () => {
  it('maps 8/8 pairs with identical show, width and charpath advances', () => {
    const { vm } = runPsText(pairFontSource() + '/Pair 10 selectfont <00410142> stringwidth 0 0 moveto <00410142> show currentpoint 0 0 moveto <00410142> false charpath currentpoint');
    [0, 2, 4].forEach(i => { expect(vm.stack[i]).toMatchObject({ value: 12 }); expect(vm.stack[i + 1]).toMatchObject({ value: 0 }); });
  });
  it('switches escape descendants, passes a doubled root escape and resets each show string', () => {
    const { vm } = runPsText(pairFontSource() + modal + '/Modal findfont setfont { pop pop } <41ff0142ffff41> cshow <41> stringwidth');
    expect(vm.stack.slice(0, 4)).toMatchObject([{ value: 65 }, { value: 66 }, { value: 255 }, { value: 65 }]);
    expect(vm.number(1).value).toBe(.5);
  });
  it('ascends modal parents on repeated escapes and honors the root EscChar', () => {
    const nested = '/Outer << /FontType 0 /FontMatrix [1 0 0 1 0 0] /FMapType 3 /Encoding [0 1] /FDepVector [ /Base0 findfont /Modal findfont ] >> definefont setfont ';
    const { vm } = runPsText(pairFontSource() + modal + nested + '{ pop pop } <ff0141ff0142ffff0043> cshow');
    expect(vm.stack).toMatchObject([{ value: 65 }, { value: 66 }, { value: 67 }]);
  });
  it('does not interpret a modal escape in the second byte of a nonmodal pair', () => {
    const root = '/Root << /FontType 0 /FontMatrix [1 0 0 1 0 0] /FMapType 3 /Encoding [0] /FDepVector [ /Pair findfont ] >> definefont setfont ';
    const { vm } = runPsText(pairFontSource() + root + '{ pop pop } <00ff> cshow'); expect(vm.stack).toMatchObject([{ value: 255 }]);
  });
  it('propagates matrices into Type0 descendants exactly once', () => {
    const source = pairFontSource() + '/Inner << /FontType 0 /FontMatrix [2 0 0 3 0 0] /FMapType 2 /Encoding [0] /FDepVector [ /Base0 findfont ] >> definefont pop /Outer << /FontType 0 /FontMatrix [5 0 0 7 0 0] /FMapType 2 /Encoding [0] /FDepVector [ /Inner findfont ] >> definefont setfont ';
    const { vm, graphics } = runPsText(source + 'currentfont /FDepVector get 0 get /FontMatrix get aload pop <000041> stringwidth 0 0 moveto <000041> false charpath currentpoint');
    expect(vm.stack.slice(0, 6)).toMatchObject([10, 0, 0, 21, 0, 0].map(value => ({ value })));
    expect(vm.number(3).value).toBe(5); expect(vm.number(1).value).toBe(5);
    const move = graphics.state.path.segments[0]!; expect(move).toMatchObject({ op: 'M' }); if (move.op !== 'Z') { expect(move.x).toBeCloseTo(1); expect(move.y).toBeCloseTo(4.2); }
  });
  it('exposes effective leaf and original root within callbacks and restores selection', () => {
    const { vm } = runPsText(pairFontSource() + '/Pair 10 selectfont { pop pop pop currentfont /FontName get rootfont /FontName get currentfont /FontMatrix get 0 get /Courier 20 selectfont currentfont rootfont eq } <0041> cshow currentfont /FontName get');
    expect(vm.stack).toMatchObject([{ text: 'Base0' }, { text: 'Pair' }, { value: .01 }, { value: true }, { text: 'Pair' }]);
  });
  it.each(['00', '0241'])('refuses truncated or invalid selectors: %s', hex => {
    expect(() => runPsText(pairFontSource() + `/Pair findfont setfont <${hex}> stringwidth`)).toThrow(/rangecheck/);
  });
  it('rejects cycles and more than five composite levels', () => {
    expect(() => runPsText('/d << /FontType 0 /FontMatrix [1 0 0 1 0 0] /FMapType 2 /Encoding [0] /FDepVector 1 array >> def d /FDepVector get 0 d put /Cycle d definefont')).toThrow(/invalidfont/);
    let source = pairFontSource(); for (let i = 0; i < 6; i++) source += `/N${i} << /FontType 0 /FontMatrix [1 0 0 1 0 0] /FMapType 2 /Encoding [0] /FDepVector [ /${i ? 'N' + (i - 1) : 'Base0'} findfont ] >> definefont pop `;
    expect(() => runPsText(source)).toThrow(/limitcheck/);
  });
  it('rejects unsupported mapping/vertical fonts explicitly', () => {
    expect(() => runPsText(pairFontSource() + '/Bad << /FontType 0 /FontMatrix [1 0 0 1 0 0] /FMapType 9 /Encoding [0] /FDepVector [ /Base0 findfont ] >> definefont')).toThrow(UnsupportedFeatureError);
  });
});
