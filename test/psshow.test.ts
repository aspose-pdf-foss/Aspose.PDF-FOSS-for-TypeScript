import { describe, expect, it } from 'vitest';
import { runPsText } from './helpers/ps-text.js';
describe('positioned PostScript shows', () => {
  it.each([
    ['2 3 (AB) ashow', 16, 6], ['10 20 65 (AB) widthshow', 22, 20], ['10 20 65 2 3 (AB) awidthshow', 26, 26],
    ['(AB) [20 30] xshow', 50, 0], ['(AB) [20 30] yshow', 0, 50], ['(AB) [1 2 3 4] xyshow', 4, 6],
    ['(AB) <95200002000a0014> xshow', 30, 0],
  ])('leaves the advanced final current point for %s', (source, x, y) => {
    const { vm } = runPsText('/Courier 10 selectfont 0 0 moveto ' + source + ' currentpoint');
    expect(vm.number(1).value).toBeCloseTo(x as number); expect(vm.number().value).toBeCloseTo(y as number);
  });
  it('refuses short displacement data rather than inventing zeroes', () => {
    expect(() => runPsText('0 0 moveto (AB) [1] xshow')).toThrow(/rangecheck/);
  });
});
