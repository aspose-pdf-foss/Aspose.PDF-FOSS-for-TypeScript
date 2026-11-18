import { describe, expect, it } from 'vitest';
import { runPsText, psTextBytes } from './helpers/ps-text.js';
describe('PostScript text callbacks', () => {
  it('passes adjacent kshow codes once and uses later font changes', () => {
    const { vm } = runPsText('/Courier 10 selectfont 0 0 moveto { /right exch def /left exch def /Helvetica 20 selectfont } (AB) kshow currentpoint left right');
    expect(vm.number(3).value).toBeCloseTo(19.34); expect(vm.number(2).value).toBe(0); expect(vm.stack.slice(-2)).toMatchObject([{ value: 65 }, { value: 66 }]);
  });
  it('cshow passes codes and width vectors without marking or moving', () => {
    const { vm, graphics } = runPsText('/Courier 10 selectfont 10 20 moveto { } (AB) cshow currentpoint');
    expect(vm.stack).toMatchObject([{ value: 65 }, { value: 6 }, { value: 0 }, { value: 66 }, { value: 6 }, { value: 0 }, { value: 10 }, { value: 20 }]);
    expect(graphics.finish()).toHaveLength(0);
  });
  it('restores cshow temporary font while allowing nested text and explicit font changes', () => {
    const { vm } = runPsText('/Courier 10 selectfont 0 0 moveto { pop pop pop /Helvetica 20 selectfont currentfont rootfont eq (A) show } (A) cshow currentfont /FontName get currentpoint');
    expect(vm.stack[0]).toMatchObject({ value: true }); expect(vm.stack[1]).toMatchObject({ text: 'Courier' }); expect(vm.number(1).value).toBeCloseTo(13.34);
  });
  it('returning error handlers resume nested cshow callbacks', () => {
    const { vm } = runPsText('errordict /undefined { pop } put { pop pop pop /missing load 7 } (A) cshow'); expect(vm.peek()).toMatchObject({ value: 7 });
  });
  it('exit crosses text work to the surrounding repeat and restores font scopes', () => {
    const { vm, graphics } = runPsText('/Courier 10 selectfont 0 0 moveto 2 { { pop pop pop /Helvetica 20 selectfont exit 99 } (AB) cshow 88 } repeat currentfont /FontName get');
    expect(vm.stack).toMatchObject([{ text: 'Courier' }]); expect(graphics.finish()).toHaveLength(0);
    vm.run(psTextBytes('1 2 add')); expect(vm.peek()).toMatchObject({ value: 3 });
  });
});
